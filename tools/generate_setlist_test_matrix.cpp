// Standalone hardware-validation CLI tool -- NOT part of the shipped app,
// not linked into kronos_editor. Loads a real .PCG/.SNG file, writes a
// matrix of Setlist Color/Volume/Comment/Font-size test permutations into
// Set List 0's slots 010-024 (leaving slot 000, the source entry, and
// everything else in the file untouched), and saves the result next to the
// input as "<name>-test<ext>" -- so the output can be loaded onto a real
// Kronos and checked by eye, slot by slot. See STATE.md for the full
// rationale: this is how every confirmed byte offset in this project has
// been verified -- real ground truth, not a plausible-looking guess.
//
// tools/generate_setlist_test_matrix.js is the equivalent devtools-console
// version -- same idea, driven through the real running app's bridge
// instead of this standalone binary. Use whichever is more convenient:
// this tool needs no GUI/WebView at all (just `cmake --build` and run it
// from a terminal), the JS version is better suited to interactive,
// one-off bridge testing inside the real running app.
//
// Deliberately built against ONLY PcgFile's public raw-byte API
// (songRecordBytes()/putSongRecordBytes()/save()) -- same minimal
// dependency set as tests/pcg_file_test.cpp (no main.cpp, no
// EditorBridge.cpp, no CHOC/WebView), so this builds and runs in seconds
// with no platform WebView toolchain needed.
//
// The Comment/Font-size/Volume ENCODING below mirrors -- byte for byte --
// src/kronos/PcgFile.cpp's private kSbk* constants (used by readSlotParams())
// and frontend/components/kronos/setlist-comment.js's/setlist-slot-params.js's
// JS codecs. It's necessarily a third expression of the same confirmed
// encoding: PcgFile.cpp's masks are private to that translation unit (by
// design -- nothing outside it needs Kronos byte offsets), and this tool
// has no WebView to run the JS codecs in. If the confirmed encoding for any
// of these fields ever changes, this needs to change with it.
//
// Usage: generate_setlist_test_matrix <input.pcg>
//   Writes <input-without-extension>-test<ext> next to it.

#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

#include "kronos/PcgFile.h"

namespace {

constexpr int kSetlistIndex = 0;
constexpr int kSourceSlot = 0;

// Mirrors PcgFile.cpp's kSbk* constants exactly (see file header comment).
constexpr size_t kTypeColorOffset = 12;
constexpr uint8_t kFontSizeLowMask = 0xC0;
constexpr size_t kVolumeOffset = 16;
constexpr size_t kFontTransposeOffset = 17;
constexpr uint8_t kFontSizeHighMask = 0x10;
constexpr size_t kCommentOffset = 18;
constexpr size_t kRecordSize = 542;

// Display order (ascending small-to-large) paired with each size's
// confirmed encoding value (docs/README.md §4.4 -- 0=S is the true
// baseline, not first alphabetically/by size; matches
// kronos::FontSize's own enum order exactly, S=0..XL=4).
const char* const kFontSizeNames[5] = {"XS", "S", "M", "L", "XL"};
constexpr int kFontSizeValues[5] = {1, 0, 2, 3, 4};
constexpr int kVolumes[5] = {0, 1, 10, 100, 127};

// Mirrors setlist-comment.js's encodeSetlistComment() -- masked read-
// modify-write so this never touches Color/Transpose/the still-unexplained
// bits sharing these same two bytes.
void encodeComment(std::vector<uint8_t>& bytes, const std::string& comment, int fontSizeValue) {
    const auto lowBits = static_cast<uint8_t>(((fontSizeValue & 2) ? 0x80 : 0) | ((fontSizeValue & 1) ? 0x40 : 0));
    bytes[kTypeColorOffset] = static_cast<uint8_t>((bytes[kTypeColorOffset] & ~kFontSizeLowMask) | lowBits);
    bytes[kFontTransposeOffset] = static_cast<uint8_t>((bytes[kFontTransposeOffset] & ~kFontSizeHighMask) |
                                                         ((fontSizeValue & 4) ? kFontSizeHighMask : 0));

    for (size_t i = kCommentOffset; i < kRecordSize; ++i) bytes[i] = 0;
    for (size_t i = 0; i < comment.size() && kCommentOffset + i < kRecordSize - 1; ++i) {
        bytes[kCommentOffset + i] = static_cast<uint8_t>(comment[i]);
    }
}

// Mirrors setlist-slot-params.js's encodeSlotVolume() -- a plain byte, no
// masking needed (not shared with any other field).
void encodeVolume(std::vector<uint8_t>& bytes, int volume) {
    bytes[kVolumeOffset] = static_cast<uint8_t>(volume < 0 ? 0 : (volume > 127 ? 127 : volume));
}

bool writeSlot(kronos::PcgFile& pcg, int slot, const std::vector<uint8_t>& sourceBytes, int fontSizeValue,
               int volume, const std::string& label, std::string& error) {
    std::vector<uint8_t> bytes = sourceBytes;
    encodeComment(bytes, label, fontSizeValue);
    encodeVolume(bytes, volume);
    if (!pcg.putSongRecordBytes(kSetlistIndex, slot, bytes)) {
        error = "putSongRecordBytes() failed for slot " + std::to_string(slot);
        return false;
    }
    std::printf("Slot %d: %s\n", slot, label.c_str());
    return true;
}

// "<dir>/<name>.pcg" -> "<dir>/<name>-test.pcg" -- keeps whatever extension
// the input actually has (".PCG"/".SNG" are both real dialects this format
// covers, see docs/README.md) rather than assuming ".pcg" specifically.
std::string testOutputPath(const std::string& inputPath) {
    size_t dot = inputPath.find_last_of('.');
    size_t slash = inputPath.find_last_of("/\\");
    if (dot != std::string::npos && (slash == std::string::npos || dot > slash)) {
        return inputPath.substr(0, dot) + "-test" + inputPath.substr(dot);
    }
    return inputPath + "-test";
}

}  // namespace

int main(int argc, char** argv) {
    if (argc != 2) {
        std::fprintf(stderr, "Usage: %s <input.pcg>\n", argv[0]);
        return 1;
    }

    const std::string inputPath = argv[1];
    kronos::PcgFile pcg;
    std::string error;
    if (!pcg.load(inputPath, error)) {
        std::fprintf(stderr, "Failed to load %s: %s\n", inputPath.c_str(), error.c_str());
        return 1;
    }

    if (static_cast<int>(pcg.setlists().size()) <= kSetlistIndex ||
        static_cast<int>(pcg.setlists()[kSetlistIndex].songs.size()) <= kSourceSlot) {
        std::fprintf(stderr, "Set List %d / slot %d doesn't exist in this file\n", kSetlistIndex, kSourceSlot);
        return 1;
    }

    auto sourceBytesOpt = pcg.songRecordBytes(kSetlistIndex, kSourceSlot);
    if (!sourceBytesOpt) {
        std::fprintf(stderr, "No SBK1 record at Set List %d / slot %d\n", kSetlistIndex, kSourceSlot);
        return 1;
    }
    const std::vector<uint8_t>& sourceBytes = *sourceBytesOpt;

    // The source entry's OWN current Font size/Volume -- used as the
    // "leave this field unchanged" value for groups 1/2 below.
    // kronos::FontSize's enum order matches the confirmed encoding value
    // directly (see its own doc comment in PcgFile.h), so this cast needs
    // no lookup table.
    const auto& sourceParams = pcg.setlists()[kSetlistIndex].songs[kSourceSlot].params;
    const int originalFontSizeValue = static_cast<int>(sourceParams.fontSize);
    const int originalVolume = sourceParams.volume;

    bool ok = true;

    // Group 1 (slots 10-14): Font size only, Volume left as the source's own.
    for (int i = 0; i < 5; ++i) {
        const std::string label = std::string("TEST FontSize: ") + kFontSizeNames[i];
        ok = writeSlot(pcg, 10 + i, sourceBytes, kFontSizeValues[i], originalVolume, label, error) && ok;
    }

    // Group 2 (slots 15-19): Volume only, Font size left as the source's own.
    for (int i = 0; i < 5; ++i) {
        const std::string label = "TEST Volume: " + std::to_string(kVolumes[i]);
        ok = writeSlot(pcg, 15 + i, sourceBytes, originalFontSizeValue, kVolumes[i], label, error) && ok;
    }

    // Group 3 (slots 20-24): both at once, the same 5 pairings from groups 1/2.
    for (int i = 0; i < 5; ++i) {
        const std::string label = std::string("TEST FontSize: ") + kFontSizeNames[i] + " Volume: " + std::to_string(kVolumes[i]);
        ok = writeSlot(pcg, 20 + i, sourceBytes, kFontSizeValues[i], kVolumes[i], label, error) && ok;
    }

    if (!ok) {
        std::fprintf(stderr, "Failed writing a test slot: %s\n", error.c_str());
        return 1;
    }

    const std::string outputPath = testOutputPath(inputPath);
    if (!pcg.save(outputPath, error)) {
        std::fprintf(stderr, "Failed to save %s: %s\n", outputPath.c_str(), error.c_str());
        return 1;
    }

    std::printf("Wrote %s\n", outputPath.c_str());
    return 0;
}
