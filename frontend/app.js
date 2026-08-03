function setStatus(message) {
  document.getElementById("statusBar").textContent = message;
}

const panes = {};

// Dropping within the same Set List (same dataset) swaps the two slots'
// contents (a reorder). Dropping onto a different Set List in the SAME
// dataset copies the source slot's content onto the destination slot,
// leaving the destination's slot positions untouched -- the Norton-
// Commander-style "copy between lists" interaction. Comparing dataset
// identity (not pane identity) is what makes two panes pointed at the same
// dataset behave like one shared document: dragging between them still
// resolves to the one underlying PcgFile. Neither writes anything back to
// disk yet (see STATE.md).
//
// Copying ACROSS two different datasets is deliberately blocked: a Song
// slot's bank/number is a physical-location reference into its OWN
// dataset's Program/Combi tables, not portable content -- copying it
// as-is into a different dataset could silently point at the wrong
// Program/Combi there (or nothing at all), since bank/number positions
// aren't guaranteed to mean the same thing across two different backups.
// This is the CMB/PRG physical-bank-position problem from the
// explore/sqlite-patch-datastore branch (see STATE.md's "EXPLORATION"
// section) -- revisit once that's solved, not before.
async function onDropEntry(source, target) {
  if (source.datasetId !== target.datasetId) {
    setStatus(
      "Can't copy Set List slots between different datasets yet -- they reference physical Program/Combi " +
        "bank positions that aren't portable across datasets. See STATE.md's EXPLORATION section."
    );
    return;
  }

  const sameList = source.setlistIndex === target.setlistIndex;

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

refreshDatasets();  // so every pane's selectors have data as soon as the bridge is ready
