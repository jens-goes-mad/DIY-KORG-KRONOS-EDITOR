// Internals: a read-only diagnostic view of a loaded dataset's raw
// structure -- which top-level chunks exist, and which Program/Combi banks
// are present (with engine type, where known) -- so a backup saved with
// only a subset of data selected (this is apparently a real, selectable
// thing when saving from a Kronos) can actually be SEEN, not silently
// guessed at from the Programs/Combis tables just coming up short. A peer
// content renderer to library.js's
// createLibraryPanels()/pane.js's createSetlistPanel() -- same "read
// datasetId via getDatasetId(), own no dataset-select of its own" contract
// as both. Loaded after pane.js in index.html specifically so it can
// reference PROGRAM_BANK_NAMES/COMBI_BANK_NAMES/NO_DATASET_MESSAGE
// directly -- classic <script> tags share one top-level let/const scope,
// the same thing app.js already relies on to call pane.js's
// kronosNumber()/formatBankNumber() with no import needed.
//
// Structure: one Entry per Topic (Top-level chunks / Program banks / Combi
// banks), reusing the exact same "click a row, an .editor-row appears
// directly below it" shape library.js's Program/Combi usage rows already
// use (and, one level further, the .editor-row-stack/.accordion-content
// wrapper pane.js's Setlist row editors use) -- not a bespoke layout, so
// this pane's interaction language matches the rest of the app instead of
// being its own one-off. Several topics can be expanded at once (a Set of
// topic keys), the same "independently toggleable, not one-at-a-time"
// model a Setlist row's own Color/Comment/Volume sections use. Each
// topic's detail is currently a single view (chunk badges, or a bank
// button grid -- see buildBankButtonGrid() below), but is deliberately
// wrapped the same way a multi-section accordion would be, so a second
// section -- e.g. an "Initialize bank" action once Phase 1.5 has real
// ground truth to build it with, see STATE.md -- can be added to a topic
// later without restructuring this shell.
//
// IMPORTANT CAVEAT, shown directly in the UI below, not just here: a bank's
// "index" is this file's OWN file-order position among however many
// PRG1/CBK1 sub-bank chunks were actually found -- NOT a confirmed-stable
// bank identity. See PcgFile::programBankInfo()'s own doc comment
// (src/kronos/PcgFile.h) for the full reasoning: if a real backup can
// genuinely omit a bank, every bank AFTER the gap would have its
// position-based label silently wrong -- not just in this pane, but
// everywhere in this app that assumes position-equals-identity (the
// Programs/Combis tables, Timbre cross-referencing, Program copy's
// destination checks). When fewer than the expected count are found, this
// pane says so plainly rather than guessing which specific bank is missing.

// The only top-level chunks this format is known to use (direct children
// of PCG1, see docs/README.md) -- SDB1/SBK1 are nested inside SLS1, not
// listed separately here.
const INTERNALS_TOP_LEVEL_CHUNKS = [
  { tag: "DIV1", label: "DIV1 (fixed table)" },
  { tag: "SLS1", label: "SLS1 (Set Lists)" },
  { tag: "PRG1", label: "PRG1 (Programs)" },
  { tag: "CMB1", label: "CMB1 (Combis)" },
  { tag: "DKT1", label: "DKT1 (Drum Kits)" },
  { tag: "WSQ1", label: "WSQ1 (Wave Sequences)" },
  { tag: "GLB1", label: "GLB1 (Global settings)" },
  { tag: "DPI1", label: "DPI1 (unidentified)" },
];

// One Entry per row of the outer table -- see the header comment above.
const INTERNALS_TOPICS = [
  { key: "chunks", title: "Top-level chunks" },
  { key: "programBanks", title: "Program banks (PRG1)" },
  { key: "combiBanks", title: "Combi banks (CMB1)" },
];

function createInternalsPanel(container, { getDatasetId, log }) {
  container.innerHTML = `
    <div class="internals-body">
      <div class="internals-caveat">
        Bank numbers below are this file's own file-order position, not a confirmed bank
        identity -- if a bank was omitted when this backup was saved, positions after the
        gap may not match their real bank (see STATE.md).
      </div>
      <div class="internals-empty help">${NO_DATASET_MESSAGE}</div>
      <div class="internals-content" hidden>
        <div class="internals-table-wrap">
          <table class="table is-fullwidth is-hoverable is-narrow internals-table">
            <colgroup><col style="width:40%"><col style="width:60%"></colgroup>
            <thead><tr><th>Topic</th><th>Summary</th></tr></thead>
            <tbody data-internals-topics></tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  const emptyEl = container.querySelector(".internals-empty");
  const contentEl = container.querySelector(".internals-content");
  const topicsBody = container.querySelector("[data-internals-topics]");

  let lastResult = null;  // most recent getDatasetInternals() response, re-rendered locally on expand/collapse -- no refetch needed just to toggle a topic
  const expandedTopics = new Set();  // topic keys currently expanded; several can be open at once, same model as a Setlist row's accordion sections

  function chunkSummary(topLevelChunks) {
    const found = new Set(topLevelChunks);
    const foundCount = INTERNALS_TOP_LEVEL_CHUNKS.filter((c) => found.has(c.tag)).length;
    return `${foundCount} of ${INTERNALS_TOP_LEVEL_CHUNKS.length} known chunks found`;
  }

  function bankSummary(present, names) {
    const foundCount = present.length;
    const expectedCount = names.length;
    return foundCount < expectedCount
      ? `${foundCount} of ${expectedCount} expected banks found -- see the caveat above before trusting which specific bank(s) are actually missing`
      : `All ${expectedCount} expected banks found`;
  }

  function buildChunkDetail(topLevelChunks) {
    const found = new Set(topLevelChunks);
    const row = document.createElement("div");
    row.className = "internals-chunk-row";
    for (const { tag, label } of INTERNALS_TOP_LEVEL_CHUNKS) {
      const badge = document.createElement("span");
      const isPresent = found.has(tag);
      badge.className = "internals-chunk-badge" + (isPresent ? " is-present" : " is-missing");
      badge.textContent = label;
      badge.title = isPresent ? `${tag} found in this file` : `${tag} NOT found in this file`;
      row.appendChild(badge);
    }
    return row;
  }

  // Splits a bank name list into the same 4 visual rows regardless of
  // category -- I-* (INT letter banks), the lone G(d) bank (Programs
  // only), U-* (single-letter USER banks), U-** (double-letter USER
  // banks, Programs only) -- dropping any row that's empty for a given
  // category (Combis have no G(d) and no double-letter USER banks, see
  // docs/README.md §5.1/§5.2) rather than rendering it blank.
  function bankNameRows(names) {
    const groups = [/^I-[A-Z]$/, /^G\(d\)$/, /^U-[A-Z]$/, /^U-[A-Z]{2}$/];
    return groups
      .map((re) => names.map((name, index) => ({ name, index })).filter(({ name }) => re.test(name)))
      .filter((row) => row.length > 0);
  }

  // Same bank-filter-button look Programs/Combis already use
  // (library.js's renderBankFilterRow(): `.bank-filter-row` grid,
  // `.button.is-small.bank-filter-button`, "Bank (Engine)" caption when
  // an engine type is known) -- but different semantics, since this isn't
  // a filter: Present = deactivated (a real button, nothing to do, this
  // bank already has data), Missing = enabled (styled `is-warning` to read
  // as "needs attention"), a future click target for initializing that
  // bank once Phase 1.5 has real ground truth to build that with (see
  // STATE.md) -- NOT YET implemented, so today's click just says so via
  // the same showToast() this app already uses for "not available yet"
  // feedback (pane.js's cross-pane edit-lock message).
  function buildBankButtonGrid(names, present) {
    const byIndex = new Map(present.map((b) => [b.index, b]));
    const wrap = document.createElement("div");
    wrap.className = "internals-bank-groups";
    for (const row of bankNameRows(names)) {
      const rowEl = document.createElement("div");
      rowEl.className = "bank-filter-row";
      for (const { name, index } of row) {
        const info = byIndex.get(index);
        const isPresent = Boolean(info);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "button is-small bank-filter-button" + (isPresent ? "" : " is-warning");
        btn.textContent = info && info.bankType ? `${name} (${info.bankType})` : name;
        btn.disabled = isPresent;
        btn.title = isPresent
          ? `${name}: present -- already has data`
          : `${name}: missing -- click to initialize (not yet implemented)`;
        if (!isPresent) {
          btn.addEventListener("click", () => {
            showToast(`Initializing "${name}" isn't built yet -- see STATE.md.`);
          });
        }
        rowEl.appendChild(btn);
      }
      wrap.appendChild(rowEl);
    }
    return wrap;
  }

  function buildProgramBankDetail(present) {
    return buildBankButtonGrid(PROGRAM_BANK_NAMES, present);
  }

  function buildCombiBankDetail(present) {
    return buildBankButtonGrid(COMBI_BANK_NAMES, present);
  }

  function topicSummary(topic, result) {
    if (topic.key === "chunks") return chunkSummary(result.topLevelChunks);
    if (topic.key === "programBanks") return bankSummary(result.programBanks, PROGRAM_BANK_NAMES);
    return bankSummary(result.combiBanks, COMBI_BANK_NAMES);
  }

  function buildTopicDetail(topic, result) {
    if (topic.key === "chunks") return buildChunkDetail(result.topLevelChunks);
    if (topic.key === "programBanks") return buildProgramBankDetail(result.programBanks);
    return buildCombiBankDetail(result.combiBanks);
  }

  // Renders the outer Topic table from `lastResult`/`expandedTopics` alone
  // -- no bridge call, so toggling a topic open/closed is instant. Each
  // expanded topic's detail is wrapped in `.accordion-content`, the same
  // indentation class a Setlist row's own accordion sections use, and the
  // row holding it reuses `.editor-row` -- the shared expand-row look from
  // library.js/pane.js/style.css -- rather than inventing new styling.
  function renderTopics() {
    topicsBody.innerHTML = "";
    if (!lastResult) return;
    for (const topic of INTERNALS_TOPICS) {
      const tr = document.createElement("tr");
      const titleTd = document.createElement("td");
      titleTd.textContent = topic.title;
      const summaryTd = document.createElement("td");
      summaryTd.className = "internals-summary";
      summaryTd.textContent = topicSummary(topic, lastResult);
      tr.append(titleTd, summaryTd);

      const isOpen = expandedTopics.has(topic.key);
      if (isOpen) tr.classList.add("is-selected");
      tr.addEventListener("click", () => {
        if (expandedTopics.has(topic.key)) expandedTopics.delete(topic.key);
        else expandedTopics.add(topic.key);
        renderTopics();
      });
      topicsBody.appendChild(tr);

      if (isOpen) {
        const editorTr = document.createElement("tr");
        editorTr.className = "editor-row";
        const td = document.createElement("td");
        td.colSpan = 2;
        const content = document.createElement("div");
        content.className = "accordion-content";
        content.appendChild(buildTopicDetail(topic, lastResult));
        td.appendChild(content);
        editorTr.appendChild(td);
        topicsBody.appendChild(editorTr);
      }
    }
  }

  async function refresh() {
    const datasetId = getDatasetId();
    if (datasetId == null) {
      emptyEl.hidden = false;
      contentEl.hidden = true;
      return;
    }

    const result = await window.getDatasetInternals(datasetId);
    if (!result.ok) {
      log(`[Internals] ${result.error}`);
      emptyEl.textContent = `Error: ${result.error}`;
      emptyEl.hidden = false;
      contentEl.hidden = true;
      return;
    }

    lastResult = result;
    emptyEl.hidden = true;
    contentEl.hidden = false;
    renderTopics();
  }

  // Called by the shell whenever its shared dataset selection changes --
  // same contract as createSetlistPanel()'s/createLibraryPanels()'s own
  // onDatasetChanged().
  async function onDatasetChanged() {
    await refresh();
  }

  return { onDatasetChanged };
}
