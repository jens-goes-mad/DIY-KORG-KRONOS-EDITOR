#include "ProgramDecoder.h"

namespace kronos {

namespace {

// Same 24-byte-field-4-bytes-in shape as every other bank record type in
// this format (Combi, and the rest of Program's own record beyond just
// the name) -- space/NUL-padded, NOT NUL-terminated, so a full-length
// 24-character name has no terminator at all and trailing NUL/space must
// be trimmed rather than scanned-for. See docs/README.md §5.
constexpr size_t kNameOffset = 4;
constexpr size_t kNameLength = 24;

}  // namespace

ProgramFields decodeProgramFields(const uint8_t* record, size_t recordSize, int bank, int number) {
    ProgramFields fields;
    fields.bank = bank;
    fields.number = number;

    if (kNameOffset + kNameLength > recordSize) return fields;  // leaves name empty

    size_t len = kNameLength;
    while (len > 0) {
        uint8_t c = record[kNameOffset + len - 1];
        if (c != 0 && c != ' ') break;
        --len;
    }
    fields.name = std::string(reinterpret_cast<const char*>(record + kNameOffset), len);
    return fields;
}

// Standard FNV-1a 64-bit. Collisions between genuinely different records
// are astronomically unlikely at the ~2500-record scale these files run,
// so a hash match is trusted directly without a follow-up byte-compare.
uint64_t hashProgramRecord(const uint8_t* record, size_t recordSize) {
    uint64_t hash = 0xcbf29ce484222325ULL;
    for (size_t i = 0; i < recordSize; ++i) {
        hash ^= record[i];
        hash *= 0x100000001b3ULL;
    }
    return hash;
}

}  // namespace kronos
