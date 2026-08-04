---
title: App Architecture & Components
links:
  - title: How the app is organized, and why
    description: componentization, encapsulation, and testability without building the native app at all
menu:
    main:
        weight: 4
        params:
            icon: sitemap

toc: true
---
This page is about *how the app is built*, not the file format itself (see
[The file format](/format) for that). It exists because the project owner wants more
contributors to be able to join in -- most comparable Kronos tooling projects out there are
either dead or tied to one platform, and lowering the bar to touch this codebase is a
deliberate goal, not an afterthought.

## The problem this solves

Until recently, working on any piece of this app's UI meant building the whole native
CHOC app first: a C++ toolchain, CMake, platform-specific WebView dependencies (see
[Building the app](/building)), and a real `.PCG` file to test against. That's a lot of
setup just to tweak a textarea or fix a button, and it's a real barrier for anyone who
wants to contribute a small piece without committing to the whole stack up front.

## The idea: small, self-contained components

Pieces of UI that touch raw Kronos bytes are being pulled out into their own files under
`frontend/components/`, split into three parts each:

1. **A codec** -- pure functions, `decode(bytes) -> state` and `encode(bytes, state) ->
   newBytes`. No DOM, no dependency on anything else in this project. This is the *only*
   part that knows about Kronos byte offsets.
2. **A component** -- owns the actual UI (buttons, textareas, whatever), operates purely
   on the codec's `state` shape, and reports changes via a plain `onChange(state)`
   callback. A *generic* component (living under `frontend/components/generic/`, not
   built yet) additionally knows nothing about Kronos at all -- just abstract shapes like
   "a list of draggable nodes," reusable for anything with that shape.
3. **A standalone test harness** -- a bare `.html` file that imports just the codec and
   component, feeds them literal byte data copied from a real backup, and lets you click
   around in a plain browser tab. No CHOC, no native build, no `mock_bridge.js` even --
   just a static file server (`python3 -m http.server`, not a build step).

The real app then wires the same codec/component into `pane.js` against the actual
loaded file -- same code path as the test harness, just fed real bytes from
`EditorBridge` instead of a hardcoded fixture.

## The backend side: decoders, and a two-tier data flow

The same split is happening in `src/kronos/` too, not just the frontend.
[`ProgramDecoder.h/.cpp`](https://github.com/jens-goes-mad/DIY-KORG-KRONOS-EDITOR/blob/main/src/kronos/ProgramDecoder.h)
is the first one: `decodeProgramFields()` (raw Kronos fields) and `hashProgramRecord()`
(this project's own derived bookkeeping, not a Kronos format field) as separate,
independently reusable functions -- mirroring the frontend codec split. `PcgFile` now
retains the whole loaded file's raw bytes instead of discarding them after an initial
parse, so a decoder can be re-invoked on demand later, not just once at load time.

[`CombiDecoder.h/.cpp`](https://github.com/jens-goes-mad/DIY-KORG-KRONOS-EDITOR/blob/main/src/kronos/CombiDecoder.h)
followed the same day: `decodeCombiFields()` returns a Combi's name plus its 16
Timbre-to-Program references, replacing what used to be inline parsing logic in
`PcgFile.cpp`. No hash function here -- byte-exact duplicate detection was only ever
requested for Programs, not Combis. `PcgFile::decodeCombi(bank, number)` mirrors
`decodeProgram()`, proving the same on-demand-re-decode property holds for a second
record type, not just the first one.

That said, not everything moves to per-chunk decoding -- there are deliberately two
tiers:

- **Bulk/list views** (the Programs table, duplicate detection) stay served by a native
  decoder walking the whole retained buffer once. That's a real efficiency win --
  hashing every Program for dedup is genuinely faster in native code than doing the
  same scan in a WebView's JS engine, and it avoids shipping a large amount of data
  across the JS/native bridge for something already sitting in native memory.
- **Detail/edit views** (Comment + Font size today) request the *specific raw byte
  chunk* they're working on from the bridge, and decode/encode it entirely in
  JavaScript -- exactly what `setlist-comment.js` already does. This is where "test
  without building the native app" actually matters, since that's the UI a human
  iterates on directly.

Writes from the JS side go straight back into the native buffer immediately (a
`putRecordBytes()`-style bridge call), rather than being tracked as a separate pending
overlay -- an overlay keyed by a record's position turns out to be a real hazard once
you consider that Programs/Combis/Set List entries can be reordered, which would leave
a stale pending edit silently applying to whatever now sits in that position. Writing
straight through sidesteps that; it's safe here specifically because this is a
single-threaded, single-user app with no concurrent writers to reconcile. Full reasoning
in `STATE.md`'s "ARCHITECTURE: DECODER/ENCODER REFACTOR" section, which is kept current
as this evolves.

## Why this helps contributors

- **You can work on one component without building anything.** Clone the repo, run a
  static file server, open the `.test.html` file, and you have a working, editable piece
  of real UI in front of you in seconds -- no C++ compiler, no CMake, no platform-specific
  WebView setup.
- **The blast radius of a change is obvious.** A codec function either round-trips
  correctly or it doesn't; a component either renders correctly given a `state` object or
  it doesn't. You don't need to understand `EditorBridge`, `PcgFile.cpp`, or CHOC's
  WebView wiring to contribute to either.
- **Generic components are meant to be reused across very different Kronos data.** An
  ADSR envelope editor, for instance, is visually and behaviorally identical whether it's
  shaping a VCA envelope, a VCF envelope, or something else entirely, regardless of
  which of the Kronos's several synth engines it belongs to -- one generic node-graph
  component, with a different thin Kronos-specific codec per envelope type. Write the
  hard UI work (dragging nodes, syncing numeric inputs) once.

## Why this helps testing

- **Codec functions are trivially unit-testable** -- pure input/output, no DOM, no async,
  no app state. `setlist-comment.test.html`'s self-checks run a dozen-plus assertions the
  instant the page loads, with pass/fail rendered directly on the page.
- **Real byte fixtures keep tests honest.** Test data is copied straight out of a real
  backup file (see the case study below) rather than invented, so a passing test means
  something about the actual format, not just about the code's own assumptions.
- **Bit-level correctness becomes mechanically checkable.** Several SBK1 fields turned
  out to share bytes with each other (see [the file format](/format)'s §4.3) -- a naive
  encoder could silently corrupt a neighboring field it doesn't even know about. The
  self-checks assert this directly: craft a record with arbitrary bits set in every field
  a given codec does *not* own, make an edit, and confirm those bits survive byte-for-byte.

### Committed, headless test suites -- not just browser harnesses

The `.test.html` harnesses above are for interactive/manual development, but they need a
human to open a browser tab and eyeball pass/fail. Every component's codec also gets a
plain, headless, `node`-runnable twin (`setlist-comment.test.js` alongside
`setlist-comment.test.html`), importing the exact same real-byte fixture from a shared
`test-fixtures.js` module (so the two never drift into testing subtly different data),
and exiting non-zero on any failed assertion -- the shape CI/`ctest`-style automation
needs, that a browser page alone can't give you.

The backend side has the same split, one level up: a small, scoped `pcg_file_test`
CMake/`ctest` target (`tests/pcg_file_test.cpp`) that depends on *only*
`PcgFile.cpp`/`ProgramDecoder.cpp`/`CombiDecoder.cpp` -- deliberately not `main.cpp`,
`EditorBridge.cpp`, or CHOC -- so it builds and runs in well under a second with no
WebView toolchain at all. Since real `.PCG` files are large and `.gitignore`'d, this test
builds a small synthetic file in memory, byte-for-byte matching the confirmed
chunk/record layout, exercising the full `PcgFile::loadFromMemory()` path (Set List
names, masked Font size/Transpose
decoding, Program bank cross-referencing, duplicate detection, and `decodeProgram()`'s
on-demand re-decode) without ever touching a real backup on disk.

## Datasets: decoupling "loaded file" from "pane"

The dual-pane UI used to conflate two different things a user wants to do:
rearranging entries between Set Lists *within one backup* (which needs both
panes looking at the *same* loaded file), and comparing/merging *two
different* backups side by side (which needs two genuinely independent
files). The old model -- one `PcgFile` per pane, keyed by the frontend's own
`"A"`/`"B"` pane id -- did neither correctly: dropping the same file onto
both panes silently forked it into two unrelated in-memory copies, with no
way to point two panes at one shared file.

The fix: promote **dataset** (one loaded file) to a first-class concept,
identified by an id `EditorBridge` mints itself on open -- never a
caller-supplied pane id -- and fully decoupled from which pane displays it.
`openFileDialog()` (a real native Open dialog, see below) mints a new dataset
per call and returns `{datasetId, displayName, setlistCount}`, or
`{alreadyOpen: true, ...}` if that exact path is already loaded, reusing the
existing dataset rather than loading a second copy; a `listDatasets()` lets
any selector populate itself from every currently open dataset, regardless of
which pane originally opened it. Each pane's one dataset selector is shared
by all of that pane's categories (Setlist/Programs/Combis/Duplicates -- see
[Overview](/#the-editor)), not one dropdown per category. Opening a file
always creates a *new* dataset (unless it's already open); pointing two panes
at the *same* one gives shared-view editing for free, since they're then both
reading/writing the one underlying `PcgFile` -- dragging a Set List row
between them resolves to an ordinary same-dataset copy, no special-casing
needed.

The native Open dialog itself was a separate fix worth noting here: CHOC's
own `<input type="file">`-triggered picker opens `NSOpenPanel` via a *sheet*
(`beginSheetModalForWindow:`), which has a long-standing z-order bug on macOS
-- the panel appears behind the app window. `src/platform/NativeFileDialog.cpp`
sidesteps CHOC's delegate entirely and calls `NSOpenPanel`/`NSSavePanel`
directly via `choc::objc` (CHOC's own reusable Objective-C interop helpers)
using `runModal` (app-modal, not sheet-attached) -- a genuinely different code
path that isn't subject to the same bug. Confirmed working in the real app;
Windows/Linux are an honest stub for now rather than untested guesswork.

A small shared frontend module, `datasets.js`, holds the last known list of
open datasets and a tiny pub/sub (`onDatasetsChanged`) so opening a file from
either pane immediately updates every other pane's selector too -- the same
"small, focused, independently testable" shape as the codec modules above,
just for UI registry state instead of byte decoding.

## Styling: Bulma, not a hand-rolled grid

The frontend's CSS moved to [Bulma](https://bulma.io) (vendored as one file,
`frontend/vendor/bulma.min.css`, no build step, no JS dependency -- Bulma has
none of its own, every interactive behavior here is still plain hand-written
JS) after several rounds of hand-rolled CSS Grid/Flexbox layout kept hitting
the same class of bug: a flex/grid item's default `min-width` is `auto`
(clamped to its content's own minimum size, not 0), so a table with locked
column widths nested a few levels deep could silently stop the whole chain
from ever shrinking below its content's natural size. Bulma's real
`.columns`/`.column` grid and `.tabs`/`.button`/`.table` components replaced
the equivalent hand-rolled CSS outright rather than being layered on top of
it -- less code to maintain, and it's the same battle-tested pattern used
everywhere else Bulma ships it. Full blow-by-blow (including the specific
things Bulma *doesn't* solve for free, like column-width locking within a
table, which Bulma has no concept of at all) is in `STATE.md`, since it's a
still-evolving area rather than a settled architectural decision.

## Case study: SetlistComment

The first component built this way is
[`frontend/components/kronos/setlist-comment.js`](https://github.com/jens-goes-mad/DIY-KORG-KRONOS-EDITOR/blob/main/frontend/components/kronos/setlist-comment.js)
-- a Comment textarea plus a Font size button bar (XS/S/M/L/XL). It's a good example of
the whole loop working end to end:

1. Built and manually tested in its
   [standalone harness](https://github.com/jens-goes-mad/DIY-KORG-KRONOS-EDITOR/blob/main/frontend/components/kronos/setlist-comment.test.html),
   seeded with a real Comment record, before anything was wired into the native app.
2. Font size's actual byte encoding was unknown at first -- an early guess (a single
   reserved byte) turned out to be wrong once tested against real hardware data, and was
   retracted rather than kept as a plausible-looking guess.
3. A properly isolated test file later revealed the real encoding: Font size turns out to
   be 3 bits split across two *different* bytes, each of which is also used by a
   completely different field (Type+Color, and Transpose) -- see
   [the file format](/format)'s §4.4 for the full derivation.
4. The codec and component were updated to match, with masked read-modify-write logic
   (clear only the bits a field owns, then OR in the new value) so editing Font size can
   never corrupt Color, Transpose, or the handful of bits in this format that are still
   completely unexplained.

Nothing here claims the architecture is finished or that every future component will fit
this shape perfectly -- it's a pattern being learned by doing, one real component at a
time, same as the file format itself.
