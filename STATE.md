=== STATE BLOCK — GOALS, ACHIEVEMENTS, BLIND SPOTS ===
Date: 2026-08-03
Status: Working prototype, git repo (github.com/jens-goes-mad/
        DIY-KORG-KRONOS-EDITOR, `main` branch) with a public Hugo/GitHub
        Pages docs site (jens-goes-mad.github.io/DIY-KORG-KRONOS-EDITOR)
        and CI building all 4 platform targets on every relevant push.
        Core file format (Set List names + params + instrument-name
        cross-reference, now including Font size/Transpose/Combi Timbre
        references) is reverse-engineered and wired into a real CHOC app
        with drag-and-drop open and two independent panes, each with its
        own dataset selector and a Setlist/Programs/Combis/Duplicates
        category navbar -- browse/filter/swap/copy Set Lists, an editable
        Comment field, and a read-only Program/Combi library with
        byte-exact duplicate detection -- see "PROGRAM/COMBI LIBRARY
        EDITOR" below. A componentized frontend pattern (small,
        standalone, byte-level-tested UI pieces) and a matching backend
        decoder/encoder architecture are now the deliberate direction --
        see "ARCHITECTURE: DECODER/ENCODER REFACTOR" below, currently the
        active thread of work.

--- GOAL ---

A cross-platform, cross-architecture editor for Korg Kronos `.PCG`/`.SNG`
backup files, built on CHOC (HTML/JS/CSS UI + native C++ bridge) -- same
stack choice as the sibling DIY-MIDI-METRONOME/EDITOR project, reused
rather than reinvented (same CMakeLists.txt structure, vendored
third_party/choc, fetchResource/bind wiring in main.cpp). Preferred
implementation language: C++.

First iteration scope, as originally given:
  1. Open a file, extract its Set List(s) to memory.
  2. Show all entries of the selected Set List; filter/search, copy/swap
     entries via drag and drop.
  3. A Norton-Commander-style dual pane to move/copy entries between
     Set Lists.

A sibling reference project (a running CHOC-based app + CI pipeline) was
mentioned early on as something the project owner would link in later for
conventions; not linked yet -- see Blind Spots.

--- THE FILE FORMAT (reverse-engineered; full byte-level detail in README.md) ---

The `.PCG`/`.SNG` container is chunked (RIFF/IFF-like, but big-endian, and
every chunk header is preceded by one still-unexplained 4-byte field).
`PCG1` (the whole file) has these top-level children:

  DIV1  -- small fixed table, not decoded
  SLS1  -- Set Lists (see below)
  PRG1  -- Programs: 20 sub-banks (MBK1/PBK1 tags, interleaved)
  CMB1  -- Combis: 14 sub-banks (CBK1 tags)
  DKT1  -- Drum Kits -- NOT explored
  WSQ1  -- Wave Sequences -- NOT explored
  GLB1  -- Global settings -- NOT explored
  DPI1  -- unidentified -- NOT explored

Set List names (`SLS1 > SLD1 > SDB1`): one `SDB1` chunk holds all 128 of
the unit's Set Lists. Header (count/numSetlists=128/bytesPerSetlist=3612)
followed by 128 blocks of 129 28-byte records each (1 name + 128 songs).
Record = `[4-byte marker][24-byte ASCII name]`. A marker value of
`28 0f 01 00` on the record right after a name flags "this is where the
128 songs start" -- names and markers otherwise look identical, so this is
the only way to find a Set List's boundary. Verified end to end: all 128
Set Lists extract correctly, including 5 real user-named ones with real
song titles.

Per-slot parameters (`SLS1 > STL1 > SBK1`, a sibling of SLD1 found only by
a *generic* chunk-tag scan, not a targeted SDB1-only search): same header
shape, 128 Set List blocks of a 40-byte header + 128 song records on a
542-byte stride. Confirmed record layout (all field offsets relative to
record start):

  +12  `4*(color-1) + type` (bits0-5 only!) -- type bit0 (1=Program, 0=Combi),
       color 1-based; bits6-7 of this SAME byte are Font size's low 2 bits
  +13  bank index (bits0-4 only!); bits5-7 of this SAME byte are
       Transpose's high 3 bits
  +14  program/combi number within that bank
  +15  Hold Time + 1
  +16  Volume, 0-127, no transform
  +17  Font size's high bit (bit4) + Transpose's low 3 bits (bits5-7);
       bit3 and bits0-2 still unexplained
  +18  Comment (free ASCII text, can contain literal \r\n, NUL-terminated)

  CONFIRMED (2026-08-01, via a properly isolated test file, test_1.PCG):
  Font size = 3 bits (0=S the true baseline, 1=XS, 2=M, 3=L, 4=XL) and
  Transpose = a 6-bit two's-complement value (-32..+31), each packed a
  few bits at a time across the two bytes noted above -- full derivation
  in docs/README.md §4.4. This was a real, actionable bug fix: Bank and
  Color were being read as the FULL byte (unmasked) until this was found,
  silently corrupted on any real slot that also had a non-default Font
  size/Transpose set -- fixed in PcgFile.cpp, masks now applied to all
  four fields.

Instrument-name cross-reference (`CMB1 > CBK1` for Combi, `PRG1 > MBK1`/
`PBK1` for Program): both use one shared record shape -- the same 12-byte
header again, then fixed-size records each starting with a 24-byte name
field 4 bytes in (space/NUL-padded, NOT NUL-terminated -- a full 24-char
name has no terminator at all). A slot's bank/number index directly into
`[bank][number]` of whichever list matches its type. Verified against
three independent ground-truth anchors the project owner gave directly
(not guessed): "Rolling in the Deep" (Combi, bank 7 = USER-A / record 9),
"Berlin Grand SW2 U.C." and "Rain Again" (Program, bank 0, records 0 and
127) -- all three matched exactly. Bank values outside the stored range
(>=20 for Program, >=14 for Combi) are real gaps, not bugs -- near-certainly
GM/GM2 references (fixed MIDI-spec content, not stored per-file); a
one-off bank-231/192 reference each looks like genuine data corruption in
that one slot rather than a parsing issue. Across a full real-ish test
file, 143/152 assigned slots resolved to a name; all 9 misses were
out-of-range, zero were in-range failures.

Deliberately NOT solved (see Blind Spots): the `used`/count header
field's meaning, SBK1 +17's bit3/bits0-2, the 4-byte chunk-header prefix
field, and exactly which of the 20 PRG1 banks maps to which *display
label* (the name lookup mechanism itself is confirmed; the specific
letter shown per bank index is a positional assumption modeled on the
project owner's given naming order, not independently verified the way
Combi's order was).

--- WHAT'S BUILT AND WORKING ---

  - `src/kronos/PcgFile.{h,cpp}`: parses SDB1 (names), SBK1 (Program/Combi/
    bank/number/Color/Hold Time/Volume/Comment per song), and CBK1/MBK1/
    PBK1 (real instrument names, cross-referenced into `Song::instrumentName`)
    per the layout above. `load(path)` and `loadFromMemory(bytes)` share
    one parsing path. Every optional chunk degrades gracefully (a file
    missing/mismatching SBK1 or the instrument banks still gets Set List
    names fine, just with emptier fields) rather than failing the whole load.
  - `src/bridge/EditorBridge.{h,cpp}`: holds loaded files keyed by a "pane"
    id ("A"/"B"). Exposes `openFile`(path, unused by the UI but kept for
    CLI/debug)/`openFileBytes`(base64, what the UI actually uses)/
    `listSetlists`/`getEntries`/`moveEntry`(swap within a Set List)/
    `copyEntry`(across panes/Set Lists, whole Song incl. all params)/
    `setComment`. Nothing is ever written back to disk -- everything is
    in-memory rearrangement only.
  - `frontend/`: two side-by-side panes (`pane.js`, one instance per side).
    Each pane is a drag-and-drop target (drop a `.PCG` file -> read via the
    browser's File API -> base64 -> `openFileBytes`; confirmed working by
    the project owner in the real app) with a Set List picker, filter/
    search, and a table of that Set List's 128 song slots showing Kronos's
    own 000-127 numbering, Type/Bank/Vol/Hold/Color columns, and the real
    instrument name as a subtitle under the slot's own label (shown
    always, even when identical to the label -- confirms the lookup found
    something). Dragging a row within a pane swaps two songs (all fields);
    dragging to a different pane/Set List copies the whole song across.
    Clicking a row expands an inline multiline Comment editor (monospace,
    grows to fit content past 10 rows, multiple rows can stay open at
    once); Apply calls `setComment`. No typed-path/Open-button UI (removed
    per explicit request -- drag-and-drop is the only way in, though the
    bridge's path-based `openFile` still exists underneath).
  - `frontend/mock_bridge.js`: fake in-memory backend (mirrors the real
    API) so the UI can be exercised in a plain browser with no native
    build -- cannot exercise real file parsing (browsers have no
    filesystem access at all, which is the whole reason Choc's native
    bridge exists).
  - `frontend/components/kronos/setlist-comment.{js,css,test.html}`: the
    first componentized piece (see "ARCHITECTURE" below) -- built,
    self-tested standalone, not yet wired into `pane.js`.
  - `docs/`: a public Hugo/GitHub Pages site
    (jens-goes-mad.github.io/DIY-KORG-KRONOS-EDITOR) alongside the format
    reference doc (`docs/README.md`, mirrored -- keep in sync by hand --
    into `docs/content/format/`). Also has an Overview page, a Building-
    the-app page, and an App Architecture & Components page.
  - Why drag-and-drop is the *only* open mechanism: a plain
    `<input type="file">` does trigger a real native NSOpenPanel inside the
    Choc-wrapped WKWebView, but the resulting sheet renders behind the app
    window instead of in front (a choc/WKWebView z-order quirk, root cause
    not isolated). Drag-and-drop sidesteps it entirely and is arguably the
    better design regardless -- it works identically on every platform,
    whereas recovering an absolute path from a WebView's file picker is
    inconsistent-to-impossible across WebKit/GTK-WebKit/WebView2. Tradeoff:
    base64-encoding a 50-70MB file in JS and shipping it through the
    bridge as one JSON string isn't fast -- fine for occasional loads, not
    a "reload on every drop" workflow.
  - Build: CMake, C++17, Debug (frontend/ read live off disk) vs Release
    (embedded via tools/embed_resources.py) split, mirroring
    DIY-MIDI-METRONOME/EDITOR's setup exactly. No MIDI/audio deps (no
    rtmidi) -- this tool only reads local files, no device I/O.

--- PROGRAM/COMBI LIBRARY EDITOR (planned, Phase 1 built) ---

Goal beyond just Set Lists: browse every Program/Combi directly, see where
each Program is actually used, find byte-exact duplicate Programs, and
eventually delete the unused ones and repoint Combis at a single kept
copy. That last part means writing to a real Kronos backup for the first
time ever in this project, based on a part of the format that isn't
reverse-engineered at all yet -- so the work was explicitly split into
three phases, only the first of which is built:

  - **Phase 1 (DONE)**: read-only. `PcgFile` gained `ProgramInfo`/
    `CombiInfo` (flat `[[{bank, number, name}]]` lists, populated from the
    same PRG1/CMB1 chunks the instrument-name cross-reference already
    walked) plus `programSetlistUsages(bank, number)` (every Program-type
    Set List slot referencing it) and `findDuplicatePrograms()` (groups of
    2+ Programs whose full ~4960-byte record hashes to the same FNV-1a
    value -- computed during parsing since the raw file bytes aren't kept
    around afterward). `EditorBridge` exposes `listPrograms`/`listCombis`/
    `getProgramUsage`/`findDuplicatePrograms`. `frontend/library.js` is a
    new top-level "Library" tab (alongside "Set Lists") with Programs/
    Combis/Duplicates sub-tabs, a Pane A/B source selector, filter/search,
    and click-to-expand usage info per Program -- read-only, no drag-and-
    drop, no delete/consolidate buttons (nothing to wire them to yet).
    Verified against the real 47.9MB sample: 2560 Programs / 1792 Combis
    (matches 20x128 / 14x128 exactly), the known "Berlin Grand SW2 U.C."
    anchor round-trips correctly, and 62 duplicate groups covering 500 of
    2560 Programs were found -- including real repeated content like
    "Snappy Clav" and "Kompton Clav" turning up twice each in different
    banks, a good sanity check.
  - Caveat found during Phase 1: **bank 0 / number 0 is also the all-zero
    byte value**, so `programSetlistUsages(0, 0)` massively over-counts --
    16,000+ "usages" on the real sample, because a Set List slot that was
    never actually assigned a Program still reads as bank 0/number 0.
    Every other bank/number spot-checked (e.g. bank 2/number 8, bank
    19/number 0) returns a small, correct-looking count. There's no known
    flag distinguishing "really assigned to 0/0" from "never touched" --
    documented in `PcgFile.h`, not fixed (no known fix without a new
    reverse-engineering lead, same as the other format blind spots below).
  - **Phase 2 (structure CONFIRMED, not wired into usage-counting yet)**:
    each Combi's 16 Timbres sit at a fixed 188-byte stride starting 4806
    bytes into the record; the first 3 bytes are Program number, a raw
    bank code, and a status byte (Off/Internal/External/Ex2 -- top 3
    bits). Confirmed via real Combi samples the project owner provided,
    cross-checked against an independent external reference
    (`DaBlick/PCG-Tools`, see `docs/references/`) -- see `docs/README.md`
    §6 for the full derivation, including a Combi that initially looked
    like a model gap but turned out to be the project owner's
    recollection of that Combi not matching what was actually saved.
    `PcgFile`'s `TimbreRef`/`CombiInfo::timbres` and `timbreBankName()`
    are built and smoke-tested; still TODO: wire this into real
    Combi-usage counting (today's `getProgramUsage` still explicitly
    flags `combiUsagesAvailable: false` rather than silently implying
    zero) -- deliberately not done yet since only 8 of the ~34 possible
    bank codes are confirmed, and a real "Combi refs" count would need
    every bank a user's file actually uses to resolve correctly.
  - **Phase 3 (not started, depends on Phase 2)**: actual deletion of
    unused duplicate Programs and repointing Combis at a kept copy -- the
    first real write-back to a `.PCG` file this project would ever do.
    Needs a dry-run/preview step and a strong recommendation to keep an
    untouched backup, since there's no way to run Korg's own file
    validator from here to confirm nothing broke.

--- ARCHITECTURE: DECODER/ENCODER REFACTOR (decided 2026-08-01, in progress) ---

A deliberate architectural direction, agreed with the project owner, for both the
frontend and backend, growing out of building `frontend/components/kronos/
setlist-comment.js` (Comment + Font size, see docs/content/components/index.md for the
full rationale):

  - **Frontend**: small, standalone UI pieces under `frontend/components/{kronos,
    generic}/`, each split into a pure codec (`decode(bytes) -> state` / `encode(bytes,
    state) -> newBytes`, no DOM), a component (owns the actual UI, operates only on
    `state`), and a standalone `.test.html` harness with real committed self-checks --
    no CHOC, no native build, just a static file server. `setlist-comment.js` is the
    first and so far only one built this way; a generic reusable envelope/ADSR editor
    (shared across every Kronos synth engine's envelope curves) was discussed as a strong
    future candidate given how much of the Kronos reuses the same ADSR-shaped UI.
  - **Backend (Program decoder BUILT 2026-08-01, verified zero-regression against the
    real 47.9MB file)**: `PcgFile` no longer discards the raw file bytes after parsing
    (`data_`, retained). `src/kronos/ProgramDecoder.{h,cpp}` is the first small,
    per-record decoder (mirrors the frontend pattern): `decodeProgramFields()` (raw
    Kronos fields) and `hashProgramRecord()` (our own derived bookkeeping) as separate
    functions, plus `PcgFile::decodeProgram(bank, number)` proving a record can be
    re-decoded on demand from the retained bytes, not just once at load. This also
    happens to be the cleanest fix for a staleness class of bug the project owner
    flagged before it was ever written: if a component/decoder holds a byte snapshot
    captured once and something else changes the underlying record in the meantime, a
    later write silently reverts that other change. With raw bytes as the *one* retained
    copy (not a byte snapshot plus a separate structured shadow copy), every decode
    always reads the current state -- there's nothing to go stale.
  - **Backend (Combi decoder BUILT 2026-08-01, same day, covered by
    `pcg_file_test`)**: `src/kronos/CombiDecoder.{h,cpp}` is the second per-record
    decoder, same shape as ProgramDecoder -- `decodeCombiFields()` returns raw Kronos
    fields (name) plus each Combi's 16 Timbre-to-Program references (`TimbreRef`, moved
    out of `PcgFile.cpp`'s old inline `collectCombiRecords()`/`readCombiTimbres()`/
    `decodeTimbreStatus()`, now dead code and removed). No `hash()` -- byte-exact
    duplicate detection was only ever requested for Programs. `PcgFile::decodeCombi(bank,
    number)` mirrors `decodeProgram()`, backed by a new `combiBankLocations_` (mirrors
    `programBankLocations_`). `tests/pcg_file_test.cpp`'s synthetic fixture grew a CBK1
    bank to cover this: a direct `decodeCombiFields()` unit test (name-padding trim,
    truncated-record degrade), plus end-to-end `combis()`/`decodeCombi()` assertions
    through `PcgFile::loadFromMemory()`. `timbreBankName()`/`isConfirmedTimbreProgramBank()`
    stayed in `PcgFile.cpp` rather than moving, since `PcgFile.cpp` itself calls them (in
    `combiUsagesForProgram()`/`combiUsageCounts()`), not just the decoder.
  - **Sequencing (explicit, small-iterations-first)**: Program decoder done, test
    infrastructure landed (Blind Spot #14), Combi decoder done -- **Set List slot decoder
    is the next step**, following the same pattern once proven against tests + the real
    UI.
  - **Datasets: decoupling "loaded file" from "pane" (BUILT 2026-08-01, human-verified
    in the real app -- "works like a charm")**: the two-pane UI used to conflate two
    different things a user wants to do -- (1) rearrange entries between Set Lists
    *within the same backup* to build a new gig Set List, which needs both panes
    looking at the *same* loaded file so an edit in one is visible in the other, vs.
    (2) compare/merge two *different* backups side by side, which needs two genuinely
    independent files. The old model (`EditorBridge`'s `m_panes`, keyed by the
    frontend's own `paneId` string, one `PcgFile` per pane, 1:1) did neither correctly:
    dropping the same file onto both panes silently forked it into two unrelated
    in-memory copies. We agreed the fix: promote **dataset** (one loaded file) to a
    first-class concept, identified by an id `EditorBridge` mints itself on open
    (`m_datasets`, keyed by `int datasetId`, never a caller-supplied string), fully
    decoupled from which pane displays it.
    - `openFile`/`openFileBytes` no longer take a paneId -- they mint a new dataset
      every call and return `{datasetId, displayName, setlistCount}`. New
      `listDatasets()` (every open dataset, for any selector to populate itself) and
      `closeDataset(datasetId)` (frees one, a harmless no-op if already gone). Every
      other method (`getEntries`, `moveEntry`, `copyEntry`, `setComment`,
      `listPrograms`, `listCombis`, `getProgramUsage`, `findDuplicatePrograms`) renamed
      its paneId arg(s) to datasetId -- `copyEntry` needed **no logic change at all**,
      since it already had no same-id special case; pointing both panes at one dataset
      and dragging between them "just works" purely from this rename.
    - `datasetId` is a plain `int` (not a string) specifically to avoid a real footgun:
      `std::map<std::string, ...>` sorts "10" before "2" lexicographically, which would
      silently scramble selector option order past the ninth open dataset. Matches how
      `setlistIndex`/`songIndex` were already round-tripped as numbers through
      `<select>` values elsewhere in this codebase.
    - New `frontend/datasets.js` (no build step, plain script like every other
      `frontend/*.js` file): `refreshDatasets()`/`onDatasetsChanged(listener)` (a small
      pub/sub -- a listener fires immediately with whatever's cached, and again on
      every future refresh from *any* pane or Library, so a file dropped anywhere shows
      up as a selectable option everywhere) plus a shared `populateDatasetSelect()` DOM
      helper used identically by `pane.js` and `library.js` so neither duplicates it.
    - Both Set List panes and the Library view each got their own dataset-select
      dropdown (Library's replaced its old hardcoded "Pane A"/"Pane B" `<option>`s --
      the closest existing analog, but never actually generated from a registry).
      Dropping a file always creates a *new* dataset (never silently overwrites); a
      pane's own selector lets it switch to *any* already-open dataset, including one
      another pane opened. `app.js`'s `onDropEntry` now compares dataset identity (not
      pane identity) to decide reorder-vs-copy, and refreshes every pane whose
      `getCurrentDatasetId()` matches either side of the move/copy -- this is the
      concrete mechanism that makes "both panes on the same dataset" behave like one
      shared document.
    - `frontend/mock_bridge.js` mirrors the new shape (`datasets = {}` keyed by a local
      counter) so the no-native-build frontend dev path stays usable.
    - Verified: full app + `pcg_file_test` build clean, `ctest` passes (this refactor
      doesn't touch `PcgFile`/decoders at all), all JS syntax-checked, `datasets.js`'s
      actual pub/sub + selector-population logic passed a headless Node smoke test, and
      a live click-through in the real app confirmed multi-dataset open, switching, and
      shared-dataset drag/drop end to end -- "works like a charm."
    - Two issues surfaced during that click-through, deliberately left unfixed for now
      (see Blind Spots #17/#18) -- neither blocks using the feature.
  - **Per-pane category navbar (BUILT 2026-08-03)**: the top-level "Set Lists" vs
    "Library" split is gone -- each pane is now a shell with its own single dataset
    selector plus a category navbar (Setlist / Programs / Combis / Duplicates; Global
    later, once `GLB1` is ever parsed -- not added as a placeholder tab, since there's
    nothing behind it yet). Motivation: the old split meant you couldn't put a Setlist
    view and a Programs view side by side, or compare two datasets' Program banks
    directly -- exactly the kind of comparison the `explore/sqlite-patch-datastore`
    branch's physical-bank-placement work would want. Built by splitting both existing
    factories into peer content renderers plus a thin shell:
    - `frontend/pane.js`'s `createSetlistPanel()` -- the old `createPane()` body
      (table/filter/comment-editor/drag-drop), now reading which dataset to show via a
      `getDatasetId()` accessor instead of owning a dataset-select itself.
    - `frontend/library.js`'s `createLibraryPanels()` (renamed from `createLibrary()`)
      -- same idea: dropped its own dataset-select *and* its own internal
      Programs/Combis/Duplicates tab bar (that nav is now the shell's, so all four
      categories are true peers) -- exposes `showPanel(name)` for the shell to call
      instead of handling its own tab clicks.
    - `createPane()` (same entry point `app.js` already called) is now the shell:
      owns the one dataset-select + category nav, notifies both renderers via
      `onDatasetChanged()` on any dataset change (regardless of which category is
      currently visible, so switching back to a hidden one later still shows fresh
      data), and still returns `{ refreshEntries, getCurrentDatasetId }` unchanged --
      `app.js`'s `onDropEntry` needed zero changes.
    - **Deliberately deferred, per explicit agreement**: no drag-and-drop for
      Programs/Combis rows (the hard physical-bank-placement problem from the
      exploration branch -- Setlist row drag/copy is unaffected); Duplicates stays
      scoped to the pane's single selected dataset, no cross-dataset dedup yet.
    - No backend/bridge changes at all -- purely a frontend reorganization reusing
      already-tested render logic; `pcg_file_test`/`ctest` untouched and still passing.
  - **Chunk-based data flow for components (designed 2026-08-01, not yet implemented)**:
    two deliberately different tiers, not one architecture for everything --
    - *Bulk/list views* (Programs table, dedup, etc.) stay served by native decoders
      walking the whole retained buffer -- real efficiency win here (e.g.
      `findDuplicatePrograms()` hashes ~12.7MB across ~2560 records; genuinely faster
      native than doing the same in a WebView's JS engine, and avoids repeatedly
      shipping large data across the JS/native bridge for something already sitting in
      native memory).
    - *Detail/edit views* (Comment+Font-size today, more later) request the *specific
      raw byte chunk* they need (one record's bytes) via the bridge, and do their own
      decode/encode entirely in JS -- exactly `setlist-comment.js`'s existing pattern,
      generalized. Preserves the "test without building the native app" property
      specifically where it matters most: interactive UI a human iterates on.
    - **Why not a deferred edit overlay**: originally considered keeping the retained
      buffer strictly immutable and layering pending edits on top as a `{position ->
      new bytes}` overlay (for undo/redo, and to avoid touching canonical state).
      Rejected: overlay keys are position-based (bank/number), and any *reorder*
      operation (moving/swapping Programs, Combis, Set List entries -- already a core
      feature) would leave a stale overlay entry silently applying to whatever record
      now occupies that position instead of the one it was meant for. **Decided
      instead**: `encode()` writes back *immediately* into `data_` via a new bridge
      method, `putRecordBytes()` -- baking the edit directly into the bytes that any
      later reorder would move, rather than tracking it separately. Safe specifically
      because this app is single-threaded JS with exactly one user editing at a time --
      no concurrent-writer conflicts to resolve. Undo/redo stays achievable this way too
      (each `putRecordBytes()` call is a discrete, reversible operation -- keep old
      bytes alongside new in a history stack), just not built yet.
    - **`putRecordBytes()` must keep the structured cache in sync**: `Song.comment`/
      `Song.params.fontSize` etc. are cached fields, parsed once out of `data_` into
      `setlists_` at load time. A raw-byte-only write would leave them stale (Set List
      table keeps showing the old comment). Required behavior once built: (1) overwrite
      bytes in `data_`, (2) re-run the *existing* SBK1 decode on just the newly-written
      bytes, (3) update the corresponding `Song` in `setlists_` from that fresh decode --
      so the structured cache is always derived from canonical bytes right after a
      write, never hand-maintained separately.
    - **Cross-pane refresh gap -- RESOLVED (2026-08-01), superseded by the Datasets
      refactor below**: the plan on this line used to be a narrow fix (a
      `getCurrentSetlistIndex()` pane accessor, `app.js` checking "is the other pane on
      the same Set List"). What actually got built is more general and solves the
      problem at its root instead: "loaded file" became its own first-class concept
      (a *dataset*) decoupled from "which pane shows it" -- see the Datasets subsection
      below. `onDropEntry` now refreshes every pane whose `getCurrentDatasetId()` matches
      either side of a move/copy, which handles "both panes on the same Set List" as one
      case of the more general "both panes on the same dataset."
  - **Streaming/mmap for raw bytes -- considered, not applicable to the current data
    path**: retaining the whole file in `data_` isn't a preference for "native heap over
    streaming" -- it's a consequence of how bytes actually arrive. The app's only wired
    file-opening mechanism (drag-and-drop) means the whole file is already fully
    materialized in memory multiple times (browser `File.arrayBuffer()`, a base64
    string shipped across the bridge, then decoded back to bytes) *before*
    `PcgFile::loadFromMemory` ever sees it -- there's no live socket/handle left to
    stream from by that point. `PcgFile::load(path)` (a plain `ifstream` read, not wired
    to any UI control -- dropped in favor of drag-and-drop specifically because of the
    NSOpenPanel-behind-the-window bug, see Blind Spots) is the one place a real
    seek/mmap-based reader would genuinely help. Worth revisiting *if* path-based
    opening ever becomes primary again (e.g. if that native-dialog bug gets fixed).
  - **No encoder yet beyond `setlist-comment.js`, deliberately**: every current
    Program/Combi use case (table population, dedup) is read-only. An encoder gets
    built once there's an actual write feature driving its real shape, same "don't
    build for hypothetical future needs" principle already applied elsewhere in this
    project. **Renaming Programs/Combis/Set Lists** was explicitly named as a likely
    upcoming feature that would need one -- not started.
  - **Open/Save dialog**: real write-back (`putRecordBytes()`, and eventually saving to
    disk) will need either a working native Save dialog (the NSOpenPanel-behind-the-
    window bug, unresolved, see Blind Spots) or some other path-recovery mechanism --
    drag-and-drop is input-only, it can't hand back a path to save *to*. Explicitly
    deferred: this project is still in read-only territory (Phase 1/2 of the Library
    Editor, no Program/Combi/Set-List encoder exists yet either), so fixing this now
    would be solving a problem too early.
  - **Explicitly not committed to being final**: both the project owner and this
    assistant agreed to revisit/rethink this shape as each piece (Program decoder now
    done; chunk-based component wiring next) proves itself against real tests and the
    real UI, rather than committing to it across the whole codebase up front.

--- EXPLORATION: SQLITE-BACKED PATCH DATA MODEL (branch: explore/sqlite-patch-datastore, 2026-08-02, NOT DECIDED) ---

Lives on its own branch, deliberately kept separate from `main` -- this is a genuine
architecture question, not yet a decision, and touches nothing that's currently
shipped. Started from a real, practical concern (memory/perf with several large
`.PCG` files open at once now that Datasets decouple "loaded file" from "pane," see
the ARCHITECTURE section above) and evolved into something bigger worth recording
even in its current unfinished state, so the reasoning isn't lost if this branch sits
for a while.

  - **Where the idea started**: instead of every open dataset holding its own
    full ~50-70MB raw byte buffer in `PcgFile::data_`, back Program (and
    potentially Combi/Set List) storage with SQLite -- an on-disk-backed file
    (not `:memory:`, which wouldn't help RAM at all), so the OS page cache can
    evict cold data instead of everything sitting permanently resident. Since
    `decodeProgramFields()`/`hashProgramRecord()` already operate on a bare
    byte pointer (not on `PcgFile` internals), swapping where that pointer's
    bytes come from -- offset math into `data_` vs. a `SELECT raw FROM
    programs WHERE bank=? AND number=?` -- is invisible to `EditorBridge`'s
    public shape and to any future JS-side component. That property held up
    well and isn't in question.
  - **Where it got more ambitious**: a Program table that persists *across
    sessions*, deduped globally by `content_hash` (not per-dataset) -- "every
    unique Program the editor has ever seen" -- plus a Combi-Timbre table
    modeled as an m:n join to Programs, plus Set List slots as private
    per-row data with a foreign key to a Program/Combi instead of resolving
    bank/number against array lookups by hand. Keeping the raw BLOB per row
    (not just derived columns) keeps this compatible with the project's core
    method -- derived fields stay honestly re-computable if a decoder's
    understanding improves later, rather than becoming a second, driftable
    source of truth.
  - **Where it hit a real wall (the reason this is a branch, not a merged
    change)**: Kronos Program/Combi data is NOT freely content-addressable
    the way the hash-dedup model assumes. A Combi's Timbre reference isn't
    "this Program's content" -- it's "whatever physically sits at raw bank
    code X, number Y," and each sound engine (HD-1, AL-1, CX-3, ...) owns its
    own dedicated bank ranges, so that physical slot has to both exist *and*
    belong to the right engine for the reference to mean anything. Copying a
    CMB bank without its dependent PRG bank(s) doesn't yield "a Combi with
    unknown sounds" -- it yields a structurally broken Combi on the receiving
    unit. (This matches why real commercial patch vendors ship one CMB bank
    plus the one or two specific PRG banks it actually depends on, never an
    arbitrary/whole-unit Program dump.) This is *the* mental block for
    building any "patch manager" on top of a hash-deduped model: content
    hash is a good *compatibility check* ("does bank X/number Y in the
    destination already hold byte-identical content to what this Combi
    expects?"), but it can't be the reference mechanism itself. Any real
    move/merge feature has to solve a physical-placement problem --
    allocating an engine-compatible bank slot in the destination and either
    confirming it already matches or copying the dependency there -- not
    just a content-copy-plus-FK-update problem.
  - **A prerequisite this surfaced that wasn't obvious before, since partly
    resolved (2026-08-02)**: safely moving/merging Combis depends on knowing
    a Program bank's engine. Research (see `docs/external/README.md`)
    turned up more than expected:
    - **Officially confirmed by Korg's own KRONOS Parameter Guide**: a bank
      is either HD-1 or EXi, never mixed -- "Banks can contain either HD-1
      Programs or EXi Programs, but not both" -- and the manual's factory
      table names the *specific* engine per bank by default (INT-D=AL-1,
      INT-E=AL-1 and CX-3, INT-F=STR-1, USER-A=MS-20EX & PolysixEX,
      USER-B=MOD-7, ...). Explicitly the factory *default* -- bank type (and
      by extension real contents) is user-reconfigurable per bank via Global
      mode, and a separately-found community document confirms real
      long-used units routinely drift from this layout. A strong
      default/fallback label set, not a per-file guarantee.
    - **Built and tested (this branch)**: `classifyProgramBankType()`
      (`src/kronos/ProgramDecoder.{h,cpp}`) derives the HD-1/EXi split from
      two signals already parsed at load time -- the bank's own chunk tag
      (`MBK1`=EXi/`PBK1`=HD-1, from `docs/references/PCG-Structure-Kronos-
      DaBlick.txt`) cross-checked against its declared per-record byte
      stride (HD-1=4960/EXi=3706 bytes, from a Synthify community
      spreadsheet, see `docs/external/README.md`) -- deliberately not a
      hardcoded per-bank-index table, since bank type is configurable.
      `ProgramInfo`/`decodeProgram()` now carry a `bankType` field; covered
      by a dedicated synthetic unit test (both match and mismatch cases) in
      `tests/pcg_file_test.cpp`, spot-checked with a deliberately broken
      assertion to confirm it fails loudly.
    - **Still open**: the byte-level mechanism itself (chunk tag + the
      4960/3706 stride figures) hasn't been cross-checked against a real
      backup's actual bytes -- no `.PCG` file was available in the
      environment this was built in. The underlying HD-1/EXi model is now
      officially confirmed; this project's specific *detection* of it from
      raw bytes is not, yet. Also still open: which *specific* EXi engine a
      given EXi bank holds isn't decoded anywhere yet (only the HD-1/EXi
      binary split is built) -- the Parameter Guide's factory table is real
      ground truth for that follow-up, whenever it's wanted.
  - **UI enforcement (BUILT 2026-08-03)**: the per-pane category navbar (see above)
    made it easy to point two panes at two *different* datasets and drag a Setlist
    slot between them -- which surfaced this problem concretely: `copyEntry` happily
    copied a Song's bank/number as-is into the other dataset, even though that
    bank/number is a physical-location reference meaningful only within its own
    dataset's Program/Combi tables. `app.js`'s `onDropEntry` now rejects any
    cross-dataset Setlist copy outright (same-dataset cross-Setlist-list copy, and
    same-list reorder, are unaffected -- both stay within one `PcgFile`, safe).
    `pane.js` also shows this during the drag itself (not just after dropping): a
    shared `draggedFromDatasetId` variable (a plain JS side channel, since
    DataTransfer's payload isn't readable during `dragover` for a same-page drag)
    lets a row being hovered skip `preventDefault()` when the drag came from a
    different dataset, so the browser shows its own "not allowed" cursor and no
    `drop` event fires there at all. Revisit once the physical-bank-position
    problem above is actually solved -- not before.
  - **Not decided, not scheduled**: no schema has been written, no SQLite
    dependency has been added, nothing here has touched `main`. This section
    exists so the reasoning survives even if this branch is set aside for a
    while -- update it in place as the exploration continues, rather than
    letting the thread live only in chat history.

--- BLIND SPOTS / NOT YET TOUCHED ---

Format:
  1. SBK1 +17's bit3 and bits0-2 -- still unexplained now that bit4 and
     bits5-7 are confirmed as Font size/Transpose (see above). Real files
     show isolated non-zero values there independent of either confirmed
     field, so something real is still unaccounted for.
  2. What the `used`/count header field (present in SDB1/SBK1/CBK1/MBK1/
     PBK1 alike) actually counts.
  3. The 4-byte prefix field preceding every chunk header throughout the
     whole format.
  4. Exactly which of the 20 PRG1 banks maps to which display label --
     lookup mechanism confirmed, specific label-per-index is not.
  5. DKT1 (Drum Kits), WSQ1 (Wave Sequences), GLB1, DPI1 -- entirely
     unexplored. Unknown whether Set List slots can reference these
     directly (if so, instrument-name lookup has a gap there too).
  6. The older SoundQuest `.SQS` backup dialect (`LIST`/`FORM`/`BANK`
     wrapping) found under `~/Documents/Sound Quest/` -- structurally
     different from the `KORG`/`PCG1` dialect this parser targets; never
     tested against it.

App/UI:
  8. Leading spaces reportedly disappearing from Comment text somewhere in
     the round-trip -- reported once, not yet reproduced. Neither
     `readComment()` nor `setComment()` does any trimming, so the cause
     isn't obvious from code inspection alone; repro steps needed (typed
     fresh via Apply vs. already present in the source file).
  9. No save-back-to-file at all -- every edit (move/copy/comment) is
     memory-only and lost on reopen. This is the single biggest gap
     between "browser" and "editor."
  10. Filter/search and row drag-swap/drag-copy interactions have been
      exercised by the project owner in the real app for file-open and
      name-lookup verification, but not explicitly confirmed end-to-end
      for the swap/copy drag gestures themselves or the Set List picker
      dropdown -- worth a deliberate pass.
  11. NSOpenPanel-behind-the-window bug (see above) -- not blocking since
      drag-and-drop covers real usage, but unresolved if ever revisited.
  12. The sibling reference CHOC project (conventions, CI pipeline) still
      not linked in -- this scaffold's choices (no Bootstrap, plain CSS,
      specific file-open pattern) may get reconciled once it is.
  13. (resolved) CI now exists: `.github/workflows/hugo.yml` (docs site)
      and `.github/workflows/native-build.yml` (macOS arm64/Intel, Linux,
      Windows, path-filtered to skip docs/frontend-only pushes).
  14. **RESOLVED (2026-08-01)**: committed test infrastructure now exists
      on both sides. C++: `tests/pcg_file_test.cpp` + a scoped
      `pcg_file_test` CMake/`ctest` target, depending on *only*
      `PcgFile.cpp`/`ProgramDecoder.cpp`/`CombiDecoder.cpp` (not
      `main.cpp`/`EditorBridge.cpp`/CHOC) -- builds a small synthetic
      `.PCG` byte buffer in memory
      (real files are large and `.gitignore`'d) exercising
      `loadFromMemory()` end-to-end: Set List names, masked Font
      size/Transpose decoding (including deliberately-poked garbage bits
      in fields it doesn't own), Program bank cross-referencing,
      `findDuplicatePrograms()`, `programSetlistUsages()`, and
      `decodeProgram()`'s on-demand re-decode; extended same-day to cover
      the new Combi decoder too (`decodeCombiFields()` directly, plus
      `combis()`/`decodeCombi()` through a synthetic CBK1 bank). Runs via
      plain `ctest` in ~0.01s. Frontend: `setlist-comment.js` now has a headless,
      `node`-runnable `setlist-comment.test.js` alongside its existing
      `.test.html` browser harness, both importing the same real-byte
      fixture from a new shared `frontend/components/kronos/
      test-fixtures.js` (so they can't drift into testing different
      data) -- exits non-zero on any failed assertion, the shape
      CI/`ctest`-style automation needs. (A `frontend/components/
      package.json` with `"type": "module"` was also added -- without it
      Node mis-parses genuine ES module `export`/`import` syntax in a
      bare `.js` file and throws a confusing "does not provide an
      export" error.) Both suites were spot-checked with a deliberately
      broken assertion to confirm they fail loudly and non-zero, not just
      pass trivially. Next: proceed to the Combi decoder, per the
      already-agreed sequencing.
  15. No progress indicator while opening a large file -- the drag-and-drop
      open path (base64-encode in JS, decode + parse in C++) can take a
      moment on a 50-70MB file and currently just shows static "Loading..."
      text. An indeterminate spinner would be a small change; a real
      percentage bar needs the encode/transfer to happen in chunks with
      progress callbacks rather than as one monolithic step, which it
      isn't today.
  16. **RESOLVED (2026-08-01)**: the Library view has now been clicked
      through end to end in the real app (see the Datasets entry in
      "ARCHITECTURE" above) -- confirmed working.
  17. **RESOLVED (2026-08-02)**: drag-and-drop file loading -- a pane (or
      its sibling, if the drag passed over it on the way to the actual drop
      target) could stay visually marked as a drop target after a dataset
      had already loaded. Root cause confirmed as hypothesized: `pane.js`'s
      old `dragleave` handler only cleared the highlight when `ev.target
      === root`, but dragenter/dragleave fire per-element as the pointer
      crosses into/out of *child* elements too (the table, the
      dataset-select), so a `dragleave` targeting a child rather than
      `root` itself left the class stuck. Fixed with the standard
      enter/leave depth counter (immune to which descendant the event
      targets), plus every pane's highlight is now explicitly cleared in
      the `drop` handler (not just the pane that received the drop) to
      cover the sibling-pane case directly, regardless of exact event
      delivery order for a given drag session.
  18. Library's Duplicates tab shows "n/a" for a duplicate Program's Combi
      reference count -- noticed during the same click-through. Reading
      `EditorBridge::findDuplicatePrograms()` shows no logic difference
      from the Programs tab's (also gated on
      `isConfirmedTimbreProgramBank(program.bank)`, i.e. INT-A..D only, see
      docs/README.md's Combi Timbre references section) -- so this may
      simply be the same, already-documented caveat resurfacing because
      real duplicate Programs (often "Init Program"-style placeholders)
      tend to sit in banks outside INT-A..D, not a new bug. Not confirmed
      either way against a concrete case yet -- if a duplicate group ever
      shows "n/a" for a Program that IS in INT-A..D, that would indicate a
      real, distinct bug worth re-investigating.

=== END STATE BLOCK ===
