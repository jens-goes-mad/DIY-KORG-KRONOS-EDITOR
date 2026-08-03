#pragma once

#include <cstdint>
#include <cstddef>
#include <string>

#include "PcgFile.h"

namespace kronos {

// First of what's meant to become several small, focused, independently
// testable per-record decoders -- see docs/content/components/index.md
// for the rationale (mirrors the frontend's codec/component split) and
// STATE.md's "ARCHITECTURE: DECODER/ENCODER REFACTOR" for the plan.
// Deliberately extracts only what PcgFile's Program table/dedup views
// currently need (name, and a content hash) -- not a "decode everything
// this record might contain" pass. No encoder yet: every current use of
// Program data is read-only (see PcgFile::decodeProgram() and
// findDuplicatePrograms()).

// Raw Kronos fields for one Program record -- read directly off the
// bytes, nothing derived or computed. bank/number are the record's own
// position among its siblings, not something stored in the record's
// bytes (see docs/README.md §5's shared record-shape note) -- passed in
// by the caller, not decoded here.
struct ProgramFields {
    int bank = 0;
    int number = 0;
    std::string name;
};

// `record` must point to exactly `recordSize` bytes -- one MBK1/PBK1
// record slice (see docs/README.md §5). Never throws or fails: a
// malformed/truncated slice just yields an empty name, matching this
// project's usual "degrade gracefully" convention for optional data.
ProgramFields decodeProgramFields(const uint8_t* record, size_t recordSize, int bank, int number);

// FNV-1a 64-bit hash of the record's raw bytes, for byte-exact duplicate
// detection (PcgFile::findDuplicatePrograms()). Deliberately a separate
// function from decodeProgramFields(): this is this project's own
// application-level bookkeeping, not a Kronos format field -- see
// ProgramInfo::contentHash's doc comment in PcgFile.h.
uint64_t hashProgramRecord(const uint8_t* record, size_t recordSize);

// Result of classifying one Program bank's type -- see ProgramBankType's
// doc comment in PcgFile.h for why this must be read per-file rather than
// looked up in a fixed table.
struct ProgramBankTypeResult {
    ProgramBankType type = ProgramBankType::Hd1;
    // False if the bank's declared per-record byte stride doesn't match
    // what's expected for `type` (4960 for HD-1, 3706 for EXi -- see
    // docs/external/README.md for where these numbers came from). `type`
    // itself is still derived from the chunk tag either way (treated as
    // the more authoritative of the two signals, since it's an explicit
    // structural marker rather than an inferred size) -- this flag exists
    // so a genuine disagreement between the two signals gets surfaced as
    // an anomaly worth investigating with real data, not silently ignored,
    // per this project's "no guessing" convention.
    bool tagMatchesStride = true;
};

// Classifies a Program bank as HD-1 or EXi from two independent signals
// already parsed at load time from the same file -- `chunkTag` (the bank's
// own MBK1/PBK1 tag: MBK1=EXi, PBK1=HD-1, confirmed via
// docs/references/PCG-Structure-Kronos-DaBlick.txt) and `bytesPerRecord`
// (the bank's declared per-record stride, cross-checked against the
// expected HD-1/EXi record sizes, confirmed via
// docs/external/Synthify-Kronos-PCG-File-Structures.xlsx). Deliberately not
// a hardcoded per-bank-index lookup table -- see ProgramBankType's doc
// comment in PcgFile.h.
ProgramBankTypeResult classifyProgramBankType(const std::string& chunkTag, uint32_t bytesPerRecord);

}  // namespace kronos
