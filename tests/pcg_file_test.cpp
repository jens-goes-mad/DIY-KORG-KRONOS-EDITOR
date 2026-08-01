// Scoped, fast C++ test target: depends only on PcgFile.cpp/ProgramDecoder.cpp
// (see CMakeLists.txt's pcg_file_test target) -- deliberately NOT main.cpp/
// EditorBridge.cpp/CHOC, so `ctest` builds and runs in seconds, no WebView
// toolchain required. Hand-rolled assertions (CHECK/CHECK_EQ below) rather
// than a pulled-in framework, matching this project's no-extra-dependencies
// convention (see CLAUDE.md).
//
// Real .PCG files are large and .gitignore'd (never committed), so this
// builds a small synthetic file in memory instead, byte-for-byte matching
// the confirmed chunk/record layout documented in docs/README.md -- enough
// to exercise PcgFile::loadFromMemory() end-to-end (SDB1 Set List names,
// SBK1 slot params incl. the Font size/Transpose bit-packing, PBK1 Program
// banks, cross-referencing, duplicate detection, and decodeProgram()'s
// on-demand re-decode) without needing a real backup on disk.

#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

#include "kronos/CombiDecoder.h"
#include "kronos/PcgFile.h"
#include "kronos/ProgramDecoder.h"

namespace {

int g_failures = 0;

void reportCheck(bool pass, const char* exprText, const char* file, int line) {
    if (pass) return;
    g_failures++;
    std::fprintf(stderr, "FAIL %s:%d: %s\n", file, line, exprText);
}

template <typename A, typename B>
void reportCheckEq(bool pass, const A& actual, const B& expected, const char* label, const char* file, int line) {
    if (pass) return;
    g_failures++;
    std::fprintf(stderr, "FAIL %s:%d: %s\n", file, line, label);
}

#define CHECK(expr) reportCheck((expr), #expr, __FILE__, __LINE__)
#define CHECK_EQ(actual, expected, label) reportCheckEq((actual) == (expected), actual, expected, label, __FILE__, __LINE__)

// --- Synthetic .PCG byte-builder helpers ------------------------------

void pushU32BE(std::vector<uint8_t>& v, uint32_t x) {
    v.push_back(static_cast<uint8_t>((x >> 24) & 0xFF));
    v.push_back(static_cast<uint8_t>((x >> 16) & 0xFF));
    v.push_back(static_cast<uint8_t>((x >> 8) & 0xFF));
    v.push_back(static_cast<uint8_t>(x & 0xFF));
}

void pushZeros(std::vector<uint8_t>& v, size_t n) { v.insert(v.end(), n, uint8_t{0}); }

// A 4-byte-prefix + 24-byte space/NUL-padded name field, the shape shared by
// Set List/Song records (SDB1) and bank records (PBK1/CBK1) -- see
// docs/README.md. `prefix` is arbitrary/unused data before the name.
void pushNameRecord(std::vector<uint8_t>& v, const std::string& name, size_t totalSize) {
    size_t start = v.size();
    pushZeros(v, totalSize);
    for (size_t i = 0; i < name.size() && i + 4 < totalSize; ++i) v[start + 4 + i] = static_cast<uint8_t>(name[i]);
}

// One CBK1 Combi record: name at offset+4 (same shape as PBK1), plus a
// couple of Timbre-to-Program references at the confirmed fixed stride
// (docs/README.md's "Combi Timbre references" section) -- byte0=number,
// byte1=rawBankCode, byte2's top 3 bits=status. Only Timbre 0 is set here;
// every other Timbre (1..15) stays all-zero, matching a genuinely
// unassigned Timbre (isDefault=true).
constexpr size_t kTimbreBaseOffset = 4806;
constexpr size_t kTimbreStride = 188;

std::vector<uint8_t> makeCbkCombiRecord(const std::string& name, size_t totalSize) {
    std::vector<uint8_t> rec(totalSize, 0);
    for (size_t i = 0; i < name.size() && 4 + i < totalSize; ++i) rec[4 + i] = static_cast<uint8_t>(name[i]);
    rec[kTimbreBaseOffset] = 5;                                   // Timbre 0 -> Program number 5
    rec[kTimbreBaseOffset + 1] = 1;                               // Timbre 0 -> raw bank code 1 (INT-B)
    rec[kTimbreBaseOffset + 2] = static_cast<uint8_t>(1 << 5);     // status Internal
    return rec;
}

void appendChunk(std::vector<uint8_t>& out, const char* tag, const std::vector<uint8_t>& content) {
    out.insert(out.end(), tag, tag + 4);
    pushU32BE(out, static_cast<uint32_t>(content.size()));
    out.insert(out.end(), content.begin(), content.end());
}

// One 542-byte SBK1 song record with the given Program bank/number and
// Comment, plus Font size/Transpose encoded via the confirmed bit-packing
// (docs/README.md §4.4): Font size's low 2 bits and Type+Color share byte
// +12, Font size's high bit and Transpose's low 3 bits share byte +17,
// Transpose's high 3 bits share byte +13 with Bank. `colorField1based`,
// `garbageBit1`, and `garbageLow4` deliberately poke bits Font size/
// Transpose/Bank/Color do NOT own, to prove decoding only reads the bits it
// actually owns (mirrors setlist-comment.test.js's bit-preservation check,
// but for the C++ decoder instead of the JS encoder).
std::vector<uint8_t> makeSbkSongRecord(bool isProgram, int bank, int number, int colorField1based, int holdTime,
                                        int volume, int fontSizeValue, int transpose, bool garbageBit1,
                                        int garbageLow4, const std::string& comment) {
    std::vector<uint8_t> rec(542, 0);

    int unsigned6 = transpose >= 0 ? transpose : transpose + 64;
    int bankHigh3 = (unsigned6 >> 3) & 0x07;
    int fontLow3 = unsigned6 & 0x07;

    uint8_t typeColor = 0;
    typeColor |= isProgram ? 0x01 : 0x00;
    typeColor |= garbageBit1 ? 0x02 : 0x00;
    typeColor |= static_cast<uint8_t>(((colorField1based - 1) & 0x0F) << 2);
    typeColor |= static_cast<uint8_t>((fontSizeValue & 0x02) ? 0x80 : 0x00);
    typeColor |= static_cast<uint8_t>((fontSizeValue & 0x01) ? 0x40 : 0x00);

    uint8_t bankByte = static_cast<uint8_t>((bank & 0x1F) | (bankHigh3 << 5));
    uint8_t fontTransposeByte =
        static_cast<uint8_t>((garbageLow4 & 0x0F) | ((fontSizeValue & 0x04) ? 0x10 : 0x00) | (fontLow3 << 5));

    rec[12] = typeColor;
    rec[13] = bankByte;
    rec[14] = static_cast<uint8_t>(number);
    rec[15] = static_cast<uint8_t>(holdTime + 1);
    rec[16] = static_cast<uint8_t>(volume);
    rec[17] = fontTransposeByte;

    for (size_t i = 0; i < comment.size() && 18 + i < rec.size() - 1; ++i) {
        rec[18 + i] = static_cast<uint8_t>(comment[i]);
    }
    return rec;
}

// Builds a whole synthetic KORG file: one Set List (SDB1), its slot params
// (SBK1), and two PBK1 Program banks -- bank 0 has an intentional byte-exact
// duplicate pair (records 0 and 1), bank 1 has two distinct records, one of
// which (bank 1, number 0) is what both crafted song slots reference, so
// programSetlistUsages() has something real to count.
std::vector<uint8_t> buildSyntheticPcgFile() {
    constexpr uint32_t kSongsPerSetlist = 128;
    constexpr size_t kRecordSize = 28;      // SDB1 name-record stride
    constexpr size_t kSbkHeaderSize = 40;
    constexpr size_t kSbkRecordSize = 542;
    constexpr size_t kBankRecordSize = 32;  // PBK1 record stride for this test (real files use ~4960)

    // SDB1: one Set List, "Test Setlist", with song 0/1 named.
    std::vector<uint8_t> sdb1;
    pushU32BE(sdb1, 1);                                     // "used" count, unused
    pushU32BE(sdb1, 1);                                     // numSetlists
    pushU32BE(sdb1, (kSongsPerSetlist + 1) * kRecordSize);  // bytesPerSetlist
    pushNameRecord(sdb1, "Test Setlist", kRecordSize);
    pushNameRecord(sdb1, "Song Zero", kRecordSize);
    pushNameRecord(sdb1, "Song One", kRecordSize);
    for (uint32_t k = 2; k < kSongsPerSetlist; ++k) pushZeros(sdb1, kRecordSize);

    // SBK1: same one Set List's slot params. Song 0 -> Program bank1/number0,
    // Font size L (3), transpose -5. Song 1 -> same Program (bank1/number0,
    // to exercise a 2-usage count), Font size XS (1), transpose +20.
    std::vector<uint8_t> sbk1;
    pushU32BE(sbk1, 1);
    pushU32BE(sbk1, 1);
    pushU32BE(sbk1, static_cast<uint32_t>(kSbkHeaderSize + kSongsPerSetlist * kSbkRecordSize));
    pushZeros(sbk1, kSbkHeaderSize);
    auto song0 = makeSbkSongRecord(/*isProgram=*/true, /*bank=*/1, /*number=*/0, /*color=*/1, /*holdTime=*/4,
                                    /*volume=*/100, /*fontSizeValue=*/3, /*transpose=*/-5, /*garbageBit1=*/true,
                                    /*garbageLow4=*/0x0B, "Hello test");
    auto song1 = makeSbkSongRecord(/*isProgram=*/true, /*bank=*/1, /*number=*/0, /*color=*/5, /*holdTime=*/9,
                                    /*volume=*/80, /*fontSizeValue=*/1, /*transpose=*/20, /*garbageBit1=*/true,
                                    /*garbageLow4=*/0x05, "second");
    sbk1.insert(sbk1.end(), song0.begin(), song0.end());
    sbk1.insert(sbk1.end(), song1.begin(), song1.end());
    for (uint32_t k = 2; k < kSongsPerSetlist; ++k) pushZeros(sbk1, kSbkRecordSize);

    // PBK1 bank 0: records 0 and 1 byte-identical (a duplicate pair), record
    // 2 unique -- exercises findDuplicatePrograms().
    std::vector<uint8_t> pbk1BankA;
    pushU32BE(pbk1BankA, 0);
    pushU32BE(pbk1BankA, 3);
    pushU32BE(pbk1BankA, static_cast<uint32_t>(kBankRecordSize));
    pushNameRecord(pbk1BankA, "Test Program A", kBankRecordSize);
    pushNameRecord(pbk1BankA, "Test Program A", kBankRecordSize);  // byte-exact duplicate of the record above
    pushNameRecord(pbk1BankA, "Unique Program", kBankRecordSize);

    // PBK1 bank 1: two distinct records -- number 0 is what both song slots
    // above reference.
    std::vector<uint8_t> pbk1BankB;
    pushU32BE(pbk1BankB, 0);
    pushU32BE(pbk1BankB, 2);
    pushU32BE(pbk1BankB, static_cast<uint32_t>(kBankRecordSize));
    pushNameRecord(pbk1BankB, "Bank1 Program0", kBankRecordSize);
    pushNameRecord(pbk1BankB, "Bank1 Program1", kBankRecordSize);

    // CBK1 bank 0: one Combi record with a real Timbre 0 (Program bank1/
    // number5, status Internal) and 15 default/unassigned Timbres.
    const size_t kCombiRecordSize = kTimbreBaseOffset + kTimbreStride * 16;
    std::vector<uint8_t> cbk1BankA;
    pushU32BE(cbk1BankA, 0);
    pushU32BE(cbk1BankA, 1);  // numRecords
    pushU32BE(cbk1BankA, static_cast<uint32_t>(kCombiRecordSize));
    auto combi0 = makeCbkCombiRecord("Test Combi", kCombiRecordSize);
    cbk1BankA.insert(cbk1BankA.end(), combi0.begin(), combi0.end());

    std::vector<uint8_t> data;
    data.insert(data.end(), {'K', 'O', 'R', 'G'});
    pushZeros(data, 12);  // pad to the 16-byte offset every chunk walk starts from
    appendChunk(data, "SDB1", sdb1);
    appendChunk(data, "SBK1", sbk1);
    appendChunk(data, "PBK1", pbk1BankA);
    appendChunk(data, "PBK1", pbk1BankB);
    appendChunk(data, "CBK1", cbk1BankA);
    return data;
}

void testDecodeProgramFields() {
    std::vector<uint8_t> record(32, 0);
    const std::string name = "Padded Name";
    for (size_t i = 0; i < name.size(); ++i) record[4 + i] = static_cast<uint8_t>(name[i]);
    // bytes 4+name.size() .. 27 stay 0 (NUL padding) -- decodeProgramFields
    // must trim that padding, not include it in the returned name.

    kronos::ProgramFields fields = kronos::decodeProgramFields(record.data(), record.size(), 3, 7);
    CHECK_EQ(fields.bank, 3, "decodeProgramFields keeps the caller-supplied bank");
    CHECK_EQ(fields.number, 7, "decodeProgramFields keeps the caller-supplied number");
    CHECK_EQ(fields.name, name, "decodeProgramFields trims trailing NUL padding from the name");

    // Truncated record (shorter than the name field needs) degrades to an
    // empty name rather than reading out of bounds.
    std::vector<uint8_t> tooShort(10, 0);
    kronos::ProgramFields shortFields = kronos::decodeProgramFields(tooShort.data(), tooShort.size(), 0, 0);
    CHECK_EQ(shortFields.name, std::string(), "decodeProgramFields on a truncated record yields an empty name");
}

void testDecodeCombiFields() {
    std::vector<uint8_t> record(kTimbreBaseOffset + kTimbreStride * 16, 0);
    const std::string name = "Combi Name";
    for (size_t i = 0; i < name.size(); ++i) record[4 + i] = static_cast<uint8_t>(name[i]);
    record[kTimbreBaseOffset] = 42;                             // Timbre 0 -> Program number 42
    record[kTimbreBaseOffset + 1] = 3;                          // Timbre 0 -> raw bank code 3
    record[kTimbreBaseOffset + 2] = static_cast<uint8_t>(3 << 5);  // status External

    kronos::CombiFields fields = kronos::decodeCombiFields(record.data(), record.size(), 2, 9);
    CHECK_EQ(fields.bank, 2, "decodeCombiFields keeps the caller-supplied bank");
    CHECK_EQ(fields.number, 9, "decodeCombiFields keeps the caller-supplied number");
    CHECK_EQ(fields.name, name, "decodeCombiFields trims trailing NUL padding from the name");
    CHECK_EQ(fields.timbres.size(), static_cast<size_t>(16), "always 16 Timbre entries");
    CHECK_EQ(fields.timbres[0].number, 42, "Timbre 0 number");
    CHECK_EQ(fields.timbres[0].rawBankCode, 3, "Timbre 0 rawBankCode");
    CHECK(fields.timbres[0].status == kronos::TimbreStatus::External);
    CHECK(!fields.timbres[0].isDefault);
    CHECK(fields.timbres[1].isDefault);  // untouched -- genuinely unassigned

    // Truncated record: shorter than even the Timbre area needs -- every
    // Timbre degrades to a default (isDefault=true) rather than reading OOB.
    std::vector<uint8_t> tooShort(100, 0);
    kronos::CombiFields shortFields = kronos::decodeCombiFields(tooShort.data(), tooShort.size(), 0, 0);
    CHECK_EQ(shortFields.name, std::string(), "decodeCombiFields on a truncated record yields an empty name");
    CHECK(shortFields.timbres[0].isDefault);
}

void testHashProgramRecord() {
    std::vector<uint8_t> a = {1, 2, 3, 4, 5};
    std::vector<uint8_t> aCopy = a;
    std::vector<uint8_t> b = {1, 2, 3, 4, 6};

    CHECK_EQ(kronos::hashProgramRecord(a.data(), a.size()), kronos::hashProgramRecord(aCopy.data(), aCopy.size()),
             "hashProgramRecord is deterministic for identical bytes");
    CHECK(kronos::hashProgramRecord(a.data(), a.size()) != kronos::hashProgramRecord(b.data(), b.size()));
}

void testPcgFileEndToEnd() {
    kronos::PcgFile pcg;
    std::string error;
    std::vector<uint8_t> data = buildSyntheticPcgFile();
    bool loaded = pcg.loadFromMemory(std::move(data), error);
    CHECK(loaded);
    if (!loaded) {
        std::fprintf(stderr, "  loadFromMemory error: %s\n", error.c_str());
        return;
    }

    CHECK_EQ(pcg.setlists().size(), static_cast<size_t>(1), "one synthetic Set List loaded");
    const auto& setlist = pcg.setlists()[0];
    CHECK_EQ(setlist.name, std::string("Test Setlist"), "Set List name read from SDB1");
    CHECK_EQ(setlist.songs.size(), static_cast<size_t>(128), "every Set List has 128 song slots");
    CHECK_EQ(setlist.songs[0].name, std::string("Song Zero"), "song 0 name read from SDB1");

    // Song 0: Font size L, transpose -5, despite garbage bits in bytes+12/17
    // that Font size/Transpose/Color/Bank don't own (proves readSlotParams()
    // masks instead of reading raw bytes).
    const auto& p0 = setlist.songs[0].params;
    CHECK(p0.found);
    CHECK(p0.isProgram);
    CHECK_EQ(p0.bank, 1, "song 0 Program bank");
    CHECK_EQ(p0.number, 0, "song 0 Program number");
    CHECK_EQ(p0.color, 1, "song 0 color unaffected by garbage bit1");
    CHECK_EQ(p0.holdTime, 4, "song 0 Hold Time (stored value - 1)");
    CHECK_EQ(p0.volume, 100, "song 0 Volume");
    CHECK(p0.fontSize == kronos::FontSize::L);
    CHECK_EQ(p0.transpose, -5, "song 0 Transpose (signed, despite garbage low bits in byte+17)");
    CHECK_EQ(setlist.songs[0].comment, std::string("Hello test"), "song 0 Comment");
    CHECK_EQ(setlist.songs[0].instrumentName, std::string("Bank1 Program0"),
             "song 0 cross-referenced to its Program's real name");

    // Song 1: same Program, different Font size/Transpose/garbage bits.
    const auto& p1 = setlist.songs[1].params;
    CHECK(p1.fontSize == kronos::FontSize::XS);
    CHECK_EQ(p1.transpose, 20, "song 1 Transpose");
    CHECK_EQ(p1.color, 5, "song 1 color");
    CHECK_EQ(setlist.songs[1].comment, std::string("second"), "song 1 Comment");
    CHECK_EQ(setlist.songs[1].instrumentName, std::string("Bank1 Program0"), "song 1 resolves to the same Program");

    // Programs table: 3 (bank 0) + 2 (bank 1) = 5 rows.
    CHECK_EQ(pcg.programs().size(), static_cast<size_t>(5), "programs() has one row per PBK1 record");

    // Duplicate detection: exactly one group, bank0/number0 + bank0/number1.
    auto dupGroups = pcg.findDuplicatePrograms();
    CHECK_EQ(dupGroups.size(), static_cast<size_t>(1), "exactly one duplicate group found");
    if (dupGroups.size() == 1) {
        CHECK_EQ(dupGroups[0].size(), static_cast<size_t>(2), "the duplicate group has 2 byte-exact members");
        CHECK_EQ(dupGroups[0][0].bank, 0, "duplicate group member 0 bank");
        CHECK_EQ(dupGroups[0][0].number, 0, "duplicate group member 0 number");
        CHECK_EQ(dupGroups[0][1].bank, 0, "duplicate group member 1 bank");
        CHECK_EQ(dupGroups[0][1].number, 1, "duplicate group member 1 number");
    }

    // Set-List usage: both song 0 and song 1 reference bank1/number0.
    auto usages = pcg.programSetlistUsages(1, 0);
    CHECK_EQ(usages.size(), static_cast<size_t>(2), "bank1/number0 is used by exactly 2 Set List slots");

    // decodeProgram() re-decodes straight from the retained raw bytes,
    // independently of the programs_ table built once at load time.
    auto redecoded = pcg.decodeProgram(1, 0);
    CHECK(redecoded.has_value());
    if (redecoded) {
        CHECK_EQ(redecoded->name, std::string("Bank1 Program0"), "decodeProgram() re-decodes the right record");
        CHECK_EQ(redecoded->contentHash, pcg.programs()[3].contentHash,
                 "decodeProgram()'s hash matches the same record's cached table entry");
    }
    CHECK(!pcg.decodeProgram(99, 0).has_value());  // out-of-range bank
    CHECK(!pcg.decodeProgram(1, 99).has_value());  // out-of-range number

    // Combis: one synthetic CBK1 record with a real Timbre 0 and 15
    // default/unassigned Timbres.
    CHECK_EQ(pcg.combis().size(), static_cast<size_t>(1), "combis() has one row for the synthetic CBK1 record");
    const auto& combi0 = pcg.combis()[0];
    CHECK_EQ(combi0.bank, 0, "Combi bank");
    CHECK_EQ(combi0.number, 0, "Combi number");
    CHECK_EQ(combi0.name, std::string("Test Combi"), "Combi name decoded");
    CHECK_EQ(combi0.timbres.size(), static_cast<size_t>(16), "Combi always has 16 Timbre entries");
    CHECK_EQ(combi0.timbres[0].number, 5, "Combi Timbre 0 number");
    CHECK_EQ(combi0.timbres[0].rawBankCode, 1, "Combi Timbre 0 rawBankCode");
    CHECK(combi0.timbres[0].status == kronos::TimbreStatus::Internal);
    CHECK(!combi0.timbres[0].isDefault);
    CHECK(combi0.timbres[1].isDefault);  // untouched -- genuinely unassigned

    auto redecodedCombi = pcg.decodeCombi(0, 0);
    CHECK(redecodedCombi.has_value());
    if (redecodedCombi) {
        CHECK_EQ(redecodedCombi->name, std::string("Test Combi"), "decodeCombi() re-decodes the right record");
        CHECK_EQ(redecodedCombi->timbres[0].number, 5, "decodeCombi()'s Timbre 0 matches combis()'s cached entry");
    }
    CHECK(!pcg.decodeCombi(99, 0).has_value());  // out-of-range bank
    CHECK(!pcg.decodeCombi(0, 99).has_value());  // out-of-range number
}

}  // namespace

int main() {
    testDecodeProgramFields();
    testDecodeCombiFields();
    testHashProgramRecord();
    testPcgFileEndToEnd();

    if (g_failures > 0) {
        std::fprintf(stderr, "\n%d check(s) FAILED\n", g_failures);
        return 1;
    }
    std::printf("All checks passed\n");
    return 0;
}
