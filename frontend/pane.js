// One Norton-Commander-style pane: a drag-and-drop file loader + a Set List
// picker + a filterable, searchable, drag-and-drop-able table of that Set
// List's 128 song slots. Two instances are created by app.js ("A" and "B")
// so slots can be dragged between them.
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

function createPane(paneId, root, { onDropEntry, log }) {
  root.innerHTML = `
    <div class="pane-header">
      <select class="setlist-select" disabled></select>
    </div>
    <div class="setlist-info">No file loaded -- drag a .PCG file onto this pane.</div>
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

  const setlistSelect = root.querySelector(".setlist-select");
  const infoEl = root.querySelector(".setlist-info");
  const filterInput = root.querySelector(".filter-input");
  const tbody = root.querySelector("tbody");

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
      const result = await window.setComment(paneId, currentSetlistIndex, entry.index, textarea.value);
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
        ev.dataTransfer.setData(
          "application/json",
          JSON.stringify({ pane: paneId, setlistIndex: currentSetlistIndex, index: entry.index })
        );
        ev.dataTransfer.effectAllowed = "copyMove";
      });
      tr.addEventListener("dragover", (ev) => {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = "move";
        tr.classList.add("drop-target");
      });
      tr.addEventListener("dragleave", () => tr.classList.remove("drop-target"));
      tr.addEventListener("drop", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();  // don't also trigger the pane's file-drop handler below
        tr.classList.remove("drop-target");
        const raw = ev.dataTransfer.getData("application/json");
        if (!raw) return;
        onDropEntry(JSON.parse(raw), { pane: paneId, setlistIndex: currentSetlistIndex, index: entry.index });
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
    if (currentSetlistIndex < 0) {
      entries = [];
    } else {
      entries = await window.getEntries(paneId, currentSetlistIndex);
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

  async function openFromResult(result, sourceDescription) {
    if (!result.ok) {
      infoEl.textContent = `Failed: ${result.error}`;
      log(`[Pane ${paneId}] ${result.error}`);
      return;
    }

    setlists = await window.listSetlists(paneId);
    populateSetlistSelect();
    currentSetlistIndex = setlists.length > 0 ? setlists[0].index : -1;
    if (currentSetlistIndex >= 0) setlistSelect.value = String(currentSetlistIndex);

    // Loading a new file into an already-occupied pane must not leak state
    // from whatever was open before -- a stale filter could hide entries
    // in the new file entirely, and a stale expanded Comment editor would
    // reopen on whatever song now happens to share that index.
    filterText = "";
    filterInput.value = "";
    expandedIndices.clear();

    infoEl.textContent = `Loaded ${sourceDescription} -- ${result.setlistCount} Set Lists`;
    filterInput.disabled = setlists.length === 0;
    await refreshEntries();
    log(`[Pane ${paneId}] Loaded ${sourceDescription}`);
  }

  // Drag-and-drop a file from Finder/Explorer straight onto the pane -- the
  // native "Open File" dialog (triggered via a hidden <input type=file>)
  // opens a real NSOpenPanel/GTK/Win32 picker but on macOS it currently
  // appears behind the app window instead of in front (a choc/WKWebView
  // z-order quirk, not something this app controls) -- see STATE.md. Drag
  // and drop sidesteps it entirely, and also works without ever needing an
  // absolute filesystem path: the browser's File API hands over real file
  // bytes directly, which is why openFileBytes() exists alongside openFile().
  root.addEventListener("dragover", (ev) => {
    if (!ev.dataTransfer.types.includes("Files")) return;
    ev.preventDefault();
    root.classList.add("drag-over");
  });
  root.addEventListener("dragleave", (ev) => {
    if (ev.target === root) root.classList.remove("drag-over");
  });
  root.addEventListener("drop", async (ev) => {
    if (!ev.dataTransfer.files || ev.dataTransfer.files.length === 0) return;
    ev.preventDefault();
    root.classList.remove("drag-over");

    const file = ev.dataTransfer.files[0];
    infoEl.textContent = `Loading ${file.name}...`;
    try {
      const base64 = await arrayBufferToBase64(await file.arrayBuffer());
      await openFromResult(await window.openFileBytes(paneId, base64, file.name), file.name);
    } catch (err) {
      infoEl.textContent = `Failed: ${err}`;
      log(`[Pane ${paneId}] ${err}`);
    }
  });

  return { refreshEntries };
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
