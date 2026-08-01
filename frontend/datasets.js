// Shared registry of currently-open datasets (loaded .PCG files), decoupled
// from any pane -- see docs/content/components/index.md's dataset section
// and STATE.md's "ARCHITECTURE" notes. Plain script (no build step, no ES
// modules -- matches every other frontend/*.js file), loaded before pane.js/
// library.js in index.html so its functions are available as globals.
//
// The native bridge (or mock_bridge.js) is the single source of truth for
// which datasets exist; this module just caches the last listDatasets()
// result and notifies subscribers (each pane, and the Library view) whenever
// it's refreshed, so a file opened from one pane immediately shows up as a
// selectable option everywhere else too.

let datasetsCache = [];
const listeners = [];

async function refreshDatasets() {
  datasetsCache = await window.listDatasets();
  for (const listener of listeners) listener(datasetsCache);
  return datasetsCache;
}

// Registers `listener(datasets)`, called immediately with whatever's already
// cached, and again every time refreshDatasets() resolves (from anywhere --
// any pane opening/closing a file, not just this listener's own owner).
function onDatasetsChanged(listener) {
  listeners.push(listener);
  listener(datasetsCache);
}

// Repopulates a <select> from the current dataset list, preserving
// `currentValue` (a datasetId, as a string -- <select> values are always
// strings) if it's still present, otherwise falling back to the placeholder.
// Shared by pane.js and library.js so neither duplicates this logic.
function populateDatasetSelect(selectEl, datasets, currentValue) {
  selectEl.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = datasets.length === 0 ? "No files open" : "(select a dataset)";
  selectEl.appendChild(placeholder);
  for (const d of datasets) {
    const opt = document.createElement("option");
    opt.value = String(d.datasetId);
    opt.textContent = d.displayName;
    selectEl.appendChild(opt);
  }
  selectEl.value = datasets.some((d) => String(d.datasetId) === currentValue) ? currentValue : "";
  selectEl.disabled = datasets.length === 0;
}
