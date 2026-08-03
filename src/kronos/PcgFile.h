#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace kronos {

// Confirmed by diffing purpose-built test files (setlist_test.PCG, and
// later test_1.PCG for Font size/Transpose specifically) where each
// parameter was varied in isolation across known slots -- see
// docs/README.md's "SBK1" section (§4.3-4.4) for the byte-level
// derivation, including the bit-packing note: Font size and Transpose
// each share a byte with Color/Bank respectively, so reading (or
// writing) any of these four fields must mask to the bits it actually
// owns -- see PcgFile.cpp's readSlotParams() for the exact masks.
//
// 0=S (the true baseline -- zero extra bits set), 1=XS, 2=M, 3=L, 4=XL --
// not alphabetical/size order, that's just what the confirmed bit
// encoding produces (see docs/README.md §4.4).
enum class FontSize { S, XS, M, L, XL };

struct SlotParams {
    bool isProgram = true;  // true = Program, false = Combi
    int bank = 0;           // bank index (masked to this field's own 5 bits -- see docs/README.md §4.3)
    int number = 0;         // program/combi number within that bank (0-127)
    int color = 1;          // 1-based color index (1..16 -- masked to this field's own bits, see §4.3)
    int holdTime = 0;       // Hold Time value
    int volume = 127;       // 0-127, MIDI-style
    FontSize fontSize = FontSize::S;
    int transpose = 0;      // semitones, signed (confirmed range -24..+24; encoding supports -32..+31)
    bool found = false;     // false if this slot had no SBK1 record at all (e.g. SBK1 missing/malformed)
};

// One song/program slot within a Set List.
struct Song {
    int index = 0;       // 0-based slot position within its Set List (0..127)
    std::string name;     // may be empty -- an unused slot
    SlotParams params;    // from SBK1; params.found is false if SBK1 wasn't parseable
    std::string comment;  // free-text comment, may contain \r\n line breaks; may be empty
    // The actual Combi's own name, looked up from the CMB1/CBK1 instrument
    // bank by params.bank/params.number -- only populated when
    // params.isProgram is false. Program-side lookup (PRG1/PBK1/MBK1) is
    // not implemented yet -- its bank layout is more complex, see
    // README.md. Empty if not applicable/not found.
    std::string instrumentName;
};

// One of the Kronos's 128 Set Lists.
struct Setlist {
    int index = 0;                 // 0-based Set List number (0..127)
    std::string name;              // e.g. "Preload Set List", or "Set List 005" if never renamed
    std::vector<Song> songs;       // always 128 entries (a real Kronos Set List has exactly 128 slots)
};

// A Program bank's underlying storage/engine family. NOT fixed per bank
// index -- Kronos OS 3.0+ lets a user reassign INT Program Banks between
// HD-1 and EXi, so this is read per-file from data already parsed at load
// time (the bank's own chunk tag, cross-checked against its declared
// per-record byte stride), never a hardcoded per-bank-index table -- see
// src/kronos/ProgramDecoder.h's classifyProgramBankType() and
// docs/external/README.md for the sources this came from. Practically:
// a Program can only be loaded into a bank of the matching type, and a
// Combi's Timbre references only mean anything if the physical bank/number
// they point at actually holds a Program (of the right type) -- relevant
// to any future cross-dataset "move/merge patches" feature, not to
// anything built yet.
//
// NOT YET independently verified against a real Kronos backup by this
// project's own "no guessing" standard -- see docs/external/README.md's
// caveat before trusting this for anything beyond its own unit test.
enum class ProgramBankType { Hd1, Exi };

// One Program's table row: `bank`/`name`/`number` are raw Kronos fields,
// read directly off PRG1's MBK1/PBK1 banks (see docs/README.md §5.2) by
// src/kronos/ProgramDecoder.h. `contentHash` is deliberately NOT a Kronos
// format field -- it's this project's own application-level bookkeeping
// (an FNV-1a hash of the record's raw bytes, for byte-exact duplicate
// detection), computed once and cached here rather than recomputed on
// every use. See docs/content/components/index.md for why this
// raw-field/derived-data split is kept explicit rather than blurred.
// `bankType` is likewise derived bookkeeping, not a per-record Kronos field
// -- see ProgramBankType's own doc comment above.
struct ProgramInfo {
    int bank = 0;
    int number = 0;
    std::string name;
    uint64_t contentHash = 0;
    ProgramBankType bankType = ProgramBankType::Hd1;
};

// A Timbre's on/off + source-engine status, read from the byte immediately
// after its [number][bank] pair (byte offset +2 within the Timbre block):
// the top 3 bits ((byte >> 5) & 0x07) give this status, confirmed against
// an independent external reference (DaBlick/PCG-Tools' "PCG Structure
// Kronos.txt", see docs/README.md) and cross-checked against this project's
// own real Combi samples. `Off` is what every genuinely-unassigned Timbre
// slot shows; the lower 5 bits of the same byte are NOT part of this --
// they hold the Timbre's own 0-based index, a redundant field unrelated to
// on/off state (confirmed by watching it count 0..15 across a real Combi's
// 16 Timbres regardless of status).
enum class TimbreStatus { Off, Internal, External, Ex2, Unknown };

// One Combi Timbre's Program reference, read directly from the Combi's raw
// record bytes at a fixed stride (see docs/README.md's "Combi Timbre
// references" section for how this was derived from real Combi samples the
// project owner provided directly, and independently cross-checked against
// DaBlick/PCG-Tools' reference doc). Encoding: byte 0 = Program number, byte
// 1 = a raw bank code -- confirmed NOT to be the same index space
// ProgramInfo::bank/SlotParams::bank use (those are PBK1 file order; this
// is some other, absolute Kronos-internal numbering). Only a handful of
// codes are confirmed to a named bank so far (see kronos::timbreBankName);
// every other code is real but not yet identified.
struct TimbreRef {
    int number = 0;
    int rawBankCode = 0;
    TimbreStatus status = TimbreStatus::Off;
    // true when number==0 && rawBankCode==0 -- this Timbre slot has no real
    // Program reference stored at all (as opposed to having one that's
    // just currently switched off -- see `status`). Deliberately NOT tied
    // to status: a Timbre can hold a genuine, non-zero bank/number while
    // status is Off (e.g. temporarily disabled without clearing its
    // assignment), and that should still count as "this Combi references
    // that Program" for anything safety-related (e.g. deciding whether a
    // Program is safe to delete) -- only isDefault means "nothing here."
    bool isDefault = true;
};

// Returns the confirmed bank name for a raw Combi Timbre bank code (e.g.
// "USER-D"), or an empty string if this code hasn't been identified yet.
// NOT the same lookup as the Program/Combi bank arrays used elsewhere --
// see TimbreRef's comment.
std::string timbreBankName(int rawBankCode);

// Whether `programBank` (this project's PBK1 file-order Program bank
// index, see ProgramInfo::bank) is confirmed to line up with the *same*
// numbering a Combi Timbre's raw bank code uses (TimbreRef::rawBankCode)
// -- true only for INT-A..D (0..3), the range independently verified in
// both schemes (see docs/README.md §6.2). Every other Program bank
// (INT-E..G, every USER bank) has a Timbre code that's confirmed to sit
// at a *different* index than its PBK1 file-order position (e.g. USER-D
// is file-order index 11 but Timbre code 20) -- counting Combi usage for
// those would silently produce wrong numbers, so it's not attempted.
bool isConfirmedTimbreProgramBank(int programBank);

// One Combi, from CMB1's CBK1 banks (see docs/README.md §5.1). No
// contentHash -- duplicate detection was only requested for Programs.
struct CombiInfo {
    int bank = 0;
    int number = 0;
    std::string name;
    std::vector<TimbreRef> timbres;  // always 16 entries, Timbre 1..16 in order
};

// One Set List slot that directly references a given Program (as opposed
// to referencing it indirectly through a Combi -- Combi-internal
// references aren't parsed yet, see docs/README.md's Phase 2 roadmap).
struct SetlistUsage {
    int setlistIndex = 0;
    std::string setlistName;
    int songIndex = 0;
};

// One Combi whose Timbres reference a given Program. `active` is true if
// *any* matching Timbre's status isn't Off -- a Combi can reference a
// Program only through an Off Timbre (e.g. a stale/disabled assignment),
// which still counts as a reference (see TimbreRef::isDefault's comment)
// but is worth distinguishing in the UI.
struct CombiUsage {
    int bank = 0;
    int number = 0;
    std::string name;
    bool active = false;
};

// Parses a Korg Kronos .PCG/.SNG backup file and extracts all 128 Set Lists
// from its SDB1 ("Set List database") chunk. Loads the whole file into
// memory -- fine for desktop use at the ~50-70MB sizes these files run.
//
// Chunk format and the SDB1 record layout are documented in README.md.
class PcgFile {
public:
    // Returns false and fills `error` on failure (bad magic, missing chunk,
    // truncated/malformed data). Does not throw.
    bool load(const std::string& path, std::string& error);

    // Same as load(), but from bytes already in memory (e.g. a file dropped
    // onto the UI and read via the browser's File API, which has no
    // filesystem path to give us -- see README.md's "Open File" section).
    bool loadFromMemory(std::vector<uint8_t> data, std::string& error);

    const std::vector<Setlist>& setlists() const { return setlists_; }
    std::vector<Setlist>& setlists() { return setlists_; }

    const std::vector<ProgramInfo>& programs() const { return programs_; }
    const std::vector<CombiInfo>& combis() const { return combis_; }

    // Every Program-type Set List slot that directly references this
    // bank/number. Does NOT include usage from inside a Combi's Timbres --
    // that part of the format isn't parsed yet (see docs/README.md).
    //
    // Caveat: bank 0 / number 0 is also the all-zero byte value, so it
    // over-counts -- a slot that was never actually assigned a Program
    // still reads as "bank 0, number 0" (confirmed: this returns 16000+
    // "usages" for 0/0 on a real backup, vs. a handful for any other
    // bank/number). There's no known flag distinguishing "really assigned
    // to bank 0/number 0" from "never touched" -- treat 0/0 usage counts
    // with that in mind; every other bank/number has been spot-checked as
    // accurate.
    std::vector<SetlistUsage> programSetlistUsages(int bank, int number) const;

    // Every Combi-type Set List slot that directly references this
    // bank/number. Same bank-0/number-0 caveat as programSetlistUsages()
    // applies here too.
    std::vector<SetlistUsage> combiSetlistUsages(int bank, int number) const;

    // Set-List-slot reference counts for every (bank, number) at once,
    // indexed `[bank][number]` -- built in one pass over all Set Lists
    // rather than calling programSetlistUsages()/combiSetlistUsages() once
    // per Program/Combi (which would be O(programs x songs) instead of
    // O(songs)). Used to attach a reference count to every row of a
    // Programs/Combis listing without it being slow at ~2500/~1800 rows.
    std::vector<std::vector<int>> setlistUsageCounts(bool isProgram) const;

    // Every Combi whose Timbres reference this bank/number, regardless of
    // on/off status (see CombiUsage::active). Only meaningful when
    // isConfirmedTimbreProgramBank(bank) is true -- returns an empty list
    // otherwise, same as if there were genuinely no usages, since this
    // project can't yet tell the difference for unconfirmed banks.
    std::vector<CombiUsage> combiUsagesForProgram(int bank, int number) const;

    // Combi-usage counts for every (bank, number) at once, indexed
    // `[bank][number]` -- same one-pass-instead-of-per-row idea as
    // setlistUsageCounts(). Only populated for banks where
    // isConfirmedTimbreProgramBank() is true; every other bank has no
    // entry at all (callers must check isConfirmedTimbreProgramBank()
    // themselves to tell "zero real usages" apart from "not computed").
    std::vector<std::vector<int>> combiUsageCounts() const;

    // Groups of 2+ Programs sharing an identical contentHash (byte-exact
    // duplicates). Programs with a unique hash are omitted entirely.
    std::vector<std::vector<ProgramInfo>> findDuplicatePrograms() const;

    // Re-decodes one Program directly from the retained raw file bytes,
    // independently of programs() (which was built once during load) --
    // proof that the decoder is a real, reusable, on-demand operation
    // rather than something only ever run once. Returns nullopt if
    // bank/number is out of range, or no file is loaded.
    //
    // This is the first piece of the architecture direction described in
    // docs/content/components/index.md and STATE.md's "ARCHITECTURE:
    // DECODER/ENCODER REFACTOR" section: raw bytes are retained as the
    // one canonical copy (see data_ below) instead of being discarded
    // after an eager parse, and small per-record decoders
    // (src/kronos/ProgramDecoder.h so far) compute structure from them on
    // demand. Combi and Set List slot decoders are the planned next steps
    // once this is proven out -- programs_/combis_/setlists_ below still
    // reflect the older eager-parse shape for everything else.
    std::optional<ProgramInfo> decodeProgram(int bank, int number) const;

    // Same as decodeProgram(), for Combis -- see src/kronos/CombiDecoder.h,
    // the second per-record decoder built this way.
    std::optional<CombiInfo> decodeCombi(int bank, int number) const;

private:
    // Where one PRG1 sub-bank's (MBK1 or PBK1) records live within data_
    // -- retained so decodeProgram() can locate and re-decode a specific
    // record on demand, without re-scanning the whole file's chunk
    // hierarchy every time.
    struct ProgramBankLocation {
        size_t recordsStart = 0;
        uint32_t numRecords = 0;
        uint32_t bytesPerRecord = 0;
        ProgramBankType bankType = ProgramBankType::Hd1;  // classified once at load, see ProgramBankType's doc comment
    };

    // Same as ProgramBankLocation, for one CBK1 sub-bank -- retained so
    // decodeCombi() can locate and re-decode a specific record on demand.
    struct CombiBankLocation {
        size_t recordsStart = 0;
        uint32_t numRecords = 0;
        uint32_t bytesPerRecord = 0;
    };

    std::vector<Setlist> setlists_;
    std::vector<ProgramInfo> programs_;
    std::vector<CombiInfo> combis_;
    std::vector<uint8_t> data_;                          // the whole file's raw bytes, retained after load
    std::vector<ProgramBankLocation> programBankLocations_;  // index into data_, one entry per PRG1 sub-bank
    std::vector<CombiBankLocation> combiBankLocations_;      // index into data_, one entry per CBK1 sub-bank
};

}  // namespace kronos
