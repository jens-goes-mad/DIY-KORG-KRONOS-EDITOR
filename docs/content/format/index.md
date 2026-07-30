---
title: The .PCG/.SNG File Format
links:
  - title: Reverse-engineering the Korg Kronos backup file format
    description: container/chunk layout, Set Lists, Programs, Combis, and Combi Timbre references
menu:
    main:
        weight: 2
        params:
            icon: book

toc: true
---
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
4       0x68                               Product ID (identifies "Kronos" specifically) -- assumed
5       0x00                               format flag: 00=PCG, 01=SNG (assumed) -- our real sample is a
                                            .PCG file and reads 0x00 here, consistent
6       0x02                               Main Version -- assumed
7       0x01-0x02 (varies by file)         Minor Version -- assumed
8       0x00-0x01 (varies by file)         checksum flag: 00=none, 01=checksum present -- assumed,
                                            location of any actual checksum not investigated
9-15    00 00 00 00 00 00 00               reserved, all-zero in every sample seen so far
```

Byte meanings above are **assumed**, not independently derived -- sourced
from an external reference ([`DaBlick/PCG-Tools`](https://github.com/DaBlick/PCG-Tools),
see §7) and cross-checked against this project's own real file's actual
byte values, which are consistent with every claim (including the format
flag reading 0x00 on a real `.PCG` file). Nothing downstream in this
parser depends on these fields yet.

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
`MBK1`, `PBK1`, `CMB1`, `CBK1`, `DKT1`, `WSQ1`, `GLB1`, `DPI1`, and
`DBK1`/`WBK1` (Drum Kit/Wave Sequence sub-banks, §7) and `INI1` (seen
once in the external reference, §7, purpose entirely unknown -- not
observed by this project directly yet).

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

## 6. Combi Timbre references — CONFIRMED (Program refs), status byte CONFIRMED

Each Combi record (`CMB1 > CBK1`, §5.1) has 16 Timbre slots, each optionally
referencing a Program. Confirmed by the project owner providing several
real Combis with known Timbre->Program assignments, and independently
cross-checked against a third-party reverse-engineering of this format
([DaBlick/PCG-Tools](https://github.com/DaBlick/PCG-Tools), see
[docs/references](https://github.com/jens-goes-mad/DIY-KORG-KRONOS-EDITOR/blob/main/docs/references/README.md)) --
both sources agree at every point they overlap.

### 6.1 Layout

16 fixed-size 188-byte blocks starting 4806 bytes into the Combi's own
record (i.e. `recordOffset + 4806 + timbreIndex * 188`), regardless of how
many Timbres are actually in use -- this stride does **not** vary with
content, an earlier "variable-length" theory was tested and disproven.
Each block's first 3 bytes:

```
offset  field
0       Program number (0-127), raw byte
1       raw bank code (see §6.2 -- NOT the same index space as §5.2's
        Program bank list; some other, absolute Kronos-internal numbering)
2       status byte -- top 3 bits ((byte >> 5) & 0x07): 0=Off, 1=Internal,
        3=External (MIDI), 4=Ex2 (expansion board). Lower 5 bits are a
        separate, unrelated field: the Timbre's own 0-based index (0..15),
        confirmed by watching it count up regardless of status.
```

**Off does not imply "no reference stored"**: a Timbre can hold a genuine,
non-zero Program number/bank while its status is Off (e.g. temporarily
disabled without clearing the assignment). The all-zero
number=0/bank=0/status=Off pattern seen on every genuinely-untouched
Timbre slot is a *separate* signal (`TimbreRef::isDefault` in
`PcgFile.h`) from the on/off status (`TimbreRef::status`) -- both are
tracked independently rather than collapsed into one flag, since anything
usage-counting-related (e.g. "is this Program safe to delete") should
probably still count an Off-but-referenced Timbre as a real reference.

### 6.2 Confirmed raw bank codes

```
0   INT-A       17  USER-A
1   INT-B       20  USER-D
2   INT-C       22  USER-F
3   INT-D       24  USER-AA
```

Every code above is a directly-verified byte value (from a real Combi
sample, the external reference, or both) -- not an extrapolation. That
said, the two clusters (`INT-A..D = 0..3`, `USER-A/D/F = 17/20/22`,
`USER-AA = 24` right after) strongly imply a contiguous
`INT-A..G = 0..6` / `USER-A..G = 17..23` scheme. Deliberately **not**
added to the lookup table (`kronos::timbreBankName()`) until each
individual code is confirmed the same rigorous way -- unknown codes
surface as a raw number in the UI rather than a guessed name.

### 6.3 A resolved "anomaly" (worth recording as a methodology note)

An early Combi sample ("061 Sledgehammer") appeared to contradict this
model: Timbre 3 and 4's raw bytes didn't match the Program numbers the
project owner recalled from memory, and Timbres 5-9 (which the project
owner believed were "active") read as all-zero/Off. Decoding the status
byte resolved this completely: Timbres 5-9 in that specific saved backup
are genuinely `Off` in the file (not a parsing gap -- the project owner's
recollection of that Combi's live state didn't match what was actually in
the saved backup), and Timbre 4's raw bytes (`number=85, bank=22`) decode
cleanly to `USER-F-085` once bank 22 was identified -- not the
`INT-A-093` recalled from memory. Both the external reference's own
independent test data and this project's byte-level analysis agree,
which is what settled it. Left in as an example of a "disagreement" that
turned out to be bad ground truth, not a model gap -- consistent with
this document's practice of recording what was *actually* resolved and
how, not just the final answer.

## 7. Notes from an external reference (not yet used by this parser)

[`docs/references/PCG-Structure-Kronos-DaBlick.txt`](https://github.com/jens-goes-mad/DIY-KORG-KRONOS-EDITOR/blob/main/docs/references/PCG-Structure-Kronos-DaBlick.txt)
(see [docs/references](https://github.com/jens-goes-mad/DIY-KORG-KRONOS-EDITOR/blob/main/docs/references/README.md)
for origin/license) goes further than this project has in a few areas.
Recorded here for later, even though nothing below is wired into
`PcgFile.cpp` yet:

- **`DIV1` chunk** (a `PCG1` sibling, right after the 16-byte file header):
  a table of counts/bitmasks for how many banks of each kind the file
  actually has (Program, Combi, Drum Kit, Wave Sequence, Global, DPI, Set
  List slots) -- this project currently discovers banks by scanning for
  chunk tags rather than reading this header, so it's an alternative
  (unused) source of the same information, not a gap in what currently
  works.
- **Program bank count discrepancy**: the external doc's `DIV1` example
  reads `21` Program banks, but this project has only ever found/parsed
  20 `MBK1`/`PBK1` chunks in real files (§5.2). Unresolved which is
  right -- possibly a 21st bank this project's chunk scan is missing
  entirely, or a quirk of that specific example file.
- **`MBK1` = EXi bank, `PBK1` = HD-1 bank**: the two Program bank tags
  this project already treats identically for name lookup (§5) turn out
  to signal which *sound engine* that bank's Programs use (EXi = the
  software synth engines like AL-1/MOD-7/etc., HD-1 = the PCM sample
  playback engine). Plausibly relevant to why some Combi Timbre blocks
  (§6) have visibly different internal parameter layouts from each other
  -- likely engine-dependent -- but not confirmed or acted on yet.
- **A possible third Set List slot type**: this project's SBK1 parsing
  (§4.3) reads a single bit (`isProgram`: 1=Program, 0=Combi). The
  external doc describes a byte with three possible values instead --
  `00=Combi, 01=Program, 02=Song` -- implying Set List slots might be able
  to reference a Song/sequence directly, which a single bit read could
  silently misclassify as a Combi. Not reproduced against a real file
  yet; worth a dedicated check before trusting `isProgram` on an
  otherwise-unusual slot. The same example also shows one further
  unexplained byte right after the slot's Type/Bank/Number fields
  (their notes just mark it `??`) -- not confirmed to be (or not be)
  this project's own reserved byte at SBK1 record offset +17 (§4.3),
  since the two documents don't use the same offset baseline.
- **`DKT1` (Drum Kits) / `WSQ1` (Wave Sequences)**: confirmed to contain
  `DBK1`/`WBK1` sub-bank chunks following the same
  count/numRecords/bytesPerRecord header shape as every other bank type
  in this format -- still entirely unparsed by this project (open
  question §8.6), but now known to at least share the familiar shape
  rather than being a total unknown. Unlike Programs/Combis' uniform
  128-slots-per-bank, the external doc's example shows **non-uniform**
  bank sizes here: Drum Kits split as 40 (Int) + 16 per USER letter
  (`000-039` Int, `040-055` U-A, ... up to `136-151` U-G, 152 total);
  Wave Sequences as 150 (Int) + 32 per USER letter (`000-149` Int,
  `150-181` U-A, ... up to `342-373` U-G). Doesn't affect this
  project's existing bank-scanning code either way -- it already reads
  each bank's own `numRecords` from its header rather than assuming 128
  -- just recorded since it's a real structural difference from every
  bank type parsed so far.
- **An `INI1` chunk tag**, seen once in the external doc's example
  (immediately after `GLB1`, before what looks like a second
  `SLS1`/`PRG1`/`MBK1`/`PBK1` sequence starting right after it) --
  purpose entirely unknown, not observed by this project's own chunk
  scan yet. Whether that apparent second Set-List/Program sequence is a
  real second copy of something (an `.SNG` "song snapshot" bundling its
  own referenced Set List/Programs alongside the main `.PCG` content,
  maybe?) or just how the source document orders its own notes isn't
  clear from the excerpt available -- flagged as a real "huh, what's
  that" rather than asserted as a confirmed structure.
- **An unresolved anomaly in the source itself**: its own test data shows
  a Timbre meant to reference `GM127` decoding to `number=126, bank=6`
  instead -- flagged by that document's own author as unexplained. Left
  unresolved there too; recorded here in case it becomes relevant once
  GM/bank-6 territory is explored further.

## 8. Open questions (consolidated)

1. The 4-byte prefix field preceding every chunk header, throughout the
   whole format (§1.2) -- a running byte offset? An index? Untested.
2. What the `used`/`count` header field (present in SDB1, SBK1, CBK1,
   MBK1, PBK1 alike) actually counts.
3. Font size and Transpose encodings in an SBK1 record (§4.4).
4. The reserved byte at SBK1 record offset +17 (§4.3).
5. Exactly which of the 20 PRG1 banks maps to which *display label* --
   the lookup mechanism itself is confirmed (§5.3); the specific label
   order (§5.2) is a positional assumption pending further verification.
6. `DKT1` (Drum Kits), `WSQ1` (Wave Sequences), `GLB1`, `DPI1`, and `INI1`
   (§7, tag observed once, never by this project directly) -- entirely
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
9. The remaining Combi Timbre bank codes (§6.2): `INT-E/F/G` and
   `USER-B/C/E/G` are strongly implied by the confirmed codes either side
   of them, but not independently verified the same rigorous way.
10. A possible third SBK1 slot type ("Song", §7) this project's single-bit
    `isProgram` read can't represent -- could be silently misclassifying
    some slots as Combis. Not reproduced yet.
11. Whether the external reference's `21`-Program-banks `DIV1` reading
    (§7) points at a real 21st bank this project's chunk scan is missing.
12. The file-header checksum flag (§1.1, byte offset 8) -- our real
    sample reads `0x01` ("checksum present" per the external reference),
    but where any such checksum would actually live, and over what range
    of bytes, hasn't been investigated at all.
13. The apparent second `SLS1`/`PRG1`/`MBK1`/`PBK1` sequence right after
    an `INI1` chunk in the external reference's example (§7) -- a real
    second copy of something, or an artifact of how that document's own
    notes are ordered? Not investigated against a real file.

## 9. Where this is implemented

- [`src/kronos/PcgFile.{h,cpp}`](https://github.com/jens-goes-mad/DIY-KORG-KRONOS-EDITOR/tree/main/src/kronos) --
  the parser itself: chunk-tag scanning, SDB1/SBK1/CBK1/MBK1/PBK1 record
  parsing, the instrument-name cross-reference.
- [`src/bridge/EditorBridge.{h,cpp}`](https://github.com/jens-goes-mad/DIY-KORG-KRONOS-EDITOR/tree/main/src/bridge) --
  exposes parsed data (and in-memory edits: move/copy/comment) to the web UI.
- See the top-level [`README.md`](https://github.com/jens-goes-mad/DIY-KORG-KRONOS-EDITOR/blob/main/README.md)
  for how to build/run the app, and
  [`STATE.md`](https://github.com/jens-goes-mad/DIY-KORG-KRONOS-EDITOR/blob/main/STATE.md)
  for current project status and the same open questions in project-planning form.
