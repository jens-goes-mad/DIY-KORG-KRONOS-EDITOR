function setStatus(message) {
  document.getElementById("statusBar").textContent = message;
}

const panes = {};

// Dropping within the same pane swaps the two slots' contents (a reorder).
// Dropping across panes copies the source slot's content onto the
// destination slot, leaving the destination pane's slot positions
// untouched -- this is the Norton-Commander-style "copy between lists"
// interaction. Neither writes anything back to disk yet (see STATE.md).
async function onDropEntry(source, target) {
  const sameSetlist = source.pane === target.pane && source.setlistIndex === target.setlistIndex;

  if (sameSetlist) {
    if (source.index === target.index) return;
    const result = await window.moveEntry(target.pane, target.setlistIndex, source.index, target.index);
    if (!result.ok) {
      setStatus(`Swap failed: ${result.error}`);
      return;
    }
    setStatus(`Swapped slots ${kronosNumber(source.index)} and ${kronosNumber(target.index)} in pane ${target.pane}.`);
    await panes[target.pane].refreshEntries();
  } else {
    const result = await window.copyEntry(
      source.pane, source.setlistIndex, source.index,
      target.pane, target.setlistIndex, target.index
    );
    if (!result.ok) {
      setStatus(`Copy failed: ${result.error}`);
      return;
    }
    setStatus(
      `Copied pane ${source.pane} slot ${kronosNumber(source.index)} -> pane ${target.pane} slot ${kronosNumber(target.index)}.`
    );
    await panes[target.pane].refreshEntries();
  }
}

document.querySelectorAll(".pane").forEach((root) => {
  const paneId = root.dataset.pane;
  panes[paneId] = createPane(paneId, root, { onDropEntry, log: setStatus });
});
