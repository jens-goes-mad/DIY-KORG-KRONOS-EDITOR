=== STATE BLOCK — GOALS, ACHIEVEMENTS, BLIND SPOTS ===
Date: 2026-08-05
Status: Working prototype, git repo (github.com/jens-goes-mad/
        DIY-KORG-KRONOS-EDITOR, `main` branch) with a public Hugo/GitHub
        Pages docs site (jens-goes-mad.github.io/DIY-KORG-KRONOS-EDITOR)
        and CI building all 4 platform targets on every relevant push.
        Core file format (Set List names + params + instrument-name
        cross-reference, now including Font size/Transpose/Combi Timbre
        references) is reverse-engineered and wired into a real CHOC app
        with drag-and-drop open and two independent panes, each with its
        own dataset selector and a Setlist/Programs/Combis/Duplicates
        category navbar -- browse/filter/swap/copy Set Lists, editable
        Comment/Color/Volume fields (all three writing straight into a
        loaded file's own raw bytes, independently open per row, safely
        blocked from being opened on the same slot in both panes at once
        with a toast popup explaining why -- see "Setlist Color/Volume/
        Comment row editors" and "Setlist editor UI polish + cross-pane
        edit lock + toasts" under "ARCHITECTURE" below), and a read-only
        Program/Combi library with byte-exact duplicate detection -- see
        "PROGRAM/COMBI LIBRARY EDITOR" below. A
        componentized frontend pattern (small, standalone, byte-level-
        tested UI pieces) and a matching backend decoder/encoder
        architecture are now the deliberate direction -- see "ARCHITECTURE:
        DECODER/ENCODER REFACTOR" below, currently the
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
    Clicking a row's Song/Type cell expands an inline multiline Comment
    editor (monospace, grows to fit content past 10 rows); clicking # opens
    a 16-button Color editor (real Kronos colors); clicking Vol opens a
    0-127 slider. All three route through the SAME shared raw-bytes cache
    per row and can be open together on one row at once (see "Setlist
    Color/Volume/Comment row editors" under ARCHITECTURE below for why that
    matters). Color/Volume commit immediately (color on click, volume on
    slider release); Comment keeps its Apply button. If two panes point at
    the same dataset AND the same Set List, opening an editor on a slot
    already open in the other pane is blocked outright (a toast explains
    why) rather than risking one pane's write silently overwriting the
    other's -- see "Setlist editor UI polish + cross-pane edit lock +
    toasts" under ARCHITECTURE below. No typed-path/Open-button UI (removed
    per explicit request -- drag-and-drop is the only way in, though the
    bridge's path-based `openFile` still exists underneath).
  - `frontend/mock_bridge.js`: fake in-memory backend (mirrors the real
    API) so the UI can be exercised in a plain browser with no native
    build -- cannot exercise real file parsing (browsers have no
    filesystem access at all, which is the whole reason Choc's native
    bridge exists).
  - `frontend/components/kronos/setlist-comment.{js,css,test.html}` and its
    sibling `setlist-slot-params.{js,test.html}` (Color/Volume): the
    componentized codec pieces (see "ARCHITECTURE" below) -- built,
    self-tested standalone, AND wired into `pane.js` via a dynamic
    `import()` (see "Setlist Color/Volume/Comment row editors" below).
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
    infrastructure landed (Blind Spot #14), Combi decoder done, Set List slot raw-byte
    read/write done (2026-08-05, see "Setlist Color/Volume/Comment row editors" below) --
    unlike Program/Combi, this didn't need a new standalone `SetlistDecoder.{h,cpp}`:
    every SBK1 song record's byte offset is one deterministic formula off a single
    retained anchor (`sbkSongsStart_`), not a per-bank location table, so
    `PcgFile::songRecordBytes()`/`putSongRecordBytes()` just reuse the *existing*
    `readSlotParams()`/`readComment()` functions already living in `PcgFile.cpp`.
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
  - **Chunk-based data flow for components (designed 2026-08-01, first real feature BUILT
    2026-08-05 for Setlist slots -- see below)**: two deliberately different tiers, not
    one architecture for everything --
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
      write, never hand-maintained separately. **Realized 2026-08-05** as
      `PcgFile::putSongRecordBytes()` -- see below, same three-step discipline, just for
      Setlist song records instead of Programs.
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
  - **Setlist Color/Volume/Comment row editors (BUILT 2026-08-05)**: per-column click
    routing on a Set List row (# -> Color, Vol -> Volume, Song/Type -> Comment, same
    fallback as before), all three independently toggleable so several can be open on
    the SAME row at once (explicit request) -- this is what turned "Comment still writes
    via the old struct-only path" from a style inconsistency into a real data-loss bug:
    with Color/Volume writing raw bytes and Comment only mutating `Setlist::songs[i]
    .comment` in memory, whichever committed second would silently discard the other
    (a raw-byte write re-derives every decoded field, including comment, from the bytes
    it just wrote). Fix: Comment was retrofitted onto the same raw-byte path, so all
    three editors on a row share one raw-bytes cache and one write path.
    - Backend: `PcgFile` retains one anchor per Set List (`sbkSongsStart_`, set during
      the existing SBK1 parse loop, no new scan) plus `songRecordBytes(setlistIndex,
      songIndex)` / `putSongRecordBytes(...)` -- the latter writes into `data_`, then
      re-derives `Song::params`/`comment` via the *existing* `readSlotParams()`/
      `readComment()`, same "cached field must never go stale after a direct write"
      discipline as `copyProgramFrom()`. Does NOT re-resolve `instrumentName` -- none of
      these three editors touch bank/number, so it stays valid; would need revisiting if
      a future editor ever did.
    - Bridge: `getSongRecordBytes`/`putSongRecordBytes` (array-of-numbers over the
      bridge, same `choc::value::createArray`/`addArrayElement` pattern every other
      array-returning method already uses -- 542 bytes needs no base64). `setComment` is
      unused by the new UI now but left in place in case anything else still calls it.
    - Frontend: new sibling codec `frontend/components/kronos/setlist-slot-params.js`
      (`decodeSlotColor`/`encodeSlotColor`/`decodeSlotVolume`/`encodeSlotVolume`) next to
      `setlist-comment.js`, same masked-read-modify-write discipline (Color shares byte
      +12 with isProgram/Font size, masked to bits2-5 only; Volume is a clean unpacked
      byte at +16, no masking needed) -- own `.test.html`/`.test.js`, reusing
      `test-fixtures.js`'s real "Rolling in the Deep" record (byte+12=`0xc0` confirms
      Color=1/Standard, byte+16=`0x7f` confirms Volume=127 on that real record).
      `pane.js` loads both codecs via a cached dynamic `import()` expression -- works
      from inside a plain (non-`type="module"`) script without converting `index.html`'s
      scripts to ES modules.
    - `pane.js`'s expand-state grew from `Set<songIndex>` to `Map<songIndex,
      Set<"comment"|"color"|"volume">>`, plus a `Map<songIndex, Uint8Array>` raw-bytes
      cache shared by every editor open on that row (`getSlotBytes()` fetches once,
      `commitSlotBytes()` is the one write path all three editors call through). Color
      commits on click, Volume commits on the slider's `change` event specifically (not
      `input`) so it writes once on release/blur, not once per pixel of drag.
    - `frontend/mock_bridge.js` gained fake `getSongRecordBytes`/`putSongRecordBytes`,
      synthesizing a 542-byte buffer from a mock entry's own fields (`makeFakeSlotBytes()`)
      so mock/no-native-build mode can exercise the whole feature.
    - Verified: `pcg_file_test`/`ctest` extended (round-trip, byte-boundary/neighbor-
      record isolation, wrong-size/out-of-range rejection), deliberately broken then
      restored per this project's standard practice; full app + test target both build
      clean; every touched JS file `node --check`ed; the new codec's headless
      `.test.js` passes (22 checks) against the real fixture bytes. Initially NOT
      visually click-tested in a real browser (no browser-automation tool available in
      the environment this was built in -- a static-file-server mock-mode smoke test,
      asset/import-path resolution only, stood in instead) -- since then click-tested
      live by the project owner in the real app across several follow-up rounds (see
      below), with real bugs found and fixed that the static smoke test couldn't have
      caught.
  - **Setlist editor UI polish + cross-pane edit lock + toasts (BUILT 2026-08-05, same
    day, driven by live click-through feedback)**: several rounds of real-app testing
    against the row editors above surfaced concrete issues -- fixed in order:
    - **Row order**: editor rows now append in a fixed Color/Comment/Volume order,
      matching the columns' own left-to-right order (#, Song/Type, Vol) instead of the
      original Comment/Color/Volume order.
    - **Volume editor**: gained a "Volume" text label in front of the slider.
    - **Editor-row visual treatment**: a generic `.editor-row` class (added alongside
      each row's specific `comment-editor-row`/`color-editor-row`/`volume-editor-row`
      class, kept as unused-for-now per-type hooks) carries a shared 10px left padding
      and a `darkorange` 1px left border, so an open editor reads as a distinct
      "you're now editing" section instead of just another table row. Took two passes
      to land correctly: the left padding was initially silently overridden by Bulma's
      own `.table.is-narrow td{padding:.25em .5em}` rule, which -- having two classes
      plus an element in its selector -- out-specifies a plain `.editor-row td` (one
      class plus an element) regardless of stylesheet order; fixed by matching Bulma's
      own `.table.is-narrow` prefix in the override selector.
    - **`tr.is-selected` row highlight** (marks "this row has an editor open") recolored
      from Bulma's default green/teal to the same `darkorange`. Same specificity lesson
      hit twice: Bulma sets the `--bulma-table-row-active-background-color` custom
      property it reads on `.table` itself, not `:root` -- a `:root`-level override
      loses because a rule that directly matches an element always wins over an
      inherited value, regardless of source order or specificity. Landed on a simpler
      fix that sidesteps the whole custom-property indirection: a plain
      `background`/`color` declaration on `.table tr.is-selected` (two classes + a
      type selector) beats Bulma's own `.is-selected` (one class) outright.
    - **`.instrument-name` contrast**: the Combi/Program name shown under a Setlist
      row's label sets its own dim-gray `color` directly, which -- being a directly-set
      property -- doesn't inherit the selected row's white text regardless of the row's
      own color; needed its own `.table tr.is-selected .instrument-name{color:#000}`
      override to stay readable against the orange highlight.
    - **Slot color palette brightened** (`SETLIST_COLOR_HEX`, `pane.js`) -- the initial
      pass read as too dark/muted; all 16 values bumped ~28% brighter (Black/White
      handled separately so they stay sane), keeping the demo palette in
      `setlist-slot-params.test.html` in sync.
    - **Cross-pane edit-lock (the one genuinely severe bug this round)**: two panes can
      legitimately point at the SAME dataset AND the same Set List at once (a real,
      already-supported setup -- see the Datasets subsection above) -- if both opened an
      editor on the SAME slot, each pane's raw-bytes cache is its own independent copy,
      so whichever pane committed second would silently overwrite whatever the other
      had just written, unnoticed. Fixed with a module-level `openSlotEditors` map
      (`pane.js`, shared across both pane instances, keyed `datasetId:setlistIndex:
      songIndex` -> owning paneId): `toggleEditor()` now refuses to open a slot another
      pane already holds, and a `releaseAllSlotLocks()` helper drops every lock a pane
      owns whenever its `expandedTypes` gets cleared wholesale (Set List switch, dataset
      switch/close) so a lock never outlives the editor state it was protecting.
    - **Toast notifications** (`app.js`'s new `showToast()`): the cross-pane block above
      needed to actually be noticed -- the persistent bottom status bar is easy to miss
      or get overwritten before being read. A small (~15-line) hand-rolled transient
      popup, deliberately not a pulled-in library (see its own doc comment -- worth
      revisiting with something like Notyf/Toastify if toast usage ever grows beyond
      simple single-line messages), styled with Bulma's own semantic `--bulma-warning`/
      `-invert` color pair (the same background/text combination `.notification.
      is-warning` uses internally) rather than a one-off hand-picked color. One shared
      `#toastContainer` (`index.html`, fixed to the viewport) so toasts from either pane
      stack in the same place.
    - Verified: every touched JS file `node --check`ed, CSS brace-balance checked,
      backend build/`ctest` re-confirmed green (none of this round touches the backend).
      UI changes confirmed against real click-through by the project owner (this is what
      surfaced the padding-specificity and cross-pane-race issues above in the first
      place) rather than only the earlier static smoke test.
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
  - **Category: a second, parallel physical-reference problem (researched 2026-08-03,
    not built)**: prompted by wanting to know what has to be checked/reassigned when
    moving a Program or Combi between datasets. Category (Keyboard/Bass/Strings/etc.,
    used to browse sounds by type regardless of bank/number) turns out to be the SAME
    shape of problem as Bank type -- confirmed via the official Kronos Parameter Guide
    (see `docs/external/Korg-Kronos-Parameter-Guide-Category-excerpt.txt`): each
    Program and Combi (two SEPARATE 18-main x 8-sub-category tables, not shared) is
    assigned a small Main Category (0-17) + Sub Category (0-7) index, but the *names*
    for those indices -- including all 16 "factory" names, not just the 2 open User
    slots -- live in a per-unit-customizable table in Global settings ("Global P3:
    Category Name"), saved via "Write Global Setting." So a Program's category index
    is portable, but its *meaning* isn't guaranteed to match between two datasets whose
    category tables have been renamed differently -- confirms the project owner's
    instinct that moving Programs/Combis between datasets may need explicit user
    confirmation/reassignment when category tables don't match. Not solved, not built
    -- two concrete, not-yet-started follow-ups: (1) locate Category/Sub-Category's
    byte offset in a Program record and (separately) a Combi record -- not in this
    project's own findings, the Synthify spreadsheet, or DaBlick's notes, so genuinely
    unexplored, same as the rest of `GLB1`; needs the same purpose-built test file
    approach already used for Font size/Transpose/Combi Timbre refs. (2) Parse `GLB1`
    itself, at minimum enough to extract both category name tables -- `GLB1` has never
    been touched at all (see Blind Spot #5).
  - **Setlist Bank-jump button, refined (BUILT 2026-08-03)**: a Setlist row's Bank cell
    is a button (`frontend/pane.js`'s `.bank-jump-button`, `stopPropagation()`-ed so it
    doesn't also toggle that row's Comment editor), styled with the same `.lib-tab`
    class as the category nav itself (not a text link) per explicit feedback. Clicking
    it switches this pane to its Programs/Combis category and expands+scrolls to that
    exact entry (`createLibraryPanels()`'s `jumpToEntry()`, found via a `data-entry-key`
    attribute added to each rendered row). `createPane()`'s category-tab-click logic was
    factored into a shared `switchCategory()` so both the tab buttons and this jump
    action stay in sync through one place. The scroll itself computes an exact target
    position (`scrollRowBelowHeader()`, via `getBoundingClientRect()`) so the row always
    lands just below the table's sticky header instead of `scrollIntoView({block:
    "center"})`, which could leave a row (especially one near the top of the list) still
    partly hidden behind it.
  - **Bank-filter buttons (BUILT 2026-08-03)**: the Programs and Combis panels each get
    a row of toggle buttons (one per bank name, between the Name search and the table)
    reusing the bank-name arrays `pane.js` already has. Only buttons for banks actually
    present in the current dataset are enabled; all enabled banks start "pressed"
    (shown) on every fresh dataset load, independently toggleable per category after
    that -- an inclusive multi-select filter, not a single-bank picker. `jumpToEntry()`
    (above) force-presses the target bank before rendering, so a Bank-jump can never
    land on a row its own filter has hidden.
  - **Bank names shortened + button/column widths equalized (BUILT 2026-08-04,
    frontend-only)**: `pane.js`'s `PROGRAM_BANK_NAMES`/`COMBI_BANK_NAMES` now hold
    "I-A".."I-G"/"U-A".."U-FF" (was "INT-A"/"USER-AA" etc.) -- purely a UI-layer
    shortening, not a change to the ground-truth naming: `PcgFile.cpp`'s confirmed
    Timbre bank-code table (`INT-A`=0, `USER-D`=20, ...) and the docs are untouched, a
    new `abbreviateBankName()` helper in `pane.js` shortens a bridge-provided full name
    (e.g. a Timbre's `bankName`) only at render time (`library.js`'s
    `formatTimbreRef()`). `formatBankNumber()` also switched from `"I-C-000"` to
    `"I-C 000"` (space, not dash). Freed-up width let `.col-bank` shrink 9em -> 6.5em
    and `.col-refs` 10em -> 4.5em (paired with renaming the "Setlist refs"/"Combi refs"/
    "Setlist references"/"Combi references" column headers, inconsistent across the
    Programs/Combis/Duplicates tables, to a uniform `#STL`/`#CMB` with a title tooltip
    spelling out the full meaning). Buttons that used to size to their own label's
    length (bank-filter buttons, the Setlist Bank-jump button, the Setlist/Programs/
    Combis/Duplicates category tabs) now share a fixed width per group
    (`.bank-filter-button` 3.6em, `.bank-jump-button` 100% of its now-narrower table
    cell, `.pane-category-tabs .lib-tab` 6.5em) so each row of buttons lines up evenly
    instead of looking ragged.
  - **Setlist row columns trimmed (BUILT 2026-08-04, frontend-only)**: Hold Time
    dropped from the row entirely (still fetched/returned by `getEntries()` --
    `entry.holdTime` is just not rendered here -- planned to resurface in the Comment
    editor panel later, not lost). The separate Color column (a small swatch) is gone
    too -- its color now paints the "#" slot-number cell's own background instead
    (`idxTd.style.background`, same unverified-placeholder hue formula as before, see
    the code comment -- **not** Korg's real color palette, no ground truth for that
    exists yet). Song name column narrowed 15em -> 10.5em (`.col-song`, a 30% cut from
    the same 15em/24-char baseline `.col-name` uses for Program/Combi names -- Set List
    slot names are confirmed the same 24-byte field, docs/README.md §3) -- wraps rather
    than ellipsis-truncates, since this cell can also hold a second line (the
    cross-referenced instrument name) that a hard truncate would clip along with it.
  - **Horizontal scrollbar bug fixed + columns shrunk to fit 800px (BUILT 2026-08-04,
    frontend-only)**: root cause -- `.entries-scroll`/`.library-body` only set
    `overflow-y: auto`, and per spec, leaving `overflow-x` at its default `visible`
    while the other axis is non-`visible` makes it compute to `auto` too, not stay
    `visible`. With two panes side by side, the Setlist table's column widths summed to
    more than a pane's actual width at the app's own 800px minimum (`main.cpp:81`'s
    `setMinimumSize(800, 500)`, unchanged/already correct), so that implicit `auto`
    kicked in as a real horizontal scrollbar. Fixed both properly (`overflow-x: hidden`
    is now explicit on both, so a scrollbar can never reappear by accident) and by
    actually shrinking columns to fit: `.col-index` (`#`) 3.5em -> 1.75em (50%),
    `.col-narrow` (Type/Vol) 4.5em -> 3.15em and `.col-bank` 6.5em -> 4.55em (30% each,
    shared classes so this also affects the Programs/Combis library tables' Type/Bank
    columns, not just Setlist). `.col-bank`'s `white-space: nowrap` was removed too --
    at the new width a label like "U-AA 009" needs to wrap onto a second line rather
    than force the column wider than its declared width. Also added `min-width: 800px`
    to `html, body` -- mirrors the native window's own floor so a plain browser tab
    (mock_bridge.js's no-native-app testing mode) can't be resized narrower than what
    the real app ever allows, which is exactly the width this bug only showed up at.
  - **Real fix for the shrink-layout bugs (BUILT 2026-08-04, supersedes the previous
    attempt, frontend-only)**: the previous pass (`overflow-x: hidden` + `min-width:
    800px` on `html`/`body`) didn't actually work -- reported back as three symptoms:
    the native window's own 800px minimum appearing not to be respected, the right
    pane going partly invisible when shrinking, and columns not visibly shrinking at
    all. Root causes, actually isolated this time:
    - `min-width: 800px` on `html, body` was actively harmful, not just insufficient --
      it forces the PAGE to stay 800px wide regardless of the WebView's real viewport
      width, so the instant the actual window (or content view, mid-resize) is even
      slightly under that, the page overflows its own viewport: a scrollbar appears and
      whatever's past the edge (the right pane) is genuinely off-screen, not just
      visually squeezed. This is almost certainly what made the OS-level
      `setMinimumSize(800, 500)` (`main.cpp:81`, itself unchanged and believed correct
      -- a plain, standard `NSWindow setContentMinSize:` call, no custom resize delegate
      overriding it) look like it wasn't being respected. **Removed** -- the page must
      be able to shrink freely below 800px so it's never wider than its actual viewport
      under any circumstance.
    - The real cause of the right pane vanishing: `.panes` is a CSS grid, and a grid
      item's default `min-width` is `auto`, which resolves to its CONTENT's min-content
      size, not 0 -- so `.pane` (the grid item) could never shrink below whatever its
      content naturally needed, no matter how narrow the `1fr` track was asked to go.
      Same underlying issue one level deeper too: `.pane-category-content` is a flex
      item (in `.pane`'s column flex container) on its cross axis, subject to the exact
      same content-based-minimum default. Fixed by adding `min-width: 0` to both --
      `.entries-scroll`/`.library-body` already got this for free from their own
      `overflow-x: hidden` (per spec, non-visible overflow on an element makes ITS OWN
      automatic minimum resolve to 0), but that never helped the ANCESTOR grid/flex
      items further up the chain, which needed the same treatment explicitly.
    - Why columns weren't visibly shrinking: `.entries-table` never set `table-layout`,
      so it defaulted to `auto` -- in auto layout, a CSS `width` on a `<td>`/`<th>` is
      only a *hint* the browser can still override to fit content (a button's own
      minimum size, an unbroken label, ...), not a hard constraint. Switched to
      `table-layout: fixed`, which makes the first row's declared widths authoritative;
      content now wraps/clips to fit instead of pushing the column wider.
    - **Per explicit request, redesigned as "hard-locked narrow columns + exactly one
      resizable column"**, rather than the previous percentage-shrink pass: `.col-index`,
      `.col-narrow`, `.col-bank`, `.col-refs`, and (new) `.col-badges` now all set
      `width`/`min-width`/`max-width` to the identical value (a genuine lock, not a
      hint, now that layout is `fixed`) -- `.col-song` (Setlist) and `.col-name`
      (Programs/Combis) are the only columns left with no width at all, so they're the
      sole ones that grow/shrink with the pane. `.col-badges` used to be the
      Combis table's own "soaks up leftover space" column (`width: auto`); now fixed at
      10em so `.col-name` is unambiguously the only resizable one there too.
  - **Column widths redone via <colgroup> (BUILT 2026-08-04, supersedes the em-on-
    th/td attempt above, frontend-only)**: the `table-layout: fixed` + hard-locked
    em-width `.col-*` classes pass looked reasonable but was reported completely
    broken in practice (the `#` column rendering far smaller than declared, every
    fixed column refusing to actually resize, Name blowing out). Root cause: `table-
    layout: fixed` only takes each column's width from cells in the table's first
    row, and `.entries-table th` sets `font-size: 12px` while most `<td>`s inherit
    14px (or their own 12px override, inconsistently) -- so an `em`-based width meant
    two different pixel values depending on whether the browser happened to key off
    the `<th>` or a `<td>`, silently producing widths nothing close to intended.
    **Fixed properly with `<colgroup>`**: a new `colgroupHtml(widthsPx)` helper in
    `pane.js` builds `<col style="width:Npx">` per column (absolute px, `null` for
    the one column meant to flex) -- `<col>` width is font-size-independent, shared
    identically by every cell in that column, and is what `table-layout: fixed`
    actually expects to key off. Every `.entries-table` (Setlist in `pane.js`,
    Programs/Combis/Duplicates in `library.js`) now opens with a `colgroupHtml(...)`
    call; the `.col-*` CSS classes are cosmetic-only now (color, font-size, text
    wrapping) -- no width/min-width/max-width left on any of them. Widths chosen
    (px): Setlist `[21, flex, 38, 55, 38]` for #/Song/Type/Bank/Vol; Programs `[55,
    flex, 38, 54, 54]` for Bank/Name/Type/#STL/#CMB (also gave Programs' Name cell
    the `.col-name` class it was missing before, so it gets the same ellipsis
    treatment Combis' always had); Combis `[55, flex, 160, 54]` for Bank/Name/Set
    Lists/#STL (Set Lists -- `.col-badges` -- used to be the "soaks up leftover
    space" column here too, which meant TWO resizable columns competing for the same
    space; now fixed at 160px so Name is unambiguously the only one); Duplicates
    `[55, 54, 54]`, no flexible column (matches its original design -- the group name
    is shown above the table, not in a column).
  - **Missing links in the min-width: 0 chain (BUILT 2026-08-04, supersedes the
    <colgroup> pass above -- that pass was reported as making zero visible
    difference)**: after the <colgroup> fix still tested as completely unchanged,
    re-audited the full flex/grid ancestor chain from `body` down to the table and
    found it was fixed at the wrong end. `.pane` and `.pane-category-content` had
    `min-width: 0` (the previous round's fix), but `.view` (a flex item of `body`,
    column flex, cross axis = width) and `.panes` (a flex item of `.view`, same
    trap) did NOT -- and since a flex/grid item's content-based auto-minimum applies
    at EVERY level independently, leaving even one un-fixed level upstream stops the
    whole chain from ever reaching the levels that were already fixed. The window
    could never actually get narrow enough for the colgroup's px widths to matter,
    which is exactly why that pass changed nothing observable. Added `min-width: 0`
    to both `.view` and `.panes`, completing the chain: `body -> .view -> .panes ->
    .pane -> .pane-category-content` all now either set `min-width: 0` explicitly or
    (`.entries-scroll`/`.library-body`) get the same effect for free from their own
    `overflow-x: hidden`.
  - **Tables rebuilt as CSS Grid, not HTML table layout (BUILT 2026-08-04, supersedes
    both the em/th-td and <colgroup> attempts above -- per explicit "the layout is
    beyond repair, kick in a real grid system" request)**: after the min-width: 0 chain
    was completed and STILL reported as no better ("same"), decided to stop fighting
    HTML table-layout algorithms entirely rather than keep patching around their
    quirks (first-row-only column sizing, th/td font-size context mismatches, engine-
    specific auto/fixed differences). Every `.entries-table` (Setlist in `pane.js`,
    Programs/Combis/Duplicates in `library.js`) is now a genuine CSS Grid: `display:
    grid` on the `<table>`, `display: contents` on `<thead>`/`<tbody>`/`<tr>` (removes
    them from the box tree so their `<th>`/`<td>` children become direct grid items,
    while leaving them in the DOM untouched -- existing click/drag handlers on `<tr>`
    still work exactly as before). Column widths are one `grid-template-columns` value
    set as an inline style directly on each `<table>` (`pane.js`'s new
    `gridTemplateColumns(widthsPx)`, replacing the `<colgroup>` helper) -- the same
    solid, explicit mechanism `.panes` (the two-pane split) has used from the start
    without any of these problems. Two knock-on fixes this forced: (1) `colSpan`
    doesn't work under `display: grid` (it's a table-rendering feature), so the three
    full-width expandable rows (`pane.js`'s Comment editor, `library.js`'s Program
    usage panel and Combi Timbre list) now use `td.style.gridColumn = "1 / -1"`
    instead -- while fixing this, found the Program usage row's old `colSpan = 2` was
    stale (Programs has had 5 columns for a while, so it was only ever spanning 2 of
    them), a real pre-existing bug now moot since `1 / -1` always means "all of them."
    (2) `display: contents` rows have no box of their own to paint a background on, so
    row-level hover/drop-target/expanded state (`tbody tr:hover`, `tr.drop-target`,
    `tr.expanded`) now targets each row's `td` children directly instead (`tr:hover
    td`, etc.) -- the state still lives as a class on the `<tr>` in the DOM, unchanged
    in JS, these are just CSS selector adjustments to reach through it. `cursor: grab`
    stayed on `tr` itself since `cursor` inherits through `display: contents` fine
    (only non-inherited properties like background/outline needed moving).
  - **Adopted Bulma for layout/components (STARTED 2026-08-04, pane shell + Setlist
    table done, library.js/Programs/Combis/Duplicates intentionally NOT converted yet)
    -- supersedes hand-rolling our own grid**: after the CSS-Grid-tables rewrite still
    didn't fix things, we asked directly why not use an established framework instead
    of continuing to hand-roll layout primitives. Landed on Bulma over Bootstrap: CSS-
    only (no JS/Popper dependency, fits this app's all-vanilla-JS interaction model --
    we still hand-write every behavior, Bulma only supplies CSS classes), ~24KB
    gzipped, MIT, vendored as one file (`frontend/vendor/bulma.min.css` + a
    `BULMA_VERSION.txt` note, same pattern as `third_party/CHOC_VERSION.txt`) rather
    than CDN-linked, since this app has no general-internet-access assumption
    (`fetchResource` serves everything from local disk). `index.html` sets
    `data-theme="dark"` on `<html>` to force Bulma's dark palette unconditionally
    (checked the CSS -- Bulma auto-dark-mode is keyed off `prefers-color-scheme` by
    default, which would drift from our own hard-coded dark `:root` whenever the OS
    itself isn't in dark mode; `[data-theme=dark]` is a real, explicit override Bulma
    ships for exactly this).
    - **Corrected a wrong assumption before it shipped**: initially claimed Bulma's
      `.column` bakes in the `min-width: 0` fix this whole saga kept needing --
      actually checked the vendored CSS and it does NOT (`.column{flex-basis:0;
      flex-grow:1;flex-shrink:1}`, no min-width). Bulma doesn't make that bug go away
      for free; `.pane`'s own `min-width: 0` (already in style.css) is still what's
      doing the work, just now on an element that also carries Bulma's `.column`
      class. Surfaced this to the project owner mid-task rather than building on the
      wrong premise -- confirmed to proceed anyway, for the grid pattern + component
      value, not because it's automatic.
    - **`.panes`/`.pane` -> Bulma's real `.columns`/`.column`** (`index.html`), not a
      hand-rolled grid -- this was the actual "we need a row/col concept" ask. Both
      Bulma's inter-column gap and each `.column`'s own padding key off one CSS
      variable (`--bulma-column-gap`); zeroed it on `.panes.columns` and kept our own
      `gap: 1px` + `background: var(--border)` (the existing thin divider-line look)
      instead of fighting Bulma's spacing system or duplicating padding.
    - **`is-mobile` on both `.topbar.level` and `.panes.columns`**: Bulma is mobile-
      first -- `.level`/`.columns` only become row layouts past a 769px breakpoint,
      stacking below it. This app's window has an 800px floor (`main.cpp`), which
      clears that breakpoint, but relying on a 31px margin above a breakpoint is
      exactly the class of narrow-width edge case that broke things repeatedly before
      this rewrite -- `is-mobile` forces row layout unconditionally, no breakpoint.
    - **Topbar**: `.level`/`.level-left`/`.level-right` for the Open button + title +
      loading indicator row; Open button and the Setlist table's Bank-jump button are
      now real Bulma `.button.is-small` (was a hand-rolled `.lib-tab` class).
    - **Category nav (Setlist/Programs/Combis/Duplicates)**: Bulma's real
      `.tabs.is-boxed` component (`<ul><li><a>`, active state as `is-active` on the
      `<li>`), replacing the hand-rolled `.lib-tabs`/`.lib-tab` buttons entirely for
      this nav specifically -- `switchCategory()` updated to toggle `is-active`.
      `.lib-tab` itself is NOT deleted -- library.js's bank-filter-row buttons still
      use it, unconverted on purpose (explicit scope: pane/Setlist-table first).
    - **Form controls**: `.setlist-select`/`.dataset-select` wrapped in Bulma's
      `.select` (`.is-fullwidth` for the Setlist one), `.filter-input` gained Bulma's
      `.input` class, `.setlist-info` gained `.help`. Checked Bulma's actual CSS before
      deleting our own hand-rolled background/border/padding/disabled-opacity rules
      for these -- confirmed `.input`/`.select.is-fullwidth` already handle
      width:100% and disabled state on their own, so that hand-rolled CSS was dead
      weight once removed; the one thing Bulma can't infer on its own (which flex item
      should grow in a specific layout) stayed as a small `.dataset-select-wrap{flex:1}`
      rule.
    - **Explicitly deferred, not forgotten**: library.js's Programs/Combis/Duplicates
      panels (bank-filter-row buttons, the data tables themselves) are UNCONVERTED --
      still `.lib-tab`-styled buttons and the CSS-Grid-based `.entries-table` mechanism
      from the previous pass. Per explicit instruction, Bulma adoption lands here next,
      once the pane shell + Setlist table are confirmed working.
  - **Setlist rebuilt as a real Bulma table + Library (Programs/Combis/Duplicates)
    fully converted too (BUILT 2026-08-04)** -- two rounds landed together:
    - **Setlist**: back to a real `<table>` (Bulma's `.table.is-fullwidth.is-hoverable
      .is-narrow`), not the CSS-Grid-dressed-as-a-table hack from the previous pass --
      per explicit "remove all non-Bulma CSS from the tables and rows" request. Column
      widths moved from px to a genuine 12-based grid (`pane.js`'s `colgroupHtml()`,
      mirroring Bulma's own `.column.is-1..is-12` convention) expressed as percentages
      via `<colgroup><col style="width:N%">`, so the table scales with its container.
      `colSpan` is back to a plain attribute (was a `grid-column: 1/-1` workaround).
      Row highlight (Comment editor open) uses Bulma's real `tr.is-selected`, not a
      hand-rolled `.expanded` class; row hover comes from Bulma's `.is-hoverable`, no
      custom CSS needed at all. What's left as genuinely irreducible custom CSS:
      column-width locking itself (`table-layout: fixed`, since Bulma's `.table` has
      no column-layout system whatsoever), an opaque sticky-header background (Bulma's
      table head background is transparent by default), and two real app-specific
      states no framework has a concept for (drag-and-drop's drop-target hint, "this
      row has a Comment").
    - **Column-width floors**: `<col>` doesn't support `min-width` (ignored by
      browsers), and `table-layout: fixed` ignores per-cell width/min-width past the
      first row -- so a per-column minimum can only live on the `<col>` itself, via
      `calc(N% + Mpx)`. `colgroupHtml()` now accepts `{frac, extraPx}` per column;
      Setlist's #/Type/Vol get +5px, Bank +10px (the jump-button's "I-C 000" text
      needs more room).
    - **Library (Programs/Combis/Duplicates) converted the same way**, closing out the
      staged rollout: same real-`<table>` + `colgroupHtml()` + `tr.is-selected`
      pattern for all three. Bank-filter-row buttons moved from the hand-rolled
      `.lib-tab` to Bulma's `.button.is-small` (pressed/active state via `is-link`,
      the idiomatic Bulma way to show a toggle button as active -- Bulma has no
      dedicated toggle-button component). Set List reference pills (Combis) moved
      from a hand-rolled `.badge`/`.badge-list` to Bulma's real `.tags`/`.tag`
      component. With library.js off it, the entire old CSS-Grid-table mechanism
      (`.entries-table`, its `display: contents` thead/tbody/tr hack, `.col-narrow`/
      `.col-bank`/`.col-refs`/`.col-name`, `.badge-list`/`.badge`, `.library-table`,
      `.lib-tab`/`:hover`/`.active`, `pane.js`'s `gridTemplateColumns()`) had nothing
      left using it -- deleted outright rather than left as dead code.
    - **Fixed a real, unrelated bug found along the way**: the topbar loading spinner
      never actually hid. Root cause -- `.topbar-loading` also carries Bulma's
      `.level-right`, and since it lives inside `.level.is-mobile`, Bulma's actual
      matching rule is `.level.is-mobile .level-right{display:flex}` (3 combined
      classes, specificity 0,0,3,0), which beat our `.topbar-loading[hidden]{display:
      none}` (0,0,2,0) outright regardless of the `hidden` attribute. Fixed with a
      deliberate, narrow `!important` -- the right tool for "must win over a
      third-party framework's conflicting rule for a boolean visibility toggle."
  - **Real Bootstrap-style responsive breakpoints (BUILT 2026-08-04)**: two changes,
    both using Bulma's mobile-first `is-N-mobile`/`is-N-tablet` column-size classes
    (verified against the actual CSS before relying on them: `.column.is-12-mobile`
    is unconditional `width:100%`, `.column.is-6-tablet` only applies inside `@media
    (min-width:769px)` -- and critically, `.columns` WITHOUT `.is-mobile` isn't
    `display:flex` at all below that breakpoint, so `.column` children just stack as
    plain blocks with no wrapping logic needed).
    - **Dataset-select and the category tabs share one responsive row (BUILT
      2026-08-04, corrected same-day)**: the first attempt put them in two separate,
      always-stacked `.columns` rows -- wrong mechanism, per follow-up clarification
      the actual want was Bootstrap's `col-12 col-lg-6` pattern: ONE row that wraps
      into two stacked rows below a breakpoint and merges into one side-by-side row
      above it. Fixed: both back in a single `.columns.is-multiline` row, each
      `.column.is-12-mobile.is-6-desktop` -- full width (stacked, 12+12 doesn't fit
      one row) below Bulma's 1024px desktop breakpoint, half width each (side by
      side, 6+6=12 fits exactly) from there up. `.is-multiline` is load-bearing here
      specifically: the container's own flex-activation breakpoint (769px, tablet) is
      EARLIER than the width-override breakpoint (1024px, desktop) it's paired with,
      so without it, the 769-1024px range would be a flex row of two still-full-width
      items with nothing telling them to wrap -- they'd overflow instead of stacking.
      (`.panes` below doesn't have this mismatch -- its own flex-activation and
      width-override are both 769px, so no `.is-multiline` needed there.) The app's
      default window (1100px, `main.cpp`) clears 1024px, so this is genuinely visible
      in normal use -- shrink the window below ~1024px total (not per-pane, Bulma
      breakpoints are viewport-width-based) to see it stack.
    - **The two-pane split (.panes/.pane) is genuinely responsive now**, not forced
      side-by-side: `is-mobile` removed from `.panes`, `.pane` gained `is-12-mobile
      is-6-tablet` -- stacks full-width below 769px, side-by-side (half each) above
      it. The app's own window has an 800px floor (`main.cpp`), comfortably clearing
      769px, so the native app always renders side-by-side either way; the stacking
      only becomes externally visible testing in a plain browser tab narrower than
      that (mock_bridge.js's no-build mode). The topbar's `.level` keeps its
      unconditional `is-mobile` (nothing useful to stack a title bar into).
  - **Pane-header breakpoint written directly, not via Bulma's grid (BUILT
    2026-08-04, supersedes the .columns.is-multiline attempt above -- reported as
    still not responding to the breakpoint at all)**: reasoning through the Bulma
    mechanism (mismatched 769px container-flex-activation vs 1024px width-override
    breakpoints, `.is-multiline` needed to bridge them) held up on paper, but with no
    screen access to debug Bulma's own minified cascade against what actually
    rendered, kept relying on an unverifiable chain of reasoning wasn't going
    anywhere. Replaced with a small, self-contained rule: `.pane-header-row{display:
    flex;flex-wrap:wrap}`, `.pane-header-col{flex:1 1 100%}` (stacked by default),
    one `@media(min-width:1024px)` flipping to `flex:1 1 0` (side by side, shared
    equally). Same lesson as the entries-table saga a few rounds back -- when a
    framework mechanism can't be visually verified and keeps failing, a few lines of
    plain CSS beat continuing to reason about a library's internals blind.
  - **View-hint row removed, moved to a native hover tooltip (BUILT 2026-08-04)**:
    the always-visible `.view-hint` text row is gone; checked first whether Bulma has
    a tooltip component to use instead (it doesn't -- tooltips were historically a
    separate, unbundled Bulma extension, not part of core) -- used the plain HTML
    `title` attribute instead (a real native hover tooltip, zero JS/CSS/extra markup
    needed), attached to the topbar's own `<h1>`.
  - **Column-width regression: calc() on <col> suspected and removed (BUILT
    2026-08-04)**: reported as "only the Song/Name column shows, everything else is
    invisible" on all four tables (Setlist, Programs, Combis, Duplicates). Root cause
    not independently confirmed (no way to inspect actual rendered layout in this
    environment), but correlates exactly with the one thing that changed since the
    last confirmed-good state: the previous pass added a per-column pixel floor via
    `calc(pct% + Npx)` on each `<col>`'s width, to bake in a min-width `<col>` doesn't
    support natively. `<col>` elements have historically had weak, inconsistent
    cross-engine support for anything beyond a plain width value -- treating that as
    the likely cause even though `calc()` on a `<col>` width is spec-legal. Reverted
    `colgroupHtml()` to plain percentages only, no calc(), across all four tables
    (`pane.js`'s Setlist + `library.js`'s Programs/Combis/Duplicates all share the
    one helper). The "make some columns a bit wider" intent from before is now
    expressed as a non-integer fraction instead (e.g. `1.3` instead of `{frac:1,
    extraPx:5}`) -- same idea, no calc() involved, `colgroupHtml()` already accepted
    any number, not just whole ones.
  - **Bank-filter buttons moved out of the scrolling table area (BUILT 2026-08-04)**:
    they used to live inside `.library-body` (the same scroll container as the
    table), so they scrolled out of view along with the rows -- moved to a new
    `.bank-filter-area` sibling ABOVE `.library-body`, between the Name search input
    and the table, always visible regardless of scroll position. `showPanel()` now
    also toggles which category's bank-filter row (if either -- Duplicates has none)
    is shown, mirroring how it already toggled `panels`. While doing this, proactively
    fixed the same `[hidden]`-losing-to-our-own-unconditional-`display`-rule bug the
    topbar spinner had a few rounds back (`.bank-filter-row[hidden]{display:none}`,
    explicit rather than assumed) -- caught before it needed reporting a second time.
  - **Program bank type (HD-1/EXi) surfaced in the UI (BUILT 2026-08-05)**: was already
    classified and stored per-Program (`ProgramInfo::bankType`, exposed via
    `listPrograms()`), but nothing showed it except the Programs table's own dedicated
    Type column -- the Programs bank-filter buttons and the Setlist/Duplicates Bank
    labels had no way to show it without a specific Program row in hand. Added
    `PcgFile::programBankTypes()` (new, one entry per bank: `{bank, bankType}`,
    derived from the already-classified `programBankLocations_`, no new parsing) and a
    matching lightweight bridge call `getProgramBankTypes(datasetId)` -- much cheaper
    than fetching all ~2560 Program records just to label ~20 banks. Covered by a new
    `pcg_file_test` assertion (verified failing before restoring the correct expected
    value, this project's usual deliberate-break-then-restore check).
    `pane.js`'s `formatBankNumber(entry, bankType)` now takes an optional bank type and
    appends `" (HD-1)"`/`" (EXi)"` -- only ever for Programs (Combis have no engine type
    of their own, so it's a no-op there regardless of what's passed). Wired into: the
    Programs bank-filter buttons (`"U-A (EXi)"`), the Setlist Bank-jump button when it
    points at a Program (`"U-A 008 (EXi)"`), and the Duplicates table's Bank cell
    (which -- unlike Programs -- has no separate Type column, so this is genuinely new
    information there, not a repeat of an adjacent column). Deliberately NOT added to
    the Programs table's own Bank cell, since its Type column already shows the same
    fact right next to it -- would just be the same information twice in one row.
    `createPane()` now fetches+caches this once per dataset load (a `bank -> type` Map)
    and shares it with both `createSetlistPanel()` and `createLibraryPanels()`, so the
    bridge call happens once per dataset change, not once per renderer. Two follow-on
    CSS fixes this forced: `.bank-filter-button`'s old fixed 3.6em width (fine when
    every label was uniformly "I-A".."U-FF") had to go, since `"U-AA (EXi)"` varies too
    much in length now; and Bulma's `.button` forces `white-space: nowrap` by default,
    which would have made the Setlist Bank-jump button overflow its cell once the
    suffix made its text much longer -- overridden to `white-space: normal` so it wraps
    onto a second line instead, plus its column's colgroup fraction bumped 2.6 -> 3.5.
    Caveat carried through honestly, not smoothed over: `ProgramBankType` itself is
    per-file-derived (Kronos OS 3.0+ lets a user reassign INT Program Banks between
    HD-1/EXi, so it was never going to be a hardcoded table) and is flagged in
    `PcgFile.h`'s own doc comment as **not yet independently verified against a real
    Kronos backup** -- this UI surfaces that classification more prominently now, not
    a newly-confirmed fact.
  - **Program drag-and-drop: the first feature that writes immediately into the
    native buffer (BUILT 2026-08-05)**: per explicit direction, editor operations
    stop being purely in-memory-bookkeeping from here on -- this is the first one
    that actually writes into a dataset's retained raw bytes (`data_`), not just
    `setlists_`. Planned via `EnterPlanMode` given the scope (first real write path,
    touches the physical-bank-placement problem this branch exists to explore) --
    plan file preserved the full design reasoning; summary here.
    - **`PcgFile::copyProgramFrom(src, srcBank, srcNumber, dstBank, dstNumber)`**
      (new): copies one Program record's raw bytes from `src` (pass `*this` for a
      same-dataset copy) into this file's target slot, re-decoding the destination's
      `programs()` entry from the freshly-written bytes so cached fields never go
      stale. Five guards, checked in order, nothing written unless all pass:
      out-of-range bank/number, engine-type mismatch (HD-1 record into an EXi bank
      would corrupt it, or vice versa -- this is exactly why bank type was surfaced
      in the UI just before this), a record-size mismatch as a defensive second
      check on top of the type check, the target slot already holding a *different*
      Program (confirmed explicitly with the project owner as a real, no-undo
      action worth a hard block, not silently overwritten), and a byte-identical
      Program already existing anywhere in the destination file. New
      `programBankTypeAt()` (single-bank lookup) alongside it.
    - **Real bug caught and fixed by the test, not by inspection**: the
      duplicate-exists check initially compared the source record's hash against
      *every* entry in the destination's `programs()`, including the source's own
      slot -- which trivially matches itself, so every same-dataset copy rejected
      itself as "a duplicate of itself." Caught immediately because
      `testCopyProgramFrom()` (new, `tests/pcg_file_test.cpp`) actually exercises a
      real same-dataset copy, not just the rejection paths -- fixed by excluding
      only the exact source slot from that comparison (not its whole bank), and
      only when `&src == this`. Also deliberately broken-then-restored once more,
      per this project's usual practice.
    - **`EditorBridge::copyProgram(args)`**: `[srcDatasetId, srcBank, srcNumber,
      dstDatasetId, dstBank, dstNumber] -> {ok}` or `{ok:false, error}`, same or
      different dataset both work (`fileOf()` twice, no aliasing risk since
      distinct (bank, number) pairs never overlap in byte range even when
      `srcDatasetId == dstDatasetId`).
    - **Cross-dataset copying is allowed for Programs specifically** -- confirmed
      with the project owner this doesn't reopen the physical-bank-placement
      problem the SQLite exploration flagged as hard: unlike a Setlist slot or a
      Combi Timbre, nothing *outside* a dataset can already be pointing at one of
      its Program slots, so copying raw bytes into another dataset's slot doesn't
      leave any dangling/wrong reference behind. Setlist's own `onDropEntry`
      (`app.js`) stays same-dataset-only, unchanged.
    - **Frontend**: Programs rows are draggable now (`library.js`, was explicitly
      "not draggable yet" until this pass) -- drag one onto another (same pane or a
      different pane's dataset) to copy. `app.js`'s new `onDropProgram` mirrors
      `onDropEntry`'s shape but only refreshes the *destination* dataset's panes
      (a copy never touches the source, unlike Setlist's swap/copy). Live
      type-mismatch feedback during `dragover` (before drop, not just after) reuses
      each row's own already-known `bankType` -- no extra bridge call needed beyond
      what the bank-type-in-UI pass already wired up. `.programs-table` shares its
      `cursor:grab`/`.drop-target` CSS with `.setlist-table` rather than duplicating
      it (one rule, two selectors).
    - **Not built**: any UI for the reverse direction (does the source disappear?
      No -- copy, not move, confirmed explicitly) or a "target occupied, overwrite
      anyway?" confirmation -- the third guard above is a hard block instead, since
      this app has no modal UI anywhere yet and building one just for this would be
      scope creep beyond what was asked.
  - **Real Kronos Set List slot colors (BUILT 2026-08-05)**: the "#" cell's
    background color used to be a synthetic hue-spread placeholder
    (`hsl(color*47%360, ...)`), explicitly flagged as not Korg's real palette.
    Replaced with `pane.js`'s `SETLIST_COLOR_NAMES`/`SETLIST_COLOR_HEX` (16 real
    color names from the official Korg manual, English + German, provided by the
    project owner) -- **ordering not yet independently confirmed against a real
    Kronos** (noted explicitly in both the code comment and here, per this
    project's "no guessing" standard); the array order is the order they were
    given in (reads like the on-device menu order), a working assumption pending
    a real-hardware cross-check the project owner will do later. Hex values are
    this project's own muted approximation of each named color (not sampled from
    real hardware either), deliberately kept dark enough that the existing
    dim-gray cell text stays legible on top of any of them -- White specifically
    can't be real white for that reason, see the code comment. `mock_bridge.js`'s
    fake Setlist songs now cycle through all 16 colors (`(k % 16) + 1`) instead of
    a fixed `color: 1`, so mock mode can actually exercise the full palette
    visually without needing a real backup file.
  - **Bank-filter grid alignment + Timbre reference engine type/Program name (BUILT
    2026-08-05)**: three small follow-ups from real usage.
    - `.bank-filter-row` moved from `flex-wrap` to a real CSS grid
      (`grid-template-columns: repeat(auto-fill, minmax(6.5em, 1fr))`) -- flex-wrap
      left each button hugging its own label's width, which read as ragged once
      labels started varying in length ("I-A" vs "U-AA (EXi)"); the grid gives every
      column the same width regardless of label length.
    - Combi Timbre references now show engine type and the actual Program name
      (`library.js`'s `formatTimbreRef()`), not just bank/number -- the name was
      "already in memory anyway" per the request: `programs` is the exact array this
      panel already fetched for its own Programs table, just searched by
      (bank, number), no new bridge call. Both are gated to
      `isConfirmedTimbreProgramBank()`'s same bank 0-3 (INT-A..D) range
      `EditorBridge::combiUsagesForProgram()`/`combiUsageCounts()` already use for
      the #CMB column -- outside that range, a Timbre's raw bank code isn't
      confirmed to mean the same thing as a Program's own `.bank` field at all, so
      showing a type/name for it would be a guess dressed up as a lookup, exactly
      what got flagged when a Combi showed `"Timbre 5: code 19 085"` with nothing
      else -- that's not a bug, it's the honest "don't know" case working as
      designed, and is the same reason a name/type can't safely be added for it
      either (mirrored in `mock_bridge.js`: one fake Timbre now deliberately matches
      a fake Program's bank/number so the new lookup has something to demonstrate
      in mock mode too).
  - **Indeterminate loading spinner (BUILT 2026-08-03)**: a pane-wide overlay
    (`.pane-loading`) shown for the duration of a file drop's base64-encode/decode+parse
    -- genuinely indeterminate, since no byte-level progress callback exists for that
    path yet (a real percentage bar would need the transfer itself restructured into
    chunks with progress events, a bigger follow-up, see Blind Spot #15).
  - **Global mode scope, when it's picked up (not started)**: intentionally narrow --
    for now, just pull the category name tables (Program's and Combi's, separately), not
    a general `GLB1` parse. Matches this project's "only extract what's currently
    needed" convention (see `docs/content/components/index.md`) -- other Global
    settings stay unparsed until something concrete needs them.
  - **Not decided, not scheduled**: no schema has been written, no SQLite
    dependency has been added, nothing here has touched `main`. This section
    exists so the reasoning survives even if this branch is set aside for a
    while -- update it in place as the exploration continues, rather than
    letting the thread live only in chat history.

--- NATIVE FILE DIALOG + PROGRESS (branch: explore/sqlite-patch-datastore, 2026-08-03, Phase 1 built) ---

A distinct thread of work from the SQLite exploration above (just landed on the same
branch) -- prompted by asking how the native side actually reads a file today, which
surfaced two real gaps: no working native Open/Save dialog (drag-and-drop is the only
mechanism, specifically *because* the native one is broken -- see Blind Spots), and no
real progress reporting (the loading spinner we built is necessarily indeterminate,
since the whole current pipeline is one monolithic base64-encode-in-JS /
base64-decode-and-parse-in-C++ step with no chunking at all).

  - **Root cause of the broken native dialog, confirmed by reading CHOC's own source**:
    `choc_WebView.h`'s `runOpenPanelWithParameters` delegate (triggered by an
    `<input type="file">` from inside the page) opens `NSOpenPanel` via
    `beginSheetModalForWindow:completionHandler:` -- a *sheet*, attached to the
    WKWebView's own window. That's the documented z-order bug. A directly-invoked,
    **app-modal** `runModal` call is a genuinely different code path -- not attached to
    any window at all, so there's no window for it to end up behind.
  - **BUILT (Phase 1)**: `src/platform/NativeFileDialog.h`/`.cpp` (new) -- macOS-only for
    now, calls `NSOpenPanel`/`NSSavePanel` directly via `choc::objc` (CHOC's own reusable
    Objective-C call helpers, `third_party/choc/choc/platform/choc_ObjectiveCHelpers.h`
    -- safe to include unconditionally, the whole file is `#if CHOC_APPLE`-guarded) and
    `runModal`, bypassing CHOC's own broken delegate entirely. `isNativeFileDialogSupported()`
    lets callers distinguish "not supported on this platform" from "user cancelled" (both
    would otherwise look like an empty result) -- Windows/Linux stub returns `false`/
    `nullopt` rather than untested `IFileOpenDialog`/`GtkFileChooserNative` code with no
    way to verify it here.
  - **BUILT (Phase 1)**: `EditorBridge::openFile()`'s body refactored into a shared
    private `openFileAtPath()`, reused by both the pre-existing `openFile(path)` (JS
    supplies the path -- still not wired to any UI control) and the new
    `openFileDialog()` (no args, calls `kronos::showOpenFileDialog()` then the same
    helper). Bound in `main.cpp`, and `pane.js` gets an "Open..." button next to each
    pane's dataset-select (opens into that specific pane, mirroring drag-and-drop).
    `mock_bridge.js` mirrors it with a `window.prompt()` stand-in, same spirit as its
    existing fabricated-data approach.
  - **Save dialog built but deliberately not wired to any UI yet**: `showSaveFileDialog()`
    exists (same mechanism, proven once Open works) but nothing calls it -- there's
    nothing meaningful to write yet. `moveEntry`/`copyEntry`/`setComment` only mutate the
    in-memory `setlists_` structs, never `data_` (no `putRecordBytes()`/encoder exists).
    Wiring a Save button now would either silently discard every edit (writing back
    unmodified original bytes) or need to be disabled/misleading -- worse than waiting.
  - **CONFIRMED WORKING in the real app (2026-08-03)**: the `runModal` fix does resolve
    the z-order bug -- the panel appears in front and a dataset loads successfully via
    "Open...". Blind Spot #11 updated accordingly. This was the actual gate for
    everything below.
  - **Drag-and-drop-to-open REMOVED (2026-08-03), now that "Open..." works**: the
    file-drop listeners (`dragenter`/`dragover`/`dragleave`/`drop` for *files*, as
    opposed to the still-present Setlist row drag-and-drop, which is unrelated and
    untouched) are gone from `pane.js`, along with `arrayBufferToBase64()`, the
    `EditorBridge::openFileBytes()` bridge method, its `main.cpp` binding, and the
    hand-rolled `decodeBase64()` helper -- all fully unreachable once "Open..." is the
    only way in, removed rather than left as dead code (per this project's usual
    convention). `mock_bridge.js`'s fake `openFileBytes` removed too; its
    no-native-bridge-detected check now looks for `window.openFileDialog` instead.
    `.pane.drag-over` (and the now-pointless `border: 2px dashed transparent` on `.pane`
    that only existed to support it) removed from `style.css`. The `.view-hint` text and
    this bridge's own doc comments updated to stop describing a mechanism that no longer
    exists.
  - **Can't open the same dataset twice (BUILT 2026-08-03)**: `openFileAtPath()` now
    checks `m_datasets` for an existing entry whose `displayName` (which, for every path-
    based open, *is* the real path) exactly matches before loading anything -- if found,
    returns that dataset's existing info (`alreadyOpen: true`) instead of loading a
    second redundant copy. This was only feasible once every open went through a real,
    stable path (drag-and-drop never had one to compare against, which is exactly why
    this wasn't attempted before). `pane.js` logs a distinct "already open" message when
    this happens, but otherwise needs no special handling -- `loadDataset()` just shows
    whichever `datasetId` came back either way. `finishOpen()` and this new check share
    a `datasetResultValue()` helper so the `{datasetId, displayName, setlistCount}` shape
    is built in exactly one place.
  - **Verified**: compiles and links clean (confirms `choc::objc` + the existing
    `-framework Cocoa`/`-framework WebKit` link flags are sufficient, no new link step
    needed), app launches without crashing, `ctest` unaffected (no `PcgFile`/decoder
    changes in Phase 1), all JS syntax-checked, a full grep swept for any leftover
    reference to the removed drag-and-drop/`openFileBytes` code (none found).
  - **"Open..." moved from per-pane to a single topbar button (2026-08-03,
    frontend-only, no C++ changes)**: opening a dataset was never really "for" a
    specific pane (a dataset is decoupled from panes -- see `EditorBridge.h`), so having
    two identical buttons was redundant. `index.html`'s `.topbar` now holds the one
    `.open-file-button` (left side, `h1` flows after it) plus a `.topbar-loading`
    spinner; `pane.js`'s per-pane button/spinner markup and click handler are gone,
    replaced by two small exports (`loadDataset`, `isEmpty`) that `app.js`'s new global
    click handler uses to land a freshly-opened dataset in the first empty pane (A
    checked before B); if both panes already show something, the dataset still becomes
    selectable from either dropdown via the usual `refreshDatasets()` broadcast, just
    not auto-shown. The same-path dedup (`alreadyOpen`) already existed in
    `EditorBridge::openFileAtPath()` from the change above -- confusion about "still
    being able to open the same file twice" turned out to be testing against a stale
    already-running process (native code had changed but the process hadn't been
    relaunched), not a real gap; `mock_bridge.js`'s fake `openFileDialog()` now mirrors
    the same dedup-by-displayName behavior for consistency in plain-browser mode.
    `datasets.js`'s `populateDatasetSelect()` now labels each option `#<id> — <full
    path>` instead of just the bare path, so the id and the complete name are both
    always visible, not just whichever was picked out via truncation/CSS ellipsis.
  - **Phase 2, designed but not built -- only once Phase 1's dialog fix is confirmed
    working**: chunked reading with real progress, reported natively -- `PcgFile::load()`
    gains an optional `std::function<void(size_t,size_t)>` progress callback (seek for
    total size upfront, read in fixed chunks, e.g. 4MB, invoking the callback after
    each). The read runs on a background `std::thread` (so it can't block the WebView);
    progress and the final result both cross back to the main thread via
    `choc::messageloop::postMessage()` (confirmed thread-safe for exactly this use, see
    `choc_MessageLoop.h:67`), which then calls `WebView::evaluateJavascript()` to push a
    `window.__onImportProgress(percent)` / `window.__onImportComplete(result)` call into
    the page -- the first *native-initiated* event this bridge will have used, versus
    every existing method's JS-initiated request/response shape. Only the final
    `m_datasets` insert happens on the main thread -- the read/parse itself touches no
    shared state, so it's safe to run in the background. `openFileDialog()`'s bound call
    becomes fire-and-forget (returns immediately once a path is chosen) rather than
    blocking for the whole read. This is *not* built yet.

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
  11. **RESOLVED (2026-08-03)**: the NSOpenPanel-behind-the-window bug was
      specifically in CHOC's own WebView-triggered delegate
      (`beginSheetModalForWindow:completionHandler:`, a *sheet* attached to
      the WKWebView's window). `src/platform/NativeFileDialog.cpp` (see the
      NATIVE FILE DIALOG + PROGRESS section) calls `NSOpenPanel`/
      `NSSavePanel` directly via `runModal` -- app-modal, not sheet-attached,
      a genuinely different code path -- bypassing that delegate entirely.
      **Confirmed working in the real app**: the panel appears in front and
      loads a dataset successfully. Drag-and-drop-to-open has since been
      removed now that this is fixed -- "Open..." is the only way to load a
      file. Save dialog exists at the native layer but isn't wired to any
      UI yet (nothing meaningful to write -- no encoder exists).
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
  15. **PARTIALLY RESOLVED (2026-08-03)**: an indeterminate spinner now covers
      the pane while a dropped file's base64-encode/decode+parse is in
      flight (see the EXPLORATION section's per-pane UI notes) -- still not
      a real percentage bar, which needs the encode/transfer restructured
      into chunks with progress callbacks rather than one monolithic step,
      not done.
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
