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
- **Detail/edit views** (a Set List slot's Comment/Font size/Color/Volume today)
  request the *specific raw byte chunk* they're working on from the bridge, and
  decode/encode it entirely in JavaScript -- exactly what `setlist-comment.js` and
  `setlist-slot-params.js` already do, see the case study below for the full loop.
  This is where "test without building the native app" actually matters, since
  that's the UI a human iterates on directly.

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

This codec is also, as of the real editor panels described next, wired into `pane.js`
against the actual loaded file -- see below for how a codec goes from a standalone test
harness to a live, writable piece of the real app.

## Case study: the Setlist editor panel -- attach, decode/encode, write back, discard

A Set List slot's Color/Comment/Volume editors (`pane.js`) are the most complete example
so far of the whole loop this page describes actually running live, not just in a test
harness -- and they surface a real correctness problem (two panes editing the same raw
bytes) that only shows up once a component is wired into a stateful app, not something
a standalone codec test would ever catch. Worth walking through in detail since the
shape here -- one shared byte buffer, one write path, state that fully discards itself
on close -- is the template for any future row-level editor in this app, Kronos-specific
or generic.

### How a panel attaches to a row

Clicking a Set List row's `#`, `Vol`, or `Song`/`Type` cell calls `pane.js`'s
`openSection(entry, type)` -- the single entry point for opening *and* for toggling a
section that's already open (a click on an accordion header inside an open panel calls
the exact same function). The first time any section opens for a given slot, `openSection`:

1. Checks a cross-pane lock (more below) and bails out with a toast if another pane
   already has this exact slot open.
2. Fetches the slot's raw 542-byte SBK1 record via `window.getSongRecordBytes(datasetId,
   setlistIndex, songIndex)` and lazily loads the two codecs (`setlist-comment.js`,
   `setlist-slot-params.js`) via a cached dynamic `import()` -- a plain expression, not a
   static `import` statement, which is what lets it work from inside `pane.js` even
   though `index.html`'s scripts are all classic (non-`module`) `<script>` tags.
3. Only once both are ready does it mark the slot as having an open panel and re-render.

Every section builder (`buildColorSection`/`buildCommentSection`/`buildVolumeSection`)
can then assume, synchronously, that a row's raw bytes and the codecs are both already
available -- no per-section "still loading" state needed anywhere downstream.

### One shared byte buffer, one write path

All three sections on one slot's panel -- Color, Comment, Volume -- read and write
through the *same* cached `Uint8Array` (`slotBytesCache`, keyed by song index), not
three independent copies. This matters because Comment originally didn't work this way:
it used to call a separate bridge method (`setComment`) that only mutated a decoded
struct field in memory, never touching raw bytes at all. That was harmless when Comment
was the only editable field, but once Color/Volume could be open on the *same* row and
write raw bytes directly, it became a real bug -- a raw-byte write re-derives every
decoded field (comment included) from the bytes it just wrote, so committing a Color
change after typing an unapplied Comment edit would silently discard the typed text. The
fix was to retrofit Comment onto the same raw-byte path, not to keep it as a special
case: every edit -- Color's immediate-apply click, Volume's slider-release, Comment's
Apply button -- funnels through one function, `commitSlotBytes(entry, newBytes)`, which:

1. Writes `newBytes` back via `window.putSongRecordBytes(datasetId, setlistIndex,
   songIndex, bytes)`.
2. Updates `slotBytesCache` with the newly-written bytes, so the *next* edit (of any
   type, in the same panel) starts from what was actually just written, not from a stale
   snapshot.
3. Re-derives the row's own display fields (`entry.comment`, `entry.color`,
   `entry.volume`, `entry.fontSize`) directly from those same bytes, via the same JS
   codecs -- no bridge round-trip needed to refresh what the table shows.
4. Re-renders.

On the native side, `PcgFile::putSongRecordBytes()` mirrors this exactly: it writes into
the file's retained raw buffer (`data_`), then re-runs the *existing* `readSlotParams()`/
`readComment()` (the same functions the initial load uses) on just the newly-written
bytes, so the cached `Song` struct never goes stale after a direct write -- the same
discipline `copyProgramFrom()` already established for Programs. Locating a slot's exact
byte range needed no new per-record lookup table, either: unlike Programs (whose bank
records vary in size, hence `programBankLocations_`), every Set List's song records sit
at a fixed 542-byte stride from one retained anchor (`sbkSongsStart_`, captured once
during the existing SBK1 parse), so `songRecordBytes()`/`putSongRecordBytes()` just do
the arithmetic.

### Discarding a panel: nothing to clean up

`renderRows()` rebuilds the whole `<tbody>` from current state on every change
(`tbody.innerHTML = ""`, then re-append every visible row). A slot's editor `<tr>` exists
in the DOM if and only if that slot's index is currently in the `openPanels` set at
render time -- closing a panel (its own dedicated Close button, not a column click,
see the note below) just removes it from that state and re-renders; there's no separate
DOM-node teardown step, no listeners to manually detach. This is a deliberate "just
re-derive the DOM from state" choice over anything resembling virtual-DOM diffing --
perfectly fine at this scale (128 rows per Set List, realistically 0-2 panels open at
once), and it means a panel's *entire* lifecycle -- attach, edit, discard -- is fully
described by three small pieces of state (`openPanels`, `expandedSections`,
`slotBytesCache`), not by anything living in the DOM itself.

(Why a dedicated Close button rather than clicking the same column again: an earlier
version closed a section by re-clicking its own trigger column, which meant "close
everything" required remembering which columns you'd opened and clicking each one again
-- confusing once several sections could be open on one row at once. The panel now stays
visible, showing all three collapsed/expanded accordion headers, until its own Close
button is clicked -- one action, not up to three.)

### The cross-pane problem this surfaces

Two panes can legitimately point at the *same* dataset and the *same* Set List at once
(see the Datasets section above) -- a real, already-supported setup, not an edge case.
If both opened an editor on the same slot, each pane's `slotBytesCache` would be its own
independent copy of those 542 bytes, so whichever pane committed second would silently
overwrite whatever the other had just written -- the exact same class of bug the shared-
buffer fix above solved *within* one pane, just reappearing *across* panes instead. A
module-level registry, `openSlotEditors` (keyed `datasetId:setlistIndex:songIndex`,
shared by every pane instance, not per-pane state), tracks which pane currently owns a
slot's panel; a second pane trying to open the same slot is refused outright (with a
toast explaining why) rather than risking the race. The lock is released whenever that
slot's panel closes, or whenever a pane's whole editor state gets cleared wholesale
(switching Set Lists, switching datasets).

### Testing this without the native app

None of the above requires building the CHOC app to iterate on. `frontend/mock_bridge.js`
provides fake `getSongRecordBytes`/`putSongRecordBytes` implementations that synthesize
(and re-derive, on write) a 542-byte buffer from a mock entry's own fields -- close enough
to the real byte layout that the *real* codecs decode/encode against it exactly as they
would against real hardware data. Serve the repo root with a plain static file server --

```sh
python3 -m http.server 8000
```

-- open `http://localhost:8000/frontend/index.html`, and the whole flow (open a panel,
edit Color/Comment/Volume, close it, even the cross-pane lock across two mock "panes") is
exercisable in a plain browser tab with real devtools, no compiler involved. This is the
same property the individual `.test.html` codec harnesses give you, one level up: a
stateful, multi-component *feature* -- not just one pure function -- that's still fully
testable without the rest of this project's native toolchain.

### Postscript: the same principle, applied to hardware validation

`tools/generate_setlist_test_matrix.{js,cpp}` -- generating a matrix of Setlist edits to
check against a real Kronos by eye (full writeup in `STATE.md`) -- is the same "reuse the
real path, don't build a parallel one" idea from above, just applied one level further
out. It would have been easy to write a quick one-off script with its own from-scratch
byte math to produce the test file faster; that was deliberately rejected, because the
entire point of the exercise is checking whether *this project's own* decode/encode
logic produces bytes real hardware accepts -- a parallel implementation would only prove
its own math was self-consistent, never whether the app's actual code is correct. Both
tools call the exact same `PcgFile`/`EditorBridge`/JS-codec functions a real user's
click would.

It already paid off once, concretely: this project's working list of the 16 Set List
color names/hex values was an unconfirmed guess (generic names like "Red"/"Blue"/
"Black") until a Color-only test group went through this exact loop -- the real
palette turned out to be a completely different, Korg-curated, muted set (Default,
Charcoal, Brick, Burgundy, ...), in a different order, with none of the generic names
present at all. See [the file format](/format) §4.5 for the confirmed table. That's
the kind of wrong-in-a-way-nobody-would-guess result this whole approach exists to
catch.

Nothing here claims the architecture is finished or that every future component will fit
this shape perfectly -- it's a pattern being learned by doing, one real component at a
time, same as the file format itself.
