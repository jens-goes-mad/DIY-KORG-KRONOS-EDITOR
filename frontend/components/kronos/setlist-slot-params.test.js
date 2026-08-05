// Headless, node-runnable version of setlist-slot-params.test.html's
// self-checks -- same assertions, same real fixture as setlist-comment.
// test.js, no browser/DOM needed since every function here is pure. Run
// directly: `node setlist-slot-params.test.js` (requires ../package.json's
// `"type": "module"` to load as ESM).
//
// Exits non-zero on any failed assertion, for CI/ctest-style usage.

import { RECORD_SIZE, decodeSlotColor, encodeSlotColor, decodeSlotVolume, encodeSlotVolume } from "./setlist-slot-params.js";
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

// Ground truth for this real record: byte+12 = 0xc0 (color bits2-5 = 0 ->
// Color 1/Standard), byte+16 = 0x7f (Volume 127) -- confirmed against the
// same bytes src/kronos/PcgFile.cpp's readSlotParams() decodes, and against
// setlist-comment.test.js's own use of this fixture (byte+12's Font size
// bits from the same byte decode as "L" there).
check("decodeSlotColor matches the real record's confirmed Color (1/Standard)", decodeSlotColor(realRecord), 1);
check("decodeSlotVolume matches the real record's confirmed Volume (127)", decodeSlotVolume(realRecord), 127);

for (const color of [1, 5, 16]) {
  const withColor = encodeSlotColor(realRecord, color);
  check(`setting color=${color} round-trips through decode()`, decodeSlotColor(withColor), color);
}
check("encodeSlotColor clamps below 1 up to 1", decodeSlotColor(encodeSlotColor(realRecord, 0)), 1);
check("encodeSlotColor clamps above 16 down to 16", decodeSlotColor(encodeSlotColor(realRecord, 99)), 16);

for (const volume of [0, 64, 127]) {
  const withVolume = encodeSlotVolume(realRecord, volume);
  check(`setting volume=${volume} round-trips through decode()`, decodeSlotVolume(withVolume), volume);
}
check("encodeSlotVolume clamps below 0 up to 0", decodeSlotVolume(encodeSlotVolume(realRecord, -5)), 0);
check("encodeSlotVolume clamps above 127 down to 127", decodeSlotVolume(encodeSlotVolume(realRecord, 200)), 127);

// CRITICAL: Color shares byte+12 with isProgram (bit0), Font size (bits6-7),
// and a still-unexplained bit1 (docs/README.md §4.3) -- a Color edit must
// never clobber those. Craft a record with arbitrary non-zero values in
// exactly the bits Color does NOT own, confirm they survive a Color change.
const craftedColor = new Uint8Array(realRecord);
craftedColor[12] = 0b11000011; // bit0=1 (isProgram), bit1=1 (unexplained), bits6-7=11 (Font size low), bits2-5=0 (Color 1)
const colorEdited = encodeSlotColor(craftedColor, 16);
check("Color edit preserves byte12's isProgram bit (0)", colorEdited[12] & 0x01, craftedColor[12] & 0x01);
check("Color edit preserves byte12's unexplained bit (1)", colorEdited[12] & 0x02, craftedColor[12] & 0x02);
check("Color edit preserves byte12's Font size bits (6-7)", colorEdited[12] & 0xc0, craftedColor[12] & 0xc0);
check("Color edit actually changed Color to 16", decodeSlotColor(colorEdited), 16);

const edited = encodeSlotColor(realRecord, 3);
check("edited record is still exactly RECORD_SIZE bytes", edited.length, RECORD_SIZE);
check(
  "bytes other than +12 are untouched by a Color edit",
  Array.from(edited.slice(0, 12)).concat(Array.from(edited.slice(13))),
  Array.from(realRecord.slice(0, 12)).concat(Array.from(realRecord.slice(13)))
);

const volumeEdited = encodeSlotVolume(realRecord, 42);
check(
  "bytes other than +16 are untouched by a Volume edit",
  Array.from(volumeEdited.slice(0, 16)).concat(Array.from(volumeEdited.slice(17))),
  Array.from(realRecord.slice(0, 16)).concat(Array.from(realRecord.slice(17)))
);

for (const fn of [decodeSlotColor, decodeSlotVolume]) {
  let threw = false;
  try {
    fn(new Uint8Array(10));
  } catch {
    threw = true;
  }
  check(`${fn.name} rejects a byte array of the wrong length`, threw, true);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nAll checks passed");
}
