=== STATE BLOCK — GOALS, ACHIEVEMENTS, BLIND SPOTS ===
Date: 2026-07-30
Status: Working prototype, now a git repo (github.com/jens-goes-mad/
        DIY-KORG-KRONOS-EDITOR, `main` branch). Core file format (Set List
        names + params + instrument-name cross-reference) is reverse-
        engineered and wired into a real CHOC app with drag-and-drop open,
        dual-pane browse/filter/swap/copy, an editable Comment field, and
        (new) a read-only Program/Combi Library browser with byte-exact
        duplicate detection -- see "PROGRAM/COMBI LIBRARY EDITOR" below.

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

  +12  `4*(color-1) + type` -- type bit0 (1=Program, 0=Combi), color 1-based
  +13  bank index
  +14  program/combi number within that bank
  +15  Hold Time + 1
  +16  Volume, 0-127, no transform
  +18  Comment (free ASCII text, can contain literal \r\n, NUL-terminated;
       one still-unexplained reserved byte at +17 separates it from Volume)

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

Deliberately NOT solved (see Blind Spots): Font size, Transpose, the
`used`/count header field's meaning, the reserved byte at SBK1 record +17,
the 4-byte chunk-header prefix field, and exactly which of the 20 PRG1
banks maps to which *display label* (the name lookup mechanism itself is
confirmed; the specific letter shown per bank index is a positional
assumption modeled on the project owner's given naming order, not
independently verified the way Combi's order was).

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
  - **Phase 2 (not started)**: reverse-engineer where inside a Combi's
    ~7,810-byte record its Timbres reference a Program -- likely the same
    method used twice already (project owner builds a test Combi with a
    few known, distinct Program assignments, we diff the bytes). Unlocks
    real Combi-usage tracking (today's `getProgramUsage` explicitly flags
    `combiUsagesAvailable: false` rather than silently implying zero).
  - **Phase 3 (not started, depends on Phase 2)**: actual deletion of
    unused duplicate Programs and repointing Combis at a kept copy -- the
    first real write-back to a `.PCG` file this project would ever do.
    Needs a dry-run/preview step and a strong recommendation to keep an
    untouched backup, since there's no way to run Korg's own file
    validator from here to confirm nothing broke.

--- BLIND SPOTS / NOT YET TOUCHED ---

Format:
  1. Font size and Transpose encodings in an SBK1 record -- tested with
     real values but neither fits a clean pattern yet. Needs another
     targeted test file with a wider/cleaner value spread.
  2. What the `used`/count header field (present in SDB1/SBK1/CBK1/MBK1/
     PBK1 alike) actually counts.
  3. The reserved byte at SBK1 record offset +17.
  4. The 4-byte prefix field preceding every chunk header throughout the
     whole format.
  5. Exactly which of the 20 PRG1 banks maps to which display label --
     lookup mechanism confirmed, specific label-per-index is not.
  6. DKT1 (Drum Kits), WSQ1 (Wave Sequences), GLB1, DPI1 -- entirely
     unexplored. Unknown whether Set List slots can reference these
     directly (if so, instrument-name lookup has a gap there too).
  7. The older SoundQuest `.SQS` backup dialect (`LIST`/`FORM`/`BANK`
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
  13. No CI pipeline of any kind yet.
  14. No automated test suite -- all verification so far has been ad hoc
      standalone smoke-test binaries compiled during investigation, not
      committed/repeatable tests.
  15. No progress indicator while opening a large file -- the drag-and-drop
      open path (base64-encode in JS, decode + parse in C++) can take a
      moment on a 50-70MB file and currently just shows static "Loading..."
      text. An indeterminate spinner would be a small change; a real
      percentage bar needs the encode/transfer to happen in chunks with
      progress callbacks rather than as one monolithic step, which it
      isn't today.
  16. The new Library view hasn't been clicked through by the project
      owner yet in the real app -- built and smoke-tested at the C++
      layer, syntax-checked at the JS layer, same as most UI work in this
      project's history, but not yet human-verified end to end.

=== END STATE BLOCK ===
