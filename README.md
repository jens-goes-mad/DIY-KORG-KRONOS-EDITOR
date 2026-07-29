# DIY Kronos Editor

A cross-platform, cross-architecture editor for Korg Kronos `.PCG`/`.SNG`
backup files, built on [CHOC](https://github.com/Tracktion/choc)
(HTML/JS/CSS UI over a thin native C++ bridge) -- same stack as the sibling
`DIY-MIDI-METRONOME/EDITOR` project, reused rather than reinvented.

First iteration scope (see `STATE.md` for current status):

1. Open a `.PCG` file (drag-and-drop) and extract all 128 Set Lists into
   memory.
2. Pick one Set List per pane and show its 128 song slots, with filter/search.
3. A Norton-Commander-style dual pane (open two files side by side) to copy
   songs between Set Lists, and swap/reorder songs within one, both via drag
   and drop.

Nothing is written back to disk yet -- this is a read/browse/rearrange-in-
memory tool for now.

## The KORG PCG/SNG file format (reverse-engineered, work in progress)

Everything below was derived by hex-inspecting a real Kronos backup
(`20210504.PCG`, ~47.9MB) -- there is no official spec being followed, so
treat field names as our own working labels, not Korg's actual terminology
unless noted.

### Container format

The file uses a chunked container format similar in spirit to
RIFF/IFF/AIFF, but **big-endian** sizes (Korg's synth DSPs are historically
Motorola-style big-endian, unlike Microsoft's little-endian RIFF).

Fixed 16-byte file header:

```
offset  bytes                         meaning
0       "KORG"                        magic
4       0x68                          format/version byte(s), not decoded
5-15    00 02 02 01 00 00 00 00 00 00 00   unknown, not decoded
```

After that, the file is a sequence of **chunks**. Each chunk we've found so
far looks like:

```
[4-byte prefix field][4-char tag][4-byte big-endian size][size bytes of content]
```

The 4-byte prefix field's purpose is **not understood yet** -- it precedes
every chunk we've located (not just the first child of a container), so our
parser (`src/kronos/PcgFile.cpp`) tries reading a chunk header at a given
position directly first, and if that doesn't look like a valid 4-letter tag,
retries 4 bytes later. This is a heuristic, not a confirmed rule -- see
"Open questions" below.

A "valid tag" (our heuristic): first byte is an uppercase letter, next three
are uppercase letters or digits (`[A-Z][A-Z0-9]{3}`). All tags observed so
far fit this (`KORG`, `PCG1`, `DIV1`, `SLS1`, `SLD1`, `SDB1`).

### Chunk hierarchy found

```
PCG1 (size 47,871,880)                     -- top-level container
 └─ DIV1 (size 44)                         -- small fixed-size table, not decoded
 └─ SLS1 "SetList Slots" (size 9,340,488)  -- huge; mostly per-slot recall-parameter
     │                                        blobs we haven't decoded, see below
     └─ SLD1 "SetList Data" (size 462,872)
         └─ SDB1 "SetList DataBase" (size 462,348)   <-- the part this editor uses
```

Only one `SLS1`/`SLD1`/`SDB1` chain was found in the sample file -- but that
single `SDB1` chunk holds **all 128 of the unit's Set Lists internally**
(confirmed below), so this isn't a limitation. `SLS1`'s huge remaining size
beyond `SLD1` (~8.9MB) is presumably the bulk "instant recall" parameter
snapshots for populated slots, not further tagged sub-chunks -- unconfirmed,
not yet explored, and not needed for this tool's current scope.

### SDB1 ("Set List database") layout -- confirmed

Found by literally grepping the raw file for known song/Set-List names (the
project owner's own Kronos setlists: `"Rolling in the Deep"`,
`"emergency exit"`, `"Wiener Hof Old Stars"`, `"Misplaced Childhood"`) and
reconstructing the byte layout around each hit -- far more reliable than
guessing from the factory-preload data alone, which turned out to be
misleading (its slots are all just named after the demo engine/category,
e.g. `"HD-1"`, `"Combi"`, so the real per-slot name field was hiding in
plain sight but looked like structural metadata until real user data was
checked against it).

```
offset (from SDB1 content start)   field
0                                   u32be used             -- meaning still unclear (344 in sample; not "slot count")
4                                   u32be numSetlists       -- 128 in sample -- matches the real hardware's 128 Set Lists
8                                   u32be bytesPerSetlist   -- 3612 in sample == 129 * 28
12..                                `numSetlists` Set List blocks, `bytesPerSetlist` bytes each
```

Each Set List block is **129 consecutive 28-byte records** (`bytesPerSetlist
== (128 songs + 1 name) * 28`):

```
record 0        -- the Set List's own name
records 1..128   -- its 128 song/program slots, in order
```

Every record is `[4-byte marker][24-byte ASCII name, NUL-padded]`. Three
marker values seen:

- `00 00 00 00` -- only on the very first record in the whole table (Set
  List #0's name). Probably just "nothing precedes this."
- `1e 02 00 00` -- the ordinary marker, used for a Set List's own name
  record (#2 onward) and for the majority of song slots.
- `28 0f 01 00` -- appears on **exactly 128 records total** (one per Set
  List) and always immediately after a name record -- i.e. it marks
  **"first song slot of a new Set List."** The name record right before it
  is otherwise indistinguishable from a normal record; you have to look
  for this marker on the *next* record to know where one Set List's name
  ends and its song list begins.

Unpopulated song slots are empty strings (all-NUL name after the marker),
which is why the header's `used` count (344) is much smaller than
`numSetlists * 128` (16,384) -- most factory-default Set Lists (`"Set List
005"` .. `"Set List 127"`) have no songs assigned at all. `used`'s exact
definition (what precisely it's counting) is still unclear, since 344
doesn't cleanly match "non-empty song slots" or "non-default Set List
names" alone -- not important for this tool's purposes.

Verified end to end against the real 47.9MB sample: all 128 Set Lists
extracted, including the 5 user-named ones (`Preload Set List`,
`emergency exit`, `Wiener Hof Old Stars`, `Misplaced Childhood`, `Pink
Floyd`) with real song titles (`Rolling in the Deep`, `Sex on Fire`, `AC/DC`,
`Africa`, `Purple Rain`, ...) and the 123 untouched `Set List NNN` defaults.

### SBK1 -- the real per-slot parameter bank (confirmed)

Every SDB1 song record turned out to be name-only (confirmed by a
purpose-built test file, `setlist_test.PCG`, with 4-6 identical-name test
slots per parameter -- their SDB1 bytes are 100% identical across the
group, proving no parameter data hides there). The actual per-slot
parameters (which Program/Combi, Volume, Hold Time, Color, ...) live in a
sibling chunk inside `SLS1` that a full generic chunk-tag scan (not just
the earlier SDB1-only search) revealed:

```
SLS1
 ├─ SLD1 -> SDB1        (names only, documented above)
 └─ STL1
     └─ SBK1            (the real per-slot parameter data)
```

`SBK1` content header (same 12-byte shape as SDB1's):
```
offset  field
0        u32be count            (347 in the original sample, 470 in the test file -- unclear meaning, same as SDB1's "used")
4        u32be numSetlists      (128)
8        u32be bytesPerSetlist  (69,416 in both samples)
12..     128 Set List blocks, bytesPerSetlist bytes each
```

Each Set List block starts with a name record (marker + ASCII name, same
idea as SDB1 but with more padding before the first song), then 128 song
records on a **542-byte stride**, confirmed by diffing a deliberately
minimal test file (`setlist_test.PCG`, ~9.3MB) where the project owner set
up groups of 4 near-identical slots each varying exactly one parameter and
told us which. First 5 bytes of a song record, confirmed by that diff:

```
byte0   4*(color-1) + type      -- CONFIRMED: color values 1,2,4,16 (as set by the
                                    project owner) produce byte0 = 1,5,13,61 exactly,
                                    i.e. color is 1-based and linearly packed with a
                                    1-bit type flag (bit0: 1 = Program, 0 = Combi) in
                                    the low bits. Verified independently both by formula
                                    derivation and by the project owner's stated values
                                    matching it exactly.
byte1   bank index (0 for the first few banks; e.g. 13 seen for a later bank)
byte2   program/combi NUMBER within that bank (0-127)
byte3   Hold Time + 1            -- CONFIRMED: values 1,2,3,5 (as set) produced
                                    byte3 = 2,3,4,6 -- a consistent +1 offset. The
                                    "default/baseline" byte3=6 seen everywhere else
                                    therefore means Hold Time defaults to 5.
byte4   Volume (0-127, MIDI-style) -- CONFIRMED: values 0,1,80,127 (as set) matched
                                    byte4 exactly, no transform needed. 127 is the
                                    default/baseline used everywhere else.
```

A free-text **Comment** field starts at byte offset **+18** (confirmed
across multiple test slots -- one reserved/flag byte at +17 sits between it
and Volume, not understood yet), ASCII, and can contain literal `\r\n` line
breaks (not a terminator -- only a genuine NUL byte ends the string). Now
parsed by `PcgFile` (`readComment()`) and editable in the UI: clicking a
song row expands an inline `<textarea>` below it (same click-to-expand
interaction as DIY-MIDI-METRONOME/EDITOR's trigger list), Apply calls
`EditorBridge::setComment()` -- in-memory only, like everything else here.

**Font size and Transpose remain unsolved** despite having exact test
values for both (Font: 1,2,4,5 on slots 12-15; Transpose: 0,-1,1,24 on
slots 52-55) -- neither produces a clean pattern against byte0 the way
Color did:

- Font's byte0 values were `0x41, 0x01, 0xc1, 0x01` for stated values
  `1, 2, 4, 5` -- two slots (font 2 and 5) show the exact Color-formula
  *baseline* (`0x01`, i.e. "color=1, no change"), while the other two show
  values consistent with the Color formula but implying color=17 and
  color=49 -- both implausibly large and not matching the color test's
  observed max of 16. Most likely explanation: Font size isn't stored in
  byte0 at all, and its real field hasn't been located yet; the byte0
  changes seen here may be an unrelated side effect (needs re-testing with
  color deliberately held constant, or searching further into the record).
- Transpose's non-baseline bytes appeared at *different offsets* depending
  on the value: `-1` showed `0xe0` at byte1, `+1` showed `0x20` at byte5,
  `+24` showed `0x60` at byte1. That's inconsistent with a single
  fixed-position signed field -- needs a cleaner test (e.g. a wider, more
  distinctive spread of values, or isolating it from whatever else might
  be varying) to pin down.

### Cross-referencing the real instrument name (Combi and Program, both confirmed)

A Set List song's SDB1 name is just a label -- it can be (and often is)
edited independently of the actual Program/Combi it points to. The real
instrument banks live as top-level siblings of `SLS1` inside `PCG1`, found
by a top-level chunk scan of the whole file (not just inside `SLS1`):

```
PCG1
 ├─ DIV1, SLS1 (documented above)
 ├─ PRG1   -- Programs. Exactly 20 sub-banks, tagged MBK1 or PBK1
 │           (10 each), interleaved in file order (not grouped by tag).
 ├─ CMB1   -- Combis. Exactly 14 CBK1 (Combi Bank) children.
 ├─ DKT1   -- Drum Kits (not explored)
 ├─ WSQ1   -- Wave Sequences (not explored)
 ├─ GLB1   -- Global settings (not explored)
 └─ DPI1   -- unidentified (not explored)
```

`CBK1` (Combi) and `MBK1`/`PBK1` (Program) banks share one record shape:
the same 12-byte header as SDB1/SBK1 (unknown count / `numRecords`=128 /
`bytesPerRecord` -- 7810 for Combi, 4960 for Program), then that many
fixed-size records. A record's name is a **fixed 24-byte field starting 4
bytes in** -- space/NUL-padded, but *not* NUL-terminated (a full-length
24-character name has no terminator at all, so trimming trailing NUL/space
is required rather than scanning for NUL). `PcgFile`'s `parseNamedBanks()`
handles both uniformly; a slot's `bank`/`number` (from SBK1, see above)
directly index `[bank][number]` into whichever list matches its
Program/Combi type -- MBK1 vs PBK1 turned out to be irrelevant to name
lookup, just two tag values for the same record shape.

**Combi** was verified first: cross-referencing "emergency exit"'s slots
by bank/number into CBK1 reproduced the slot's own SDB1 name exactly for
the great majority of songs (e.g. bank 7 / number 9 -> "Rolling in the
Deep", matching the project owner's own example of the scheme) -- a
handful of real mismatches turned out to be genuine signal, not bugs (the
slot was custom-relabeled independently of the Combi's own name, or vice
versa) -- this is why the UI shows both when they differ, rather than
only one.

**Program** was solved the same session by the project owner pointing out
three known real Program names in sequence ("Subdivisions", "Perfect
Kiss", "Sirius") -- searching the file located them as consecutive records
(90, 91, 92) in the very first PRG1 sub-bank, confirming Program uses the
exact same record layout/mechanism as Combi (just against MBK1/PBK1 instead
of CBK1), with no special-casing needed.

**Bank values >=20 for Program (seen in real data) don't correspond to any
stored bank** -- there are only 20 real PRG1 sub-banks (indices 0-19).
These are near-certainly references to GM/GM2 (fixed content per the MIDI
spec, not stored per-file) rather than a parsing bug; a bank-232 Combi
reference and a bank-192 Program reference were also seen once each in
real data and are more likely genuine data corruption in that one slot
than anything this parser gets wrong. All of these are left showing a raw
`bank-number` rather than a guessed label, both for the name (empty
`instrumentName`, degrading gracefully) and the UI's bank label.

**Display bank labels** (`PROGRAM_BANK_NAMES`/`COMBI_BANK_NAMES` in
`pane.js`) use the project owner's given naming order (`INT-A..INT-G`,
`G(d)`, `USER-A..USER-F`, `USER-AA..USER-FF` for Program -- note `GM`
itself is *not* one of the 20 stored banks per the reasoning above, so it's
omitted from this list rather than claimed at some index). This label
mapping assumes file order == that list order positionally; unlike the
name *lookup* itself (mechanically confirmed above), the specific letter
label shown per bank index hasn't been independently verified the same
way -- if a label ever looks wrong for a bank you recognize, that's the
part to double check first, not the name lookup.

### Open questions

1. What is the 4-byte prefix field preceding every *chunk* header (`PCG1`,
   `DIV1`, `SLS1`, `SLD1`, `SDB1` themselves, not the SDB1 song/name
   records above, which are fully understood now)? A running byte offset?
   An index? Untested.
2. RESOLVED: `SLS1`'s bulk data beyond `SLD1` is the `STL1`/`SBK1` chunk
   pair holding the real per-slot parameters -- see above. `SBK1`'s own
   content is 100% accounted for by its header + 128 Set List blocks, no
   further mystery region left within it.
3. What does the `used`/`count` header field (344 in SDB1, 347/470 seen in
   SBK1 across two files) actually count? Not slot-count, not
   non-empty-Set-List-count in any way checked yet.
4. Where Font size actually lives -- confirmed NOT to be in byte0 (Color's
   own field, fully solved -- see above); the byte0 values seen during the
   Font test (0x41, 0x01, 0xc1, 0x01) turned out to be unrelated noise, not
   explained by comment placement either. Its real location is unknown.
5. Transpose's exact byte offset/encoding (signed? scaled? multi-byte?) --
   see above, needs another test with a cleaner/wider value spread.
6. The one reserved/unknown byte at record offset +17, between Volume and
   the Comment field.

## Opening a file

The UI only exposes one mechanism: **drag a file from Finder/Explorer onto a
pane.** The browser's File API hands the dropped file's bytes to JS directly
(`File.arrayBuffer()`), no filesystem path involved at all; `pane.js`
base64-encodes them and calls `openFileBytes` -> `PcgFile::loadFromMemory(bytes)`.

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

Mirrors `DIY-MIDI-METRONOME/EDITOR`'s CMake setup:

```sh
cmake -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build
./build/kronos_editor
```

Debug builds read `frontend/` live off disk (edit-reload friendly). Release
builds (`-DCMAKE_BUILD_TYPE=Release`, or `-DEDITOR_EMBED_RESOURCES=ON`)
embed `frontend/` into the binary via `tools/embed_resources.py`.

## Layout

```
src/
  kronos/PcgFile.{h,cpp}     -- the file-format parser described above
  bridge/EditorBridge.{h,cpp} -- native functions exposed to the web UI
  main.cpp                   -- CHOC window/webview wiring
frontend/
  index.html, app.js, pane.js, style.css   -- dual-pane UI
  mock_bridge.js              -- fake in-memory backend for plain-browser dev (no native build needed)
third_party/choc/            -- vendored from DIY-MIDI-METRONOME/EDITOR
```
