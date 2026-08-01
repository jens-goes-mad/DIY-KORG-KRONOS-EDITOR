// Read-only Program/Combi library browser: three sub-tabs (Programs,
// Combis, Duplicates) over whichever open dataset is selected -- its own
// selector, independent of what either Set Lists pane is currently showing
// (see docs/content/components/index.md's dataset section). Unlike
// pane.js's Set List view, nothing here is drag-and-drop-able or editable --
// this is a browser/reporting tool. See STATE.md's "Program/Combi Library
// Editor" plan for the phased roadmap this is Phase 1 of.
function createLibrary(root, { log }) {
  root.innerHTML = `
    <div class="library-header">
      <select class="dataset-select"></select>
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

  const datasetSelect = root.querySelector(".dataset-select");
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

  // null when nothing's selected (the placeholder option) -- datasetId 0
  // would collide with Number("") coercing to 0, so this is explicit instead.
  function currentDataset() {
    return datasetSelect.value ? Number(datasetSelect.value) : null;
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
    td.colSpan = 2;

    const box = document.createElement("div");
    box.textContent = "Loading usage...";
    td.appendChild(box);
    tr.appendChild(td);

    (async () => {
      const usage = await window.getProgramUsage(currentDataset(), program.bank, program.number);
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
        p.combiReferenceCountAvailable
          ? refCell(String(p.combiReferenceCount), false)
          : refCell("n/a", true)
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

  datasetSelect.addEventListener("change", () => {
    expandedProgramKey = null;
    expandedCombiKey = null;
    load();
  });

  filterInput.addEventListener("input", () => renderCurrentTab());

  // Fires immediately with whatever's already cached, and again whenever any
  // pane opens/closes a dataset -- so a file dropped onto either pane shows
  // up as a selectable option here too, without Library needing to poll or
  // reach into pane.js's own state.
  onDatasetsChanged((datasets) => {
    const previousValue = datasetSelect.value;
    populateDatasetSelect(datasetSelect, datasets, previousValue);
    // Reload if the resolved selection actually changed -- e.g. the dataset
    // this view was showing got closed elsewhere and populateDatasetSelect()
    // fell back to the placeholder. A dataset merely being ADDED elsewhere
    // doesn't change this view's own selection, so no reload in that case.
    if (datasetSelect.value !== previousValue) load();
  });

  async function load() {
    const datasetId = currentDataset();
    if (datasetId == null) {
      programs = [];
      combis = [];
      duplicateGroups = [];
      renderCurrentTab();
      return;
    }
    programs = await window.listPrograms(datasetId);
    combis = await window.listCombis(datasetId);
    duplicateGroups = await window.findDuplicatePrograms(datasetId);
    log(`[Library] Loaded dataset ${datasetId}: ${programs.length} Programs, ${combis.length} Combis, ${duplicateGroups.length} duplicate groups.`);
    renderCurrentTab();
  }

  return { refresh: load };
}
