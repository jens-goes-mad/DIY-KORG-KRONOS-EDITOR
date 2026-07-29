# Korg Kronos `.PCG`/`.SNG` File Format (reverse-engineered)

This is the complete internals reference for the file format this project
parses. There is no official Korg spec being followed here -- everything
below was derived by hex-inspecting real backups and, where noted,
confirmed against ground truth the project owner provided directly (known
song/Combi/Program names, or deliberately-constructed test files that vary
one parameter at a time). Field names are our own working labels, not
necessarily Korg's internal terminology, unless stated otherwise.

Two files were used throughout: a real full backup (`20210504.PCG`,
~47.9MB) and two purpose-built test files the project owner created
specifically to isolate individual fields (`setlist_test.PCG`,
`setlist_test_2.PCG`, the latter ~36MB and including full instrument-bank
data). Anything marked **CONFIRMED** below was checked against one or more
of these; anything else is a working hypothesis.

Status legend used throughout: **CONFIRMED** (checked against real/known
data), **assumed** (mechanically plausible, not independently verified),
**unknown** (not yet investigated).

---

## 1. Container format

The file uses a chunked container similar in spirit to RIFF/IFF/AIFF, but
**big-endian** sizes throughout (Korg's synth DSPs are historically
Motorola-style big-endian, unlike Microsoft's little-endian RIFF).

### 1.1 Fixed 16-byte file header

```
offset  bytes                              meaning
0       "KORG"                             magic
4       0x68                               format/version byte(s) -- unknown
5-15    00 02 02 01 00 00 00 00 00 00 00    unknown
```

### 1.2 Chunk framing

After the file header, the rest of the file is a sequence of chunks:

```
[4-byte prefix field][4-char tag][4-byte big-endian size][size bytes of content]
```

The 4-byte prefix field's purpose is **unknown**. It precedes *every*
chunk encountered (not just a container's first child), so a chunk header
must be searched for at two candidate positions: directly, and 4 bytes
later. All tags found so far are 4 characters, first an uppercase letter,
remaining three uppercase letters or digits (`[A-Z][A-Z0-9]{3}`) --
`KORG`, `PCG1`, `DIV1`, `SLS1`, `SLD1`, `SDB1`, `STL1`, `SBK1`, `PRG1`,
`MBK1`, `PBK1`, `CMB1`, `CBK1`, `DKT1`, `WSQ1`, `GLB1`, `DPI1`.

## 2. Chunk hierarchy

```
PCG1                                -- whole-file container
 ├─ DIV1                            -- small fixed-size table, unknown, not decoded
 ├─ SLS1                            -- Set Lists (all 128 of them -- see §3, §4)
 │   ├─ SLD1
 │   │   └─ SDB1                    -- Set List NAMES (§3)
 │   └─ STL1
 │       └─ SBK1                    -- Set List per-slot PARAMETERS (§4)
 ├─ PRG1                            -- Programs: 20 sub-banks (§5.2)
 │   └─ MBK1 / PBK1  x20            -- interleaved in file order, 10 of each tag
 ├─ CMB1                            -- Combis: 14 sub-banks (§5.1)
 │   └─ CBK1  x14
 ├─ DKT1                            -- Drum Kits -- NOT explored
 ├─ WSQ1                            -- Wave Sequences -- NOT explored
 ├─ GLB1                            -- Global settings -- NOT explored
 └─ DPI1                            -- unidentified -- NOT explored
```

Only one `SLS1`/`SLD1`/`SDB1`/`STL1`/`SBK1` chain exists per file, but that
single chain holds all 128 of the unit's Set Lists internally (§3) -- this
is not a limitation.

`SLS1`'s total size is far larger than `SLD1` alone -- the remainder is
`STL1`/`SBK1` (§4), which fully accounts for it (no further mystery region
left inside `SLS1` once `SBK1`'s own header + 128 blocks are subtracted).

## 3. SDB1 -- Set List names — CONFIRMED

Found by grepping a real backup for known Set List/song names directly
(`"Rolling in the Deep"`, `"emergency exit"`, `"Wiener Hof Old Stars"`,
`"Misplaced Childhood"`) and reconstructing the byte layout around each
hit. This was necessary because the factory-preload data alone is
*misleading*: its slots are named after their demo engine/category (e.g.
`"HD-1"`, `"Combi"`), which looks like structural metadata rather than a
free-text name field until real user data is checked against it.

### 3.1 Header (12 bytes, at SDB1's content start)

```
offset  field                  sample value
0       u32be used             344       -- meaning unclear, not a simple slot/name count
4       u32be numSetlists      128       -- matches real hardware's 128 Set Lists
8       u32be bytesPerSetlist  3612      -- == 129 * 28
12..    `numSetlists` Set List blocks, `bytesPerSetlist` bytes each
```

### 3.2 Set List block (129 x 28-byte records)

```
record 0        the Set List's own name
records 1..128   its 128 song/program slots, in order
```

Every record: `[4-byte marker][24-byte ASCII name, NUL-padded]`.

Three marker values seen:

| Marker | Meaning |
|---|---|
| `00 00 00 00` | Only on the very first record in the whole table (Set List #0's name). |
| `1e 02 00 00` | Ordinary marker -- a Set List's own name record (#2 onward), and most song slots. |
| `28 0f 01 00` | Appears on **exactly 128 records total** (one per Set List), always immediately after a name record -- flags "first song slot of a new Set List." This is the *only* way to find where one Set List's name ends and its 128 songs begin -- the name record itself is byte-for-byte indistinguishable from an ordinary record otherwise. |

Unpopulated song slots are empty strings (all-NUL after the marker) --
most factory-default Set Lists (`"Set List 005"` .. `"Set List 127"`) have
no songs assigned. The header's `used` count doesn't cleanly match
"non-empty song slots" or "non-default Set List count" -- still unknown.

**Verified** end to end against the real 47.9MB sample: all 128 Set Lists
extracted correctly, including 5 real user-named ones (`Preload Set List`,
`emergency exit`, `Wiener Hof Old Stars`, `Misplaced Childhood`, `Pink
Floyd`) with real song titles (`Rolling in the Deep`, `Sex on Fire`,
`AC/DC`, `Africa`, `Purple Rain`, ...) and 123 untouched `Set List NNN`
defaults.

## 4. SBK1 -- per-slot parameters — CONFIRMED (mostly)

Every SDB1 song record turned out to be **name-only** -- confirmed with a
purpose-built test file containing 4-6 identical-name slots per test
parameter, whose SDB1 bytes were 100% identical across the group, proving
no parameter data hides there. The real parameters live in `SBK1`, found
only by a *generic* chunk-tag scan (not a targeted SDB1-only search).

### 4.1 Header (same 12-byte shape as SDB1)

```
offset  field                  sample value
0       u32be count            347 / 470 seen across two files -- unclear meaning
4       u32be numSetlists      128
8       u32be bytesPerSetlist  69,416  -- == 40 (header) + 128 * 542
12..    `numSetlists` Set List blocks, `bytesPerSetlist` bytes each
```

### 4.2 Set List block

A 40-byte name/header record (same idea as SDB1's, more padding before the
first song), then 128 song records on a **542-byte stride**.

### 4.3 Song record layout (offsets relative to record start)

Confirmed by diffing `setlist_test.PCG`/`setlist_test_2.PCG`, in which the
project owner set up groups of 4-6 near-identical slots each varying
**exactly one** parameter and told us the exact values used:

| Offset | Field | Encoding | Confirmed via |
|---|---|---|---|
| +12 | Type + Color | `byte = 4*(color-1) + type`; bit0 = type (1=Program, 0=Combi), remaining bits = 1-based color | Color values `1,2,4,16` -> byte `1,5,13,61`, exact match |
| +13 | Bank | raw bank index | see §5 |
| +14 | Number | program/combi number within that bank (0-127) | see §5 |
| +15 | Hold Time | `byte = HoldTime + 1` | Values `1,2,3,5` -> byte `2,3,4,6`, exact match. Default/baseline byte value 6 => default Hold Time is 5. |
| +16 | Volume | raw 0-127, MIDI-style, no transform | Values `0,1,80,127` matched exactly. Default/baseline is 127. |
| +17 | *(reserved)* | **unknown** | -- |
| +18.. | Comment | free ASCII text, can contain literal `\r\n`; NUL-terminated (not `\r\n`-terminated) | Multiple test comments matched exactly, incl. multi-line ones |

### 4.4 Font size and Transpose — NOT solved

Tested with real values, neither fits a clean pattern:

- **Font size** (values `1,2,4,5` tested): byte-region values seen were
  `0x41, 0x01, 0xc1, 0x01`. Two of the four are just the Color-formula
  *baseline* (`0x01`), the other two imply color=17/49 via that same
  formula -- both implausibly large versus Color's own observed max of 16.
  Most likely Font size isn't in that byte region at all, and the changes
  seen were an unrelated side effect. Real location: **unknown**.
- **Transpose** (values `0,-1,+1,+24,-12,+12` tested across two rounds):
  non-baseline bytes appeared at *different offsets* depending on the
  value (e.g. `-1` at byte+13 relative offset showing `0xe0`, `+1` showing
  `0x20` four bytes later, `+24` back at the earlier offset as `0x60`).
  Inconsistent with one fixed-position signed field. One partial fit:
  `byte(+16-ish) = (transpose * 32) mod 256` matched for small values
  (0, +1) but is ambiguous for larger ones (+12 and -12 collide on the
  same byte value under that formula, meaning sign must be carried
  elsewhere -- unresolved). Needs a cleaner, wider-spread test.

## 5. Instrument-name cross-reference — CONFIRMED

An SDB1 song name is just a label -- it can be (and often is) edited
independently of the actual Program/Combi it points to. The *real*
instrument banks are top-level siblings of `SLS1` inside `PCG1` (found by
scanning the whole file's top level, not just inside `SLS1`).

`CBK1` (Combi) and `MBK1`/`PBK1` (Program) banks all share **one record
shape**:

```
offset  field                     Combi value   Program value
0       u32be count (unknown)     varies        varies
4       u32be numRecords          128           128
8       u32be bytesPerRecord      7810          4960
12..    `numRecords` records, `bytesPerRecord` bytes each
```

Each record's name is a **fixed 24-byte field starting 4 bytes into the
record** -- space/NUL-padded, but **not NUL-terminated**: a full-length
24-character name has no terminator at all, so trailing NUL/space must be
trimmed rather than scanned-for. `parseNamedBanks()` in `PcgFile.cpp`
handles both bank types uniformly; a slot's `bank`/`number` (from SBK1,
§4.3) directly index `[bank][number]` into whichever list matches its
type. Whether a bank is tagged `MBK1` or `PBK1` turned out to be
irrelevant to name lookup -- just two tag values for the identical record
shape (unknown what the tag distinction itself actually signifies).

### 5.1 Combi banks (`CMB1 > CBK1`) -- 14 banks

Bank order (file order == this list, **CONFIRMED**):

```
0  INT-A     4  INT-E      8  USER-B    12  USER-F
1  INT-B     5  INT-F      9  USER-C    13  USER-G
2  INT-C     6  INT-G     10  USER-D
3  INT-D     7  USER-A    11  USER-E
```

### 5.2 Program banks (`PRG1 > MBK1`/`PBK1`) -- 20 banks

Bank order (file order == this list, **assumed** -- the lookup mechanism
itself is confirmed, see below, but the specific label shown per index has
not been independently verified the same rigorous way Combi's was):

```
0  INT-A     5  INT-F      10  USER-C    15  USER-BB
1  INT-B     6  INT-G      11  USER-D    16  USER-CC
2  INT-C     7  G(d)       12  USER-E    17  USER-DD
3  INT-D     8  USER-A     13  USER-F    18  USER-EE
4  INT-E     9  USER-B     14  USER-AA   19  USER-FF
```

Note `GM` itself is *not* one of these 20 stored banks -- bank values
`>=20` seen in real slot data don't correspond to anything stored per-file
(see §5.4), consistent with `GM` being fixed MIDI-spec content Korg
doesn't need to store, rather than the 21st item in this list.

### 5.3 Verification anchors (ground truth given directly, not guessed)

| Anchor | Type | Location found | Result |
|---|---|---|---|
| "Rolling in the Deep" | Combi | bank 7 (USER-A) / record 9 | Exact match -- Set List slot name, Combi name, and the project owner's own stated bank/number all agree |
| "Berlin Grand SW2 U.C." | Program | PRG1 bank 0 / record 0 | Exact match |
| "Rain Again" | Program | PRG1 bank 0 / record 127 | Exact match |
| "Subdivisions", "Perfect Kiss", "Sirius" | Program | PRG1 bank 0 / records 90, 91, 92 (consecutive) | Exact match -- confirmed Program uses the identical record layout/mechanism as Combi |
| "KARMA INTERNAL COMBI" | Combi | banks 7 & 8, several records | Matched a real (placeholder/default) Combi name -- confirms those banks parse correctly, though this specific name recurs as a generic default, not a unique identifier |
| "Dont stop believin" | Combi | bank 7 / record 4 | Exact match |

Across a full pass of a real-ish test file (`setlist_test_2.PCG`), 143 of
152 assigned slots resolved to a name; all 9 misses had a bank value
outside the stored range (§5.4) -- **zero** in-range lookups failed.

### 5.4 Bank values outside the stored range

Program bank values `>=20` and Combi bank values `>=14` seen in real slot
data don't correspond to any stored bank (there are only 20/14
respectively). These are near-certainly `GM`/`GM2` references (fixed
content per the MIDI spec, not stored per-file) rather than a parsing
bug. A one-off bank-231 (Combi) and bank-192 (Program) reference were also
seen once each in real data -- more likely genuine data corruption/an
edge case in that one specific slot than anything this parser mishandles.
All out-of-range cases are left showing a raw `bank-number` rather than a
guessed label, both for the name (empty, degrading gracefully) and the
UI's bank label.

## 6. Open questions (consolidated)

1. The 4-byte prefix field preceding every chunk header, throughout the
   whole format (§1.2) -- a running byte offset? An index? Untested.
2. What the `used`/`count` header field (present in SDB1, SBK1, CBK1,
   MBK1, PBK1 alike) actually counts.
3. Font size and Transpose encodings in an SBK1 record (§4.4).
4. The reserved byte at SBK1 record offset +17 (§4.3).
5. Exactly which of the 20 PRG1 banks maps to which *display label* --
   the lookup mechanism itself is confirmed (§5.3); the specific label
   order (§5.2) is a positional assumption pending further verification.
6. `DKT1` (Drum Kits), `WSQ1` (Wave Sequences), `GLB1`, `DPI1` -- entirely
   unexplored. Unknown whether Set List slots can reference these
   directly (if so, the instrument-name lookup has a gap there too).
7. The older SoundQuest `.SQS` backup dialect (`LIST`/`FORM`/`BANK`
   wrapping, seen in some third-party backup tools) is structurally
   different from the `KORG`/`PCG1` dialect this document/parser covers --
   never tested against it, likely needs its own separate reverse-
   engineering pass if ever needed.
8. Reported (not yet reproduced): leading spaces disappearing from
   Comment text somewhere in a round-trip through the app. Neither the
   read nor write path does any trimming in code, so the cause -- if
   real -- isn't obvious from inspection alone.

## 7. Where this is implemented

- `src/kronos/PcgFile.{h,cpp}` -- the parser itself: chunk-tag scanning,
  SDB1/SBK1/CBK1/MBK1/PBK1 record parsing, the instrument-name
  cross-reference.
- `src/bridge/EditorBridge.{h,cpp}` -- exposes parsed data (and in-memory
  edits: move/copy/comment) to the web UI.
- See the top-level `README.md` for how to build/run the app, and
  `STATE.md` for current project status and the same open questions in
  project-planning form.
