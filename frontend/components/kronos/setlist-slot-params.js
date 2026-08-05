// SetlistSlotParams: Color and Volume codec for one SBK1 Set List song
// record. Sibling to setlist-comment.js (same 542-byte record, same
// masked-read-modify-write discipline), kept as its own file rather than
// merged in -- each file stays small and independently testable, one
// concern per file. Deliberately standalone -- no dependency on the rest of
// this app, choc, or a native build. Open setlist-slot-params.test.html
// directly (via a static file server, see setlist-comment.test.html's own
// comment for why) to develop/test this file in isolation.
//
// Both fields are CONFIRMED -- see docs/README.md §4.3 and
// src/kronos/PcgFile.cpp's readSlotParams()/kSbk* constants for the C++
// side of the same derivation.
//
// Color is a 4-bit field (1-based, 1..16) packed into byte +12's bits 2-5 --
// that byte is ALSO bit0 (isProgram) and bits6-7 (Font size's low 2 bits,
// see setlist-comment.js). Every read/write below masks to exactly the bits
// Color owns, so this never clobbers isProgram, Font size, or the still-
// unexplained bit1.
//
// Volume, unlike Color/Font size/Transpose, is a clean unpacked byte at
// +16 -- no masking needed, but still routed through the same
// decode/encode shape as everything else here for a consistent editor
// interface.
export const RECORD_SIZE = 542; // SBK1 song record stride (docs/README.md §4.2), same as setlist-comment.js
const TYPE_COLOR_OFFSET = 12; // docs/README.md §4.3 -- bits2-5 are Color's own bits
const COLOR_MASK = 0x3c; // bits 2-5 of +12
const VOLUME_OFFSET = 16; // docs/README.md §4.3 -- a plain byte, 0-127 MIDI-style

function checkLength(bytes, fnName) {
  if (bytes.length !== RECORD_SIZE) {
    throw new Error(`${fnName}: expected ${RECORD_SIZE} bytes, got ${bytes.length}`);
  }
}

// Returns the 1-based Color index (1..16).
export function decodeSlotColor(bytes) {
  checkLength(bytes, "decodeSlotColor");
  return ((bytes[TYPE_COLOR_OFFSET] & COLOR_MASK) >> 2) + 1;
}

// Returns a NEW 542-byte Uint8Array: Color's own bits (byte +12, bits2-5)
// set to `color` (1-based, clamped to 1..16), every other bit of that byte
// (isProgram, Font size, the unexplained bit1) and every other byte
// byte-identical to the input.
export function encodeSlotColor(bytes, color) {
  checkLength(bytes, "encodeSlotColor");
  const out = Uint8Array.from(bytes);
  const clamped = Math.max(1, Math.min(16, Math.round(color)));
  const fieldBits = ((clamped - 1) << 2) & COLOR_MASK;
  // Clear only Color's own bits first (& ~mask), THEN OR in the new value --
  // never a plain assignment, same discipline as setlist-comment.js's Font
  // size write, for the same reason (this byte is shared with other fields).
  out[TYPE_COLOR_OFFSET] = (bytes[TYPE_COLOR_OFFSET] & ~COLOR_MASK) | fieldBits;
  return out;
}

// Returns the raw Volume byte (0-127, MIDI-style).
export function decodeSlotVolume(bytes) {
  checkLength(bytes, "decodeSlotVolume");
  return bytes[VOLUME_OFFSET];
}

// Returns a NEW 542-byte Uint8Array: byte +16 set to `volume` (clamped to
// 0..127), every other byte byte-identical to the input -- no masking
// needed, this byte isn't shared with any other field.
export function encodeSlotVolume(bytes, volume) {
  checkLength(bytes, "encodeSlotVolume");
  const out = Uint8Array.from(bytes);
  out[VOLUME_OFFSET] = Math.max(0, Math.min(127, Math.round(volume)));
  return out;
}
