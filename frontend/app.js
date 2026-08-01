function setStatus(message) {
  document.getElementById("statusBar").textContent = message;
}

const panes = {};

// Dropping within the same dataset+Set List swaps the two slots' contents (a
// reorder). Dropping across a different dataset (or a different Set List in
// the same dataset) copies the source slot's content onto the destination
// slot, leaving the destination's slot positions untouched -- the Norton-
// Commander-style "copy between lists" interaction. Comparing dataset
// identity (not pane identity) is what makes two panes pointed at the same
// dataset behave like one shared document: dragging between them still
// resolves to the one underlying PcgFile. Neither writes anything back to
// disk yet (see STATE.md).
async function onDropEntry(source, target) {
  const sameList = source.datasetId === target.datasetId && source.setlistIndex === target.setlistIndex;

  let result;
  if (sameList) {
    if (source.index === target.index) return;
    result = await window.moveEntry(target.datasetId, target.setlistIndex, source.index, target.index);
    if (!result.ok) {
      setStatus(`Swap failed: ${result.error}`);
      return;
    }
    setStatus(`Swapped slots ${kronosNumber(source.index)} and ${kronosNumber(target.index)}.`);
  } else {
    result = await window.copyEntry(
      source.datasetId, source.setlistIndex, source.index,
      target.datasetId, target.setlistIndex, target.index
    );
    if (!result.ok) {
      setStatus(`Copy failed: ${result.error}`);
      return;
    }
    setStatus(`Copied slot ${kronosNumber(source.index)} -> slot ${kronosNumber(target.index)}.`);
  }

  // Refresh every pane currently showing either affected dataset -- could be
  // 0, 1, or both panes (e.g. both pointed at the same dataset, exactly the
  // "shared gig Set List" case this refactor exists for).
  const affected = new Set([source.datasetId, target.datasetId]);
  for (const pane of Object.values(panes)) {
    if (affected.has(pane.getCurrentDatasetId())) await pane.refreshEntries();
  }
}

document.querySelectorAll(".pane").forEach((root) => {
  const paneId = root.dataset.pane;
  panes[paneId] = createPane(paneId, root, { onDropEntry, log: setStatus });
});

refreshDatasets();  // so every selector (both panes + Library) has data as soon as the bridge is ready

const library = createLibrary(document.getElementById("libraryView"), { log: setStatus });

const setlistsView = document.getElementById("setlistsView");
const libraryView = document.getElementById("libraryView");
let libraryLoadedOnce = false;

document.querySelectorAll(".top-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".top-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");

    const view = tab.dataset.view;
    setlistsView.hidden = view !== "setlists";
    libraryView.hidden = view !== "library";

    // Loaded lazily on first visit rather than at startup -- Programs/
    // Combis lists only make sense once a dataset is selected, and
    // re-fetching on every tab switch would be wasteful busywork for data
    // that doesn't change on its own. Its own dataset selector stays in
    // sync independently of tab visibility (see library.js's
    // onDatasetsChanged subscription), so no extra work is needed here on
    // subsequent visits.
    if (view === "library" && !libraryLoadedOnce) {
      libraryLoadedOnce = true;
      library.refresh();
    }
  });
});
