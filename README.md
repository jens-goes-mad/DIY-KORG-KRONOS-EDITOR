# DIY Kronos Editor

[![Build Kronos Editor (native)](https://github.com/jens-goes-mad/DIY-KORG-KRONOS-EDITOR/actions/workflows/native-build.yml/badge.svg)](https://github.com/jens-goes-mad/DIY-KORG-KRONOS-EDITOR/actions/workflows/native-build.yml)

A cross-platform, cross-architecture editor for Korg Kronos `.PCG`/`.SNG`
backup files, built on [CHOC](https://github.com/Tracktion/choc)
(HTML/JS/CSS UI over a thin native C++ bridge) -- same stack as the sibling
`DIY-MIDI-METRONOME/EDITOR` project, reused rather than reinvented.

First iteration scope (see `STATE.md` for current status):

1. Open a `.PCG` file (drag-and-drop) and extract all 128 Set Lists into
   memory as a **dataset**.
2. Pick one Set List per pane and show its 128 song slots, with filter/search.
3. A Norton-Commander-style dual pane to copy songs between Set Lists, and
   swap/reorder songs within one, both via drag and drop.

Nothing is written back to disk yet -- this is a read/browse/rearrange-in-
memory tool for now.

## Datasets: one loaded file, decoupled from which pane shows it

Each dropped `.PCG` file becomes its own **dataset**, identified by an id the
native bridge mints on open (not by which pane received the drop). Every
pane -- both Set Lists panes, and the Library view -- has its own selector to
pick *which already-open dataset* to display, independent of the others.
This covers two different workflows with one mechanism instead of two UI
modes:

- **Rearranging one backup** (e.g. building a new gig Set List from songs
  spread across other Set Lists in the same file): point both panes at the
  *same* dataset. Since they're then both reading/writing the one shared
  in-memory file, an edit made via either pane is immediately visible in the
  other.
- **Merging/comparing two different backups**: drop a second file -- it
  becomes a second, fully independent dataset -- and point each pane at a
  different one. Dragging a row between them still works exactly the same
  way, just copying across datasets instead of within one.

Dropping a file always creates a *new* dataset; it never silently overwrites
whatever a pane was already showing. See `docs/content/components`'s
Datasets section and `STATE.md`'s "ARCHITECTURE" block for the full
before/after and why this replaced the old one-file-per-pane model.

## Library view (Programs / Combis / Duplicates)

A second top-level tab, alongside Set Lists: browse every Program and
Combi on the unit directly (not just through Set List slots), see which
Set List slots directly reference a given Program, and find Programs that
are byte-for-byte duplicates of each other. Read-only -- this is Phase 1
of a larger plan (see `STATE.md`'s "Program/Combi Library Editor" section)
that eventually aims to delete unused duplicates and repoint Combis at a
single kept copy; that part needs a currently-unparsed piece of the format
(a Combi's internal Timbre-to-Program references) and a safe write-back
mechanism this app has never had, so it's deliberately not built yet.

## The KORG PCG/SNG file format

Everything about the file format -- container structure, the Set List
name and per-slot parameter layout, the Program/Combi instrument-name
cross-reference, verification evidence, and the full list of remaining
unknowns -- is documented in **[`docs/README.md`](docs/README.md)**. There
is no official Korg spec being followed; that document is the complete
internals reference this project's parser (`src/kronos/PcgFile.cpp`) is
based on.

## Opening a file

The UI only exposes one mechanism: **drag a file from Finder/Explorer onto a
pane.** The browser's File API hands the dropped file's bytes to JS directly
(`File.arrayBuffer()`), no filesystem path involved at all; `pane.js`
base64-encodes them and calls `openFileBytes` -> `PcgFile::loadFromMemory(bytes)`,
which mints a new dataset id and returns it -- see "Datasets" above.

`EditorBridge`/`PcgFile` also still support opening `openFile(path)` ->
`PcgFile::load(path)`, a plain `std::ifstream` read -- but the pane's typed-
path input and Open button were removed from the UI (the project owner
found the resulting UI confusing next to drag-and-drop, and drag-and-drop
alone covers real usage). The path-based method stays in the bridge/parser
because it's simpler for future CLI/debug tooling and is what the automated
smoke tests exercise; it's just not wired to any UI control right now.

Drag-and-drop became the *only* UI mechanism because of a bug found in
manual testing:

**A plain HTML `<input type="file">` does trigger a real native file picker
(NSOpenPanel on macOS) inside the Choc WebView** -- confirmed by adding one
directly to `index.html` for testing. `choc_WebView.h`'s
`webView:runOpenPanelWithParameters:...` delegate method does the textbook-
correct thing (`beginSheetModalForWindow:` attached to the WKWebView's own
window), but in practice **the resulting sheet appears behind the main app
window** rather than in front of it, making it unusable. Root cause not yet
isolated -- plausibly related to the app window not reliably becoming
key/frontmost (also observed independently while trying to script the app
via `System Events`/`screencapture` during earlier debugging). Not something
this project's code controls directly (it's inside choc's vendored
Objective-C), so rather than fighting it, drag-and-drop sidesteps the whole
problem -- no separate OS panel/window ever needs to appear or gain focus.
`openFileBytes` was added specifically to support this (and is a strictly
better long-term answer anyway: it works identically on every platform,
whereas resolving an absolute path back out of a browser `File` object is
inconsistent/impossible across WebKit/GTK-WebKit/WebView2).

Known limitation: base64-encoding a 50-70MB file in JS and passing it
through the bridge as one big JSON string is not fast -- fine for occasional
loads, not something to build a "live reload on every drop" workflow around.

## Build

Builds on macOS (arm64 + Intel), Linux, and Windows -- verified via CI
([`.github/workflows/native-build.yml`](.github/workflows/native-build.yml)),
one CMake project, no per-platform source trees (CHOC maps to WebKit/
WebKit2GTK/WebView2 depending on the OS). Full requirements and
platform-specific notes: **[docs/content/building](docs/content/building/index.md)**
(also live at [the project site](https://jens-goes-mad.github.io/DIY-KORG-KRONOS-EDITOR/building/)).

```sh
cmake -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build
./build/kronos_editor
```

Debug builds read `frontend/` live off disk (edit-reload friendly). Release
builds (`-DCMAKE_BUILD_TYPE=Release`, or `-DEDITOR_EMBED_RESOURCES=ON`)
embed `frontend/` into the binary via `tools/embed_resources.py`.

## Testing

```sh
# C++: scoped to just the format-parsing code (no CHOC/WebView build needed)
cmake --build build --target pcg_file_test
ctest --test-dir build -R pcg_file_test

# Frontend: headless, per-component
node frontend/components/kronos/setlist-comment.test.js
```

See **[docs/content/components](docs/content/components/index.md)**'s "Committed,
headless test suites" section for how these fit alongside each component's
`.test.html` browser harness.

## Architecture direction

Both the frontend and backend are moving toward small, focused
decoder/encoder units instead of one big eager parse -- see
**[docs/content/components](docs/content/components/index.md)** (also
live at [the project site](https://jens-goes-mad.github.io/DIY-KORG-KRONOS-EDITOR/components/))
for the rationale, and `STATE.md`'s "ARCHITECTURE: DECODER/ENCODER
REFACTOR" section for the current decision and where it's headed next
(Program decoder first, then Combi, then Set List slot).

## Layout

```
docs/README.md                -- the full file-format internals reference
docs/content/                 -- the public Hugo/GitHub Pages docs site (mirrors docs/README.md by hand)
src/
  kronos/PcgFile.{h,cpp}     -- the file-format parser (implements docs/README.md)
  bridge/EditorBridge.{h,cpp} -- native functions exposed to the web UI
  main.cpp                   -- CHOC window/webview wiring
frontend/
  index.html, app.js, style.css   -- top-level tab bar (Set Lists / Library) + shared wiring
  datasets.js                  -- shared dataset registry (open files, decoupled from pane) -- see Datasets above
  pane.js                      -- Set Lists dual-pane UI
  library.js                   -- Library view (Programs/Combis/Duplicates)
  mock_bridge.js              -- fake in-memory backend for plain-browser dev (no native build needed)
  components/kronos/          -- standalone, byte-level-tested UI pieces (see Architecture direction above)
third_party/choc/            -- vendored from DIY-MIDI-METRONOME/EDITOR
```
