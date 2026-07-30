#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace kronos {

// Confirmed by diffing a purpose-built test file (setlist_test.PCG) where
// each parameter was varied in isolation across known slots -- see
// README.md's "SBK1" section for the byte-level derivation. Font size and
// Transpose are NOT included here yet -- their encoding isn't solved.
struct SlotParams {
    bool isProgram = true;  // true = Program, false = Combi
    int bank = 0;           // bank index
    int number = 0;         // program/combi number within that bank (0-127)
    int color = 1;          // 1-based color index (1, 2, 4, 16, ... seen)
    int holdTime = 0;       // Hold Time value
    int volume = 127;       // 0-127, MIDI-style
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

// One Program, from PRG1's MBK1/PBK1 banks (see docs/README.md §5.2).
struct ProgramInfo {
    int bank = 0;
    int number = 0;
    std::string name;
    // FNV-1a hash of the program's full raw record (computed at parse
    // time -- the raw bytes themselves aren't kept around afterward, see
    // PcgFile::loadFromMemory). Used to find byte-exact duplicates.
    uint64_t contentHash = 0;
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

    // Groups of 2+ Programs sharing an identical contentHash (byte-exact
    // duplicates). Programs with a unique hash are omitted entirely.
    std::vector<std::vector<ProgramInfo>> findDuplicatePrograms() const;

private:
    std::vector<Setlist> setlists_;
    std::vector<ProgramInfo> programs_;
    std::vector<CombiInfo> combis_;
};

}  // namespace kronos
