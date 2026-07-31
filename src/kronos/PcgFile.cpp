#include "PcgFile.h"

#include <algorithm>
#include <cstring>
#include <fstream>
#include <functional>
#include <optional>
#include <unordered_map>

#include "ProgramDecoder.h"

namespace kronos {

namespace {

bool isUpperOrDigit(uint8_t c) {
    return (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
}

// Chunk tags observed in this format (KORG, PCG1, DIV1, SLS1, SLD1, SDB1)
// are all 4 uppercase-alphanumeric characters starting with a letter.
bool looksLikeTag(const uint8_t* p) {
    return p[0] >= 'A' && p[0] <= 'Z' && isUpperOrDigit(p[1]) && isUpperOrDigit(p[2]) && isUpperOrDigit(p[3]);
}

uint32_t readU32BE(const uint8_t* p) {
    return (uint32_t(p[0]) << 24) | (uint32_t(p[1]) << 16) | (uint32_t(p[2]) << 8) | uint32_t(p[3]);
}

struct ChunkInfo {
    size_t contentStart = 0;
    size_t contentEnd = 0;
    std::string tag;
};

// Every chunk record in this format is preceded by one extra 4-byte field of
// unknown purpose before its [4-char tag][u32be size][content] header --
// try the direct position first, then the position shifted by 4 bytes.
// See README.md ("Open questions") for what this prefix field might be.
std::optional<ChunkInfo> readChunk(const std::vector<uint8_t>& data, size_t pos, size_t end) {
    for (int prefixLen : {0, 4}) {
        size_t p = pos + prefixLen;
        if (p + 8 > end) continue;
        if (!looksLikeTag(&data[p])) continue;

        uint32_t size = readU32BE(&data[p + 4]);
        size_t contentStart = p + 8;
        size_t contentEnd = contentStart + size;
        if (contentEnd < contentStart || contentEnd > end) continue;

        ChunkInfo info;
        info.contentStart = contentStart;
        info.contentEnd = contentEnd;
        info.tag.assign(reinterpret_cast<const char*>(&data[p]), 4);
        return info;
    }
    return std::nullopt;
}

// Depth-first walk collecting every chunk anywhere in the hierarchy whose
// tag satisfies `wanted` (e.g. matches one specific tag, or one of several --
// MBK1/PBK1 Program banks are interleaved in file order under PRG1, so
// collecting "either tag" in one walk is what preserves that order). The
// depth cap is a safety net against pathological/corrupt input, not
// something normal files should hit.
void collectChunks(const std::vector<uint8_t>& data, size_t start, size_t end,
                    const std::function<bool(const std::string&)>& wanted, std::vector<ChunkInfo>& out, int depth) {
    if (depth > 64) return;
    size_t pos = start;
    while (pos + 8 <= end) {
        auto chunk = readChunk(data, pos, end);
        if (!chunk) break;
        if (wanted(chunk->tag)) out.push_back(*chunk);
        collectChunks(data, chunk->contentStart, chunk->contentEnd, wanted, out, depth + 1);
        pos = chunk->contentEnd + (chunk->contentEnd % 2);
    }
}

void collectChunks(const std::vector<uint8_t>& data, size_t start, size_t end, const std::string& wantedTag,
                    std::vector<ChunkInfo>& out, int depth) {
    collectChunks(
        data, start, end, [&wantedTag](const std::string& tag) { return tag == wantedTag; }, out, depth);
}

// A Set List record: 4-byte marker + 24-byte null-padded ASCII name.
constexpr size_t kRecordSize = 28;
constexpr size_t kMarkerSize = 4;

std::string readRecordName(const uint8_t* data, size_t off, size_t end) {
    if (off + kRecordSize > end) return {};
    const uint8_t* nameStart = data + off + kMarkerSize;
    const uint8_t* nameEnd = data + off + kRecordSize;
    const uint8_t* nul = std::find(nameStart, nameEnd, uint8_t{0});
    return std::string(reinterpret_cast<const char*>(nameStart), static_cast<size_t>(nul - nameStart));
}

// SBK1 per-Set-List block: a name/header record (kSbkHeaderSize bytes,
// not re-parsed here -- SDB1 already gave us the name), followed by 128
// song parameter records on a fixed stride. Offsets confirmed by diffing
// setlist_test.PCG and test_1.PCG, files the project owner built
// specifically to isolate one parameter per group of slots -- see
// docs/README.md's "SBK1" section (§4.3-4.4).
//
// +12 and +17 are each shared by two fields, and +13 by two more --
// Font size and Transpose are packed a few bits at a time into otherwise-
// unrelated bytes (Type+Color, Bank), presumably because this format
// predates spare bytes being cheap. Every mask below exists so reading
// (or writing) one field never touches bits that belong to another.
constexpr size_t kSbkHeaderSize = 40;
constexpr size_t kSbkRecordSize = 542;
constexpr size_t kSbkTypeColorOffset = 12;  // bit0: 1=Program/0=Combi; bits2-5: (color-1); bits6-7: Font size low 2 bits
constexpr uint8_t kSbkTypeColorMask = 0x3F;      // bits 0-5 -- Type+Color's own bits
constexpr uint8_t kSbkFontSizeLowMask = 0xC0;    // bits 6-7 of +12
constexpr size_t kSbkBankOffset = 13;       // bits0-4: bank; bits5-7: Transpose high 3 bits
constexpr uint8_t kSbkBankMask = 0x1F;           // bits 0-4 -- Bank's own bits
constexpr uint8_t kSbkTransposeHighMask = 0xE0;  // bits 5-7 of +13
constexpr size_t kSbkNumberOffset = 14;
constexpr size_t kSbkHoldTimeOffset = 15;  // stored value = Hold Time + 1
constexpr size_t kSbkVolumeOffset = 16;
constexpr size_t kSbkFontTransposeOffset = 17;   // bit4: Font size high bit; bits5-7: Transpose low 3 bits; bit3 and bits0-2 still unexplained, see docs/README.md
constexpr uint8_t kSbkFontSizeHighMask = 0x10;   // bit 4 of +17
constexpr uint8_t kSbkTransposeLowMask = 0xE0;   // bits 5-7 of +17
constexpr size_t kSbkCommentOffset = 18;

// The Comment field can contain embedded \r\n line breaks, so unlike
// readRecordName() this only stops at a genuine NUL byte, not otherwise.
// Scans to the end of the 542-byte record (kSbkRecordSize), the largest
// this field could possibly be.
std::string readComment(const uint8_t* data, size_t songOff, size_t end) {
    size_t start = songOff + kSbkCommentOffset;
    size_t recordEnd = songOff + kSbkRecordSize;
    if (start >= end) return {};
    const uint8_t* commentStart = data + start;
    const uint8_t* scanEnd = data + std::min(recordEnd, end);
    const uint8_t* nul = std::find(commentStart, scanEnd, uint8_t{0});
    return std::string(reinterpret_cast<const char*>(commentStart), static_cast<size_t>(nul - commentStart));
}

SlotParams readSlotParams(const uint8_t* data, size_t songOff, size_t end) {
    SlotParams params;
    if (songOff + kSbkFontTransposeOffset + 1 > end) return params;  // leaves found=false

    uint8_t typeColor = data[songOff + kSbkTypeColorOffset];
    uint8_t bankByte = data[songOff + kSbkBankOffset];
    uint8_t fontTransposeByte = data[songOff + kSbkFontTransposeOffset];

    params.isProgram = (typeColor & 0x01) != 0;
    params.color = ((typeColor & kSbkTypeColorMask) >> 2) + 1;
    params.bank = bankByte & kSbkBankMask;
    params.number = data[songOff + kSbkNumberOffset];
    params.holdTime = static_cast<int>(data[songOff + kSbkHoldTimeOffset]) - 1;
    params.volume = data[songOff + kSbkVolumeOffset];

    // Font size: 3 bits, low 2 in +12's top bits, high 1 in +17 bit 4 --
    // see docs/README.md §4.4. Enum order (S,XS,M,L,XL) matches this
    // value directly, no further lookup needed.
    int fontSizeValue = ((fontTransposeByte & kSbkFontSizeHighMask) ? 4 : 0) |
                         ((typeColor & 0x80) ? 2 : 0) | ((typeColor & 0x40) ? 1 : 0);
    params.fontSize = static_cast<FontSize>(fontSizeValue);

    // Transpose: 6-bit two's complement, high 3 bits in +13's top bits,
    // low 3 bits in +17's top bits -- see docs/README.md §4.4.
    int unsigned6 = ((bankByte & kSbkTransposeHighMask) >> 2) | ((fontTransposeByte & kSbkTransposeLowMask) >> 5);
    params.transpose = unsigned6 >= 32 ? unsigned6 - 64 : unsigned6;

    params.found = true;
    return params;
}

// CBK1 (Combi banks, nested in CMB1) and MBK1/PBK1 (Program banks, nested
// in PRG1) share this exact same record shape: a 12-byte header (unknown
// count, numRecords=128, bytesPerRecord) -- same shape as SDB1/SBK1's
// headers -- followed by numRecords fixed-size records, each starting with
// a 24-byte name field 4 bytes in (space/NUL-padded, NOT NUL-terminated --
// a full-length 24-character name has no terminator at all, so this trims
// trailing NUL/space rather than searching for NUL).
constexpr size_t kBankRecordNameOffset = 4;
constexpr size_t kBankRecordNameLength = 24;

std::string readBankRecordName(const uint8_t* data, size_t recordOff, size_t end) {
    size_t nameOff = recordOff + kBankRecordNameOffset;
    if (nameOff + kBankRecordNameLength > end) return {};
    size_t len = kBankRecordNameLength;
    while (len > 0) {
        uint8_t c = data[nameOff + len - 1];
        if (c != 0 && c != ' ') break;
        --len;
    }
    return std::string(reinterpret_cast<const char*>(data + nameOff), len);
}

// A Combi's 16 Timbres each reference a Program at a fixed 188-byte stride
// starting 4806 bytes into the Combi's own record, byte 0 = number, byte 1
// = raw bank code. Confirmed by the project owner providing real Combis
// (with known Timbre->Program assignments) to diff against -- see
// docs/README.md's "Combi Timbre references" section. `recordEnd` bounds
// the read so a truncated/malformed record just yields default TimbreRefs
// past that point rather than reading out of range.
constexpr size_t kCombiTimbreBaseOffset = 4806;
constexpr size_t kCombiTimbreStride = 188;
constexpr int kCombiTimbreCount = 16;

// Top 3 bits of the status byte (offset+2 within a Timbre block) -- see
// TimbreStatus's doc comment in PcgFile.h. The lower 5 bits are a separate,
// unrelated field (the Timbre's own 0-based index) and are ignored here.
TimbreStatus decodeTimbreStatus(uint8_t statusByte) {
    switch ((statusByte >> 5) & 0x07) {
        case 0: return TimbreStatus::Off;
        case 1: return TimbreStatus::Internal;
        case 3: return TimbreStatus::External;
        case 4: return TimbreStatus::Ex2;
        default: return TimbreStatus::Unknown;
    }
}

std::vector<TimbreRef> readCombiTimbres(const uint8_t* data, size_t recordOff, size_t recordEnd) {
    std::vector<TimbreRef> timbres;
    timbres.reserve(kCombiTimbreCount);
    for (int i = 0; i < kCombiTimbreCount; ++i) {
        size_t h = recordOff + kCombiTimbreBaseOffset + static_cast<size_t>(i) * kCombiTimbreStride;
        TimbreRef ref;
        if (h + 2 < recordEnd) {
            ref.number = data[h];
            ref.rawBankCode = data[h + 1];
            ref.status = decodeTimbreStatus(data[h + 2]);
            ref.isDefault = (ref.number == 0 && ref.rawBankCode == 0);
        }
        timbres.push_back(ref);
    }
    return timbres;
}

// One record from a CBK1 (Combi) bank -- like BankRecord, but also carries
// each Combi's 16 Timbre Program references (Programs have no equivalent,
// hence a separate struct/collector rather than extending BankRecord).
struct CombiRecord {
    int bank = 0;
    int number = 0;
    std::string name;
    std::vector<TimbreRef> timbres;
};

std::vector<CombiRecord> collectCombiRecords(const std::vector<uint8_t>& data, const std::vector<ChunkInfo>& chunks) {
    std::vector<CombiRecord> records;
    for (size_t bankIdx = 0; bankIdx < chunks.size(); ++bankIdx) {
        const auto& chunk = chunks[bankIdx];
        if (chunk.contentStart + 12 > chunk.contentEnd) continue;

        readU32BE(&data[chunk.contentStart]);  // meaning not understood yet, unused here
        uint32_t numRecords = readU32BE(&data[chunk.contentStart + 4]);
        uint32_t bytesPerRecord = readU32BE(&data[chunk.contentStart + 8]);
        size_t recordsStart = chunk.contentStart + 12;

        if (bytesPerRecord == 0) continue;
        if (recordsStart + static_cast<size_t>(bytesPerRecord) * numRecords > chunk.contentEnd) continue;

        for (uint32_t i = 0; i < numRecords; ++i) {
            size_t off = recordsStart + static_cast<size_t>(i) * bytesPerRecord;
            CombiRecord rec;
            rec.bank = static_cast<int>(bankIdx);
            rec.number = static_cast<int>(i);
            rec.name = readBankRecordName(data.data(), off, data.size());
            rec.timbres = readCombiTimbres(data.data(), off, std::min(off + bytesPerRecord, data.size()));
            records.push_back(std::move(rec));
        }
    }
    return records;
}

}  // namespace

// Confirmed via real Combi samples the project owner provided directly,
// cross-checked against an independent external reference (DaBlick/
// PCG-Tools' "PCG Structure Kronos.txt", see docs/references/) -- both
// sources agree at every point they overlap (INT-A/B/C, and USER-F's code
// independently explaining a byte this project had first read from its own
// sample but the project owner had misremembered the Program number for).
// See docs/README.md's "Combi Timbre references" section for the full
// derivation. Every code below is a directly-verified byte value, from one
// source or the other -- not an extrapolation. That said, the two anchors
// on each side (INT-A..D=0..3, USER-A=17/USER-D=20/USER-F=22/USER-AA=24)
// strongly imply a contiguous INT-A..G=0..6 / USER-A..G=17..23 scheme;
// deliberately not added below until each individual code is confirmed the
// same way as these -- everything else returns "" so the UI shows the raw
// numeric code instead of a guessed name.
std::string timbreBankName(int rawBankCode) {
    switch (rawBankCode) {
        case 0: return "INT-A";
        case 1: return "INT-B";
        case 2: return "INT-C";
        case 3: return "INT-D";
        case 17: return "USER-A";
        case 20: return "USER-D";
        case 22: return "USER-F";
        case 24: return "USER-AA";
        default: return "";
    }
}

bool isConfirmedTimbreProgramBank(int programBank) {
    return programBank >= 0 && programBank <= 3;
}

bool PcgFile::load(const std::string& path, std::string& error) {
    std::ifstream file(path, std::ios::binary);
    if (!file) {
        error = "Could not open file: " + path;
        return false;
    }

    std::vector<uint8_t> data((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
    return loadFromMemory(std::move(data), error);
}

bool PcgFile::loadFromMemory(std::vector<uint8_t> data, std::string& error) {
    setlists_.clear();

    if (data.size() < 16 || std::memcmp(data.data(), "KORG", 4) != 0) {
        error = "Not a KORG PCG/SNG file (missing 'KORG' magic)";
        return false;
    }

    std::vector<ChunkInfo> sdbChunks;
    collectChunks(data, 16, data.size(), "SDB1", sdbChunks, 0);
    if (sdbChunks.empty()) {
        error = "No SDB1 (Set List database) chunk found in this file";
        return false;
    }

    // A single SDB1 chunk holds all of the unit's Set Lists (128 on a real
    // Kronos), not just one -- see README.md for how this was derived by
    // searching the file for known song/Set List names.
    for (const auto& sdb : sdbChunks) {
        if (sdb.contentStart + 12 > sdb.contentEnd) continue;

        readU32BE(&data[sdb.contentStart]);  // "used" count -- meaning not fully understood yet, unused here
        uint32_t numSetlists = readU32BE(&data[sdb.contentStart + 4]);
        uint32_t bytesPerSetlist = readU32BE(&data[sdb.contentStart + 8]);
        size_t setlistsStart = sdb.contentStart + 12;

        constexpr uint32_t kSongsPerSetlist = 128;  // 1 name record + 128 song records per Set List
        if (bytesPerSetlist != (kSongsPerSetlist + 1) * kRecordSize) continue;  // doesn't match the known layout
        if (setlistsStart + static_cast<size_t>(bytesPerSetlist) * numSetlists > data.size()) continue;

        for (uint32_t s = 0; s < numSetlists; ++s) {
            size_t setlistOff = setlistsStart + static_cast<size_t>(s) * bytesPerSetlist;

            Setlist setlist;
            setlist.index = static_cast<int>(s);
            setlist.name = readRecordName(data.data(), setlistOff, data.size());

            for (uint32_t k = 0; k < kSongsPerSetlist; ++k) {
                size_t songOff = setlistOff + kRecordSize + static_cast<size_t>(k) * kRecordSize;
                Song song;
                song.index = static_cast<int>(k);
                song.name = readRecordName(data.data(), songOff, data.size());
                setlist.songs.push_back(std::move(song));
            }

            setlists_.push_back(std::move(setlist));
        }
    }

    // SBK1 (nested inside SLS1 > STL1) holds the real per-slot parameters --
    // Program/Combi/bank/number/Hold Time/Volume/Color. Optional: if it's
    // missing or doesn't match the known layout, Set List names from SDB1
    // above still work fine, just without these extra fields (params.found
    // stays false). See README.md for how this chunk was found and decoded.
    std::vector<ChunkInfo> sbkChunks;
    collectChunks(data, 16, data.size(), "SBK1", sbkChunks, 0);

    for (const auto& sbk : sbkChunks) {
        if (sbk.contentStart + 12 > sbk.contentEnd) continue;

        readU32BE(&data[sbk.contentStart]);  // count -- meaning not understood yet, unused here
        uint32_t numSetlists = readU32BE(&data[sbk.contentStart + 4]);
        uint32_t bytesPerSetlist = readU32BE(&data[sbk.contentStart + 8]);
        size_t setlistsStart = sbk.contentStart + 12;

        constexpr uint32_t kSongsPerSetlist = 128;
        if (bytesPerSetlist != kSbkHeaderSize + kSongsPerSetlist * kSbkRecordSize) continue;
        if (setlistsStart + static_cast<size_t>(bytesPerSetlist) * numSetlists > data.size()) continue;

        for (uint32_t s = 0; s < numSetlists && s < setlists_.size(); ++s) {
            size_t setlistOff = setlistsStart + static_cast<size_t>(s) * bytesPerSetlist;
            size_t songsStart = setlistOff + kSbkHeaderSize;

            auto& songs = setlists_[s].songs;
            for (uint32_t k = 0; k < kSongsPerSetlist && k < songs.size(); ++k) {
                size_t songOff = songsStart + static_cast<size_t>(k) * kSbkRecordSize;
                songs[k].params = readSlotParams(data.data(), songOff, data.size());
                songs[k].comment = readComment(data.data(), songOff, data.size());
            }
        }
    }

    // CBK1 (Combi banks, nested CMB1 > CBK1) and MBK1/PBK1 (Program banks,
    // nested PRG1 > MBK1/PBK1, interleaved in file order) -- cross-
    // referenced by each slot's bank/number to show the instrument's real
    // name. Both confirmed against known real names the project owner
    // pointed out directly (e.g. "Subdivisions"/"Perfect Kiss"/"Sirius" as
    // three consecutive Program records; "Dont stop believin" as a Combi
    // record matching its Set List slot exactly). Optional, same as SBK1:
    // missing/malformed just leaves instrumentName empty rather than
    // failing the whole load.
    std::vector<ChunkInfo> cbkChunks;
    collectChunks(data, 16, data.size(), "CBK1", cbkChunks, 0);
    std::vector<CombiRecord> combiRecords = collectCombiRecords(data, cbkChunks);
    std::vector<std::vector<std::string>> combiBankNames;  // [bank][number]
    for (const auto& r : combiRecords) {
        if (r.bank >= static_cast<int>(combiBankNames.size())) combiBankNames.resize(r.bank + 1);
        if (r.number >= static_cast<int>(combiBankNames[r.bank].size())) combiBankNames[r.bank].resize(r.number + 1);
        combiBankNames[r.bank][r.number] = r.name;
    }

    combis_.clear();
    for (const auto& r : combiRecords) combis_.push_back({r.bank, r.number, r.name, r.timbres});

    // Programs: the first field decoded via a standalone per-record
    // decoder (src/kronos/ProgramDecoder.h) instead of inline in a
    // generic bank-walking helper -- see STATE.md's "ARCHITECTURE:
    // DECODER/ENCODER REFACTOR". This single walk populates both
    // programs_ (the table/dedup view) and programBankNames (the
    // instrument-name cross-reference below) from the same decoded
    // fields, and also records each bank's location in
    // programBankLocations_ so decodeProgram() can re-decode any single
    // Program on demand later, straight from the retained raw bytes
    // (data_, set at the end of this function) -- not just once, here.
    std::vector<ChunkInfo> programBankChunks;
    collectChunks(
        data, 16, data.size(), [](const std::string& tag) { return tag == "MBK1" || tag == "PBK1"; },
        programBankChunks, 0);

    programs_.clear();
    programBankLocations_.clear();
    std::vector<std::vector<std::string>> programBankNames;  // [bank][number]

    for (size_t bankIdx = 0; bankIdx < programBankChunks.size(); ++bankIdx) {
        const auto& chunk = programBankChunks[bankIdx];
        if (chunk.contentStart + 12 > chunk.contentEnd) continue;

        readU32BE(&data[chunk.contentStart]);  // meaning not understood yet, unused here
        uint32_t numRecords = readU32BE(&data[chunk.contentStart + 4]);
        uint32_t bytesPerRecord = readU32BE(&data[chunk.contentStart + 8]);
        size_t recordsStart = chunk.contentStart + 12;

        if (bytesPerRecord == 0) continue;
        if (recordsStart + static_cast<size_t>(bytesPerRecord) * numRecords > chunk.contentEnd) continue;

        programBankLocations_.push_back({recordsStart, numRecords, bytesPerRecord});

        for (uint32_t i = 0; i < numRecords; ++i) {
            size_t off = recordsStart + static_cast<size_t>(i) * bytesPerRecord;
            const uint8_t* record = &data[off];
            ProgramFields fields = decodeProgramFields(record, bytesPerRecord, static_cast<int>(bankIdx), static_cast<int>(i));
            uint64_t hash = hashProgramRecord(record, bytesPerRecord);
            programs_.push_back({fields.bank, fields.number, fields.name, hash});

            if (fields.bank >= static_cast<int>(programBankNames.size())) programBankNames.resize(fields.bank + 1);
            if (fields.number >= static_cast<int>(programBankNames[fields.bank].size())) {
                programBankNames[fields.bank].resize(fields.number + 1);
            }
            programBankNames[fields.bank][fields.number] = fields.name;
        }
    }

    for (auto& setlist : setlists_) {
        for (auto& song : setlist.songs) {
            if (!song.params.found) continue;
            const auto& banks = song.params.isProgram ? programBankNames : combiBankNames;
            int bank = song.params.bank;
            int number = song.params.number;
            if (bank < 0 || bank >= static_cast<int>(banks.size())) continue;
            if (number < 0 || number >= static_cast<int>(banks[bank].size())) continue;
            song.instrumentName = banks[bank][number];
        }
    }

    // Retained rather than discarded, now that decodeProgram() (and
    // future per-record decoders) can re-read from it on demand -- see
    // STATE.md's "ARCHITECTURE: DECODER/ENCODER REFACTOR". Moved, not
    // copied: nothing above this point needs the local `data` again.
    data_ = std::move(data);

    return true;
}

namespace {

std::vector<SetlistUsage> setlistUsagesFor(const std::vector<Setlist>& setlists, bool isProgram, int bank,
                                            int number) {
    std::vector<SetlistUsage> usages;
    for (const auto& setlist : setlists) {
        for (const auto& song : setlist.songs) {
            if (!song.params.found || song.params.isProgram != isProgram) continue;
            if (song.params.bank != bank || song.params.number != number) continue;
            usages.push_back({setlist.index, setlist.name, song.index});
        }
    }
    return usages;
}

}  // namespace

std::vector<SetlistUsage> PcgFile::programSetlistUsages(int bank, int number) const {
    return setlistUsagesFor(setlists_, true, bank, number);
}

std::vector<SetlistUsage> PcgFile::combiSetlistUsages(int bank, int number) const {
    return setlistUsagesFor(setlists_, false, bank, number);
}

std::vector<std::vector<int>> PcgFile::setlistUsageCounts(bool isProgram) const {
    std::vector<std::vector<int>> counts;
    for (const auto& setlist : setlists_) {
        for (const auto& song : setlist.songs) {
            if (!song.params.found || song.params.isProgram != isProgram) continue;
            int bank = song.params.bank;
            int number = song.params.number;
            if (bank < 0 || number < 0) continue;
            if (bank >= static_cast<int>(counts.size())) counts.resize(bank + 1);
            if (number >= static_cast<int>(counts[bank].size())) counts[bank].resize(number + 1, 0);
            counts[bank][number]++;
        }
    }
    return counts;
}

std::vector<CombiUsage> PcgFile::combiUsagesForProgram(int bank, int number) const {
    std::vector<CombiUsage> usages;
    if (!isConfirmedTimbreProgramBank(bank)) return usages;

    for (const auto& combi : combis_) {
        bool referenced = false;
        bool active = false;
        for (const auto& t : combi.timbres) {
            if (t.isDefault || t.rawBankCode != bank || t.number != number) continue;
            referenced = true;
            if (t.status != TimbreStatus::Off) active = true;
        }
        if (referenced) usages.push_back({combi.bank, combi.number, combi.name, active});
    }
    return usages;
}

std::vector<std::vector<int>> PcgFile::combiUsageCounts() const {
    std::vector<std::vector<int>> counts;
    for (const auto& combi : combis_) {
        for (const auto& t : combi.timbres) {
            if (t.isDefault || !isConfirmedTimbreProgramBank(t.rawBankCode)) continue;
            int bank = t.rawBankCode;
            int number = t.number;
            if (bank >= static_cast<int>(counts.size())) counts.resize(bank + 1);
            if (number >= static_cast<int>(counts[bank].size())) counts[bank].resize(number + 1, 0);
            counts[bank][number]++;
        }
    }
    return counts;
}

std::vector<std::vector<ProgramInfo>> PcgFile::findDuplicatePrograms() const {
    std::unordered_map<uint64_t, std::vector<ProgramInfo>> byHash;
    for (const auto& program : programs_) byHash[program.contentHash].push_back(program);

    std::vector<std::vector<ProgramInfo>> groups;
    for (auto& [hash, group] : byHash) {
        if (group.size() < 2) continue;
        std::sort(group.begin(), group.end(), [](const ProgramInfo& a, const ProgramInfo& b) {
            return a.bank != b.bank ? a.bank < b.bank : a.number < b.number;
        });
        groups.push_back(std::move(group));
    }
    // unordered_map iteration order isn't deterministic run-to-run -- sort
    // groups themselves so callers (and tests) see a stable order.
    std::sort(groups.begin(), groups.end(), [](const auto& a, const auto& b) {
        return a.front().bank != b.front().bank ? a.front().bank < b.front().bank : a.front().number < b.front().number;
    });
    return groups;
}

std::optional<ProgramInfo> PcgFile::decodeProgram(int bank, int number) const {
    if (bank < 0 || bank >= static_cast<int>(programBankLocations_.size())) return std::nullopt;
    const auto& loc = programBankLocations_[bank];
    if (number < 0 || static_cast<uint32_t>(number) >= loc.numRecords) return std::nullopt;

    size_t off = loc.recordsStart + static_cast<size_t>(number) * loc.bytesPerRecord;
    if (off + loc.bytesPerRecord > data_.size()) return std::nullopt;

    const uint8_t* record = &data_[off];
    ProgramFields fields = decodeProgramFields(record, loc.bytesPerRecord, bank, number);
    uint64_t hash = hashProgramRecord(record, loc.bytesPerRecord);
    return ProgramInfo{fields.bank, fields.number, fields.name, hash};
}

}  // namespace kronos
