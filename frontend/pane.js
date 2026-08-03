// One Norton-Commander-style pane: a thin shell (one dataset selector, one
// category navbar -- Setlist/Programs/Combis/Duplicates, Global later once
// GLB1 is ever parsed) around two content renderers -- createSetlistPanel()
// below, and library.js's createLibraryPanels() -- so a pane can show any
// category of any already-open dataset, independent of the other pane. Two
// shells are created by app.js ("A" and "B") so Setlist slots can be
// dragged between them.
// Korg's own bank naming, from a song slot's raw `bank` byte. Combi (14
// banks, 0-13) is mechanically confirmed -- cross-referencing CBK1 by this
// exact order reproduces known real Combi names exactly (see README.md).
// Program (bank 0-19) is NOT independently confirmed the same way -- the
// project owner gave us this label order, but we only know it maps onto
// the file's 20 real PRG1 banks positionally, not that position-for-
// position it's exactly this list (GM itself, per the project owner's own
// list, doesn't get a stored bank at all -- real slot data references it
// via bank values >=20, which have no corresponding stored bank and are
// deliberately left showing a raw index rather than a guessed label).
const COMBI_BANK_NAMES = [
  "INT-A", "INT-B", "INT-C", "INT-D", "INT-E", "INT-F", "INT-G",
  "USER-A", "USER-B", "USER-C", "USER-D", "USER-E", "USER-F", "USER-G",
];

const PROGRAM_BANK_NAMES = [
  "INT-A", "INT-B", "INT-C", "INT-D", "INT-E", "INT-F", "INT-G", "G(d)",
  "USER-A", "USER-B", "USER-C", "USER-D", "USER-E", "USER-F",
  "USER-AA", "USER-BB", "USER-CC", "USER-DD", "USER-EE", "USER-FF",
];

function kronosNumber(n) {
  return String(n).padStart(3, "0");
}

function formatBankNumber(entry) {
  const num = kronosNumber(entry.number);
  const names = entry.isProgram ? PROGRAM_BANK_NAMES : COMBI_BANK_NAMES;
  if (entry.bank >= 0 && entry.bank < names.length) {
    return `${names[entry.bank]}-${num}`;
  }
  // Beyond the stored bank list -- almost certainly a GM/GM2 reference
  // (fixed content, not stored per-file) or corrupt data. Show the raw
  // index rather than guess at a label.
  return `${entry.bank}-${num}`;
}

const NO_DATASET_MESSAGE = "No dataset selected -- drag a .PCG file onto this pane, or pick an already-open one above.";

// Shared across every pane's Setlist rows during a same-page row drag --
// lets a row being dragged OVER (not just dropped on) know which dataset
// the drag actually originated from, so a cross-dataset drop can be shown
// as rejected during hover, not just after release. HTML5's DataTransfer
// payload isn't readable during dragover for security reasons, but since
// this is a same-page drag (not a file dragged in from Finder/Explorer), a
// plain shared variable works fine as a side channel. The actual block
// (app.js's onDropEntry) doesn't depend on this -- it's purely a visual
// hint, see that function's own doc comment for why cross-dataset Setlist
// copies are rejected at all.
let draggedFromDatasetId = null;

// The Setlist category's own content: a Set List picker + a filterable,
// searchable, drag-and-drop-able table of that Set List's 128 song slots,
// plus the per-slot Comment editor. Extracted out of the pane shell so it's
// a peer of library.js's createLibraryPanels() -- both are just "renderers"
// the shell mounts/hides depending on which category button is active.
// Reads the dataset to show via getDatasetId() (owned by the shell) rather
// than tracking it itself, matching createLibraryPanels()'s same contract.
function createSetlistPanel(container, { paneId, log, onDropEntry, getDatasetId }) {
  container.innerHTML = `
    <select class="setlist-select" disabled></select>
    <div class="setlist-info">${NO_DATASET_MESSAGE}</div>
    <input class="filter-input" type="text" placeholder="Filter / search..." disabled />
    <div class="entries-scroll">
      <table class="entries-table">
        <thead>
          <tr>
            <th class="col-index">#</th>
            <th>Song</th>
            <th class="col-narrow" title="Program or Combi">Type</th>
            <th class="col-bank" title="Bank / number within bank">Bank</th>
            <th class="col-narrow">Vol</th>
            <th class="col-narrow" title="Hold Time">Hold</th>
            <th class="col-narrow">Color</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
  `;

  const setlistSelect = container.querySelector(".setlist-select");
  const infoEl = container.querySelector(".setlist-info");
  const filterInput = container.querySelector(".filter-input");
  const tbody = container.querySelector("tbody");

  let setlists = [];        // [{index, name}], as returned by listSetlists()
  let currentSetlistIndex = -1;
  let entries = [];         // [{index, label}], as returned by getEntries()
  let filterText = "";
  // Which songs' Comment editors are currently open -- a Set, not a single
  // index, so opening one row's editor doesn't close another's (per
  // explicit request: multiple can stay open across rows/panes at once).
  let expandedIndices = new Set();

  const COMMENT_EDITOR_MIN_ROWS = 10;

  // Grows the textarea to fit its content (no internal scrollbar) but never
  // shrinks below COMMENT_EDITOR_MIN_ROWS worth of height.
  function autoSizeCommentEditor(textarea) {
    textarea.style.height = "auto";
    textarea.style.height = `${Math.max(textarea.scrollHeight, textarea.minHeightPx)}px`;
  }

  // Comment editor -- click a row to expand a multiline-editable panel below
  // it (same click-to-expand-inline interaction as DIY-MIDI-METRONOME's
  // EDITOR trigger list), Apply writes it back via setComment(). A plain
  // <textarea> is used (not contenteditable) so \r\n line breaks Just Work
  // via normal textarea semantics, no extra handling needed. Sized to show
  // at least 10 lines, growing to fit longer content instead of scrolling.
  function buildCommentEditorRow(entry, columnCount) {
    const editorTr = document.createElement("tr");
    editorTr.className = "comment-editor-row";

    const td = document.createElement("td");
    td.colSpan = columnCount;

    const textarea = document.createElement("textarea");
    textarea.className = "comment-editor";
    textarea.rows = COMMENT_EDITOR_MIN_ROWS;
    textarea.value = entry.comment || "";
    textarea.placeholder = "Comment (supports line breaks)...";
    textarea.addEventListener("input", () => autoSizeCommentEditor(textarea));

    const applyBtn = document.createElement("button");
    applyBtn.type = "button";
    applyBtn.textContent = "Apply";
    applyBtn.addEventListener("click", async () => {
      const result = await window.setComment(getDatasetId(), currentSetlistIndex, entry.index, textarea.value);
      if (!result.ok) {
        log(`[Pane ${paneId}] ${result.error}`);
        return;
      }
      entry.comment = textarea.value;
      renderRows();
    });

    const row = document.createElement("div");
    row.className = "comment-editor-row-inner";
    row.append(textarea, applyBtn);
    td.appendChild(row);
    editorTr.appendChild(td);

    // Measured after the row is actually in the DOM (scrollHeight needs
    // layout), and only then grown to fit content taller than 10 rows.
    requestAnimationFrame(() => {
      textarea.minHeightPx = textarea.clientHeight;
      autoSizeCommentEditor(textarea);
    });

    return editorTr;
  }

  function renderRows() {
    const needle = filterText.trim().toLowerCase();
    const visible = needle ? entries.filter((e) => e.label.toLowerCase().includes(needle)) : entries;
    const columnCount = 7;

    tbody.innerHTML = "";
    for (const entry of visible) {
      const tr = document.createElement("tr");
      tr.draggable = true;
      tr.dataset.index = String(entry.index);
      if (expandedIndices.has(entry.index)) tr.classList.add("expanded");

      tr.addEventListener("click", () => {
        if (expandedIndices.has(entry.index)) {
          expandedIndices.delete(entry.index);
        } else {
          expandedIndices.add(entry.index);
        }
        renderRows();
      });

      tr.addEventListener("dragstart", (ev) => {
        draggedFromDatasetId = getDatasetId();
        ev.dataTransfer.setData(
          "application/json",
          JSON.stringify({ datasetId: getDatasetId(), setlistIndex: currentSetlistIndex, index: entry.index })
        );
        ev.dataTransfer.effectAllowed = "copyMove";
      });
      tr.addEventListener("dragend", () => {
        draggedFromDatasetId = null;
      });
      tr.addEventListener("dragover", (ev) => {
        // Cross-dataset Setlist copies are rejected outright (see app.js's
        // onDropEntry) -- don't even show this row as a valid drop target,
        // and don't preventDefault() so the browser's own "not allowed"
        // cursor takes over and no `drop` event fires here at all.
        if (draggedFromDatasetId != null && draggedFromDatasetId !== getDatasetId()) {
          tr.classList.remove("drop-target");
          return;
        }
        ev.preventDefault();
        ev.dataTransfer.dropEffect = "move";
        tr.classList.add("drop-target");
      });
      tr.addEventListener("dragleave", () => tr.classList.remove("drop-target"));
      tr.addEventListener("drop", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();  // don't also trigger the pane's file-drop handler
        tr.classList.remove("drop-target");
        const raw = ev.dataTransfer.getData("application/json");
        if (!raw) return;
        onDropEntry(JSON.parse(raw), { datasetId: getDatasetId(), setlistIndex: currentSetlistIndex, index: entry.index });
      });

      const idxTd = document.createElement("td");
      idxTd.className = "col-index";
      idxTd.textContent = kronosNumber(entry.index);  // 0-based, matching the Kronos's own 000-127 numbering

      const labelTd = document.createElement("td");
      labelTd.textContent = entry.label || "(empty)";
      if (entry.comment) {
        labelTd.classList.add("has-comment");
        labelTd.title = entry.comment;
      }
      // The Combi/Program's OWN name (cross-referenced from the instrument
      // bank, see README.md) -- shown always, even when it matches the
      // slot's own label, so it's visible that the lookup actually found
      // something (per explicit request, not just shown on mismatch).
      if (entry.instrumentName) {
        const instrumentEl = document.createElement("div");
        instrumentEl.className = "instrument-name";
        instrumentEl.textContent = entry.instrumentName;
        labelTd.appendChild(instrumentEl);
      } else if (entry.paramsFound && !entry.instrumentName && entry.label) {
        // A real assignment exists (bank/number), but nothing in this
        // file's instrument banks matched it -- almost always a GM/GM2
        // reference (fixed content the file doesn't store, bank >=20 for
        // Program / >=14 for Combi -- see README.md), occasionally a
        // corrupt bank value in that one slot. Shown explicitly rather
        // than silently blank, so it doesn't read as "lookup is broken."
        const instrumentEl = document.createElement("div");
        instrumentEl.className = "instrument-name instrument-name-unknown";
        instrumentEl.textContent = `(${formatBankNumber(entry)} not in this file -- likely GM)`;
        labelTd.appendChild(instrumentEl);
      }

      const typeTd = document.createElement("td");
      typeTd.className = "col-narrow";
      const bankTd = document.createElement("td");
      bankTd.className = "col-bank";
      const volTd = document.createElement("td");
      volTd.className = "col-narrow";
      const holdTd = document.createElement("td");
      holdTd.className = "col-narrow";
      const colorTd = document.createElement("td");
      colorTd.className = "col-narrow";

      if (entry.paramsFound) {
        typeTd.textContent = entry.isProgram ? "Prog" : "Combi";
        bankTd.textContent = formatBankNumber(entry);
        volTd.textContent = String(entry.volume);
        holdTd.textContent = String(entry.holdTime);
        // Not Korg's actual color palette (unknown) -- just a stable,
        // visually distinct swatch per color index for now.
        const swatch = document.createElement("span");
        swatch.className = "color-swatch";
        swatch.style.background = `hsl(${(entry.color * 47) % 360}, 65%, 45%)`;
        swatch.title = `Color ${entry.color}`;
        colorTd.appendChild(swatch);
      }

      tr.append(idxTd, labelTd, typeTd, bankTd, volTd, holdTd, colorTd);
      tbody.appendChild(tr);

      if (expandedIndices.has(entry.index)) {
        tbody.appendChild(buildCommentEditorRow(entry, columnCount));
      }
    }
  }

  async function refreshEntries() {
    const datasetId = getDatasetId();
    if (datasetId == null || currentSetlistIndex < 0) {
      entries = [];
    } else {
      entries = await window.getEntries(datasetId, currentSetlistIndex);
    }
    renderRows();
  }

  function populateSetlistSelect() {
    setlistSelect.innerHTML = "";
    for (const s of setlists) {
      const opt = document.createElement("option");
      opt.value = String(s.index);
      opt.textContent = `${kronosNumber(s.index)}  ${s.name}`;
      setlistSelect.appendChild(opt);
    }
    setlistSelect.disabled = setlists.length === 0;
  }

  setlistSelect.addEventListener("change", async () => {
    currentSetlistIndex = Number(setlistSelect.value);
    filterText = "";
    filterInput.value = "";
    expandedIndices.clear();  // don't carry an open Comment editor over to a different Set List's song at the same index
    await refreshEntries();
  });

  filterInput.addEventListener("input", () => {
    filterText = filterInput.value;
    renderRows();
  });

  // Called by the shell whenever its shared dataset selection changes --
  // either a fresh dataset (displayName given) or the dataset this pane was
  // showing having been closed elsewhere (displayName omitted/getDatasetId()
  // already null by the time this runs).
  async function onDatasetChanged(displayName) {
    const datasetId = getDatasetId();
    if (datasetId == null) {
      setlists = [];
      currentSetlistIndex = -1;
      populateSetlistSelect();
      entries = [];
      filterText = "";
      filterInput.value = "";
      filterInput.disabled = true;
      expandedIndices.clear();
      infoEl.textContent = NO_DATASET_MESSAGE;
      renderRows();
      return;
    }

    setlists = await window.listSetlists(datasetId);
    populateSetlistSelect();
    currentSetlistIndex = setlists.length > 0 ? setlists[0].index : -1;
    if (currentSetlistIndex >= 0) setlistSelect.value = String(currentSetlistIndex);

    // Switching a pane to a different dataset must not leak state from
    // whatever was showing before -- a stale filter could hide entries in
    // the new dataset entirely, and a stale expanded Comment editor would
    // reopen on whatever song now happens to share that index.
    filterText = "";
    filterInput.value = "";
    expandedIndices.clear();

    infoEl.textContent = `Showing ${displayName}`;
    filterInput.disabled = setlists.length === 0;
    await refreshEntries();
    log(`[Pane ${paneId}] Showing ${displayName}`);
  }

  return { refreshEntries, onDatasetChanged };
}

function createPane(paneId, root, { onDropEntry, log }) {
  root.innerHTML = `
    <div class="pane-header">
      <select class="dataset-select"></select>
      <nav class="lib-tabs pane-category-tabs">
        <button class="lib-tab active" type="button" data-category="setlist">Setlist</button>
        <button class="lib-tab" type="button" data-category="programs">Programs</button>
        <button class="lib-tab" type="button" data-category="combis">Combis</button>
        <button class="lib-tab" type="button" data-category="duplicates">Duplicates</button>
      </nav>
    </div>
    <div class="pane-category-content" data-category-panel="setlist"></div>
    <div class="pane-category-content" data-category-panel="library" hidden></div>
  `;

  const datasetSelect = root.querySelector(".dataset-select");
  const categoryTabs = root.querySelectorAll(".pane-category-tabs .lib-tab");
  const setlistContainer = root.querySelector('[data-category-panel="setlist"]');
  const libraryContainer = root.querySelector('[data-category-panel="library"]');

  let currentDatasetId = null;  // which loaded dataset this pane is showing, if any -- decoupled from paneId
  let knownDatasets = [];       // last list from onDatasetsChanged(), so the dataset-select's change handler can resolve a displayName without a bridge round-trip
  let currentCategory = "setlist";  // "setlist" | "programs" | "combis" | "duplicates"

  function getCurrentDatasetId() {
    return currentDatasetId;
  }

  const setlistPanel = createSetlistPanel(setlistContainer, {
    paneId,
    log,
    onDropEntry,
    getDatasetId: getCurrentDatasetId,
  });
  const libraryPanels = createLibraryPanels(libraryContainer, {
    log,
    getDatasetId: getCurrentDatasetId,
  });

  // Category switching just toggles which container is visible -- no data
  // reload needed on its own, since both renderers already hold current
  // data from the last dataset change (see onDatasetChanged() below).
  categoryTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      categoryTabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      currentCategory = tab.dataset.category;

      const isSetlist = currentCategory === "setlist";
      setlistContainer.hidden = !isSetlist;
      libraryContainer.hidden = isSetlist;
      if (!isSetlist) libraryPanels.showPanel(currentCategory);
    });
  });

  // Displays an already-open dataset in this pane -- called both right after
  // a fresh file drop (a new dataset) and when the dataset-select's change
  // handler switches to a dataset another pane already opened. Notifies
  // BOTH content renderers regardless of which category is currently
  // visible, so switching back to a hidden category later still shows
  // fresh data instead of whatever was last loaded.
  async function loadDataset(datasetId, displayName) {
    currentDatasetId = datasetId;
    datasetSelect.value = String(datasetId);
    await setlistPanel.onDatasetChanged(displayName);
    await libraryPanels.onDatasetChanged();
  }

  // Back to the "nothing selected" state -- used both for the dataset-select's
  // own placeholder option and when the dataset this pane was showing gets
  // closed from elsewhere (another pane).
  async function resetToEmpty() {
    currentDatasetId = null;
    await setlistPanel.onDatasetChanged();
    await libraryPanels.onDatasetChanged();
  }

  datasetSelect.addEventListener("change", async () => {
    const value = datasetSelect.value;
    if (!value) {
      await resetToEmpty();
      return;
    }
    const datasetId = Number(value);
    const dataset = knownDatasets.find((d) => d.datasetId === datasetId);
    await loadDataset(datasetId, dataset ? dataset.displayName : "");
  });

  // Fires immediately with whatever's already cached, and again whenever any
  // pane (or another pane's Library categories) opens/closes a dataset --
  // keeps this pane's selector (and its own currently-shown dataset, if it
  // just got closed elsewhere) in sync without needing a bespoke pub/sub
  // per action.
  onDatasetsChanged((datasets) => {
    knownDatasets = datasets;
    populateDatasetSelect(datasetSelect, datasets, currentDatasetId != null ? String(currentDatasetId) : "");
    const stillOpen = currentDatasetId != null && datasets.some((d) => d.datasetId === currentDatasetId);
    if (currentDatasetId != null && !stillOpen) resetToEmpty();
  });

  // Drag-and-drop a file from Finder/Explorer straight onto the pane -- the
  // native "Open File" dialog (triggered via a hidden <input type=file>)
  // opens a real NSOpenPanel/GTK/Win32 picker but on macOS it currently
  // appears behind the app window instead of in front (a choc/WKWebView
  // z-order quirk, not something this app controls) -- see STATE.md. Drag
  // and drop sidesteps it entirely, and also works without ever needing an
  // absolute filesystem path: the browser's File API hands over real file
  // bytes directly, which is why openFileBytes() exists alongside openFile().
  // Drag depth counter instead of a plain add/remove pair: dragenter/
  // dragleave fire per-element as the pointer crosses into/out of CHILD
  // elements too (the entries table, the dataset-select, ...), and since
  // only root has a listener, a dragleave crossing into a child arrives
  // with ev.target set to that child, not root -- the old `ev.target ===
  // root` guard could then simply never fire again for the rest of that
  // hover, leaving the highlight stuck. Counting enters/leaves is immune to
  // that regardless of which descendant the event targets.
  let dragDepth = 0;
  root.addEventListener("dragenter", (ev) => {
    if (!ev.dataTransfer.types.includes("Files")) return;
    ev.preventDefault();
    dragDepth++;
    root.classList.add("drag-over");
  });
  root.addEventListener("dragover", (ev) => {
    if (!ev.dataTransfer.types.includes("Files")) return;
    ev.preventDefault();  // still required on every dragover for drop to be allowed
  });
  root.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) root.classList.remove("drag-over");
  });
  root.addEventListener("drop", async (ev) => {
    if (!ev.dataTransfer.files || ev.dataTransfer.files.length === 0) return;
    ev.preventDefault();
    dragDepth = 0;
    // Clear EVERY pane's highlight, not just this one -- a drag that
    // passed over a sibling pane on the way here can otherwise leave that
    // pane's highlight stuck even after this drop lands somewhere else.
    document.querySelectorAll(".pane").forEach((p) => p.classList.remove("drag-over"));

    const file = ev.dataTransfer.files[0];
    log(`[Pane ${paneId}] Loading ${file.name}...`);
    try {
      const base64 = await arrayBufferToBase64(await file.arrayBuffer());
      const result = await window.openFileBytes(base64, file.name);
      if (!result.ok) {
        log(`[Pane ${paneId}] ${result.error}`);
        return;
      }
      // Dropping always creates a NEW dataset -- refresh the shared registry
      // first so every selector (the other pane, this pane's own Library
      // categories) learns about it too, then show it in THIS pane
      // specifically. The other pane keeps showing whatever it already
      // had, unless the user picks this same dataset from its own selector.
      await refreshDatasets();
      await loadDataset(result.datasetId, result.displayName);
    } catch (err) {
      log(`[Pane ${paneId}] ${err}`);
    }
  });

  // Exposed so app.js's onDropEntry knows which pane(s) are currently
  // showing an affected dataset after a move/copy, and need refreshing --
  // could be 0, 1, or both panes, e.g. when both point at the same dataset.
  return { refreshEntries: setlistPanel.refreshEntries, getCurrentDatasetId };
}

// Chunked to avoid blowing the call-stack limit of String.fromCharCode.apply
// on large files (Kronos backups run 50-70MB).
async function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
