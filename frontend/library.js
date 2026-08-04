// Read-only Program/Combi library panels: Programs, Combis, and Duplicates,
// embedded inside a pane shell (see pane.js's createPane()) as three of its
// top-level categories (Setlist/Programs/Combis/Duplicates all live as peer
// buttons in the shell's own nav -- this module doesn't render its own tab
// bar, just whichever single panel the shell tells it to show via
// showPanel()). Operates on whichever dataset the shell tells it via
// getDatasetId(), not its own selector (the shell owns ONE dataset-select
// shared by every category). Nothing here is drag-and-drop-able or
// editable -- this is a browser/reporting tool, and Programs/Combis rows
// are deliberately not draggable at all (moving/repointing Program content
// across physical bank locations is the hard, explicitly-deferred problem
// from the explore/sqlite-patch-datastore branch -- see STATE.md's
// "EXPLORATION" section). Duplicates is (and stays) scoped to a single
// selected dataset -- no cross-dataset dedup here, that's a real future
// idea, not this pass. See STATE.md's "Program/Combi Library Editor" plan
// for the phased roadmap this is Phase 1 of.
function createLibraryPanels(root, { log, getDatasetId }) {
  root.innerHTML = `
    <input class="filter-input library-filter" type="text" placeholder="Filter / search..." />
    <div class="library-body">
      <div class="lib-panel" data-panel="programs">
        <div class="bank-filter-row" data-bank-filter="programs"></div>
        <div class="lib-panel-table" data-panel-table="programs"></div>
      </div>
      <div class="lib-panel" data-panel="combis" hidden>
        <div class="bank-filter-row" data-bank-filter="combis"></div>
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
  const bankFilterRows = {
    programs: root.querySelector('[data-bank-filter="programs"]'),
    combis: root.querySelector('[data-bank-filter="combis"]'),
  };

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
  // (`present`), pressed (.active) if currently in `filterSet`. Pure
  // rendering -- only the click handler mutates `filterSet`, so calling
  // this again (e.g. to reflect a programmatic change from jumpToEntry())
  // never resets a user's existing choices on its own.
  function renderBankFilterRow(container, bankNames, present, filterSet, onToggle) {
    container.innerHTML = "";
    bankNames.forEach((name, bank) => {
      const isPresent = present.has(bank);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "lib-tab bank-filter-button";
      btn.textContent = name;
      btn.disabled = !isPresent;
      if (isPresent && filterSet.has(bank)) btn.classList.add("active");
      btn.addEventListener("click", () => {
        if (filterSet.has(bank)) filterSet.delete(bank);
        else filterSet.add(bank);
        btn.classList.toggle("active");
        onToggle();
      });
      container.appendChild(btn);
    });
  }

  function refreshProgramBankButtons() {
    renderBankFilterRow(bankFilterRows.programs, PROGRAM_BANK_NAMES, programPresentBanks, programBankFilter, () =>
      renderProgramsPanel()
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

  function bankCell(isProgram, bank, number) {
    const td = document.createElement("td");
    td.className = "col-bank";
    td.textContent = formatBankNumber({ isProgram, bank, number });
    return td;
  }

  // Small pill per Set List reference (name + slot number) -- only shown
  // when there are few enough (<=10) to stay readable; above that, the
  // "#STL" count column still shows the total, just without the
  // per-reference breakdown.
  function badgesCell(setlistUsages) {
    const td = document.createElement("td");
    td.className = "col-badges";
    if (setlistUsages && setlistUsages.length > 0 && setlistUsages.length <= 10) {
      const wrap = document.createElement("div");
      wrap.className = "badge-list";
      for (const u of setlistUsages) {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = `${u.setlistName} (${kronosNumber(u.songIndex)})`;
        wrap.appendChild(badge);
      }
      td.appendChild(wrap);
    }
    return td;
  }

  function refCell(text, unavailable) {
    const td = document.createElement("td");
    td.className = unavailable ? "col-refs col-refs-unavailable" : "col-refs";
    td.textContent = text;
    if (unavailable) {
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
    // Span every column -- table is display:grid now (see style.css). Was
    // `colSpan = 2` under the old <table> layout, a stale value from when
    // the Programs table had fewer columns (it's had 5 for a while); fixed
    // as part of the grid migration since grid-column: 1 / -1 always means
    // "all of them," not a number that can silently drift out of sync.
    td.style.gridColumn = "1 / -1";

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
    table.className = "entries-table library-table";
    table.style.gridTemplateColumns = gridTemplateColumns([55, null, 38, 54, 54]);
    table.innerHTML =
      "<thead><tr><th class=\"col-bank\">Bank</th><th class=\"col-name\">Name</th><th class=\"col-narrow\" " +
      "title=\"HD-1 or EXi -- not yet cross-checked against a real backup, see docs/external/README.md\">Type</th>" +
      "<th class=\"col-refs\" title=\"Set List references\">#STL</th>" +
      "<th class=\"col-refs\" title=\"Combi references\">#CMB</th></tr></thead><tbody></tbody>";
    const tbody = table.querySelector("tbody");

    for (const p of rows) {
      const tr = document.createElement("tr");
      const nameTd = document.createElement("td");
      nameTd.className = "col-name";
      nameTd.textContent = p.name || "(empty)";
      const typeTd = document.createElement("td");
      typeTd.className = "col-narrow";
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
      if (key === expandedProgramKey) tr.classList.add("expanded");
      tr.addEventListener("click", () => {
        expandedProgramKey = expandedProgramKey === key ? null : key;
        renderProgramsPanel();
      });
      tbody.appendChild(tr);

      if (key === expandedProgramKey) tbody.appendChild(buildUsageRow(p));
    }

    panel.appendChild(table);
  }

  // Formats one Timbre's Program reference for display: the confirmed bank
  // name when known, otherwise the raw numeric code so it's still honest
  // about what was found (see docs/README.md's "Combi Timbre references"
  // section -- only some bank codes have been identified so far). A
  // Timbre can hold a real reference while switched off (status != Off is
  // NOT the same thing as isDefault -- see TimbreRef's doc comment in
  // PcgFile.h), so that's called out explicitly rather than hidden --
  // it still counts as "this Combi references that Program."
  function formatTimbreRef(t) {
    if (t.isDefault) return "--";
    const bank = t.bankName ? abbreviateBankName(t.bankName) : `code ${t.rawBankCode}`;
    const ref = `${bank} ${kronosNumber(t.number)}`;
    return t.status === "Off" ? `${ref} (off)` : ref;
  }

  function buildTimbreRow(combi) {
    const tr = document.createElement("tr");
    tr.className = "comment-editor-row";
    const td = document.createElement("td");
    td.style.gridColumn = "1 / -1";  // span every column -- table is display:grid now, see style.css

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
      "Some raw bank codes aren't identified yet -- shown as \"code N\" rather than guessed. " +
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
    table.className = "entries-table library-table";
    table.style.gridTemplateColumns = gridTemplateColumns([55, null, 160, 54]);
    table.innerHTML =
      "<thead><tr><th class=\"col-bank\">Bank</th><th class=\"col-name\">Name</th><th class=\"col-badges\">Set Lists</th>" +
      "<th class=\"col-refs\" title=\"Set List references\">#STL</th></tr></thead><tbody></tbody>";
    const tbody = table.querySelector("tbody");

    for (const c of rows) {
      const tr = document.createElement("tr");
      const nameTd = document.createElement("td");
      nameTd.className = "col-name";
      nameTd.textContent = c.name || "(empty)";
      tr.append(
        bankCell(false, c.bank, c.number),
        nameTd,
        badgesCell(c.setlistUsages),
        refCell(String(c.setlistReferenceCount), false)
      );

      const key = `${c.bank}-${c.number}`;
      tr.dataset.entryKey = key;  // lets jumpToEntry() find this exact row after a re-render
      if (key === expandedCombiKey) tr.classList.add("expanded");
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
      table.className = "entries-table library-table";
      table.style.gridTemplateColumns = gridTemplateColumns([55, 54, 54]);
      table.innerHTML =
        "<thead><tr><th class=\"col-bank\">Bank</th><th class=\"col-refs\" title=\"Set List references\">#STL</th>" +
        "<th class=\"col-refs\" title=\"Combi references\">#CMB</th></tr></thead><tbody></tbody>";
      const tbody = table.querySelector("tbody");

      for (const p of group) {
        const tr = document.createElement("tr");
        tr.append(
          bankCell(true, p.bank, p.number),
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

  return { onDatasetChanged, showPanel, jumpToEntry };
}
