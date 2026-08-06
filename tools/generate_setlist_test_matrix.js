// Hardware-validation helper -- NOT part of the app itself, never loaded by
// index.html. Generates a real .PCG/.SNG file with a matrix of Setlist Color/
// Volume/Comment/Font-size permutations, so the results can be checked by
// eye on a real Kronos, one slot at a time -- see STATE.md for the full
// rationale (this is how every confirmed byte offset in this project has
// been verified: real ground truth, not a plausible-looking guess).
//
// Deliberately NOT a from-scratch script re-implementing the SBK1 byte
// math -- it drives the real app's own bridge methods (getSongRecordBytes/
// putSongRecordBytes/saveFileAs) and the real JS codecs
// (setlist-comment.js/setlist-slot-params.js). The whole point of this
// exercise is validating THAT code path against real hardware; a parallel
// implementation would only prove its own math right, not the app's.
//
// Usage:
//   1. Build and run the real native app (see README.md -- this needs the
//      actual CHOC/WebView bridge, mock_bridge.js's fakes won't produce a
//      loadable real file).
//   2. Open your minimal test file (one populated Setlist entry, everything
//      else empty -- see STATE.md's save-to-disk section for why a minimal
//      file is the right starting point) via the app's own Open dialog.
//   3. Open devtools (right-click -> Inspect Element; enabled via
//      options.enableDebugMode in main.cpp) and switch to the Console tab.
//   4. Paste this entire file's contents into the console and press enter
//      (defines the two functions below, does nothing else on its own).
//   5. Run:  await generateSetlistTestMatrix()
//      -- edits happen in memory only at this point, same as any other edit
//      in this app; nothing is written to disk yet.
//   6. Check the console output, then run:
//        await saveTestFile("/absolute/path/to/output.pcg")
//      -- writes the whole dataset (your one real entry PLUS the 15 new
//      test slots below, everything else untouched) to that path.
//   7. Load output.pcg onto your Kronos and check slots 010-045 by eye.
//
// Both functions default to SET LIST INDEX 0, SOURCE SLOT 0 (Kronos's own
// 000-127 numbering) and the MOST RECENTLY OPENED dataset -- edit the
// constants below first if your test file's one real entry lives somewhere
// else.

const TEST_MATRIX_SETLIST_INDEX = 0;
const TEST_MATRIX_SOURCE_SLOT = 0;

// The 5 confirmed Font size values (docs/README.md §4.4) and 5 representative
// Volume values (0/1 = the extremes past "silent", 10/100 = two ordinary
// values, 127 = max) -- one each per group, in this fixed order.
const TEST_MATRIX_FONT_SIZES = ["XS", "S", "M", "L", "XL"];
const TEST_MATRIX_VOLUMES = [0, 1, 10, 100, 127];

// Group 4's word-wrap probe: sequential 2-digit tokens ("01 02 03 ... 80"),
// same text in all 5 Font sizes so wherever the real hardware breaks each
// line can be read straight off the screen and reported back exactly (e.g.
// "line 1 ends at 09, line 2 at 19") -- no ambiguity about which word is
// which, unlike a real sentence. See frontend/readme-screen.txt's own
// (unverified, likely fabricated) claims about Kronos text rendering --
// this is how to actually find out, not guess.
const TEST_MATRIX_WRAP_TEXT = Array.from({ length: 80 }, (_, i) => String(i + 1).padStart(2, "0")).join(" ");

// The 16 real Kronos Set List colors, confirmed against real hardware via
// this very group -- see pane.js's SETLIST_COLOR_NAMES (kept in sync) and
// STATE.md for the confirmation record.
const TEST_MATRIX_COLOR_NAMES = [
  "Default", "Charcoal", "Brick", "Burgundy", "Ivy", "Olive", "Gold", "Cacao",
  "Indigo", "Navy", "Rose", "Lavender", "Azure", "Denim", "Silver", "Slate",
];

async function generateSetlistTestMatrix() {
  const datasets = await window.listDatasets();
  if (datasets.length === 0) throw new Error("No dataset open -- open your test file first.");
  const datasetId = datasets[datasets.length - 1].datasetId;
  console.log(`Using dataset ${datasetId} (${datasets[datasets.length - 1].displayName}), Set List ${TEST_MATRIX_SETLIST_INDEX}.`);

  // Relative to the loaded PAGE (frontend/index.html), not to this script's
  // own path on disk -- code pasted into devtools console runs in the
  // page's own context, so a relative import() resolves the same way
  // pane.js's own dynamic import of these same two files already does.
  const { decodeSetlistComment, encodeSetlistComment } = await import("./components/kronos/setlist-comment.js");
  const { encodeSlotColor, encodeSlotVolume } = await import("./components/kronos/setlist-slot-params.js");

  const sourceResult = await window.getSongRecordBytes(datasetId, TEST_MATRIX_SETLIST_INDEX, TEST_MATRIX_SOURCE_SLOT);
  if (!sourceResult.ok) throw new Error(`Couldn't read the source slot: ${sourceResult.error}`);
  const sourceBytes = Uint8Array.from(sourceResult.bytes);
  const sourceDecoded = decodeSetlistComment(sourceBytes);

  // Writes `sourceBytes` into `slot`, with `fontSize`/`volume`/`color`
  // overridden where given (null/undefined leaves the source entry's own
  // value untouched) and Comment set to `label` -- mirrors exactly what
  // pane.js's buildColorSection()/buildCommentSection()/buildVolumeSection()
  // already do per edit, just scripted across many slots instead of one
  // click at a time.
  async function writeSlot(slot, { fontSize, volume, color, label }) {
    let bytes = encodeSetlistComment(sourceBytes, {
      comment: label,
      fontSize: fontSize ?? sourceDecoded.fontSize,
    });
    if (volume != null) bytes = encodeSlotVolume(bytes, volume);
    if (color != null) bytes = encodeSlotColor(bytes, color);

    const result = await window.putSongRecordBytes(datasetId, TEST_MATRIX_SETLIST_INDEX, slot, Array.from(bytes));
    if (!result.ok) throw new Error(`Slot ${slot}: ${result.error}`);
    console.log(`Slot ${slot}: ${label}`);
  }

  // Group 1 (slots 10-14): Font size only, Volume left as the source's own.
  for (let i = 0; i < TEST_MATRIX_FONT_SIZES.length; i++) {
    const fontSize = TEST_MATRIX_FONT_SIZES[i];
    await writeSlot(10 + i, { fontSize, volume: null, label: `TEST FontSize: ${fontSize}` });
  }

  // Group 2 (slots 15-19): Volume only, Font size left as the source's own.
  for (let i = 0; i < TEST_MATRIX_VOLUMES.length; i++) {
    const volume = TEST_MATRIX_VOLUMES[i];
    await writeSlot(15 + i, { fontSize: null, volume, label: `TEST Volume: ${volume}` });
  }

  // Group 3 (slots 20-24): both at once, the same 5 pairings from groups 1/2.
  for (let i = 0; i < TEST_MATRIX_FONT_SIZES.length; i++) {
    const fontSize = TEST_MATRIX_FONT_SIZES[i];
    const volume = TEST_MATRIX_VOLUMES[i];
    await writeSlot(20 + i, { fontSize, volume, label: `TEST FontSize: ${fontSize} Volume: ${volume}` });
  }

  // Group 4 (slots 25-29): Font size only, same wrap-probe Comment text in
  // every slot -- Volume left as the source's own, same as group 1.
  for (let i = 0; i < TEST_MATRIX_FONT_SIZES.length; i++) {
    const fontSize = TEST_MATRIX_FONT_SIZES[i];
    await writeSlot(25 + i, { fontSize, volume: null, label: TEST_MATRIX_WRAP_TEXT });
  }

  // Group 5 (slots 30-45): Color only, one slot per real Kronos color, in
  // TEST_MATRIX_COLOR_NAMES' order -- Font size/Volume left as the source's
  // own.
  for (let i = 0; i < TEST_MATRIX_COLOR_NAMES.length; i++) {
    const color = i + 1;  // SlotParams.color is 1-based
    const name = TEST_MATRIX_COLOR_NAMES[i];
    await writeSlot(30 + i, { fontSize: null, volume: null, color, label: `TEST Color: ${name}` });
  }

  console.log("Done -- 36 slots written (010-045). Now run: await saveTestFile(\"/absolute/path/to/output.pcg\")");
}

async function saveTestFile(path) {
  const datasets = await window.listDatasets();
  if (datasets.length === 0) throw new Error("No dataset open.");
  const datasetId = datasets[datasets.length - 1].datasetId;
  const result = await window.saveFileAs(datasetId, path);
  if (!result.ok) throw new Error(result.error);
  console.log(`Saved to ${path}`);
}
