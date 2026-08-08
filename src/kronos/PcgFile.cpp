#include "PcgFile.h"

#include <algorithm>
#include <cstring>
#include <fstream>
#include <functional>
#include <optional>
#include <unordered_map>

#include "CombiDecoder.h"
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

// Every chunk in this format has a fixed 12-byte header: a 4-char tag, a
// u32be content size, and a 4-byte field of still-unknown purpose ("dwX")
// -- CONFIRMED via docs/external/Synthify-Kronos-PCG-File-Structures.xlsx,
// which independently documents this exact structure ("TAG1, size, dwX,
// Data"). This corrects this project's own earlier model (an AMBIGUOUS
// 4-byte field sometimes preceding the tag, tried at two candidate
// positions) -- the unknown field is not a prefix before the tag at all,
// it's the third word of a fixed header, right after size and right
// before content. See docs/README.md §1 for the full story of how this
// was found (cross-referencing two independent official/community
// documents against this project's own byte-level findings) and its
// real-world consequence: every top-level chunk's `contentStart` was
// previously computed 4 bytes too early (`p+8`, tag+size only, missing
// dwX), which drifted the whole-file top-level walk (topLevelChunkTags())
// out of sync after the first chunk or two -- see the Internals pane's
// Format Blind Spot notes in STATE.md.
std::optional<ChunkInfo> readChunk(const std::vector<uint8_t>& data, size_t pos, size_t end) {
    if (pos + 12 > end) return std::nullopt;
    if (!looksLikeTag(&data[pos])) return std::nullopt;

    uint32_t size = readU32BE(&data[pos + 4]);
    size_t contentStart = pos + 12;
    size_t contentEnd = contentStart + size;
    if (contentEnd < contentStart || contentEnd > end) return std::nullopt;

    ChunkInfo info;
    info.contentStart = contentStart;
    info.contentEnd = contentEnd;
    info.tag.assign(reinterpret_cast<const char*>(&data[pos]), 4);
    return info;
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
    while (pos + 12 <= end) {
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
constexpr size_t kSbkTypeColorOffset = 12;  // bits0-1: Type (0=Combi/1=Program/2=Song); bits2-5: (color-1); bits6-7: Font size low 2 bits
constexpr uint8_t kSbkTypeMask = 0x03;           // bits 0-1 -- Performance Type, confirmed 2 bits wide via
                                                  // docs/external/KORG/SetList.txt (2026-08-08), not the single
                                                  // bit this project originally assumed -- see docs/README.md
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
// 512 bytes, confirmed via docs/external/KORG/SetList.txt (2026-08-08) --
// NOT kSbkRecordSize-18(=524), this project's original assumption before
// that source was available. The remaining 12 bytes at the very end of
// each 542-byte song record (530..541) are not comment space -- same
// width as the 12 unexplained bytes at the record's own start (+0..+11),
// a symmetric shape this project doesn't have an explanation for yet.
// Getting this wrong isn't just a decode inaccuracy: the encoder
// (frontend/components/kronos/setlist-comment.js) writes into this same
// span, so a too-generous bound here risked a long comment overwriting
// whatever those trailing 12 bytes actually are.
constexpr size_t kSbkCommentMaxLength = 512;

// The Comment field can contain embedded \r\n line breaks, so unlike
// readRecordName() this only stops at a genuine NUL byte, not otherwise.
// Scans up to kSbkCommentMaxLength bytes, the largest this field could
// possibly be.
std::string readComment(const uint8_t* data, size_t songOff, size_t end) {
    size_t start = songOff + kSbkCommentOffset;
    size_t recordEnd = songOff + kSbkCommentOffset + kSbkCommentMaxLength;
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

    // Was `(typeColor & 0x01) != 0` -- only bit 0. Confirmed 2 bits wide
    // (0=Combi/1=Program/2=Song) via docs/external/KORG/SetList.txt
    // (2026-08-08) -- isProgram still only distinguishes "is this a
    // Program slot" (true for exactly type==1), so a Song slot (type==2)
    // isn't separately represented here yet (nothing else in this app
    // handles a third slot type), but the read is now correct rather than
    // accidentally-right: the old bit-0-only check would have also
    // treated the unused/invalid value 3 as a Program.
    params.isProgram = (typeColor & kSbkTypeMask) == 1;
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

}  // namespace

// Confirmed via real Combi samples the project owner provided directly,
// cross-checked against an independent external reference (DaBlick/
// PCG-Tools' "PCG Structure Kronos.txt", see docs/references/) -- both
// sources agree at every point they overlap (INT-A/B/C, and USER-F's code
// independently explaining a byte this project had first read from its own
// sample but the project owner had misremembered the Program number for).
// See docs/README.md's "Combi Timbre references" section for the full
// derivation. Every entry below is a directly-verified byte value, from one
// source or the other -- not an extrapolation. That said, the two anchors
// on each side (INT-A..D=0..3, USER-A=17/USER-D=20/USER-F=22/USER-AA=24)
// strongly imply a contiguous INT-A..G=0..6 / USER-A..G=17..23 scheme;
// deliberately not added below until each individual code is confirmed the
// same way as these.
//
// `programBankIndex` is this project's own PBK1 file-order Program bank
// index (ProgramInfo::bank, see docs/README.md §5.2); `rawBankCode` is the
// completely separate number a Combi Timbre slot's own byte actually
// stores (TimbreRef::rawBankCode). The two coincide for INT-A..D (both use
// 0..3) but diverge for every other confirmed bank (e.g. USER-D is
// file-order index 11 but Timbre code 20) -- one shared table so
// timbreBankName()/isConfirmedTimbreProgramBank() and the two Combi-usage
// functions below can't drift out of sync with each other as more codes
// get confirmed later.
struct ConfirmedTimbreBank {
    int programBankIndex;
    int rawBankCode;
    const char* name;
};
constexpr ConfirmedTimbreBank kConfirmedTimbreBanks[] = {
    {0, 0, "INT-A"},    {1, 1, "INT-B"},    {2, 2, "INT-C"},    {3, 3, "INT-D"},
    {8, 17, "USER-A"},  {11, 20, "USER-D"}, {13, 22, "USER-F"}, {14, 24, "USER-AA"},
};

std::string timbreBankName(int rawBankCode) {
    for (const auto& b : kConfirmedTimbreBanks) {
        if (b.rawBankCode == rawBankCode) return b.name;
    }
    // Unconfirmed code -- the UI shows the raw numeric code instead of a
    // guessed name (see the doc comment above for why the implied
    // contiguous pattern isn't used here).
    return "";
}

bool isConfirmedTimbreProgramBank(int programBank) {
    for (const auto& b : kConfirmedTimbreBanks) {
        if (b.programBankIndex == programBank) return true;
    }
    return false;
}

// Internal linkage -- pure implementation detail of combiUsagesForProgram()/
// combiUsageCounts() below, not declared in PcgFile.h since nothing outside
// this file needs the raw-code translation itself, only its effect.
//
// The confirmed Timbre raw bank code for a PBK1 file-order Program bank
// index, or -1 if that bank isn't independently confirmed yet -- see
// kConfirmedTimbreBanks above.
static int confirmedTimbreCodeForProgramBank(int programBank) {
    for (const auto& b : kConfirmedTimbreBanks) {
        if (b.programBankIndex == programBank) return b.rawBankCode;
    }
    return -1;
}

// Reverse of the above -- the confirmed PBK1 file-order Program bank index
// for a Timbre's raw bank code, or -1 if that code isn't confirmed yet.
static int programBankForConfirmedTimbreCode(int rawBankCode) {
    for (const auto& b : kConfirmedTimbreBanks) {
        if (b.rawBankCode == rawBankCode) return b.programBankIndex;
    }
    return -1;
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

bool PcgFile::save(const std::string& path, std::string& error) const {
    if (data_.empty()) {
        error = "No file loaded";
        return false;
    }

    std::ofstream file(path, std::ios::binary);
    if (!file) {
        error = "Could not open file for writing: " + path;
        return false;
    }

    file.write(reinterpret_cast<const char*>(data_.data()), static_cast<std::streamsize>(data_.size()));
    if (!file) {
        error = "Failed writing to file: " + path;
        return false;
    }

    return true;
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
        if (sdb.contentStart + 8 > sdb.contentEnd) continue;

        uint32_t numSetlists = readU32BE(&data[sdb.contentStart]);
        uint32_t bytesPerSetlist = readU32BE(&data[sdb.contentStart + 4]);
        size_t setlistsStart = sdb.contentStart + 8;

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

    sbkSongsStart_.assign(setlists_.size(), static_cast<size_t>(-1));

    for (const auto& sbk : sbkChunks) {
        if (sbk.contentStart + 8 > sbk.contentEnd) continue;

        uint32_t numSetlists = readU32BE(&data[sbk.contentStart]);
        uint32_t bytesPerSetlist = readU32BE(&data[sbk.contentStart + 4]);
        size_t setlistsStart = sbk.contentStart + 8;

        constexpr uint32_t kSongsPerSetlist = 128;
        if (bytesPerSetlist != kSbkHeaderSize + kSongsPerSetlist * kSbkRecordSize) continue;
        if (setlistsStart + static_cast<size_t>(bytesPerSetlist) * numSetlists > data.size()) continue;

        for (uint32_t s = 0; s < numSetlists && s < setlists_.size(); ++s) {
            size_t setlistOff = setlistsStart + static_cast<size_t>(s) * bytesPerSetlist;
            size_t songsStart = setlistOff + kSbkHeaderSize;

            sbkSongsStart_[s] = songsStart;

            auto& songs = setlists_[s].songs;
            for (uint32_t k = 0; k < kSongsPerSetlist && k < songs.size(); ++k) {
                size_t songOff = songsStart + static_cast<size_t>(k) * kSbkRecordSize;
                songs[k].params = readSlotParams(data.data(), songOff, data.size());
                songs[k].comment = readComment(data.data(), songOff, data.size());
            }
        }
    }

    // CBK1 (Combi banks, nested CMB1 > CBK1) -- cross-referenced by each
    // slot's bank/number to show the instrument's real name. Confirmed
    // against known real names the project owner pointed out directly
    // (e.g. "Dont stop believin" as a Combi record matching its Set List
    // slot exactly). Optional, same as SBK1: missing/malformed just leaves
    // instrumentName empty rather than failing the whole load.
    //
    // Decoded via a standalone per-record decoder
    // (src/kronos/CombiDecoder.h), same pattern as Programs below --
    // combiBankLocations_ records each bank's location so decodeCombi()
    // can re-decode any single Combi on demand later, straight from the
    // retained raw bytes (data_, set at the end of this function).
    std::vector<ChunkInfo> cbkChunks;
    collectChunks(data, 16, data.size(), "CBK1", cbkChunks, 0);

    combis_.clear();
    combiBankLocations_.clear();
    std::vector<std::vector<std::string>> combiBankNames;  // [bank][number]

    for (size_t bankIdx = 0; bankIdx < cbkChunks.size(); ++bankIdx) {
        const auto& chunk = cbkChunks[bankIdx];
        if (chunk.contentStart + 8 > chunk.contentEnd) continue;

        uint32_t numRecords = readU32BE(&data[chunk.contentStart]);
        uint32_t bytesPerRecord = readU32BE(&data[chunk.contentStart + 4]);
        size_t recordsStart = chunk.contentStart + 8;

        if (bytesPerRecord == 0) continue;
        if (recordsStart + static_cast<size_t>(bytesPerRecord) * numRecords > chunk.contentEnd) continue;

        combiBankLocations_.push_back({recordsStart, numRecords, bytesPerRecord});

        for (uint32_t i = 0; i < numRecords; ++i) {
            size_t off = recordsStart + static_cast<size_t>(i) * bytesPerRecord;
            const uint8_t* record = &data[off];
            CombiFields fields = decodeCombiFields(record, bytesPerRecord, static_cast<int>(bankIdx), static_cast<int>(i));
            combis_.push_back({fields.bank, fields.number, fields.name, fields.timbres});

            if (fields.bank >= static_cast<int>(combiBankNames.size())) combiBankNames.resize(fields.bank + 1);
            if (fields.number >= static_cast<int>(combiBankNames[fields.bank].size())) {
                combiBankNames[fields.bank].resize(fields.number + 1);
            }
            combiBankNames[fields.bank][fields.number] = fields.name;
        }
    }

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
        if (chunk.contentStart + 8 > chunk.contentEnd) continue;

        uint32_t numRecords = readU32BE(&data[chunk.contentStart]);
        uint32_t bytesPerRecord = readU32BE(&data[chunk.contentStart + 4]);
        size_t recordsStart = chunk.contentStart + 8;

        if (bytesPerRecord == 0) continue;
        if (recordsStart + static_cast<size_t>(bytesPerRecord) * numRecords > chunk.contentEnd) continue;

        // See ProgramBankType's doc comment in PcgFile.h -- bank type is
        // read per-file from data already parsed here (the chunk's own tag,
        // cross-checked against its declared stride), not looked up in a
        // fixed table.
        ProgramBankType bankType = classifyProgramBankType(chunk.tag, bytesPerRecord).type;
        programBankLocations_.push_back({recordsStart, numRecords, bytesPerRecord, bankType});

        for (uint32_t i = 0; i < numRecords; ++i) {
            size_t off = recordsStart + static_cast<size_t>(i) * bytesPerRecord;
            const uint8_t* record = &data[off];
            ProgramFields fields = decodeProgramFields(record, bytesPerRecord, static_cast<int>(bankIdx), static_cast<int>(i));
            uint64_t hash = hashProgramRecord(record, bytesPerRecord);
            programs_.push_back({fields.bank, fields.number, fields.name, hash, bankType});

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
    // `bank` is a PBK1 file-order index; a Timbre's own rawBankCode uses a
    // different number space that only coincides with it for INT-A..D --
    // translate before comparing, see kConfirmedTimbreBanks's doc comment.
    const int rawCode = confirmedTimbreCodeForProgramBank(bank);
    if (rawCode < 0) return usages;

    for (const auto& combi : combis_) {
        bool referenced = false;
        bool active = false;
        for (const auto& t : combi.timbres) {
            if (t.isDefault || t.rawBankCode != rawCode || t.number != number) continue;
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
            if (t.isDefault) continue;
            // Reverse direction from combiUsagesForProgram() above -- t.rawBankCode
            // is the Timbre's own number space, translate to this project's
            // PBK1 file-order index before indexing `counts` by it (callers,
            // e.g. EditorBridge::listPrograms(), index this table by
            // ProgramInfo::bank, a file-order index).
            const int bank = programBankForConfirmedTimbreCode(t.rawBankCode);
            if (bank < 0) continue;
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

std::vector<PcgFile::ProgramBankTypeEntry> PcgFile::programBankTypes() const {
    std::vector<ProgramBankTypeEntry> result;
    result.reserve(programBankLocations_.size());
    for (size_t bank = 0; bank < programBankLocations_.size(); ++bank) {
        result.push_back({static_cast<int>(bank), programBankLocations_[bank].bankType});
    }
    return result;
}

std::optional<ProgramBankType> PcgFile::programBankTypeAt(int bank) const {
    if (bank < 0 || bank >= static_cast<int>(programBankLocations_.size())) return std::nullopt;
    return programBankLocations_[static_cast<size_t>(bank)].bankType;
}

std::vector<std::string> PcgFile::topLevelChunkTags() const {
    std::vector<std::string> tags;
    if (data_.size() < 16) return tags;

    // Byte 16 is PCG1 itself (the whole-file root container, confirmed via
    // a real file: its own declared size exactly spans the rest of the
    // file), not its children -- DIV1/SLS1/PRG1/CMB1/etc. are one level
    // further in, at PCG1's own contentStart. "Top-level" here means
    // PCG1's direct children, which is what every other top-level tag in
    // this format (and the Internals pane) actually means.
    auto pcg1 = readChunk(data_, 16, data_.size());
    if (!pcg1) return tags;

    size_t pos = pcg1->contentStart;
    while (pos + 12 <= pcg1->contentEnd) {
        auto chunk = readChunk(data_, pos, pcg1->contentEnd);
        if (!chunk) break;
        tags.push_back(chunk->tag);
        pos = chunk->contentEnd + (chunk->contentEnd % 2);
    }
    return tags;
}

std::vector<PcgFile::ProgramBankInfo> PcgFile::programBankInfo() const {
    std::vector<ProgramBankInfo> result;
    result.reserve(programBankLocations_.size());
    for (size_t i = 0; i < programBankLocations_.size(); ++i) {
        const auto& loc = programBankLocations_[i];
        result.push_back({static_cast<int>(i), loc.bankType, static_cast<int>(loc.numRecords),
                           static_cast<int>(loc.bytesPerRecord)});
    }
    return result;
}

std::vector<PcgFile::CombiBankInfo> PcgFile::combiBankInfo() const {
    std::vector<CombiBankInfo> result;
    result.reserve(combiBankLocations_.size());
    for (size_t i = 0; i < combiBankLocations_.size(); ++i) {
        const auto& loc = combiBankLocations_[i];
        result.push_back({static_cast<int>(i), static_cast<int>(loc.numRecords), static_cast<int>(loc.bytesPerRecord)});
    }
    return result;
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
    return ProgramInfo{fields.bank, fields.number, fields.name, hash, loc.bankType};
}

std::optional<PcgFile::ProgramCopyError> PcgFile::copyProgramFrom(const PcgFile& src, int srcBank, int srcNumber,
                                                                    int dstBank, int dstNumber) {
    // Bounds -- same pattern as decodeProgram()/decodeProgram(), just against
    // two different files' own bank tables.
    if (srcBank < 0 || srcBank >= static_cast<int>(src.programBankLocations_.size())) return ProgramCopyError::OutOfRange;
    const auto& srcLoc = src.programBankLocations_[static_cast<size_t>(srcBank)];
    if (srcNumber < 0 || static_cast<uint32_t>(srcNumber) >= srcLoc.numRecords) return ProgramCopyError::OutOfRange;

    if (dstBank < 0 || dstBank >= static_cast<int>(programBankLocations_.size())) return ProgramCopyError::OutOfRange;
    const auto& dstLoc = programBankLocations_[static_cast<size_t>(dstBank)];
    if (dstNumber < 0 || static_cast<uint32_t>(dstNumber) >= dstLoc.numRecords) return ProgramCopyError::OutOfRange;

    if (srcLoc.bankType != dstLoc.bankType) return ProgramCopyError::BankTypeMismatch;
    if (srcLoc.bytesPerRecord != dstLoc.bytesPerRecord) return ProgramCopyError::RecordSizeMismatch;

    const size_t srcOff = srcLoc.recordsStart + static_cast<size_t>(srcNumber) * srcLoc.bytesPerRecord;
    const size_t dstOff = dstLoc.recordsStart + static_cast<size_t>(dstNumber) * dstLoc.bytesPerRecord;
    if (srcOff + srcLoc.bytesPerRecord > src.data_.size()) return ProgramCopyError::OutOfRange;
    if (dstOff + dstLoc.bytesPerRecord > data_.size()) return ProgramCopyError::OutOfRange;

    // Target slot already holds a *different* Program -- reject rather than
    // silently overwrite. Re-dropping the exact same Program already sitting
    // there is caught by the DuplicateExists check below instead (it already
    // exists in this file, namely right here), not this one.
    for (const auto& p : programs_) {
        if (p.bank == dstBank && p.number == dstNumber && !p.name.empty()) return ProgramCopyError::TargetSlotOccupied;
    }

    const uint8_t* srcRecord = &src.data_[srcOff];
    const uint64_t srcHash = hashProgramRecord(srcRecord, srcLoc.bytesPerRecord);
    const bool sameFile = &src == this;
    for (const auto& p : programs_) {
        // For a same-dataset copy, the source's own slot trivially has this
        // exact hash (it's the thing being copied) -- comparing against it
        // would reject every same-dataset copy as "a duplicate of itself".
        // Skip only that one specific slot, not its whole bank.
        if (sameFile && p.bank == srcBank && p.number == srcNumber) continue;
        if (p.contentHash == srcHash) return ProgramCopyError::DuplicateExists;
    }

    std::copy(srcRecord, srcRecord + dstLoc.bytesPerRecord, data_.begin() + static_cast<long>(dstOff));

    const uint8_t* dstRecord = &data_[dstOff];
    ProgramFields fields = decodeProgramFields(dstRecord, dstLoc.bytesPerRecord, dstBank, dstNumber);
    uint64_t hash = hashProgramRecord(dstRecord, dstLoc.bytesPerRecord);
    ProgramInfo updated{fields.bank, fields.number, fields.name, hash, dstLoc.bankType};

    auto it = std::find_if(programs_.begin(), programs_.end(),
                            [&](const ProgramInfo& p) { return p.bank == dstBank && p.number == dstNumber; });
    if (it != programs_.end()) {
        *it = updated;
    } else {
        programs_.push_back(updated);
    }

    return std::nullopt;
}

std::optional<CombiInfo> PcgFile::decodeCombi(int bank, int number) const {
    if (bank < 0 || bank >= static_cast<int>(combiBankLocations_.size())) return std::nullopt;
    const auto& loc = combiBankLocations_[bank];
    if (number < 0 || static_cast<uint32_t>(number) >= loc.numRecords) return std::nullopt;

    size_t off = loc.recordsStart + static_cast<size_t>(number) * loc.bytesPerRecord;
    if (off + loc.bytesPerRecord > data_.size()) return std::nullopt;

    const uint8_t* record = &data_[off];
    CombiFields fields = decodeCombiFields(record, loc.bytesPerRecord, bank, number);
    return CombiInfo{fields.bank, fields.number, fields.name, fields.timbres};
}

std::optional<std::vector<uint8_t>> PcgFile::songRecordBytes(int setlistIndex, int songIndex) const {
    if (setlistIndex < 0 || static_cast<size_t>(setlistIndex) >= sbkSongsStart_.size()) return std::nullopt;
    if (songIndex < 0 || static_cast<size_t>(songIndex) >= setlists_[static_cast<size_t>(setlistIndex)].songs.size())
        return std::nullopt;

    size_t start = sbkSongsStart_[static_cast<size_t>(setlistIndex)];
    if (start == static_cast<size_t>(-1)) return std::nullopt;

    size_t songOff = start + static_cast<size_t>(songIndex) * kSbkRecordSize;
    if (songOff + kSbkRecordSize > data_.size()) return std::nullopt;

    return std::vector<uint8_t>(data_.begin() + static_cast<long>(songOff),
                                 data_.begin() + static_cast<long>(songOff + kSbkRecordSize));
}

bool PcgFile::putSongRecordBytes(int setlistIndex, int songIndex, const std::vector<uint8_t>& bytes) {
    if (bytes.size() != kSbkRecordSize) return false;
    if (setlistIndex < 0 || static_cast<size_t>(setlistIndex) >= sbkSongsStart_.size()) return false;
    if (songIndex < 0 || static_cast<size_t>(songIndex) >= setlists_[static_cast<size_t>(setlistIndex)].songs.size())
        return false;

    size_t start = sbkSongsStart_[static_cast<size_t>(setlistIndex)];
    if (start == static_cast<size_t>(-1)) return false;

    size_t songOff = start + static_cast<size_t>(songIndex) * kSbkRecordSize;
    if (songOff + kSbkRecordSize > data_.size()) return false;

    std::copy(bytes.begin(), bytes.end(), data_.begin() + static_cast<long>(songOff));

    Song& song = setlists_[static_cast<size_t>(setlistIndex)].songs[static_cast<size_t>(songIndex)];
    song.params = readSlotParams(data_.data(), songOff, data_.size());
    song.comment = readComment(data_.data(), songOff, data_.size());
    return true;
}

}  // namespace kronos
