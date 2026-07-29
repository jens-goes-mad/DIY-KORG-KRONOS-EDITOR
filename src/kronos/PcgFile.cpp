#include "PcgFile.h"

#include <algorithm>
#include <cstring>
#include <fstream>
#include <functional>
#include <optional>

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
// setlist_test.PCG, a file the project owner built specifically to isolate
// one parameter per group of slots -- see README.md's "SBK1" section.
constexpr size_t kSbkHeaderSize = 40;
constexpr size_t kSbkRecordSize = 542;
constexpr size_t kSbkTypeColorOffset = 12;  // bit0: 1=Program/0=Combi; bits2-7: (color-1)
constexpr size_t kSbkBankOffset = 13;
constexpr size_t kSbkNumberOffset = 14;
constexpr size_t kSbkHoldTimeOffset = 15;  // stored value = Hold Time + 1
constexpr size_t kSbkVolumeOffset = 16;
constexpr size_t kSbkCommentOffset = 18;  // one reserved/flag byte at +17 not understood yet, see README.md

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
    if (songOff + kSbkVolumeOffset + 1 > end) return params;  // leaves found=false

    uint8_t typeColor = data[songOff + kSbkTypeColorOffset];
    params.isProgram = (typeColor & 0x01) != 0;
    params.color = (typeColor >> 2) + 1;
    params.bank = data[songOff + kSbkBankOffset];
    params.number = data[songOff + kSbkNumberOffset];
    params.holdTime = static_cast<int>(data[songOff + kSbkHoldTimeOffset]) - 1;
    params.volume = data[songOff + kSbkVolumeOffset];
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

// Parses a set of same-shaped bank chunks (CBK1s under CMB1, or MBK1/PBK1s
// under PRG1) into [bank][number] -> name. Chunks not matching the expected
// header/size relationship are skipped rather than aborting the whole scan
// -- keeps this tolerant of a bank that doesn't parse rather than losing
// every other bank too.
std::vector<std::vector<std::string>> parseNamedBanks(const std::vector<uint8_t>& data,
                                                        const std::vector<ChunkInfo>& chunks) {
    std::vector<std::vector<std::string>> banks;
    for (const auto& chunk : chunks) {
        if (chunk.contentStart + 12 > chunk.contentEnd) continue;

        readU32BE(&data[chunk.contentStart]);  // meaning not understood yet, unused here
        uint32_t numRecords = readU32BE(&data[chunk.contentStart + 4]);
        uint32_t bytesPerRecord = readU32BE(&data[chunk.contentStart + 8]);
        size_t recordsStart = chunk.contentStart + 12;

        if (bytesPerRecord == 0) continue;
        if (recordsStart + static_cast<size_t>(bytesPerRecord) * numRecords > chunk.contentEnd) continue;

        std::vector<std::string> names;
        names.reserve(numRecords);
        for (uint32_t i = 0; i < numRecords; ++i) {
            size_t off = recordsStart + static_cast<size_t>(i) * bytesPerRecord;
            names.push_back(readBankRecordName(data.data(), off, data.size()));
        }
        banks.push_back(std::move(names));
    }
    return banks;
}

}  // namespace

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
    std::vector<std::vector<std::string>> combiBankNames = parseNamedBanks(data, cbkChunks);  // [bank][number]

    std::vector<ChunkInfo> programBankChunks;
    collectChunks(
        data, 16, data.size(), [](const std::string& tag) { return tag == "MBK1" || tag == "PBK1"; },
        programBankChunks, 0);
    std::vector<std::vector<std::string>> programBankNames = parseNamedBanks(data, programBankChunks);  // [bank][number]

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

    return true;
}

}  // namespace kronos
