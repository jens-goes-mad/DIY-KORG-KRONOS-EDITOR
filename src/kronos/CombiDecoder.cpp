#include "CombiDecoder.h"

namespace kronos {

namespace {

// Same 24-byte-field-4-bytes-in shape as every other bank record type in
// this format (Program, and the rest of Combi's own record beyond just the
// name) -- space/NUL-padded, NOT NUL-terminated, so a full-length
// 24-character name has no terminator at all and trailing NUL/space must
// be trimmed rather than scanned-for. See docs/README.md §5.
constexpr size_t kNameOffset = 4;
constexpr size_t kNameLength = 24;

// A Combi's 16 Timbres each reference a Program at a fixed 188-byte stride
// starting 4806 bytes into the Combi's own record, byte 0 = number, byte 1
// = raw bank code. Confirmed by the project owner providing real Combis
// (with known Timbre->Program assignments) to diff against -- see
// docs/README.md's "Combi Timbre references" section.
constexpr size_t kTimbreBaseOffset = 4806;
constexpr size_t kTimbreStride = 188;
constexpr int kTimbreCount = 16;

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

}  // namespace

CombiFields decodeCombiFields(const uint8_t* record, size_t recordSize, int bank, int number) {
    CombiFields fields;
    fields.bank = bank;
    fields.number = number;

    if (kNameOffset + kNameLength <= recordSize) {
        size_t len = kNameLength;
        while (len > 0) {
            uint8_t c = record[kNameOffset + len - 1];
            if (c != 0 && c != ' ') break;
            --len;
        }
        fields.name = std::string(reinterpret_cast<const char*>(record + kNameOffset), len);
    }

    fields.timbres.reserve(kTimbreCount);
    for (int i = 0; i < kTimbreCount; ++i) {
        size_t h = kTimbreBaseOffset + static_cast<size_t>(i) * kTimbreStride;
        TimbreRef ref;
        if (h + 2 < recordSize) {
            ref.number = record[h];
            ref.rawBankCode = record[h + 1];
            ref.status = decodeTimbreStatus(record[h + 2]);
            ref.isDefault = (ref.number == 0 && ref.rawBankCode == 0);
        }
        fields.timbres.push_back(ref);
    }
    return fields;
}

}  // namespace kronos
