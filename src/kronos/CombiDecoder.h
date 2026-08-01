#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include "PcgFile.h"

namespace kronos {

// Second of the small, focused, independently testable per-record decoders
// -- see docs/content/components/index.md and STATE.md's "ARCHITECTURE:
// DECODER/ENCODER REFACTOR" for the rationale. Same shape as
// ProgramDecoder.h, extended to also decode each Combi's 16
// Timbre-to-Program references (Programs have no equivalent). No
// contentHash -- byte-exact duplicate detection was only requested for
// Programs, see CombiInfo's doc comment in PcgFile.h. No encoder yet --
// every current use of Combi data is read-only.

// Raw Kronos fields for one Combi record -- read directly off the bytes.
// bank/number are the record's own position among its siblings, not
// something stored in the record's bytes (same convention as
// ProgramFields) -- passed in by the caller, not decoded here.
struct CombiFields {
    int bank = 0;
    int number = 0;
    std::string name;
    std::vector<TimbreRef> timbres;  // always 16 entries, Timbre 1..16 in order
};

// `record` must point to exactly `recordSize` bytes -- one CBK1 record
// slice (see docs/README.md's "Combi Timbre references" section). Never
// throws or fails: a malformed/truncated slice yields an empty name and/or
// default (isDefault=true) TimbreRefs for whatever doesn't fit, matching
// this project's usual "degrade gracefully" convention for optional data.
CombiFields decodeCombiFields(const uint8_t* record, size_t recordSize, int bank, int number);

}  // namespace kronos
