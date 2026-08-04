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
// Shortened form ("I-A"/"U-A") of Korg's own "INT-A"/"USER-A" naming --
// used everywhere in the UI to save column width (see STATE.md); the full
// "INT-"/"USER-" form is what's actually verified against ground truth
// (docs/README.md, PcgFile.cpp's confirmed Timbre bank codes), so only the
// display layer abbreviates, never the underlying data.
const COMBI_BANK_NAMES = [
  "I-A", "I-B", "I-C", "I-D", "I-E", "I-F", "I-G",
  "U-A", "U-B", "U-C", "U-D", "U-E", "U-F", "U-G",
];

const PROGRAM_BANK_NAMES = [
  "I-A", "I-B", "I-C", "I-D", "I-E", "I-F", "I-G", "G(d)",
  "U-A", "U-B", "U-C", "U-D", "U-E", "U-F",
  "U-AA", "U-BB", "U-CC", "U-DD", "U-EE", "U-FF",
];

// Applies the same "INT-"/"USER-" -> "I-"/"U-" shortening to a full bank
// name coming straight from the bridge (e.g. a Timbre's confirmed
// `bankName`, see library.js's formatTimbreRef()) -- so a ground-truth name
// stored/logged in full still renders shortened, consistent with
// COMBI_BANK_NAMES/PROGRAM_BANK_NAMES above.
function abbreviateBankName(name) {
  return name.replace(/^INT-/, "I-").replace(/^USER-/, "U-");
}

function kronosNumber(n) {
  return String(n).padStart(3, "0");
}

function formatBankNumber(entry) {
  const num = kronosNumber(entry.number);
  const names = entry.isProgram ? PROGRAM_BANK_NAMES : COMBI_BANK_NAMES;
  if (entry.bank >= 0 && entry.bank < names.length) {
    return `${names[entry.bank]} ${num}`;
  }
  // Beyond the stored bank list -- almost certainly a GM/GM2 reference
  // (fixed content, not stored per-file) or corrupt data. Show the raw
  // index rather than guess at a label.
  return `${entry.bank} ${num}`;
}

// Builds a <colgroup> from 12-based column-grid fractions -- Bulma's own
// grid (.column.is-1 .. is-12) is a 12-column system; this applies the same
// convention to table <col> widths, as percentages (e.g. [1,7,1,2,1] ->
// 8.33%/58.33%/8.33%/16.67%/8.33%, summing to 100%) so the table scales
// proportionally with its container instead of being pixel-locked. Paired
// with style.css's `table-layout: fixed` (shared by every real .table in
// this app -- Setlist here, Programs/Combis/Duplicates in library.js) --
// Bulma's .table component styles a real HTML table (colors/borders/
// hover), it doesn't do column-width layout at all, so this is the one
// genuinely irreducible bit of non-Bulma CSS a table still needs. `<col>`
// only accepts a handful of CSS properties (width chief among them), which
// is exactly what's needed here and nothing more.
//
// Fractions don't have to be whole numbers -- a plain float like `1.3`
// nudges a column a bit wider without disturbing the others' ratios. A
// previous version supported `{frac, extraPx}`, baking a flat pixel bump
// into the width via `calc(pct% + Npx)` -- reverted after that made every
// column except the flexible one effectively disappear. `<col>` elements
// have historically had weak, inconsistent cross-engine support for
// anything beyond a plain width value, and this correlates exactly with
// when the widths broke, so calc() on a <col> is being treated as unsafe
// here even though it's spec-legal -- not independently confirmed root-
// caused (no way to inspect the actual rendered layout in this
// environment), but not worth risking a second time either.
function colgroupHtml(fractions12) {
  return (
    "<colgroup>" +
    fractions12
      .map((f) => (f == null ? "<col>" : `<col style="width:${((f / 12) * 100).toFixed(4)}%">`))
      .join("") +
    "</colgroup>"
  );
}

const NO_DATASET_MESSAGE = "No dataset selected -- use the Open... button above, or pick an already-open dataset from the selector.";

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
function createSetlistPanel(container, { paneId, log, onDropEntry, getDatasetId, onJumpToInstrument }) {
  container.innerHTML = `
    <div class="select is-fullwidth is-small">
      <select class="setlist-select" disabled></select>
    </div>
    <div class="setlist-info help">${NO_DATASET_MESSAGE}</div>
    <input class="filter-input input is-small" type="text" placeholder="Filter / search..." disabled />
    <div class="entries-scroll">
      <table class="table is-fullwidth is-hoverable is-narrow setlist-table">
        ${colgroupHtml([
          1.3,   // #
          null,  // Song -- flexible
          1.3,   // Type
          2.6,   // Bank -- the jump-button's "I-C 000" text needs more room than a bare number/type abbreviation
          1.3,   // Vol
        ])}
        <thead>
          <tr>
            <th title="Slot number -- background shows the slot's Color">#</th>
            <th class="col-song">Song</th>
            <th title="Program or Combi">Type</th>
            <th title="Bank / number within bank">Bank</th>
            <th>Vol</th>
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
  function buildCommentEditorRow(entry) {
    const editorTr = document.createElement("tr");
    editorTr.className = "comment-editor-row";

    const td = document.createElement("td");
    td.colSpan = 5;  // #, Song, Type, Bank, Vol -- a real <table> again, so a plain colSpan instead of a grid-column hack

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

    tbody.innerHTML = "";
    for (const entry of visible) {
      const tr = document.createElement("tr");
      tr.draggable = true;
      tr.dataset.index = String(entry.index);
      // Bulma's own `tr.is-selected` highlight (real Bulma table state, not
      // a hand-rolled class) marks which row's Comment editor is open.
      if (expandedIndices.has(entry.index)) tr.classList.add("is-selected");

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
      idxTd.textContent = kronosNumber(entry.index);  // 0-based, matching the Kronos's own 000-127 numbering

      const labelTd = document.createElement("td");
      labelTd.className = "col-song";
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
      const bankTd = document.createElement("td");
      const volTd = document.createElement("td");

      if (entry.paramsFound) {
        typeTd.textContent = entry.isProgram ? "Prog" : "Combi";
        // A button, not plain text: clicking it jumps to this exact
        // Program/Combi in the pane's own Programs/Combis category instead
        // of toggling this row's Comment editor (stopPropagation below
        // keeps the row's own click handler from also firing).
        const bankButton = document.createElement("button");
        bankButton.type = "button";
        bankButton.className = "button is-small bank-jump-button";  // Bulma button, same look as the topbar's Open button
        bankButton.textContent = formatBankNumber(entry);
        bankButton.title = `Show ${entry.isProgram ? "Program" : "Combi"} ${formatBankNumber(entry)} in this pane's Programs/Combis view`;
        bankButton.addEventListener("click", (ev) => {
          ev.stopPropagation();
          onJumpToInstrument({ isProgram: entry.isProgram, bank: entry.bank, number: entry.number });
        });
        bankTd.appendChild(bankButton);
        volTd.textContent = String(entry.volume);
        // Color used to be its own swatch column -- now shown as the "#"
        // cell's own background instead, freeing up a whole column. Not
        // Korg's actual color palette (unknown) -- just a stable, visually
        // distinct hue per color index, same formula as before.
        idxTd.style.background = `hsl(${(entry.color * 47) % 360}, 65%, 25%)`;
        idxTd.title = `Color ${entry.color}`;
      }

      // Hold Time dropped from this row (2026-08-04) -- moving to the
      // Comment editor panel later rather than showing it here; entry.holdTime
      // itself is untouched (still fetched/returned by getEntries()), just
      // not rendered as its own column for now.
      tr.append(idxTd, labelTd, typeTd, bankTd, volTd);
      tbody.appendChild(tr);

      if (expandedIndices.has(entry.index)) {
        tbody.appendChild(buildCommentEditorRow(entry));
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
      <div class="pane-header-row">
        <div class="pane-header-col">
          <div class="select is-small is-fullwidth dataset-select-wrap">
            <select class="dataset-select"></select>
          </div>
        </div>
        <div class="pane-header-col">
          <div class="tabs is-boxed is-small pane-category-tabs">
            <ul>
              <li class="is-active" data-category="setlist"><a>Setlist</a></li>
              <li data-category="programs"><a>Programs</a></li>
              <li data-category="combis"><a>Combis</a></li>
              <li data-category="duplicates"><a>Duplicates</a></li>
            </ul>
          </div>
        </div>
      </div>
    </div>
    <div class="pane-category-content" data-category-panel="setlist"></div>
    <div class="pane-category-content" data-category-panel="library" hidden></div>
  `;

  const datasetSelect = root.querySelector(".dataset-select");
  const categoryTabs = root.querySelectorAll(".pane-category-tabs li");
  const setlistContainer = root.querySelector('[data-category-panel="setlist"]');
  const libraryContainer = root.querySelector('[data-category-panel="library"]');

  let currentDatasetId = null;  // which loaded dataset this pane is showing, if any -- decoupled from paneId
  let knownDatasets = [];       // last list from onDatasetsChanged(), so the dataset-select's change handler can resolve a displayName without a bridge round-trip
  let currentCategory = "setlist";  // "setlist" | "programs" | "combis" | "duplicates"

  function getCurrentDatasetId() {
    return currentDatasetId;
  }

  // Category switching just toggles which container is visible -- no data
  // reload needed on its own, since both renderers already hold current
  // data from the last dataset change (see onDatasetChanged() below).
  // Shared between category-tab clicks and jumpToInstrument() below, so
  // there's one place that keeps the tab-active state and container
  // visibility in sync.
  function switchCategory(category) {
    // Bulma's tabs component puts "active" state on the <li> as `is-active`
    // (not a plain custom class), see style.css's dark-theme override.
    categoryTabs.forEach((t) => t.classList.toggle("is-active", t.dataset.category === category));
    currentCategory = category;

    const isSetlist = category === "setlist";
    setlistContainer.hidden = !isSetlist;
    libraryContainer.hidden = isSetlist;
    if (!isSetlist) libraryPanels.showPanel(category);
  }

  categoryTabs.forEach((tab) => {
    tab.addEventListener("click", () => switchCategory(tab.dataset.category));
  });

  // Called when a Setlist row's Bank button is clicked -- switches this
  // pane to its Programs/Combis category and expands+scrolls to that exact
  // entry, instead of just showing a bank/number label. (Note for later,
  // per STATE.md's EXPLORATION section: once bank-filter buttons exist on
  // the Programs/Combis panels, this needs to also make sure the target
  // bank's filter is "pressed" first, or the jump could land on a filtered-
  // out row.)
  function jumpToInstrument({ isProgram, bank, number }) {
    switchCategory(isProgram ? "programs" : "combis");
    libraryPanels.jumpToEntry(isProgram, bank, number);
  }

  const setlistPanel = createSetlistPanel(setlistContainer, {
    paneId,
    log,
    onDropEntry,
    getDatasetId: getCurrentDatasetId,
    onJumpToInstrument: jumpToInstrument,
  });
  const libraryPanels = createLibraryPanels(libraryContainer, {
    log,
    getDatasetId: getCurrentDatasetId,
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

  // Exposed so app.js's onDropEntry knows which pane(s) are currently
  // showing an affected dataset after a move/copy, and need refreshing --
  // could be 0, 1, or both panes, e.g. when both point at the same dataset.
  // `loadDataset`/`isEmpty` are exposed for app.js's single, global Open
  // button (see index.html's topbar) to pick a pane to land a newly-opened
  // dataset in, now that opening is no longer a per-pane action.
  return {
    refreshEntries: setlistPanel.refreshEntries,
    getCurrentDatasetId,
    loadDataset,
    isEmpty: () => currentDatasetId == null,
  };
}
