// Program/Combi library panels: Programs, Combis, and Duplicates, embedded
// inside a pane shell (see pane.js's createPane()) as three of its top-level
// categories (Setlist/Programs/Combis/Duplicates all live as peer buttons in
// the shell's own nav -- this module doesn't render its own tab bar, just
// whichever single panel the shell tells it to show via showPanel()).
// Operates on whichever dataset the shell tells it via getDatasetId(), not
// its own selector (the shell owns ONE dataset-select shared by every
// category). Combis/Duplicates stay read-only, not draggable -- repointing a
// Combi's Timbre references or deduping is a separate, harder problem, not
// this pass. Programs rows ARE draggable (drag one onto another to copy its
// raw bytes into that slot, same dataset or across two panes' different
// datasets -- see onDropProgram in app.js and PcgFile::copyProgramFrom()'s
// own doc comment for the validation guards), once explicitly deferred as
// "the hard, physical-bank-placement problem" (STATE.md's EXPLORATION
// section) but now unblocked by surfacing bank type in the UI first (this
// same session). Duplicates is (and stays) scoped to a single selected
// dataset -- no cross-dataset dedup here, that's a real future idea, not
// this pass. See STATE.md's "Program/Combi Library Editor" plan for the
// phased roadmap this is Phase 1 of.
function createLibraryPanels(root, { log, getDatasetId, getProgramBankType, onDropProgram }) {
  root.innerHTML = `
    <input class="filter-input library-filter input is-small" type="text" placeholder="Filter / search..." />
    <div class="bank-filter-area">
      <div class="bank-filter-row" data-bank-filter="programs"></div>
      <div class="bank-filter-row" data-bank-filter="combis" hidden></div>
    </div>
    <div class="library-body">
      <div class="lib-panel" data-panel="programs">
        <div class="lib-panel-table" data-panel-table="programs"></div>
      </div>
      <div class="lib-panel" data-panel="combis" hidden>
        <div class="lib-panel-table" data-panel-table="combis"></div>
      </div>
      <div class="lib-panel" data-panel="duplicates" hidden></div>
    </div>
  `;

  const filterInput = root.querySelector(".library-filter");
  // The outer per-category divs -- used only for show/hide (showPanel()).
  const panels = {
    programs: root.querySelector('[data-panel="programs"]'),
    combis: root.querySelector('[data-panel="combis"]'),
    duplicates: root.querySelector('[data-panel="duplicates"]'),
  };
  // Where each table actually gets (re)built -- separate from `panels` above
  // so rebuilding a table on every render/filter keystroke doesn't also
  // wipe out that category's bank-filter buttons.
  const panelTables = {
    programs: root.querySelector('[data-panel-table="programs"]'),
    combis: root.querySelector('[data-panel-table="combis"]'),
  };
  // Bank-filter buttons live outside .library-body now (a sibling above it,
  // not inside the scrolling area) -- per explicit request, they were
  // scrolling out of view along with the table. showPanel() below toggles
  // which one (if either -- Duplicates has no bank filter at all) is shown,
  // mirroring `panels`' own show/hide.
  const bankFilterRows = {
    programs: root.querySelector('[data-bank-filter="programs"]'),
    combis: root.querySelector('[data-bank-filter="combis"]'),
  };

  // Set during a Programs row's own dragstart, cleared on dragend -- lets a
  // row being dragged OVER (not just dropped on) show immediate reject
  // feedback if the two banks' engine types don't match, same technique as
  // pane.js's draggedFromDatasetId for Setlist rows (HTML5 DataTransfer
  // payloads aren't readable during dragover, so a plain shared variable
  // stands in). The actual copy still goes through EditorBridge::
  // copyProgram()'s own validation regardless -- this is only a hover hint.
  let draggedProgram = null;

  let currentTab = "programs";
  let programs = [];
  let combis = [];
  let duplicateGroups = [];
  let expandedProgramKey = null;  // `${bank}-${number}` of the one expanded usage row, if any
  let expandedCombiKey = null;    // `${bank}-${number}` of the one expanded Timbre row, if any
  // Bank-filter state, per category -- `present` is which bank indices
  // actually have entries in the current dataset (recomputed on every
  // load()), `filter` is which of those are currently "pressed" (shown),
  // reset to match `present` (show everything) on every load() and then
  // independently user-toggleable. Buttons for banks NOT in `present` are
  // disabled, per explicit request -- there's nothing to show there.
  let programPresentBanks = new Set();
  let programBankFilter = new Set();
  let combiPresentBanks = new Set();
  let combiBankFilter = new Set();

  // scrollIntoView({block:"center"}) can leave a row still partly hidden
  // under the table's sticky <thead> (especially rows near the top of the
  // list, which can't be centered past the header at all) -- this instead
  // computes the exact scroll position so the row lands just below the
  // header, using getBoundingClientRect() (robust regardless of the
  // table/tbody nesting between the row and its scrolling ancestor).
  function scrollRowBelowHeader(row) {
    const scrollBox = row.closest(".library-body");
    if (!scrollBox) return;
    // row.closest("table"), not scrollBox.querySelector("thead") -- Programs'
    // and Combis' tables can both exist in the DOM at once (one just
    // hidden), so querying from scrollBox could grab the wrong table's
    // header height entirely.
    const table = row.closest("table");
    const header = table ? table.querySelector("thead") : null;
    const headerHeight = header ? header.getBoundingClientRect().height : 0;
    const rowRect = row.getBoundingClientRect();
    const boxRect = scrollBox.getBoundingClientRect();
    const currentOffset = rowRect.top - boxRect.top;
    const desiredOffset = headerHeight + 8;  // a small gap below the header
    scrollBox.scrollTo({ top: scrollBox.scrollTop + currentOffset - desiredOffset, behavior: "smooth" });
  }

  // Draws one category's bank-filter button row: one toggle per bank name,
  // enabled only if that bank actually has entries in the current dataset
  // (`present`), pressed (Bulma's `is-link` -- there's no dedicated
  // "toggle button" component, this is the idiomatic way to show a button
  // as active) if currently in `filterSet`. Pure rendering -- only the
  // click handler mutates `filterSet`, so calling this again (e.g. to
  // reflect a programmatic change from jumpToEntry()) never resets a
  // user's existing choices on its own.
  // `getBankType(bank)` is optional -- only Programs has one (Combis have no
  // engine type of their own, see PcgFile.h's ProgramBankType doc comment),
  // so refreshCombiBankButtons() below just omits it and buttons stay plain.
  function renderBankFilterRow(container, bankNames, present, filterSet, onToggle, getBankType) {
    container.innerHTML = "";
    bankNames.forEach((name, bank) => {
      const isPresent = present.has(bank);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "button is-small bank-filter-button";
      const bankType = getBankType && getBankType(bank);
      btn.textContent = bankType ? `${name} (${bankType})` : name;
      btn.disabled = !isPresent;
      if (isPresent && filterSet.has(bank)) btn.classList.add("is-link");
      btn.addEventListener("click", () => {
        if (filterSet.has(bank)) filterSet.delete(bank);
        else filterSet.add(bank);
        btn.classList.toggle("is-link");
        onToggle();
      });
      container.appendChild(btn);
    });
  }

  function refreshProgramBankButtons() {
    renderBankFilterRow(
      bankFilterRows.programs,
      PROGRAM_BANK_NAMES,
      programPresentBanks,
      programBankFilter,
      () => renderProgramsPanel(),
      getProgramBankType
    );
  }

  function refreshCombiBankButtons() {
    renderBankFilterRow(bankFilterRows.combis, COMBI_BANK_NAMES, combiPresentBanks, combiBankFilter, () =>
      renderCombisPanel()
    );
  }

  function filterByName(rows, needle) {
    if (!needle) return rows;
    return rows.filter((r) => (r.name || "").toLowerCase().includes(needle));
  }

  function bankCell(isProgram, bank, number, bankType) {
    const td = document.createElement("td");
    td.textContent = formatBankNumber({ isProgram, bank, number }, bankType);
    return td;
  }

  // Small pill per Set List reference (name + slot number) -- only shown
  // when there are few enough (<=10) to stay readable; above that, the
  // "#STL" count column still shows the total, just without the
  // per-reference breakdown. Bulma's own `.tags`/`.tag` (a real pill/chip
  // component), not a hand-rolled one.
  function badgesCell(setlistUsages) {
    const td = document.createElement("td");
    if (setlistUsages && setlistUsages.length > 0 && setlistUsages.length <= 10) {
      const wrap = document.createElement("div");
      wrap.className = "tags";
      for (const u of setlistUsages) {
        const badge = document.createElement("span");
        badge.className = "tag";
        badge.textContent = `${u.setlistName} (${kronosNumber(u.songIndex)})`;
        wrap.appendChild(badge);
      }
      td.appendChild(wrap);
    }
    return td;
  }

  function refCell(text, unavailable) {
    const td = document.createElement("td");
    td.textContent = text;
    if (unavailable) {
      td.className = "col-refs-unavailable";
      td.title =
        "Combi usage is only confirmed correct for INT-A..D so far -- other banks would risk a wrong " +
        "count due to the Combi-internal bank numbering not matching this bank's index everywhere. " +
        "See docs/README.md's Combi Timbre references section.";
    }
    return td;
  }

  function buildUsageRow(program) {
    const tr = document.createElement("tr");
    tr.className = "comment-editor-row";  // reuses the existing expand-row look from pane.js
    const td = document.createElement("td");
    td.colSpan = 5;  // Bank, Name, Type, #STL, #CMB -- a real <table> again

    const box = document.createElement("div");
    box.textContent = "Loading usage...";
    td.appendChild(box);
    tr.appendChild(td);

    (async () => {
      const usage = await window.getProgramUsage(getDatasetId(), program.bank, program.number);
      box.innerHTML = "";
      if (!usage.ok) {
        box.textContent = `Error: ${usage.error}`;
        return;
      }

      const heading = document.createElement("div");
      heading.className = "usage-heading";
      heading.textContent = `Set List usage (${usage.setlistUsages.length}):`;
      box.appendChild(heading);

      if (usage.setlistUsages.length === 0) {
        const none = document.createElement("div");
        none.className = "usage-empty";
        none.textContent = "No Set List slot directly references this Program.";
        box.appendChild(none);
      } else {
        const list = document.createElement("ul");
        list.className = "usage-list";
        for (const u of usage.setlistUsages) {
          const li = document.createElement("li");
          li.textContent = `${u.setlistName} -- slot ${kronosNumber(u.songIndex)}`;
          list.appendChild(li);
        }
        box.appendChild(list);
      }

      if (!usage.combiUsagesAvailable) {
        const note = document.createElement("div");
        note.className = "usage-note";
        note.textContent =
          "Combi usage: not available for this bank yet -- only confirmed for INT-A..D so far. " +
          "See docs/README.md's Combi Timbre references section.";
        box.appendChild(note);
      } else {
        const combiHeading = document.createElement("div");
        combiHeading.className = "usage-heading";
        combiHeading.textContent = `Combi usage (${usage.combiUsages.length}):`;
        box.appendChild(combiHeading);

        if (usage.combiUsages.length === 0) {
          const none = document.createElement("div");
          none.className = "usage-empty";
          none.textContent = "No Combi's Timbres reference this Program.";
          box.appendChild(none);
        } else {
          const list = document.createElement("ul");
          list.className = "usage-list";
          for (const c of usage.combiUsages) {
            const li = document.createElement("li");
            li.textContent = `${formatBankNumber({ isProgram: false, bank: c.bank, number: c.number })} "${c.name || "(empty)"}"`;
            if (!c.active) {
              li.textContent += " (via an Off Timbre only)";
              li.className = "timbre-inactive-ref";
            }
            list.appendChild(li);
          }
          box.appendChild(list);
        }
      }
    })();

    return tr;
  }

  function renderProgramsPanel() {
    const panel = panelTables.programs;
    const needle = filterInput.value.trim().toLowerCase();
    const rows = filterByName(programs, needle).filter((p) => programBankFilter.has(p.bank));

    panel.innerHTML = "";
    const table = document.createElement("table");
    table.className = "table is-fullwidth is-hoverable is-narrow programs-table";
    table.innerHTML =
      colgroupHtml([2.6, null, 1.3, 1.3, 1.3]) +
      "<thead><tr><th>Bank</th><th>Name</th><th " +
      "title=\"HD-1 or EXi -- not yet cross-checked against a real backup, see docs/external/README.md\">Type</th>" +
      "<th title=\"Set List references\">#STL</th>" +
      "<th title=\"Combi references\">#CMB</th></tr></thead><tbody></tbody>";
    const tbody = table.querySelector("tbody");

    for (const p of rows) {
      const tr = document.createElement("tr");
      const nameTd = document.createElement("td");
      nameTd.textContent = p.name || "(empty)";
      const typeTd = document.createElement("td");
      typeTd.textContent = p.bankType || "";
      tr.append(
        bankCell(true, p.bank, p.number),
        nameTd,
        typeTd,
        refCell(String(p.setlistReferenceCount), false),
        p.combiReferenceCountAvailable
          ? refCell(String(p.combiReferenceCount), false)
          : refCell("n/a", true)
      );

      const key = `${p.bank}-${p.number}`;
      tr.dataset.entryKey = key;  // lets jumpToEntry() find this exact row after a re-render
      // Bulma's own `tr.is-selected` highlight, not a hand-rolled class.
      if (key === expandedProgramKey) tr.classList.add("is-selected");
      tr.addEventListener("click", () => {
        expandedProgramKey = expandedProgramKey === key ? null : key;
        renderProgramsPanel();
      });

      // Drag this Program onto another Program row (same pane or a
      // different pane's dataset) to copy its raw bytes into that slot --
      // see onDropProgram in app.js. Copy, not move: dragstart's payload
      // never mutates the source, only drop() (on the TARGET row) calls
      // into the bridge.
      tr.draggable = true;
      tr.addEventListener("dragstart", (ev) => {
        draggedProgram = { datasetId: getDatasetId(), bank: p.bank, number: p.number, bankType: p.bankType };
        ev.dataTransfer.setData("application/json", JSON.stringify(draggedProgram));
        ev.dataTransfer.effectAllowed = "copy";
      });
      tr.addEventListener("dragend", () => {
        draggedProgram = null;
      });
      tr.addEventListener("dragover", (ev) => {
        // Reject up front (no preventDefault -- the browser's own "not
        // allowed" cursor takes over, no `drop` fires here at all) if the
        // dragged Program's engine type doesn't match this row's own bank.
        // EditorBridge::copyProgram() enforces this regardless; this is
        // just immediate hover feedback instead of only after the drop.
        if (draggedProgram != null && draggedProgram.bankType !== p.bankType) {
          tr.classList.remove("drop-target");
          return;
        }
        ev.preventDefault();
        ev.dataTransfer.dropEffect = "copy";
        tr.classList.add("drop-target");
      });
      tr.addEventListener("dragleave", () => tr.classList.remove("drop-target"));
      tr.addEventListener("drop", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        tr.classList.remove("drop-target");
        const raw = ev.dataTransfer.getData("application/json");
        if (!raw) return;
        onDropProgram(JSON.parse(raw), { datasetId: getDatasetId(), bank: p.bank, number: p.number });
      });

      tbody.appendChild(tr);

      if (key === expandedProgramKey) tbody.appendChild(buildUsageRow(p));
    }

    panel.appendChild(table);
  }

  // Mirrors PcgFile::isConfirmedTimbreProgramBank() (INT-A..D, bank 0-3) --
  // the one range where a Timbre's raw bank code is confirmed to directly
  // index the SAME Program bank space as ProgramInfo.bank (this is already
  // the assumption EditorBridge::combiUsagesForProgram()/combiUsageCounts()
  // bake in for the #CMB column; every other bank is explicitly flagged as
  // unconfirmed there too -- see refCell()'s "unavailable" tooltip above).
  // Outside this range, rawBankCode isn't known to mean the same thing as a
  // Program's own .bank field at all, so looking up its type/name would be
  // a guess, not a lookup -- exactly what this project doesn't do.
  function isConfirmedTimbreProgramBank(bank) {
    return bank >= 0 && bank <= 3;
  }

  // Formats one Timbre's Program reference for display: the confirmed bank
  // name when known, otherwise the raw numeric code so it's still honest
  // about what was found (see docs/README.md's "Combi Timbre references"
  // section -- only some bank codes have been identified so far). For a
  // confirmed bank, also shows the engine type (getProgramBankType(), same
  // per-bank map the Programs panel's own bank-filter buttons use) and the
  // actual Program name -- already sitting in the `programs` array this
  // panel loaded for its own table, no extra bridge call needed. A Timbre
  // can hold a real reference while switched off (status != Off is NOT the
  // same thing as isDefault -- see TimbreRef's doc comment in PcgFile.h),
  // so that's called out explicitly rather than hidden -- it still counts
  // as "this Combi references that Program."
  function formatTimbreRef(t) {
    if (t.isDefault) return "--";
    const confirmed = isConfirmedTimbreProgramBank(t.rawBankCode);
    const bank = t.bankName ? abbreviateBankName(t.bankName) : `code ${t.rawBankCode}`;
    let ref = `${bank} ${kronosNumber(t.number)}`;
    if (confirmed) {
      const bankType = getProgramBankType(t.rawBankCode);
      if (bankType) ref += ` (${bankType})`;
      const program = programs.find((p) => p.bank === t.rawBankCode && p.number === t.number);
      if (program && program.name) ref += ` — "${program.name}"`;
    }
    return t.status === "Off" ? `${ref} (off)` : ref;
  }

  function buildTimbreRow(combi) {
    const tr = document.createElement("tr");
    tr.className = "comment-editor-row";
    const td = document.createElement("td");
    td.colSpan = 4;  // Bank, Name, Set Lists, #STL -- a real <table> again

    const heading = document.createElement("div");
    heading.className = "usage-heading";
    heading.textContent = "Timbre Program references:";
    td.appendChild(heading);

    const list = document.createElement("ul");
    list.className = "usage-list timbre-list";
    combi.timbres.forEach((t, i) => {
      const li = document.createElement("li");
      li.className = t.isDefault ? "timbre-default" : t.status === "Off" ? "timbre-inactive-ref" : "";
      li.textContent = `Timbre ${i + 1}: ${formatTimbreRef(t)}`;
      list.appendChild(li);
    });
    td.appendChild(list);

    const note = document.createElement("div");
    note.className = "usage-note";
    note.textContent =
      "Some raw bank codes aren't identified yet -- shown as \"code N\" rather than guessed, and for the " +
      "same reason engine type/Program name are only shown for the confirmed INT-A..D range. " +
      "See STATE.md's Phase 2 notes.";
    td.appendChild(note);

    tr.appendChild(td);
    return tr;
  }

  function renderCombisPanel() {
    const panel = panelTables.combis;
    const needle = filterInput.value.trim().toLowerCase();
    const rows = filterByName(combis, needle).filter((c) => combiBankFilter.has(c.bank));

    panel.innerHTML = "";
    const table = document.createElement("table");
    table.className = "table is-fullwidth is-hoverable is-narrow";
    table.innerHTML =
      colgroupHtml([2.6, null, 4, 1.3]) +
      "<thead><tr><th>Bank</th><th>Name</th><th>Set Lists</th>" +
      "<th title=\"Set List references\">#STL</th></tr></thead><tbody></tbody>";
    const tbody = table.querySelector("tbody");

    for (const c of rows) {
      const tr = document.createElement("tr");
      const nameTd = document.createElement("td");
      nameTd.textContent = c.name || "(empty)";
      tr.append(
        bankCell(false, c.bank, c.number),
        nameTd,
        badgesCell(c.setlistUsages),
        refCell(String(c.setlistReferenceCount), false)
      );

      const key = `${c.bank}-${c.number}`;
      tr.dataset.entryKey = key;  // lets jumpToEntry() find this exact row after a re-render
      if (key === expandedCombiKey) tr.classList.add("is-selected");
      tr.addEventListener("click", () => {
        expandedCombiKey = expandedCombiKey === key ? null : key;
        renderCombisPanel();
      });
      tbody.appendChild(tr);

      if (key === expandedCombiKey && c.timbres) tbody.appendChild(buildTimbreRow(c));
    }

    panel.appendChild(table);
  }

  function renderDuplicatesPanel() {
    const panel = panels.duplicates;
    const needle = filterInput.value.trim().toLowerCase();
    panel.innerHTML = "";

    if (duplicateGroups.length === 0) {
      const empty = document.createElement("div");
      empty.className = "usage-empty";
      empty.textContent = "No byte-exact duplicate Programs found.";
      panel.appendChild(empty);
      return;
    }

    for (const group of duplicateGroups) {
      const groupName = group[0].name || "(empty)";
      if (needle && !groupName.toLowerCase().includes(needle)) continue;

      const box = document.createElement("div");
      box.className = "duplicate-group";

      const title = document.createElement("div");
      title.className = "duplicate-group-title";
      title.textContent = `"${groupName}" -- ${group.length} identical copies`;
      box.appendChild(title);

      const table = document.createElement("table");
      table.className = "table is-fullwidth is-hoverable is-narrow";
      table.innerHTML =
        colgroupHtml([2.6, 1.3, 1.3]) +
        "<thead><tr><th>Bank</th><th title=\"Set List references\">#STL</th>" +
        "<th title=\"Combi references\">#CMB</th></tr></thead><tbody></tbody>";
      const tbody = table.querySelector("tbody");

      for (const p of group) {
        const tr = document.createElement("tr");
        tr.append(
          // Unlike the Programs table, Duplicates has no separate Type
          // column -- worth showing here since two byte-exact duplicates
          // could in principle sit in banks of different engine types.
          bankCell(true, p.bank, p.number, p.bankType),
          refCell(String(p.setlistUsageCount), false),
          p.combiUsageCountAvailable ? refCell(String(p.combiUsageCount), false) : refCell("n/a", true)
        );
        tbody.appendChild(tr);
      }

      box.appendChild(table);
      panel.appendChild(box);
    }
  }

  function renderCurrentTab() {
    if (currentTab === "programs") renderProgramsPanel();
    else if (currentTab === "combis") renderCombisPanel();
    else renderDuplicatesPanel();
  }

  // Called by the shell when its own "Programs"/"Combis"/"Duplicates"
  // category button is clicked -- name is "programs"|"combis"|"duplicates".
  function showPanel(name) {
    currentTab = name;
    Object.entries(panels).forEach(([panelName, el]) => {
      el.hidden = panelName !== currentTab;
    });
    // Duplicates has no bank-filter row at all -- both stay hidden there.
    Object.entries(bankFilterRows).forEach(([rowName, el]) => {
      el.hidden = rowName !== currentTab;
    });
    renderCurrentTab();
  }

  filterInput.addEventListener("input", () => renderCurrentTab());

  async function load() {
    const datasetId = getDatasetId();
    if (datasetId == null) {
      programs = [];
      combis = [];
      duplicateGroups = [];
    } else {
      programs = await window.listPrograms(datasetId);
      combis = await window.listCombis(datasetId);
      duplicateGroups = await window.findDuplicatePrograms(datasetId);
      log(`[Library] Loaded dataset ${datasetId}: ${programs.length} Programs, ${combis.length} Combis, ${duplicateGroups.length} duplicate groups.`);
    }
    // Reset both bank filters to "show every bank actually present" -- a
    // fresh dataset's bank layout has nothing to do with whatever was
    // toggled for a previous one.
    programPresentBanks = new Set(programs.map((p) => p.bank));
    programBankFilter = new Set(programPresentBanks);
    combiPresentBanks = new Set(combis.map((c) => c.bank));
    combiBankFilter = new Set(combiPresentBanks);
    refreshProgramBankButtons();
    refreshCombiBankButtons();
    renderCurrentTab();
  }

  // Called by the shell (pane.js's createPane()) whenever its shared
  // dataset-select changes -- either a fresh selection, or the dataset this
  // pane was showing having been closed elsewhere (getDatasetId() will
  // already reflect that by the time this is called).
  function onDatasetChanged() {
    expandedProgramKey = null;
    expandedCombiKey = null;
    load();
  }

  // Called by the shell after it's already switched to this Program's/
  // Combi's category (via showPanel()) -- expands that exact entry's usage/
  // Timbre row and scrolls it into view, same as clicking the row directly.
  // Clears any active text filter, and makes sure the target bank's filter
  // button is "pressed," so neither can hide the entry being jumped to.
  function jumpToEntry(isProgram, bank, number) {
    filterInput.value = "";
    const key = `${bank}-${number}`;
    if (isProgram) {
      expandedProgramKey = key;
      programBankFilter.add(bank);
      refreshProgramBankButtons();
    } else {
      expandedCombiKey = key;
      combiBankFilter.add(bank);
      refreshCombiBankButtons();
    }
    renderCurrentTab();
    const row = root.querySelector(`[data-entry-key="${key}"]`);
    if (row) scrollRowBelowHeader(row);
  }

  // `refresh` is just `load` under a name that makes sense to an outside
  // caller -- exposed so app.js's onDropProgram can re-fetch this pane's
  // Programs table after a copy lands in it, without resetting bank
  // filters/expanded state any harder than onDatasetChanged already does.
  return { onDatasetChanged, showPanel, jumpToEntry, refresh: load };
}
