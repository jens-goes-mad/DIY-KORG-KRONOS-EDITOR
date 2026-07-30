// Fallback bridge for plain-browser mode (open index.html directly, no
// native app build). Fabricates fake Set List data so drag-and-drop file
// loading, the Set List picker, filter/search, and drag-and-drop swap/copy
// can all be exercised with real devtools -- but it CANNOT open real files:
// a plain browser page has no filesystem access at all (that's a
// web-platform restriction, not a Choc one -- Choc's native bridge is what
// gives the real app actual access to disk).
//
// When running inside the native app, choc's addInitScript() injects the
// real window.openFileBytes/listSetlists/getEntries/moveEntry/copyEntry
// *before* this script runs, so this file becomes a no-op there.
(function () {
  if (window.openFileBytes) return;

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

  const panes = {};  // paneId -> { setlists: [{index, name}], songs: {setlistIndex: [{index, label}]} }

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
      color: 1,
      holdTime: 5,
      volume: 127,
      comment: "",
      instrumentName: "",
    };
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
        // Combi refs available too, mirroring the real bridge.
        programs.push({
          bank,
          number,
          name,
          setlistReferenceCount: 0,
          combiReferenceCountAvailable: true,
          combiReferenceCount: 0,
        })
      );
    }
    return programs;
  }

  // Mock-only Timbre references -- three "active" slots followed by 13
  // defaults, standing in for the real bridge's per-Combi Timbre array
  // (see docs/README.md's "Combi Timbre references" section).
  function makeFakeTimbres() {
    const timbres = [
      { number: 100, rawBankCode: 1, bankName: "INT-B", status: "Internal", isDefault: false },
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
    return { setlists, songs, programs: makeFakePrograms(), combis: makeFakeCombis() };
  }

  window.openFileBytes = (paneId, _base64Data, displayName) => {
    if (!paneId) return fail("openFileBytes requires a pane id and file data");
    panes[paneId] = makeFakeFile(displayName || "dropped-file");
    return ok({ setlistCount: panes[paneId].setlists.length });
  };

  window.listSetlists = (paneId) => Promise.resolve(panes[paneId] ? panes[paneId].setlists : []);

  window.getEntries = (paneId, setlistIndex) => {
    const pane = panes[paneId];
    return Promise.resolve(pane && pane.songs[setlistIndex] ? pane.songs[setlistIndex] : []);
  };

  window.moveEntry = (paneId, setlistIndex, fromIndex, toIndex) => {
    const list = panes[paneId] && panes[paneId].songs[setlistIndex];
    if (!list) return fail(`Pane '${paneId}' has no such Set List loaded`);
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

  window.copyEntry = (srcPaneId, srcSetlistIndex, srcIndex, dstPaneId, dstSetlistIndex, dstIndex) => {
    const srcList = panes[srcPaneId] && panes[srcPaneId].songs[srcSetlistIndex];
    const dstList = panes[dstPaneId] && panes[dstPaneId].songs[dstSetlistIndex];
    if (!srcList || !dstList) return fail("Source or destination Set List not loaded");
    const srcIdx = srcList.findIndex((e) => e.index === srcIndex);
    const dstIdx = dstList.findIndex((e) => e.index === dstIndex);
    if (srcIdx < 0 || dstIdx < 0) return fail("Entry index out of range");
    const dstOriginalIndex = dstList[dstIdx].index;
    dstList[dstIdx] = Object.assign({}, srcList[srcIdx], { index: dstOriginalIndex });
    return ok();
  };

  window.setComment = (paneId, setlistIndex, songIndex, newComment) => {
    const list = panes[paneId] && panes[paneId].songs[setlistIndex];
    if (!list) return fail(`Pane '${paneId}' has no such Set List loaded`);
    const entry = list.find((e) => e.index === songIndex);
    if (!entry) return fail("Entry index out of range");
    entry.comment = newComment;
    return ok();
  };

  window.listPrograms = (paneId) => Promise.resolve(panes[paneId] ? panes[paneId].programs : []);

  window.listCombis = (paneId) => Promise.resolve(panes[paneId] ? panes[paneId].combis : []);

  window.getProgramUsage = (paneId, bank, number) => {
    const pane = panes[paneId];
    if (!pane) return fail(`Pane '${paneId}' has no file loaded`);

    const setlistUsages = [];
    for (const setlist of pane.setlists) {
      const list = pane.songs[setlist.index] || [];
      for (const song of list) {
        if (song.isProgram && song.bank === bank && song.number === number) {
          setlistUsages.push({ setlistIndex: setlist.index, setlistName: setlist.name, songIndex: song.index });
        }
      }
    }
    const combiUsagesAvailable = bank >= 0 && bank <= 3;
    const combiUsages = combiUsagesAvailable
      ? pane.combis
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

  window.findDuplicatePrograms = (paneId) => {
    const pane = panes[paneId];
    if (!pane) return Promise.resolve([]);

    const byName = {};
    for (const p of pane.programs) {
      (byName[p.name] = byName[p.name] || []).push(p);
    }
    const groups = Object.values(byName)
      .filter((g) => g.length >= 2)
      .map((g) => g.map((p) => Object.assign({ setlistUsageCount: 0, combiUsageCountAvailable: true, combiUsageCount: 0 }, p)));
    return Promise.resolve(groups);
  };
})();
