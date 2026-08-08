// Headless, node-runnable version of setlist-comment.test.html's
// self-checks -- same assertions, same real fixture, no browser/DOM
// needed since decodeSetlistComment/encodeSetlistComment are pure
// functions. Run directly: `node setlist-comment.test.js`
// (requires ../package.json's `"type": "module"` to load as ESM).
//
// Exits non-zero on any failed assertion, for CI/ctest-style usage.

import {
  RECORD_SIZE,
  COMMENT_OFFSET,
  COMMENT_MAX_LENGTH,
  FONT_SIZES,
  decodeSetlistComment,
  encodeSetlistComment,
} from "./setlist-comment.js";
import { ROLLING_IN_THE_DEEP_RECORD_HEX, hexToBytes } from "./test-fixtures.js";

let failures = 0;

function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) {
    failures++;
    console.error(`FAIL -- ${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
  } else {
    console.log(`PASS -- ${label}`);
  }
}

const realRecord = hexToBytes(ROLLING_IN_THE_DEEP_RECORD_HEX);

check("record is the documented SBK1 stride", realRecord.length, RECORD_SIZE);

const decoded = decodeSetlistComment(realRecord);
check("comment starts with real text", decoded.comment.startsWith("Intro (1):"), true);
check("comment preserves embedded \\r\\n", decoded.comment.includes("\r\nBridge"), true);
// Confirmed via a dedicated isolated test file (docs/README.md §4.4) --
// this real record's font-size bits happen to decode as "L", matching
// the C++ parser (src/kronos/PcgFile.cpp) exactly on the same record.
check("fontSize decodes per the confirmed encoding (§4.4)", decoded.fontSize, "L");

const roundTripped = decodeSetlistComment(encodeSetlistComment(realRecord, decoded));
check("decode(encode(bytes)) round-trips the comment exactly", roundTripped.comment, decoded.comment);
check("decode(encode(bytes)) round-trips fontSize exactly", roundTripped.fontSize, decoded.fontSize);

for (const size of FONT_SIZES) {
  const withSize = encodeSetlistComment(realRecord, { ...decoded, fontSize: size });
  check(`setting fontSize=${size} round-trips through decode()`, decodeSetlistComment(withSize).fontSize, size);
}

// CRITICAL: Font size shares byte+12 with Type+Color and byte+17 with
// Transpose/unexplained bits (docs/README.md §4.3) -- a font-size edit
// must never clobber those other bits. Craft a record with arbitrary
// non-zero values in exactly the bits Font size does NOT own, then
// confirm they survive a font-size change untouched.
const crafted = new Uint8Array(realRecord);
crafted[12] = 0b00101101; // bits0-5 = arbitrary Type+Color, bits6-7 = 00 (S)
crafted[17] = 0b11101011; // bits5-7 = arbitrary Transpose-low, bit4 = 0 (S), bits0-2 = arbitrary unexplained
const craftedEdited = encodeSetlistComment(crafted, { ...decodeSetlistComment(crafted), fontSize: "XL" });
check("font-size edit preserves byte12's Type+Color bits (0-5)", craftedEdited[12] & 0x3f, crafted[12] & 0x3f);
check("font-size edit preserves byte17's Transpose-low bits (5-7)", craftedEdited[17] & 0xe0, crafted[17] & 0xe0);
check("font-size edit preserves byte17's unexplained bits (0-3)", craftedEdited[17] & 0x0f, crafted[17] & 0x0f);
check("font-size edit actually changed fontSize to XL", decodeSetlistComment(craftedEdited).fontSize, "XL");

const edited = encodeSetlistComment(realRecord, { ...decoded, comment: "short" });
check("edited record is still exactly RECORD_SIZE bytes", edited.length, RECORD_SIZE);
check(
  "bytes 0-11 (before Type+Color) are untouched by a comment edit",
  Array.from(edited.slice(0, 12)),
  Array.from(realRecord.slice(0, 12))
);
// Only through COMMENT_OFFSET+COMMENT_MAX_LENGTH (530), not RECORD_SIZE
// (542) -- the trailing 12 bytes (530..541) aren't comment space, see
// COMMENT_MAX_LENGTH's own comment, and encodeSetlistComment() must leave
// them untouched rather than zero them.
check(
  "shortening the comment zero-fills the rest of the comment field (not past it)",
  edited.slice(COMMENT_OFFSET + 5, COMMENT_OFFSET + COMMENT_MAX_LENGTH).every((b) => b === 0),
  true
);

let threw = false;
try {
  decodeSetlistComment(new Uint8Array(10));
} catch {
  threw = true;
}
check("decode() rejects a byte array of the wrong length", threw, true);

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nAll checks passed");
}
