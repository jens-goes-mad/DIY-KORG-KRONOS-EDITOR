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

  function makeFakeFile(fileName) {
    const names = ["Mock Set List", ...mockSongsByList.map((_, i) => `Mock List ${i + 1}`)];
    const setlists = names.map((name, index) => ({ index, name: `${name} (${fileName})` }));
    const songs = {};
    setlists.forEach((s, i) => {
      const titles = mockSongsByList[i - 1] || [];
      songs[s.index] = Array.from({ length: 16 }, (_, k) => makeFakeSong(k, titles[k] || ""));
    });
    return { setlists, songs };
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
})();
