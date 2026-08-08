// Fallback bridge for plain-browser mode (open index.html directly, no
// native app build). Fabricates fake data so the "Open..." button, the Set
// List picker, filter/search, and drag-and-drop swap/copy can all be
// exercised with real devtools -- but it CANNOT open real files: a plain
// browser page has no filesystem access at all (that's a web-platform
// restriction, not a Choc one -- Choc's native bridge is what gives the
// real app actual access to disk), so openFileDialog() below fakes a
// picker via window.prompt() instead of a real one.
//
// When running inside the native app, choc's addInitScript() injects the
// real window.openFileDialog/listDatasets/listSetlists/getEntries/
// moveEntry/copyEntry *before* this script runs, so this file becomes a
// no-op there.
(function () {
  if (window.openFileDialog) return;

  console.warn(
    "[mock_bridge] No native bridge detected -- running in plain-browser mode with fabricated " +
      "Set List data. Dropped files are NOT actually parsed (browsers can't read arbitrary binary " +
      "formats meaningfully here anyway); see README.md."
  );

  const mockSongsByList = [
    ["Rolling in the Deep", "Sex on Fire", "Keep the Faith", "Separate Ways", "Call Me", "Weak"],
    ["Burning down the House", "Aint no Love in the City", "Smooth", "Fragile", "Gravity"],
    ["Marillion", "Marillion", "Marillion"],
    ["Pink Floyd"],
  ];

  // Real Comment text the project owner confirmed renders "nearly identical"
  // to an actual Kronos (pane.js's Font-size-driven wrap preview, see
  // STATE.md) -- planted on Setlist 000 / Song 000 below so the preview can
  // be exercised in mock/browser mode too, without the real native app.
  // Exact whitespace/line breaks preserved as given, not reformatted.
  const MOCK_WRAP_TEST_COMMENT =
    "Intro (1): [e-#f-h]  oben bolero h, #c, e  rechts Tonleiter\n" +
    "                 single note: a__   Ende: d__\n" +
    "Str (2): D   A/#c   bm7   bm7 | G   D/#f   em7\n" +
    "             #fm   G   D   A\n" +
    "Ref (3): D   A/#c   em7 | em7   G   A |:2\n" +
    "              D   A  em\n" +
    "Str (2): wie Str1 | 1/2 Str1 | A D A\n" +
    "Bridge (4): C+c, G+h, #A, F+a | C G dm A\n" +
    "8 * Ref (bm / D im Wechsel)";

  const datasets = {};  // datasetId -> { displayName, setlists: [{index, name}], songs: {setlistIndex: [{index, label}]}, programs, combis }
  let nextDatasetId = 1;

  const ok = (extra) => Promise.resolve(Object.assign({ ok: true }, extra));
  const fail = (error) => Promise.resolve({ ok: false, error });

  function makeFakeSong(k, label) {
    return {
      index: k,
      label,
      paramsFound: label !== "",
      isProgram: k % 4 !== 0,
      bank: 0,
      number: k,
      color: (k % 16) + 1,  // cycle through all 16 real colors (pane.js's SETLIST_COLOR_NAMES/_HEX) for visual testing
      holdTime: 5,
      volume: 127,
      fontSize: "S",  // baseline/default, matches SlotParams' own default (PcgFile.h)
      comment: "",
      instrumentName: "",
    };
  }

  // Same encoding setlist-comment.js's encodeSetlistComment() uses (bits
  // 6-7 of byte+12, bit 4 of byte+17) -- duplicated by hand here rather
  // than importing that module, matching this file's existing pattern for
  // Color (below) and Volume: a plain script, not built to load ES modules.
  const FONT_SIZE_VALUE = { S: 0, XS: 1, M: 2, L: 3, XL: 4 };
  const FONT_SIZE_BY_VALUE = ["S", "XS", "M", "L", "XL"];

  // Mock mode has no real SBK1 bytes to hand back -- getSongRecordBytes()/
  // putSongRecordBytes() below need SOME 542-byte buffer that the real
  // frontend/components/kronos codecs can decode/encode against, so this
  // synthesizes one from a fake entry's own fields, close enough to the
  // real byte layout (docs/README.md §4.3, src/kronos/PcgFile.cpp's kSbk*
  // constants) for Color (byte+12 bits2-5)/Volume (byte+16)/Font size
  // (byte+12 bits6-7 + byte+17 bit4)/Comment (byte+18..) to round-trip
  // correctly. Transpose/isProgram's other bits aren't reconstructed (mock
  // entries don't track them), so they'll always decode as their zero/
  // default value here -- fine, no mock UI reads them.
  const SBK_RECORD_SIZE = 542;
  function makeFakeSlotBytes(entry) {
    const bytes = new Uint8Array(SBK_RECORD_SIZE);
    const colorField = ((Math.max(1, Math.min(16, entry.color)) - 1) << 2) & 0x3c;
    const fontValue = FONT_SIZE_VALUE[entry.fontSize] ?? FONT_SIZE_VALUE.S;
    const fontLowBits = (fontValue & 2 ? 0x80 : 0) | (fontValue & 1 ? 0x40 : 0);
    bytes[12] = colorField | fontLowBits | (entry.isProgram ? 0x01 : 0x00);
    bytes[13] = entry.bank & 0x1f;
    bytes[14] = entry.number & 0xff;
    bytes[15] = (entry.holdTime + 1) & 0xff;
    bytes[16] = Math.max(0, Math.min(127, entry.volume));
    bytes[17] = fontValue & 4 ? 0x10 : 0x00;
    const comment = entry.comment || "";
    for (let i = 0; i < comment.length && 18 + i < SBK_RECORD_SIZE - 1; i++) {
      bytes[18 + i] = comment.charCodeAt(i) & 0xff;
    }
    return bytes;
  }

  // Mock-only Programs -- deliberately includes a repeated name ("Init
  // Program") on two different banks, standing in for a real byte-exact
  // duplicate (the real bridge hashes full record content; this fake data
  // has no such content to hash, so duplicates here are grouped by name
  // instead, purely for exercising the Duplicates tab's UI).
  function makeFakePrograms() {
    const names = ["Berlin Grand SW2 U.C.", "Rain Again", "Init Program", "Init Program", "Subdivisions"];
    const programs = [];
    for (let bank = 0; bank < 2; bank++) {
      names.forEach((name, number) =>
        // bank 0/1 are both within the confirmed INT-A..D range (see
        // kronos::isConfirmedTimbreProgramBank()), so mock mode marks
        // Combi refs available too, mirroring the real bridge. bankType
        // here is purely cosmetic (alternating HD-1/EXi by bank) -- mock
        // mode has no real bytes to classify, see PcgFile.h's
        // ProgramBankType doc comment for how the real bridge does this.
        programs.push({
          bank,
          number,
          name,
          bankType: bank === 0 ? "HD-1" : "EXi",
          setlistReferenceCount: 0,
          combiReferenceCountAvailable: true,
          combiReferenceCount: 0,
        })
      );
      // One genuinely empty slot per bank (number 5) -- gives copyProgram()
      // below a real target to succeed into, not just reject; every other
      // slot above already has a name, so a same-type drop onto one of
      // those correctly exercises the "target slot occupied" rejection
      // instead.
      programs.push({
        bank,
        number: names.length,
        name: "",
        bankType: bank === 0 ? "HD-1" : "EXi",
        setlistReferenceCount: 0,
        combiReferenceCountAvailable: true,
        combiReferenceCount: 0,
      });
    }
    return programs;
  }

  // Mock-only Timbre references -- three "active" slots followed by 13
  // defaults, standing in for the real bridge's per-Combi Timbre array
  // (see docs/README.md's "Combi Timbre references" section).
  function makeFakeTimbres() {
    const timbres = [
      // number:0/rawBankCode:1 deliberately matches makeFakePrograms()'s own
      // bank1/number0 ("Berlin Grand SW2 U.C.") -- exercises the new name/
      // engine-type lookup in mock mode too, not just the real bridge.
      { number: 0, rawBankCode: 1, bankName: "INT-B", status: "Internal", isDefault: false },
      { number: 15, rawBankCode: 20, bankName: "USER-D", status: "Internal", isDefault: false },
      // A real reference that's currently switched off -- exercises the
      // "referenced but inactive" display case in mock mode too.
      { number: 90, rawBankCode: 0, bankName: "INT-A", status: "Off", isDefault: false },
    ];
    for (let i = timbres.length; i < 16; i++) {
      timbres.push({ number: 0, rawBankCode: 0, bankName: "INT-A", status: "Off", isDefault: true });
    }
    return timbres;
  }

  function makeFakeCombis() {
    const names = ["K-Lab: Katja's House", "Stradivarius Goes POP", "Rolling in the Deep"];
    const combis = [];
    for (let bank = 0; bank < 2; bank++) {
      names.forEach((name, number) => {
        // "Rolling in the Deep" gets a fabricated usage so the Set List
        // "badges" column has something real to render in mock mode too.
        const setlistUsages =
          name === "Rolling in the Deep"
            ? [{ setlistIndex: 1, setlistName: "Mock List 1", songIndex: 0 }]
            : [];
        combis.push({
          bank,
          number,
          name,
          setlistReferenceCount: setlistUsages.length,
          setlistUsages,
          timbres: makeFakeTimbres(),
        });
      });
    }
    return combis;
  }

  function makeFakeFile(fileName) {
    const names = ["Mock Set List", ...mockSongsByList.map((_, i) => `Mock List ${i + 1}`)];
    const setlists = names.map((name, index) => ({ index, name: `${name} (${fileName})` }));
    const songs = {};
    setlists.forEach((s, i) => {
      const titles = mockSongsByList[i - 1] || [];
      songs[s.index] = Array.from({ length: 16 }, (_, k) => makeFakeSong(k, titles[k] || ""));
    });

    // Setlist 000's songs are otherwise all blank (index 0 has no entry in
    // mockSongsByList, deliberately -- see the `titles[i - 1]` offset
    // above), so Song 000 needs a real label of its own here to actually
    // have paramsFound=true and be clickable at all.
    if (songs[0] && songs[0][0]) {
      songs[0][0] = makeFakeSong(0, "Wrap Test");
      songs[0][0].comment = MOCK_WRAP_TEST_COMMENT;
    }

    return { displayName: fileName, setlists, songs, programs: makeFakePrograms(), combis: makeFakeCombis() };
  }

  // A plain browser tab can't show a real native file picker (or read an
  // arbitrary local path at all) -- window.prompt() stands in for it here
  // just so the "Open..." button has SOMETHING to do in mock mode.
  window.openFileDialog = () => {
    const displayName = window.prompt("Mock mode has no real file picker -- type a fake file name:", "mock-file.pcg");
    if (!displayName) return Promise.resolve({ ok: true, cancelled: true });
    // Mirrors the real bridge's dedup (EditorBridge::openFileAtPath): typing
    // the same fake name twice reuses the existing mock dataset instead of
    // creating a duplicate, so mock mode exercises the same "already open"
    // behavior the native dialog does.
    const existingId = Object.keys(datasets).find((id) => datasets[id].displayName === displayName);
    if (existingId) {
      const d = datasets[existingId];
      return ok({ datasetId: Number(existingId), displayName: d.displayName, setlistCount: d.setlists.length, alreadyOpen: true });
    }
    const datasetId = nextDatasetId++;
    datasets[datasetId] = makeFakeFile(displayName);
    return ok({ datasetId, displayName: datasets[datasetId].displayName, setlistCount: datasets[datasetId].setlists.length });
  };

  window.listDatasets = () =>
    Promise.resolve(
      Object.entries(datasets).map(([datasetId, d]) => ({
        datasetId: Number(datasetId),
        displayName: d.displayName,
        setlistCount: d.setlists.length,
      }))
    );

  window.closeDataset = (datasetId) => {
    delete datasets[datasetId];
    return ok();
  };

  window.listSetlists = (datasetId) => Promise.resolve(datasets[datasetId] ? datasets[datasetId].setlists : []);

  window.getEntries = (datasetId, setlistIndex) => {
    const dataset = datasets[datasetId];
    return Promise.resolve(dataset && dataset.songs[setlistIndex] ? dataset.songs[setlistIndex] : []);
  };

  window.moveEntry = (datasetId, setlistIndex, fromIndex, toIndex) => {
    const list = datasets[datasetId] && datasets[datasetId].songs[setlistIndex];
    if (!list) return fail(`Dataset ${datasetId} has no such Set List loaded`);
    const fromIdx = list.findIndex((e) => e.index === fromIndex);
    const toIdx = list.findIndex((e) => e.index === toIndex);
    if (fromIdx < 0 || toIdx < 0) return fail("Entry index out of range");
    const fromOriginalIndex = list[fromIdx].index;
    const toOriginalIndex = list[toIdx].index;
    [list[fromIdx], list[toIdx]] = [list[toIdx], list[fromIdx]];
    list[fromIdx].index = fromOriginalIndex;
    list[toIdx].index = toOriginalIndex;
    return ok();
  };

  window.copyEntry = (srcDatasetId, srcSetlistIndex, srcIndex, dstDatasetId, dstSetlistIndex, dstIndex) => {
    const srcList = datasets[srcDatasetId] && datasets[srcDatasetId].songs[srcSetlistIndex];
    const dstList = datasets[dstDatasetId] && datasets[dstDatasetId].songs[dstSetlistIndex];
    if (!srcList || !dstList) return fail("Source or destination Set List not loaded");
    const srcIdx = srcList.findIndex((e) => e.index === srcIndex);
    const dstIdx = dstList.findIndex((e) => e.index === dstIndex);
    if (srcIdx < 0 || dstIdx < 0) return fail("Entry index out of range");
    const dstOriginalIndex = dstList[dstIdx].index;
    dstList[dstIdx] = Object.assign({}, srcList[srcIdx], { index: dstOriginalIndex });
    return ok();
  };

  window.setComment = (datasetId, setlistIndex, songIndex, newComment) => {
    const list = datasets[datasetId] && datasets[datasetId].songs[setlistIndex];
    if (!list) return fail(`Dataset ${datasetId} has no such Set List loaded`);
    const entry = list.find((e) => e.index === songIndex);
    if (!entry) return fail("Entry index out of range");
    entry.comment = newComment;
    return ok();
  };

  // The Setlist Color/Volume/Comment row editors (frontend/pane.js) read/
  // write through these two instead of setComment() above -- see
  // makeFakeSlotBytes()'s own comment for how a mock 542-byte record is
  // synthesized.
  window.getSongRecordBytes = (datasetId, setlistIndex, songIndex) => {
    const list = datasets[datasetId] && datasets[datasetId].songs[setlistIndex];
    if (!list) return fail(`Dataset ${datasetId} has no file loaded`);
    const entry = list.find((e) => e.index === songIndex);
    if (!entry) return fail("No SBK1 record for that Set List slot");
    return ok({ bytes: Array.from(makeFakeSlotBytes(entry)) });
  };

  window.putSongRecordBytes = (datasetId, setlistIndex, songIndex, bytes) => {
    const list = datasets[datasetId] && datasets[datasetId].songs[setlistIndex];
    if (!list) return fail(`Dataset ${datasetId} has no file loaded`);
    const entry = list.find((e) => e.index === songIndex);
    if (!entry || !Array.isArray(bytes) || bytes.length !== SBK_RECORD_SIZE) {
      return fail("Couldn't write that Set List slot's record (wrong size, or index out of range)");
    }
    // Re-derive the mock entry's own fields from the written bytes, same
    // discipline as the real PcgFile::putSongRecordBytes() -- a cached
    // field must never go stale after a direct "raw bytes" write, even in
    // mock mode.
    entry.color = ((bytes[12] & 0x3c) >> 2) + 1;
    entry.volume = bytes[16];
    const fontValue = (bytes[17] & 0x10 ? 4 : 0) | (bytes[12] & 0x80 ? 2 : 0) | (bytes[12] & 0x40 ? 1 : 0);
    entry.fontSize = FONT_SIZE_BY_VALUE[fontValue] || "S";
    let end = 18;
    while (end < bytes.length && bytes[end] !== 0) end++;
    entry.comment = bytes.slice(18, end).map((b) => String.fromCharCode(b)).join("");
    return ok();
  };

  window.listPrograms = (datasetId) => Promise.resolve(datasets[datasetId] ? datasets[datasetId].programs : []);

  window.listCombis = (datasetId) => Promise.resolve(datasets[datasetId] ? datasets[datasetId].combis : []);

  // Mirrors makeFakePrograms()'s own bank 0 = HD-1 / bank 1 = EXi convention,
  // independent of which programs actually exist in a bank -- same as the
  // real bridge's getProgramBankTypes(), which is a per-bank listing, not
  // derived from any specific Program row.
  window.getProgramBankTypes = (datasetId) =>
    Promise.resolve(datasets[datasetId] ? [{ bank: 0, bankType: "HD-1" }, { bank: 1, bankType: "EXi" }] : []);

  // Mirrors makeFakePrograms()/makeFakeCombis()' own record counts (6 per
  // Program bank -- 5 named + 1 empty filler slot; 3 per Combi bank, no
  // filler) -- for exercising internals.js in mock mode. Only 2 of the 20
  // expected Program banks and 2 of 14 expected Combi banks "exist" here,
  // deliberately, so the pane's own "N of 20/14 found" shortfall messaging
  // has something real to show in mock mode too, not just when a real
  // backup is actually missing banks. Same reasoning for topLevelChunks --
  // a plausible but incomplete subset (no DKT1/WSQ1/GLB1/DPI1), consistent
  // with what this project has never actually parsed for any real file.
  window.getDatasetInternals = (datasetId) => {
    if (!datasets[datasetId]) return fail(`Dataset ${datasetId} has no file loaded`);
    return ok({
      topLevelChunks: ["DIV1", "SLS1", "PRG1", "CMB1"],
      programBanks: [
        { index: 0, bankType: "HD-1", numRecords: 6, bytesPerRecord: 4960 },
        { index: 1, bankType: "EXi", numRecords: 6, bytesPerRecord: 3706 },
      ],
      combiBanks: [
        { index: 0, numRecords: 3, bytesPerRecord: 4048 },
        { index: 1, numRecords: 3, bytesPerRecord: 4048 },
      ],
    });
  };

  window.getProgramUsage = (datasetId, bank, number) => {
    const dataset = datasets[datasetId];
    if (!dataset) return fail(`Dataset ${datasetId} has no file loaded`);

    const setlistUsages = [];
    for (const setlist of dataset.setlists) {
      const list = dataset.songs[setlist.index] || [];
      for (const song of list) {
        if (song.isProgram && song.bank === bank && song.number === number) {
          setlistUsages.push({ setlistIndex: setlist.index, setlistName: setlist.name, songIndex: song.index });
        }
      }
    }
    const combiUsagesAvailable = bank >= 0 && bank <= 3;
    const combiUsages = combiUsagesAvailable
      ? dataset.combis
          .filter((c) => c.timbres.some((t) => !t.isDefault && t.rawBankCode === bank && t.number === number))
          .map((c) => ({
            bank: c.bank,
            number: c.number,
            name: c.name,
            active: c.timbres.some(
              (t) => !t.isDefault && t.rawBankCode === bank && t.number === number && t.status !== "Off"
            ),
          }))
      : [];
    return ok({ setlistUsages, combiUsagesAvailable, combiUsages });
  };

  // Mirrors EditorBridge::copyProgram()'s three rejection guards (see
  // PcgFile::copyProgramFrom()'s doc comment for the real thing) using
  // `name` as mock mode's stand-in for real byte content, same convention
  // findDuplicatePrograms() above already uses -- mock data has no actual
  // bytes to hash.
  window.copyProgram = (srcDatasetId, srcBank, srcNumber, dstDatasetId, dstBank, dstNumber) => {
    const srcDataset = datasets[srcDatasetId];
    const dstDataset = datasets[dstDatasetId];
    if (!srcDataset) return fail("Source dataset is no longer open.");
    if (!dstDataset) return fail("Destination dataset is no longer open.");

    const srcProgram = srcDataset.programs.find((p) => p.bank === srcBank && p.number === srcNumber);
    if (!srcProgram) return fail("Can't copy: source or destination bank/number is out of range.");

    const dstBankType = dstBank === 0 ? "HD-1" : "EXi";  // same convention as getProgramBankTypes() above
    if (srcProgram.bankType !== dstBankType) {
      return fail(
        "Can't copy: source and destination banks are different engine types (HD-1/EXi) -- " +
          "a Program can only be loaded into a bank of the matching type."
      );
    }

    const existingAtTarget = dstDataset.programs.find((p) => p.bank === dstBank && p.number === dstNumber);
    if (existingAtTarget && existingAtTarget.name) {
      return fail("Can't copy: the destination slot already holds a different Program.");
    }

    const duplicate = dstDataset.programs.find(
      (p) => p.name && p.name === srcProgram.name && !(srcDatasetId === dstDatasetId && p.bank === srcBank && p.number === srcNumber)
    );
    if (duplicate) {
      return fail("Can't copy: a byte-identical Program already exists in the destination dataset.");
    }

    if (existingAtTarget) {
      existingAtTarget.name = srcProgram.name;
      existingAtTarget.bankType = dstBankType;
    } else {
      dstDataset.programs.push({
        bank: dstBank,
        number: dstNumber,
        name: srcProgram.name,
        bankType: dstBankType,
        setlistReferenceCount: 0,
        combiReferenceCountAvailable: true,
        combiReferenceCount: 0,
      });
    }
    return ok();
  };

  window.findDuplicatePrograms = (datasetId) => {
    const dataset = datasets[datasetId];
    if (!dataset) return Promise.resolve([]);

    const byName = {};
    for (const p of dataset.programs) {
      if (!p.name) continue;  // empty slots (makeFakePrograms()'s copyProgram() target) aren't "duplicates" of each other
      (byName[p.name] = byName[p.name] || []).push(p);
    }
    const groups = Object.values(byName)
      .filter((g) => g.length >= 2)
      .map((g) => g.map((p) => Object.assign({ setlistUsageCount: 0, combiUsageCountAvailable: true, combiUsageCount: 0 }, p)));
    return Promise.resolve(groups);
  };
})();
