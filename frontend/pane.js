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

// Real Kronos Set List slot color names (16 total, matching SlotParams'
// 1-based `color` field -- see PcgFile.h §4.3), from the official Korg
// manual. Order is NOT yet independently confirmed against a real Kronos --
// this is the order they were given in (reads like the on-device menu
// order), kept as the working assumption until cross-checked against real
// hardware, per this project's "no guessing" standard -- see STATE.md.
const SETLIST_COLOR_NAMES = [
  "Standard", "Blue", "Ivy", "Gold", "Rose", "Azure", "Red", "Orange",
  "Yellow", "Green", "Cyan", "Purple", "Magenta", "Brown", "Black", "White",
];

// This project's own muted approximation of each named color above (not
// sampled from real hardware -- Korg's exact palette isn't known any more
// than the ordering is), bumped up a bit from an earlier, darker pass (per
// explicit feedback that they read as too dark/muted) while still dark
// enough that the existing dim-gray cell text (.col-index) stays legible on
// top of any of them. Same index (0-based here, color field is 1-based) as
// SETLIST_COLOR_NAMES.
const SETLIST_COLOR_HEX = [
  "#8e8e8e", // Standard (Grau/Dunkelgrau)
  "#426bbd", // Blue (Blau)
  "#507946", // Ivy (Efeu-Grün)
  "#b6912d", // Gold (Gold/Gelb)
  "#b6566e", // Rose (Rosa/Hellrot)
  "#428db6", // Azure (Azurblau/Hellblau)
  "#b64242", // Red (Rot)
  "#b6792d", // Orange
  "#b6a82d", // Yellow (Gelb)
  "#428e46", // Green (Grün)
  "#2da2a2", // Cyan (Cyan/Türkis)
  "#7942b6", // Purple (Violett)
  "#a242a2", // Magenta
  "#79542d", // Brown (Braun)
  "#262626", // Black (Schwarz)
  "#a8a8a8", // White (Weiss) -- real white would wreck the dim-gray text's contrast, see .col-index
];

// entry.color is 1-based -- falls back to Standard rather than guessing if
// it's ever out of the confirmed 1..16 range.
function setlistColorHex(color) {
  return SETLIST_COLOR_HEX[color - 1] || SETLIST_COLOR_HEX[0];
}

function setlistColorName(color) {
  return SETLIST_COLOR_NAMES[color - 1] || `Color ${color}`;
}

function kronosNumber(n) {
  return String(n).padStart(3, "0");
}

// `bankType` ("HD-1"/"EXi", see EditorBridge::getProgramBankTypes()) is
// optional and only ever shown for Programs -- Combis have no engine type of
// their own, so it's ignored whenever entry.isProgram is false, regardless
// of what's passed. Per-file data, not a hardcoded table -- see
// PcgFile.h's ProgramBankType doc comment: Kronos OS 3.0+ lets a user
// reassign INT Program Banks between HD-1 and EXi.
function formatBankNumber(entry, bankType) {
  const num = kronosNumber(entry.number);
  const names = entry.isProgram ? PROGRAM_BANK_NAMES : COMBI_BANK_NAMES;
  const label =
    entry.bank >= 0 && entry.bank < names.length
      ? `${names[entry.bank]} ${num}`
      : // Beyond the stored bank list -- almost certainly a GM/GM2 reference
        // (fixed content, not stored per-file) or corrupt data. Show the raw
        // index rather than guess at a label.
        `${entry.bank} ${num}`;
  return entry.isProgram && bankType ? `${label} (${bankType})` : label;
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

// Lazily loads the two pure-JS SBK1 record codecs (frontend/components/
// kronos/setlist-comment.js, setlist-slot-params.js) the Setlist row
// editors below use to read-modify-write raw bytes -- a dynamic import()
// expression works from inside this plain (non-module) script without
// converting index.html's scripts to type="module", see STATE.md. Cached
// in one shared promise so opening a second editor (same pane or the
// other one) doesn't re-trigger a second import; the browser's own module
// cache would dedupe the actual fetch anyway, but this also dedupes the
// in-flight Promise for callers that race each other. `resolvedSlotCodecs`
// holds the already-settled value so row-builders (called synchronously
// from renderRows(), see toggleEditor()'s own comment for why that's safe)
// can use the codecs without themselves being async.
let slotCodecsPromise = null;
let resolvedSlotCodecs = null;
function loadSlotCodecs() {
  if (!slotCodecsPromise) {
    slotCodecsPromise = Promise.all([
      import("./components/kronos/setlist-comment.js"),
      import("./components/kronos/setlist-slot-params.js"),
    ]).then(([comment, slotParams]) => {
      resolvedSlotCodecs = { ...comment, ...slotParams };
      return resolvedSlotCodecs;
    });
  }
  return slotCodecsPromise;
}

// Shared across every pane instance (both "A" and "B" are separate
// createSetlistPanel() closures) -- keyed by "datasetId:setlistIndex:
// songIndex", value is the paneId currently holding at least one editor
// open on that exact slot. Two panes CAN legitimately show the same Set
// List at once (both pointed at the same dataset -- a real, supported
// setup, see the Datasets architecture in STATE.md); if they did and both
// opened an editor on the same slot, each pane's raw-bytes cache below is
// its own independent copy of those 542 bytes, so whichever pane committed
// second would silently overwrite whatever the other had just written --
// the same class of bug multi-open already had to solve for within one
// pane (see commitSlotBytes()'s own comment), just across panes instead of
// across editor types within a row. Blocking a second pane from opening
// the SAME slot at all avoids the race outright, rather than trying to
// detect or merge a conflicting write after the fact.
const openSlotEditors = new Map();
function slotEditorKey(datasetId, setlistIndex, songIndex) {
  return `${datasetId}:${setlistIndex}:${songIndex}`;
}

// The Setlist category's own content: a Set List picker + a filterable,
// searchable, drag-and-drop-able table of that Set List's 128 song slots,
// plus the per-slot Comment editor. Extracted out of the pane shell so it's
// a peer of library.js's createLibraryPanels() -- both are just "renderers"
// the shell mounts/hides depending on which category button is active.
// Reads the dataset to show via getDatasetId() (owned by the shell) rather
// than tracking it itself, matching createLibraryPanels()'s same contract.
function createSetlistPanel(container, { paneId, log, showToast, onDropEntry, getDatasetId, getProgramBankType, onJumpToInstrument }) {
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
          3.5,   // Bank -- room for "I-C 000" plus an optional "(HD-1)"/"(EXi)" suffix (wraps onto a 2nd line if it still doesn't fit, see .bank-jump-button)
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
  // Which editors are open, per song -- songIndex -> Set of
  // "comment"|"color"|"volume", not a single flag, so several editor types
  // can stay open on the SAME row at once (per explicit request), and
  // independently across every OTHER row/pane too -- except the exact same
  // slot in another pane showing the same Set List of the same dataset,
  // which openSlotEditors below deliberately blocks (a real, not
  // hypothetical, setup -- see its own comment).
  let expandedTypes = new Map();
  // One shared raw-bytes cache per row with at least one editor open, keyed
  // by songIndex -- Comment/Color/Volume editors on the same row all
  // read/write through the same cached Uint8Array (see commitSlotBytes())
  // rather than each fetching (and each other's writes silently discarding)
  // their own copy -- see STATE.md for why Comment was retrofitted onto
  // this same raw-byte path once multi-open made that a real correctness
  // risk, not just a style choice. Populated lazily in getSlotBytes(),
  // dropped once every editor on that row closes.
  let slotBytesCache = new Map();

  function isExpanded(songIndex) {
    const set = expandedTypes.get(songIndex);
    return !!set && set.size > 0;
  }

  // Fetches (once per row) and caches this row's raw 542-byte SBK1 record.
  async function getSlotBytes(entry) {
    if (slotBytesCache.has(entry.index)) return slotBytesCache.get(entry.index);
    const result = await window.getSongRecordBytes(getDatasetId(), currentSetlistIndex, entry.index);
    if (!result.ok) {
      log(`[Pane ${paneId}] ${result.error}`);
      return null;
    }
    const bytes = Uint8Array.from(result.bytes);
    slotBytesCache.set(entry.index, bytes);
    return bytes;
  }

  // Opens/closes one editor type on one row. Closing never needs to touch
  // the network, so it re-renders immediately; opening awaits both the
  // codecs and this row's raw bytes FIRST and only marks the type as open
  // once both are ready -- row-builders below (called synchronously from
  // renderRows()) can then assume slotBytesCache/resolvedSlotCodecs are
  // populated for any type that's actually in expandedTypes, no per-row
  // "still loading" state needed.
  async function toggleEditor(entry, type) {
    const key = slotEditorKey(getDatasetId(), currentSetlistIndex, entry.index);
    const current = expandedTypes.get(entry.index);
    if (current && current.has(type)) {
      current.delete(type);
      if (current.size === 0) {
        expandedTypes.delete(entry.index);
        slotBytesCache.delete(entry.index);
        openSlotEditors.delete(key);
      }
      renderRows();
      return;
    }

    // Refuse to open if another pane already has this exact slot open --
    // see openSlotEditors' own comment for the race this avoids. Not this
    // pane's own lock, though: re-opening a second editor type on a slot
    // THIS pane already has open is exactly the normal multi-open case. A
    // toast (not just the persistent status bar) because this is a click
    // that visibly did nothing -- without an in-the-moment popup, it just
    // looks broken rather than deliberately blocked.
    const owner = openSlotEditors.get(key);
    if (owner != null && owner !== paneId) {
      showToast(`This Set List slot is already being edited in Pane ${owner}.`);
      return;
    }

    const [bytes] = await Promise.all([getSlotBytes(entry), loadSlotCodecs()]);
    if (bytes == null) return;  // getSlotBytes() already logged the error

    const updated = expandedTypes.get(entry.index) || new Set();
    updated.add(type);
    expandedTypes.set(entry.index, updated);
    openSlotEditors.set(key, paneId);
    renderRows();
  }

  // Releases every cross-pane edit-lock THIS pane currently holds (see
  // openSlotEditors above) -- called anywhere expandedTypes is about to be
  // cleared wholesale (Set List switch, dataset switch), so a lock never
  // outlives the editor state it was protecting. Brute-force scan is fine
  // here: at most a couple of entries are ever locked at once.
  function releaseAllSlotLocks() {
    for (const [key, owner] of openSlotEditors) {
      if (owner === paneId) openSlotEditors.delete(key);
    }
  }

  // Writes `newBytes` back via the bridge, updates the shared cache and
  // this row's own already-in-memory display fields (comment/color/volume)
  // straight from the codecs (no refetch needed), then re-renders -- the
  // single write path every editor below (Comment/Color/Volume) commits
  // through, so none of them can silently discard another's in-flight edit
  // on the same row.
  async function commitSlotBytes(entry, newBytes) {
    const result = await window.putSongRecordBytes(getDatasetId(), currentSetlistIndex, entry.index, Array.from(newBytes));
    if (!result.ok) {
      log(`[Pane ${paneId}] ${result.error}`);
      return;
    }
    slotBytesCache.set(entry.index, newBytes);
    const codecs = await loadSlotCodecs();
    entry.comment = codecs.decodeSetlistComment(newBytes).comment;
    entry.color = codecs.decodeSlotColor(newBytes);
    entry.volume = codecs.decodeSlotVolume(newBytes);
    renderRows();
  }

  // Shared shell every editor row below builds on: a <tr> spanning all 5
  // columns (a real <table> again, so a plain colSpan instead of a grid-
  // column hack), wrapping whatever `buildContent()` returns as the cell's
  // one child. Every editor row carries BOTH the generic "editor-row" class
  // (style.css's shared left-border/padding treatment, one rule instead of
  // a per-type selector list) and its own specific class (comment-editor-
  // row/color-editor-row/volume-editor-row) as a hook for anything that
  // ever needs to style one type differently -- nothing does yet, but the
  // hook costs nothing to keep. Open/close state itself already lives in
  // expandedTypes/toggleEditor() above -- this only dedupes the identical
  // <tr>/<td colSpan> construction the three row-builders would otherwise
  // each repeat by hand. There's nothing to clean up on close beyond this:
  // a closed row's <tr> simply isn't rebuilt into the next renderRows()
  // pass (tbody.innerHTML = "" there), so it's fully gone from the DOM the
  // moment its type leaves expandedTypes -- no separate removal step.
  function buildEditorRow(className, buildContent) {
    const editorTr = document.createElement("tr");
    editorTr.classList.add("editor-row", className);
    const td = document.createElement("td");
    td.colSpan = 5;  // #, Song, Type, Bank, Vol
    td.appendChild(buildContent());
    editorTr.appendChild(td);
    return editorTr;
  }

  const COMMENT_EDITOR_MIN_ROWS = 10;

  // Grows the textarea to fit its content (no internal scrollbar) but never
  // shrinks below COMMENT_EDITOR_MIN_ROWS worth of height.
  function autoSizeCommentEditor(textarea) {
    textarea.style.height = "auto";
    textarea.style.height = `${Math.max(textarea.scrollHeight, textarea.minHeightPx)}px`;
  }

  // Comment editor -- click a row's Song/Type cell to expand a multiline-
  // editable panel below it (same click-to-expand-inline interaction as
  // DIY-MIDI-METRONOME's EDITOR trigger list), Apply reads/writes through
  // the shared raw-bytes cache via setlist-comment.js's real codec (see
  // commitSlotBytes()) -- retrofitted off the old struct-only setComment()
  // bridge call once Color/Volume being independently open on the same row
  // made that a real data-loss risk, not just an inconsistency (see
  // STATE.md). A plain <textarea> is used (not contenteditable) so \r\n
  // line breaks Just Work via normal textarea semantics. Sized to show at
  // least 10 lines, growing to fit longer content instead of scrolling.
  function buildCommentEditorRow(entry) {
    return buildEditorRow("comment-editor-row", () => {
      const bytes = slotBytesCache.get(entry.index);
      const decoded = resolvedSlotCodecs.decodeSetlistComment(bytes);

      const textarea = document.createElement("textarea");
      textarea.className = "comment-editor";
      textarea.rows = COMMENT_EDITOR_MIN_ROWS;
      textarea.value = decoded.comment;
      textarea.placeholder = "Comment (supports line breaks)...";
      textarea.addEventListener("input", () => autoSizeCommentEditor(textarea));

      const applyBtn = document.createElement("button");
      applyBtn.type = "button";
      applyBtn.textContent = "Apply";
      applyBtn.addEventListener("click", async () => {
        const current = slotBytesCache.get(entry.index);
        const encoded = resolvedSlotCodecs.encodeSetlistComment(current, {
          ...resolvedSlotCodecs.decodeSetlistComment(current),
          comment: textarea.value,
        });
        await commitSlotBytes(entry, encoded);
      });

      // Measured after the row is actually in the DOM (scrollHeight needs
      // layout), and only then grown to fit content taller than 10 rows --
      // safe to schedule before this element is inserted since renderRows()
      // (the only caller) appends buildEditorRow()'s return value
      // synchronously, well before the next paint this callback waits for.
      requestAnimationFrame(() => {
        textarea.minHeightPx = textarea.clientHeight;
        autoSizeCommentEditor(textarea);
      });

      const row = document.createElement("div");
      row.className = "comment-editor-row-inner";
      row.append(textarea, applyBtn);
      return row;
    });
  }

  // Color editor -- click a row's # cell to expand a row of 16 buttons, one
  // per real Kronos Set List color (SETLIST_COLOR_NAMES/_HEX above).
  // Immediate-apply, no Apply button (per explicit request): each click
  // decodes/re-encodes through setlist-slot-params.js's masked Color codec
  // and commits straight away.
  function buildColorEditorRow(entry) {
    return buildEditorRow("color-editor-row", () => {
      const row = document.createElement("div");
      row.className = "color-editor-row-inner";
      for (let color = 1; color <= 16; color++) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "button is-small color-swatch-button" + (color === entry.color ? " is-link" : "");
        btn.style.background = setlistColorHex(color);
        btn.title = setlistColorName(color);
        btn.addEventListener("click", async () => {
          const current = slotBytesCache.get(entry.index);
          const encoded = resolvedSlotCodecs.encodeSlotColor(current, color);
          await commitSlotBytes(entry, encoded);
        });
        row.appendChild(btn);
      }
      return row;
    });
  }

  // Volume editor -- click a row's Vol cell to expand a 0-127 slider.
  // Immediate-apply on release (per explicit request: "color on press and
  // slider on release") -- `change` fires on release/blur, not on every
  // `input` tick during drag, so this doesn't spam a write per pixel of
  // drag movement. The live numeric label still updates on every `input`
  // tick for feedback, it just doesn't commit until `change`.
  function buildVolumeEditorRow(entry) {
    return buildEditorRow("volume-editor-row", () => {
      const labelEl = document.createElement("label");
      labelEl.className = "volume-label";
      labelEl.textContent = "Volume";

      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = "0";
      slider.max = "127";
      slider.value = String(entry.volume);
      slider.className = "volume-slider";

      const valueEl = document.createElement("span");
      valueEl.className = "volume-value";
      valueEl.textContent = String(entry.volume);

      slider.addEventListener("input", () => {
        valueEl.textContent = slider.value;
      });
      slider.addEventListener("change", async () => {
        const current = slotBytesCache.get(entry.index);
        const encoded = resolvedSlotCodecs.encodeSlotVolume(current, Number(slider.value));
        await commitSlotBytes(entry, encoded);
      });

      const row = document.createElement("div");
      row.className = "volume-editor-row-inner";
      row.append(labelEl, slider, valueEl);
      return row;
    });
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
      // a hand-rolled class) marks whether ANY editor on this row is open.
      if (isExpanded(entry.index)) tr.classList.add("is-selected");

      // Row-level fallback: Song/Type cells (and anywhere else not handled
      // by a cell's own listener below) open the Comment editor, same as
      // before this row grew per-column routing. # and Vol get their own
      // listeners (with stopPropagation) further down, inside the
      // paramsFound block -- there's nothing meaningful to toggle for
      // either without real slot params.
      tr.addEventListener("click", () => {
        toggleEditor(entry, "comment");
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
        const bankType = entry.isProgram ? getProgramBankType(entry.bank) : undefined;
        const bankButton = document.createElement("button");
        bankButton.type = "button";
        bankButton.className = "button is-small bank-jump-button";  // Bulma button, same look as the topbar's Open button
        bankButton.textContent = formatBankNumber(entry, bankType);
        bankButton.title = `Show ${entry.isProgram ? "Program" : "Combi"} ${formatBankNumber(entry, bankType)} in this pane's Programs/Combis view`;
        bankButton.addEventListener("click", (ev) => {
          ev.stopPropagation();
          onJumpToInstrument({ isProgram: entry.isProgram, bank: entry.bank, number: entry.number });
        });
        bankTd.appendChild(bankButton);
        volTd.textContent = String(entry.volume);
        // Vol cell opens the Volume editor instead of the row's own
        // Comment-editor fallback -- stopPropagation keeps the row-level
        // listener above from also firing (same pattern as bankButton).
        volTd.addEventListener("click", (ev) => {
          ev.stopPropagation();
          toggleEditor(entry, "volume");
        });
        // Color used to be its own swatch column -- now shown as the "#"
        // cell's own background instead, freeing up a whole column. Real
        // Kronos color names now (SETLIST_COLOR_NAMES/_HEX above), not the
        // old synthetic hue-spread placeholder -- ordering still unconfirmed
        // against real hardware, see that array's own doc comment.
        idxTd.style.background = setlistColorHex(entry.color);
        idxTd.title = `Color ${entry.color} (${setlistColorName(entry.color)})`;
        // # cell opens the Color editor instead of the row's own
        // Comment-editor fallback -- same stopPropagation pattern as Vol.
        idxTd.addEventListener("click", (ev) => {
          ev.stopPropagation();
          toggleEditor(entry, "color");
        });
      }

      // Hold Time dropped from this row (2026-08-04) -- moving to the
      // Comment editor panel later rather than showing it here; entry.holdTime
      // itself is untouched (still fetched/returned by getEntries()), just
      // not rendered as its own column for now.
      tr.append(idxTd, labelTd, typeTd, bankTd, volTd);
      tbody.appendChild(tr);

      // Fixed order (Color, Comment, Volume) regardless of the order they
      // were opened in, so several open at once on the same row don't
      // reshuffle as OTHER rows' editors open/close elsewhere in the table --
      // matches the columns' own left-to-right order (#, Song/Type, Vol).
      const openTypes = expandedTypes.get(entry.index);
      if (openTypes) {
        if (openTypes.has("color")) tbody.appendChild(buildColorEditorRow(entry));
        if (openTypes.has("comment")) tbody.appendChild(buildCommentEditorRow(entry));
        if (openTypes.has("volume")) tbody.appendChild(buildVolumeEditorRow(entry));
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
    expandedTypes.clear();  // don't carry an open editor over to a different Set List's song at the same index
    slotBytesCache.clear();
    releaseAllSlotLocks();
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
      expandedTypes.clear();
      slotBytesCache.clear();
      releaseAllSlotLocks();
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
    // the new dataset entirely, and a stale expanded editor would reopen on
    // whatever song now happens to share that index (and its raw-bytes
    // cache would be for the WRONG dataset's slot entirely).
    filterText = "";
    filterInput.value = "";
    expandedTypes.clear();
    slotBytesCache.clear();
    releaseAllSlotLocks();

    infoEl.textContent = `Showing ${displayName}`;
    filterInput.disabled = setlists.length === 0;
    await refreshEntries();
    log(`[Pane ${paneId}] Showing ${displayName}`);
  }

  return { refreshEntries, onDatasetChanged };
}

function createPane(paneId, root, { onDropEntry, onDropProgram, log, showToast }) {
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

  // bank -> "HD-1"/"EXi", refreshed on every dataset change -- shared by
  // both content renderers (Setlist's Bank-jump button, the Programs
  // bank-filter row) so the small getProgramBankTypes() bridge call happens
  // once per dataset load, not once per renderer. Per-file data, never a
  // hardcoded table -- see PcgFile.h's ProgramBankType doc comment.
  let programBankTypes = new Map();

  function getProgramBankType(bank) {
    return programBankTypes.get(bank);
  }

  async function refreshProgramBankTypes() {
    programBankTypes = new Map();
    if (currentDatasetId == null) return;
    const entries = await window.getProgramBankTypes(currentDatasetId);
    for (const entry of entries) programBankTypes.set(entry.bank, entry.bankType);
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
    showToast,
    onDropEntry,
    getDatasetId: getCurrentDatasetId,
    getProgramBankType,
    onJumpToInstrument: jumpToInstrument,
  });
  const libraryPanels = createLibraryPanels(libraryContainer, {
    log,
    getDatasetId: getCurrentDatasetId,
    getProgramBankType,
    onDropProgram,
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
    await refreshProgramBankTypes();
    await setlistPanel.onDatasetChanged(displayName);
    await libraryPanels.onDatasetChanged();
  }

  // Back to the "nothing selected" state -- used both for the dataset-select's
  // own placeholder option and when the dataset this pane was showing gets
  // closed from elsewhere (another pane).
  async function resetToEmpty() {
    currentDatasetId = null;
    await refreshProgramBankTypes();
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
    // Exposed so app.js's onDropProgram can re-fetch this pane's Programs
    // table after a Program copy lands in it -- same "which pane(s) need
    // refreshing" need as refreshEntries above, just for the library view.
    refreshLibrary: libraryPanels.refresh,
    getCurrentDatasetId,
    loadDataset,
    isEmpty: () => currentDatasetId == null,
  };
}
