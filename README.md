# DIY Kronos Editor

[![Build Kronos Editor (native)](https://github.com/jens-goes-mad/DIY-KORG-KRONOS-EDITOR/actions/workflows/native-build.yml/badge.svg)](https://github.com/jens-goes-mad/DIY-KORG-KRONOS-EDITOR/actions/workflows/native-build.yml)

A cross-platform, cross-architecture editor for Korg Kronos `.PCG`/`.SNG`
backup files, built on [CHOC](https://github.com/Tracktion/choc)
(HTML/JS/CSS UI over a thin native C++ bridge) -- same stack as the sibling
`DIY-MIDI-METRONOME/EDITOR` project, reused rather than reinvented.

## Why this exists

Korg never published a spec for the Kronos's `.PCG`/`.SNG` backup format, and
managing a real Kronos's library -- years of accumulated duplicate Programs,
Set Lists scattered across gig backups, no easy way to compare two backups
side by side -- means doing it entirely by hand on the unit's own screen, or
not at all. This project is reverse-engineering that format from scratch,
byte by byte, verified against real backup files with known ground truth
(not guessed), and building a real cross-platform editor on top of it as the
findings land -- see [`docs/README.md`](docs/README.md) for the full format
writeup and [the docs site](https://jens-goes-mad.github.io/DIY-KORG-KRONOS-EDITOR)
for the readable version.

**If you own a Kronos**, the browsing/rearranging features below already work
on real backups today, and every additional confirmed field or fixed Set List
name is real progress on a format nobody else has fully documented.
**If you're a developer** curious about reverse-engineering a real binary
format, building a cross-platform native+web UI, or both, the codebase is
built specifically to lower that bar -- see
[App architecture & components](https://jens-goes-mad.github.io/DIY-KORG-KRONOS-EDITOR/components/)
for how small, independently testable pieces let you contribute to one part
without building the whole native app first. `STATE.md` tracks exactly
what's built, what's verified, and every known blind spot/open question --
that's the place to look for where a contribution would actually help right
now (Drum Kits/Wave Sequences/Global settings are still completely
unexplored; Windows/Linux native file dialogs are an honest stub; the
write-back/encoder side barely exists yet).

**Tools/stack**: C++ (CMake), [CHOC](https://github.com/Tracktion/choc) for
the native window/WebView bridge, plain vanilla JS/HTML/CSS on the frontend
(no bundler, no build step in dev -- open `frontend/index.html` in a
browser tab with `mock_bridge.js`'s fake data and iterate without compiling
anything), [Bulma](https://bulma.io) (vendored, CSS-only) for layout/styling,
a scoped `ctest` target plus headless `node`-runnable tests for the
byte-level parsing logic, and GitHub Actions CI building macOS
(arm64+Intel), Linux, and Windows on every relevant push.

First iteration scope (see `STATE.md` for current status):

1. Open a `.PCG` file via a native Open dialog and extract all 128 Set Lists
   into memory as a **dataset**.
2. Pick one Set List per pane and show its 128 song slots, with filter/search.
3. A Norton-Commander-style dual pane to copy songs between Set Lists, and
   swap/reorder songs within one, both via drag and drop.

Nothing is written back to disk yet -- this is a read/browse/rearrange-in-
memory tool for now.

## Datasets: one loaded file, decoupled from which pane shows it

Each opened `.PCG` file becomes its own **dataset**, identified by an id the
native bridge mints on open (not by which pane opened it -- there's a single,
global Open button, not a per-pane one). Each pane has its own selector to
pick *which already-open dataset* to display, shared by all of that pane's
categories (Setlist/Programs/Combis/Duplicates, see below) -- independent of
the other pane. This covers two different workflows with one mechanism
instead of two UI modes:

- **Rearranging one backup** (e.g. building a new gig Set List from songs
  spread across other Set Lists in the same file): point both panes at the
  *same* dataset. Since they're then both reading/writing the one shared
  in-memory file, an edit made via either pane is immediately visible in the
  other.
- **Merging/comparing two different backups**: drop a second file -- it
  becomes a second, fully independent dataset -- and point each pane at a
  different one. Dragging a row between them still works exactly the same
  way, just copying across datasets instead of within one.

Opening a path already open elsewhere reuses that existing dataset instead of
loading a second copy; otherwise opening always creates a *new* dataset, and
never silently overwrites whatever a pane was already showing. See
`docs/content/components`'s Datasets section and `STATE.md`'s "ARCHITECTURE"
block for the full before/after and why this replaced the old
one-file-per-pane model.

## Per-pane categories: Setlist / Programs / Combis / Duplicates

Each pane has its own category navbar, not a separate top-level tab -- so two
panes can independently show different categories of the same dataset, the
same category of two different datasets side by side, or anything in
between.

- **Setlist**: the 128-slot browsing/filtering/drag-and-drop described above,
  plus a Bank-jump button per slot that switches that same pane to
  Programs/Combis and scrolls straight to the exact entry it points at.
- **Programs / Combis / Duplicates**: browse every Program and Combi on the
  unit directly (not just through Set List slots), filter by bank, see which
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

Each pane has an **"Open..." button** next to its dataset selector. Clicking it
calls `openFileDialog` -> a real native file picker (`NSOpenPanel` on macOS,
via `src/platform/NativeFileDialog.cpp`), invoked *directly* rather than
through Choc's own WebView-triggered picker (see the bug writeup below for why
that distinction matters). Once a path is chosen, the bridge reads it with a
plain `std::ifstream` (`PcgFile::load(path)`), mints a new dataset id, and
returns it -- see "Datasets" above. Opening a path that's already open (exact
match against the dataset's `displayName`) reuses the existing dataset instead
of loading a second copy, and reports this back as `alreadyOpen: true`.

Drag-and-drop-to-open (an earlier workaround, described below) has since been
**removed** now that the native dialog works. The Setlist table's own
row-level drag-and-drop (dragging a song between panes to swap/copy entries)
is a separate, unrelated feature and is unaffected.

The native dialog exists specifically because of a bug found in earlier manual
testing, which is why drag-and-drop was the *only* UI mechanism for a while:

**A plain HTML `<input type="file">` does trigger a real native file picker
(NSOpenPanel on macOS) inside the Choc WebView** -- confirmed by adding one
directly to `index.html` for testing. `choc_WebView.h`'s
`webView:runOpenPanelWithParameters:...` delegate method does the textbook-
correct thing (`beginSheetModalForWindow:` attached to the WKWebView's own
window), but in practice **the resulting sheet appears behind the main app
window** rather than in front of it, making it unusable. The fix: rather than
going through that delegate at all, `NativeFileDialog.cpp` calls `NSOpenPanel`
directly via `choc::objc` and uses `runModal` (app-modal, not attached to any
window) instead of the sheet-based `beginSheetModalForWindow:` -- a genuinely
different code path that sidesteps the z-order bug entirely. Confirmed working
in the real app. See STATE.md's "NATIVE FILE DIALOG + PROGRESS" section and
Blind Spot #11 for the full history.

Currently macOS-only; Windows/Linux `NativeFileDialog.cpp` is an honest stub
returning "unsupported" rather than untested guesswork.

Known limitation: the whole file is read into memory in one shot with no
progress reporting yet -- fine for occasional loads, but there's no percentage
indicator during a large import (only an indeterminate spinner). A
chunked-read-with-progress design (background thread + `postMessage`/
`evaluateJavascript` push events) is written up in STATE.md but not built yet.

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
  platform/NativeFileDialog.{h,cpp} -- native Open/Save dialog (macOS; Windows/Linux stubbed)
  main.cpp                   -- CHOC window/webview wiring
frontend/
  index.html, app.js, style.css   -- topbar (global Open button) + shared wiring
  datasets.js                  -- shared dataset registry (open files, decoupled from pane) -- see Datasets above
  pane.js                      -- pane shell (dataset selector + Setlist/Programs/Combis/Duplicates category nav) + Setlist UI
  library.js                   -- Programs/Combis/Duplicates category content, embedded per-pane (not a separate tab)
  mock_bridge.js              -- fake in-memory backend for plain-browser dev (no native build needed)
  vendor/bulma.min.css         -- vendored Bulma (CSS only, no JS/build-step dependency) -- see docs/content/components
  components/kronos/          -- standalone, byte-level-tested UI pieces (see Architecture direction above)
third_party/choc/            -- vendored from DIY-MIDI-METRONOME/EDITOR
```
