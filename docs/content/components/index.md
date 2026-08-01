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
`PcgFile.cpp`/`ProgramDecoder.cpp` -- deliberately not `main.cpp`, `EditorBridge.cpp`, or
CHOC -- so it builds and runs in well under a second with no WebView toolchain at all.
Since real `.PCG` files are large and `.gitignore`'d, this test builds a small synthetic
file in memory, byte-for-byte matching the confirmed chunk/record layout, exercising the
full `PcgFile::loadFromMemory()` path (Set List names, masked Font size/Transpose
decoding, Program bank cross-referencing, duplicate detection, and `decodeProgram()`'s
on-demand re-decode) without ever touching a real backup on disk.

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
