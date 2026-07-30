// Read-only Program/Combi library browser: three sub-tabs (Programs,
// Combis, Duplicates) over whichever pane's loaded file is selected.
// Unlike pane.js's Set List view, nothing here is drag-and-drop-able or
// editable -- this is a browser/reporting tool. See STATE.md's "Program/
// Combi Library Editor" plan for the phased roadmap this is Phase 1 of.
function createLibrary(root, { log, panes }) {
  root.innerHTML = `
    <div class="library-header">
      <select class="library-pane-select">
        <option value="A">Pane A</option>
        <option value="B">Pane B</option>
      </select>
      <nav class="lib-tabs">
        <button class="lib-tab active" type="button" data-tab="programs">Programs</button>
        <button class="lib-tab" type="button" data-tab="combis">Combis</button>
        <button class="lib-tab" type="button" data-tab="duplicates">Duplicates</button>
      </nav>
      <input class="filter-input library-filter" type="text" placeholder="Filter / search..." />
    </div>
    <div class="library-body">
      <div class="lib-panel" data-panel="programs"></div>
      <div class="lib-panel" data-panel="combis" hidden></div>
      <div class="lib-panel" data-panel="duplicates" hidden></div>
    </div>
  `;

  const paneSelect = root.querySelector(".library-pane-select");
  const filterInput = root.querySelector(".library-filter");
  const tabs = root.querySelectorAll(".lib-tab");
  const panels = {
    programs: root.querySelector('[data-panel="programs"]'),
    combis: root.querySelector('[data-panel="combis"]'),
    duplicates: root.querySelector('[data-panel="duplicates"]'),
  };

  let currentTab = "programs";
  let programs = [];
  let combis = [];
  let duplicateGroups = [];
  let expandedProgramKey = null;  // `${bank}-${number}` of the one expanded usage row, if any
  let expandedCombiKey = null;    // `${bank}-${number}` of the one expanded Timbre row, if any

  function currentPane() {
    return paneSelect.value;
  }

  // Plain "Pane A"/"Pane B" doesn't say what's actually open there -- show
  // the Set List currently selected in that pane's own Set Lists view
  // instead, when there is one. Cheap (no bridge calls, just reads
  // pane.js's own in-memory state), so this can be called on every tab
  // activation, not just when Programs/Combis/Duplicates are (re)fetched.
  function updatePaneOptions() {
    root.querySelectorAll(".library-pane-select option").forEach((opt) => {
      const pane = panes && panes[opt.value];
      const setlistName = pane && pane.getCurrentSetlistName && pane.getCurrentSetlistName();
      opt.textContent = setlistName || "";
    });
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
  // "Setlist refs" count column still shows the total, just without the
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
      td.title = "Combi-internal Program references aren't parsed yet -- see STATE.md's Phase 2 roadmap.";
    }
    return td;
  }

  function buildUsageRow(program) {
    const tr = document.createElement("tr");
    tr.className = "comment-editor-row";  // reuses the existing expand-row look from pane.js
    const td = document.createElement("td");
    td.colSpan = 2;

    const box = document.createElement("div");
    box.textContent = "Loading usage...";
    td.appendChild(box);
    tr.appendChild(td);

    (async () => {
      const usage = await window.getProgramUsage(currentPane(), program.bank, program.number);
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
        note.textContent = "Combi usage: not available yet -- Combi-internal Program references aren't parsed yet.";
        box.appendChild(note);
      }
    })();

    return tr;
  }

  function renderProgramsPanel() {
    const panel = panels.programs;
    const needle = filterInput.value.trim().toLowerCase();
    const rows = filterByName(programs, needle);

    panel.innerHTML = "";
    const table = document.createElement("table");
    table.className = "entries-table library-table";
    table.innerHTML =
      "<thead><tr><th class=\"col-bank\">Bank</th><th>Name</th>" +
      "<th class=\"col-refs\">Setlist refs</th><th class=\"col-refs\">Combi refs</th></tr></thead><tbody></tbody>";
    const tbody = table.querySelector("tbody");

    for (const p of rows) {
      const tr = document.createElement("tr");
      const nameTd = document.createElement("td");
      nameTd.textContent = p.name || "(empty)";
      tr.append(
        bankCell(true, p.bank, p.number),
        nameTd,
        refCell(String(p.setlistReferenceCount), false),
        refCell("0", true)
      );

      const key = `${p.bank}-${p.number}`;
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
    const bank = t.bankName || `code ${t.rawBankCode}`;
    const ref = `${bank}-${kronosNumber(t.number)}`;
    return t.status === "Off" ? `${ref} (off)` : ref;
  }

  function buildTimbreRow(combi) {
    const tr = document.createElement("tr");
    tr.className = "comment-editor-row";
    const td = document.createElement("td");
    td.colSpan = 4;

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
    const panel = panels.combis;
    const needle = filterInput.value.trim().toLowerCase();
    const rows = filterByName(combis, needle);

    panel.innerHTML = "";
    const table = document.createElement("table");
    table.className = "entries-table library-table";
    table.innerHTML =
      "<thead><tr><th class=\"col-bank\">Bank</th><th class=\"col-name\">Name</th><th class=\"col-badges\">Set Lists</th>" +
      "<th class=\"col-refs\">Setlist refs</th></tr></thead><tbody></tbody>";
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
      table.innerHTML =
        "<thead><tr><th class=\"col-bank\">Bank</th><th class=\"col-refs\">Setlist references</th>" +
        "<th class=\"col-refs\">Combi references</th></tr></thead><tbody></tbody>";
      const tbody = table.querySelector("tbody");

      for (const p of group) {
        const tr = document.createElement("tr");
        tr.append(bankCell(true, p.bank, p.number), refCell(String(p.setlistUsageCount), false), refCell("0", true));
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

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      currentTab = tab.dataset.tab;
      Object.entries(panels).forEach(([name, el]) => {
        el.hidden = name !== currentTab;
      });
      renderCurrentTab();
    });
  });

  paneSelect.addEventListener("change", () => {
    expandedProgramKey = null;
    load();
  });

  filterInput.addEventListener("input", () => renderCurrentTab());

  async function load() {
    updatePaneOptions();
    const paneId = currentPane();
    programs = await window.listPrograms(paneId);
    combis = await window.listCombis(paneId);
    duplicateGroups = await window.findDuplicatePrograms(paneId);
    log(`[Library] Loaded pane ${paneId}: ${programs.length} Programs, ${combis.length} Combis, ${duplicateGroups.length} duplicate groups.`);
    renderCurrentTab();
  }

  return { refresh: load, updatePaneOptions };
}
