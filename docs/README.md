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
from an external reference (`DaBlick/PCG-Tools`, see §7) and cross-checked
against this project's own real file's actual byte values, which are
consistent with every claim (including the format flag reading 0x00 on a
real `.PCG` file). Nothing downstream in this parser depends on these
fields yet.

### 1.2 Chunk framing — CONFIRMED (2026-08-08, revises an earlier wrong model)

After the file header, the rest of the file is a sequence of chunks, each
with a **fixed 12-byte header**:

```
[4-char tag][4-byte big-endian size][4-byte unknown field "dwX"][size bytes of content]
```

**Confirmed** via `docs/external/Synthify-Kronos-PCG-File-Structures.xlsx`
(fetched independently, see §9's external-references list), which
describes exactly this structure in its own words: "A Chunk has a header
consisting of three 4-byte sized objects... TAG1... size... dwX... Data".
Cross-checked against this project's own byte-level findings via two
*other* independently-fetched official/community documents
(`docs/external/KORG/SetList.txt` and `CombiAndSongTimbreSet.txt`, Korg's
own SysEx parameter documentation) -- every field offset in those documents
lines up exactly with this project's own confirmed on-disk offsets once
this 12-byte header (not the old 8-byte one) is accounted for.

This **revises an earlier, wrong model**: this project previously believed
an extra 4-byte field of unknown purpose *preceded* the tag, ambiguously
(sometimes present, sometimes not), requiring a chunk header to be searched
for at two candidate positions. That was backwards -- the unknown field
(`dwX`) isn't a prefix before the tag at all; it's the *third* word of a
fixed, unambiguous header, right after `size` and right before the content
starts. The old model's "try position 0, then position+4" logic happened
to self-correct the resulting drift often enough (especially for deep,
unscoped searches like finding `MBK1`/`PBK1` bank chunks anywhere in the
file) that it went unnoticed for a while -- but a strict top-to-bottom walk
of a file's *top-level* chunks (`PcgFile::topLevelChunkTags()`, added for
the Internals pane) drifted out of sync after the first nested chunk with
the old math, which is what surfaced this. `dwX`'s own meaning is still
**unknown** -- only its presence, fixed position, and fixed width are
confirmed.

All tags found so far are 4 characters, first an uppercase letter,
remaining three uppercase letters or digits (`[A-Z][A-Z0-9]{3}`) --
`KORG`, `PCG1`, `DIV1`, `SLS1`, `SLD1`, `SDB1`, `STL1`, `SBK1`, `PRG1`,
`MBK1`, `PBK1`, `CMB1`, `CBK1`, `DKT1`, `WSQ1`, `GLB1`, `DPI1`, and
`DBK1`/`WBK1` (Drum Kit/Wave Sequence sub-banks, §7) and `INI1` (seen
once in the external reference, §7, purpose entirely unknown -- not
observed by this project directly yet).

A container chunk's own declared `size` covers *all* of its content,
including any chunks nested inside it -- i.e. for a chunk that's itself a
parent of children, the children's own full sizes (their own 12-byte
header plus their own content, recursively) sum to exactly the parent's
declared size, with no gap and no overlap. This is what lets a strict,
non-recursive walk of one level (e.g. `topLevelChunkTags()`) skip cleanly
from one top-level chunk directly to the next sibling, and what lets a
deep, unscoped recursive search (`collectChunks()`) find a chunk regardless
of how many levels it's nested at. Verified end-to-end via a synthetic test
fixture built with a *real* nested hierarchy (`PCG1 > SLS1 > (SDB1, SBK1)`,
`PCG1 > PRG1 > (PBK1, MBK1)`, `PCG1 > CMB1 > (CBK1)`, matching §2 below) --
deliberately reverting the header-size fix while keeping that nested
fixture makes the whole file fail to load at all ("No SDB1 chunk found"),
confirming this isn't just a cosmetic offset difference but the mechanism
a nested walk actually depends on.

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

`PCG1` itself is a real, explicit chunk (its own 12-byte header, §1.2)
starting at byte 16, immediately after the 16-byte file header (§1.1) --
**not** implicitly consumed by that file header. Confirmed directly
against a real 36MB backup: `PCG1`'s own declared content size exactly
spans the rest of the file, and `DIV1`/`SLS1`/`PRG1`/`CMB1`/`GLB1` are its
direct children, one level inside its own content -- `topLevelChunkTags()`
(`PcgFile.cpp`) reads `PCG1` first and returns *its* children, not
whatever it finds naively starting at byte 16.

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

### 3.1 Header (8 bytes, at SDB1's content start) — CORRECTED 2026-08-08

```
offset  field                  sample value
0       u32be numSetlists      128       -- matches real hardware's 128 Set Lists
4       u32be bytesPerSetlist  3612      -- == 129 * 28
8..     `numSetlists` Set List blocks, `bytesPerSetlist` bytes each
```

**Was previously documented as a 12-byte header** with a leading `used`
field (sample value 344, "meaning unclear") before `numSetlists`. That
extra field never existed -- it was a misreading, caused by an unrelated
bug in this project's *chunk-level* header parsing (a 4-byte field, `dwX`,
that belongs to the chunk wrapper around SDB1, not to SDB1's own content --
see §1.2) that happened to shift every offset in this section by exactly
4 bytes in a way that canceled itself out end-to-end, so real Set List
names still decoded correctly despite the wrong field labels. Fixing the
chunk-level bug on its own (2026-08-08) broke this cancellation and
exposed the real, always-8-byte header underneath -- confirmed directly
against a real 36MB backup: `numSetlists`/`bytesPerSetlist` land exactly
where expected, and the whole 128-Set-List table (including all 5 real
user-named Set Lists in the exact confirmed order, §3.2) decodes correctly
with this header shape and no other. There are 4 bytes left over between
the last Set List block and the chunk's own declared end
(`bytesPerSetlist * numSetlists` is 4 bytes short of the chunk's full
content size) -- not yet understood, flagged rather than guessed at (see
open question list).

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
no songs assigned.

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

### 4.1 Header (same 8-byte shape as SDB1, see §3.1)

```
offset  field                  sample value
0       u32be numSetlists      128
4       u32be bytesPerSetlist  69,416  -- == 40 (header) + 128 * 542
8..     `numSetlists` Set List blocks, `bytesPerSetlist` bytes each
```

Previously documented as a 12-byte header with a leading `count` field
(347/470 seen across two files) -- same correction as §3.1, same cause
(canceled out against an unrelated chunk-level bug until 2026-08-08).
Confirmed directly against a real 36MB backup: `numSetlists`=128,
`bytesPerSetlist`=69,416 land exactly where expected with this 8-byte
shape, and all 128 Set Lists' worth of slot parameters (2,560 Programs /
1,792 Combis' worth of references, matching the real maximums exactly)
decode correctly.

### 4.2 Set List block

A 40-byte name/header record (same idea as SDB1's, more padding before the
first song), then 128 song records on a **542-byte stride**.

### 4.3 Song record layout (offsets relative to record start)

Confirmed by diffing `setlist_test.PCG`/`setlist_test_2.PCG`, in which the
project owner set up groups of 4-6 near-identical slots each varying
**exactly one** parameter and told us the exact values used:

| Offset | Field | Encoding | Confirmed via |
|---|---|---|---|
| +12 | Type + Color + Font size (low 2 bits) | bits 0-1 = Type (0=Combi, 1=Program, 2=Song); bits 2-5 = `4*(color-1)`, 1-based color (this byte's bits 0-5 only -- see §4.4 note); bits 6-7 = Font size's low 2 bits, see §4.4 | Color values `1,2,4,16` -> byte `1,5,13,61`, exact match. Type: **CORRECTED 2026-08-08** -- was documented (and coded) as a single bit (bit0 only, 1=Program/0=Combi); Korg's own SysEx documentation (`docs/external/KORG/SetList.txt`) confirms it's 2 bits, and this project's own code was accidentally still correct for Program-vs-Combi specifically (bit0 alone distinguishes those two), just not for Song (a slot this project has still never observed in a real file) and the unused value 3. |
| +13 | Bank + Transpose (high 3 bits) | bits 0-4 = raw bank index (see §5); bits 5-7 = Transpose's high 3 bits, see §4.4 | see §5 |
| +14 | Number | program/combi number within that bank (0-127) | see §5 |
| +15 | Hold Time | `byte = HoldTime + 1` | Values `1,2,3,5` -> byte `2,3,4,6`, exact match. Default/baseline byte value 6 => default Hold Time is 5. |
| +16 | Volume | raw 0-127, MIDI-style, no transform | Values `0,1,80,127` matched exactly. Default/baseline is 127. |
| +17 | Font size (high bit) + Transpose (low 3 bits) + Keyboard Track | bit 4 = Font size's high bit, see §4.4; bits 5-7 = Transpose's low 3 bits, see §4.4; bits 0-3 = Keyboard Track (track 1-16), per `docs/external/KORG/SetList.txt` -- not yet decoded anywhere in this app (nothing needs it yet). Bits 0-2 specifically still not independently isolated by this project's own test files. | see §4.4; Keyboard Track per Korg's own SysEx doc, 2026-08-08 |
| +18.. | Comment | free ASCII text, **512 bytes max** (confirmed 2026-08-08, was assumed to run to the record's own end, 524 bytes), can contain literal `\r\n`; NUL-terminated only if shorter than the full 512 bytes (a full-length comment has no terminator, same convention as this format's name fields) | Multiple test comments matched exactly, incl. multi-line ones; length cap per `docs/external/KORG/SetList.txt` |

Bits 6-7 of +12 and bit 4 of +17 (Font size), and bits 5-7 of +13 and +17
(Transpose), overlap with fields already documented above (Color, Bank) --
**always mask to the bits you actually own when reading or writing any of
these four fields**. Both this project's own earlier `setlist_test.PCG`
analysis and a naive full-byte read of Bank/Color would silently produce
wrong values on any real slot that also has a non-default Font size or
Transpose set (this is likely rare in practice on Combi/Program-type
slots, but not rare enough to ignore -- see docs' note on `PcgFile.cpp`'s
fix in the "Where this is implemented" section). Presumably Korg packed
fields this tightly because the format predates spare bytes being cheap
-- see the open questions list for what bit 3 and bits 0-2 of +17 might
still be doing.

### 4.4 Font size and Transpose — CONFIRMED

Both isolated and confirmed via a purpose-built test file (Set List 127,
slots 0-4 for Font size, slots 8-19 for Transpose -- confirmed to be
properly isolated this time, unlike the earlier Font size false start,
see below) with the project owner giving the exact real values used.
Both fields turn out to be a handful of bits packed across two otherwise-
unrelated bytes rather than living in one clean byte of their own.

**Font size** -- 3 bits, split across +12's top 2 bits and +17's bit 4:

```
value = ((byte17 >> 4) & 1) * 4 + ((byte12 >> 7) & 1) * 2 + ((byte12 >> 6) & 1) * 1
0 = S (the true baseline/default -- zero extra bits set)
1 = XS
2 = M
3 = L (== M's bit | XS's bit, i.e. both of the other two bits set)
4 = XL
```

**Transpose** -- a 6-bit two's-complement signed value (range -32..+31),
high 3 bits in +13's top 3 bits, low 3 bits in +17's top 3 bits:

```
unsigned6 = ((byte13 >> 5) & 0x7) << 3 | ((byte17 >> 5) & 0x7)
transpose = unsigned6 >= 32 ? unsigned6 - 64 : unsigned6
```

Verified against all 12 of the project owner's real test values
(`-24, -23, -12, -11, -10, -1, 0, 1, 11, 12, 13, 24`) -- every single one
round-trips exactly through this formula, no exceptions.

**Why the earlier attempt failed**: the original "Font size" observation
(`0x41, 0x01, 0xc1, 0x01`, recorded as unsolved) was never from isolated
Font-size-only slots at all -- confirmed with the project owner. Those
byte values are exactly the Color-sweep test's own edge-case slots
(colors 17, 1, 49, 1 -- byte `+12`'s bits 6-7 set to non-zero, which the
plain Color formula misreads as "colors beyond the documented 1-16
range" precisely because those bits are Font size's, not Color's). The
old Transpose partial fit (`byte(+16-ish) = (transpose*32) mod 256`,
matched only for small values) is also now explained: that's `+17`'s top
3 bits, the low half of the real 6-bit value -- it looked right for
small transpose values because the high 3 bits (in `+13`) happened to
still be 0 for those, and broke down for larger values because the high
half lives in a completely different byte.
  value (e.g. `-1` at byte+13 relative offset showing `0xe0`, `+1` showing
  `0x20` four bytes later, `+24` back at the earlier offset as `0x60`).
  Inconsistent with one fixed-position signed field. One partial fit:
  `byte(+16-ish) = (transpose * 32) mod 256` matched for small values
  (0, +1) but is ambiguous for larger ones (+12 and -12 collide on the
  same byte value under that formula, meaning sign must be carried
  elsewhere -- unresolved). Needs a cleaner, wider-spread test.

### 4.5 Color names — CONFIRMED

The `color` field (+12, bits 2-5, see §4.3) is 1-based, 1-16. Confirmed
against real Kronos hardware (2026-08-06, via `tools/
generate_setlist_test_matrix.{js,cpp}`'s Group 5, one real color written
to a Set List slot per value 1-16, checked by eye on the device) -- and
substantially different from this project's earlier working guess, which
used generic named colors ("Red"/"Blue"/"Black"/"White"...) in what turned
out to be the wrong order too. The real palette is Korg's own curated,
muted set -- none of the generic names exist at all:

| Value | Name | Hex (as read off the device) |
|---|---|---|
| 1 | Default | `#494c55` |
| 2 | Charcoal | `#282b31` |
| 3 | Brick | `#af4350` |
| 4 | Burgundy | `#661b27` |
| 5 | Ivy | `#929a33` |
| 6 | Olive | `#233519` |
| 7 | Gold | `#aa8c3e` |
| 8 | Cacao | `#723d3f` |
| 9 | Indigo | `#3759bf` |
| 10 | Navy | `#0410ab` |
| 11 | Rose | `#9478c7` |
| 12 | Lavender | `#745ad2` |
| 13 | Azure | `#5588c2` |
| 14 | Denim | `#385f9c` |
| 15 | Silver | `#546180` |
| 16 | Slate | `#2a3149` |

Hex values are the project owner's own on-screen reading, not a
pixel-sampled measurement -- close enough to use directly (this app's UI
brightens them a bit further for on-screen legibility, a purely cosmetic
display-time adjustment, see `frontend/pane.js`'s `brightenHex()`), but not
guaranteed pixel-perfect. **Open question, not yet investigated**: whether
this palette (names and/or hex) is identical across every Kronos hardware
variant/revision, or whether it differs by model (e.g. an original unit vs.
a limited/"silver edition" unit) -- confirmed so far only on the one unit
this project has access to.

## 5. Instrument-name cross-reference — CONFIRMED

An SDB1 song name is just a label -- it can be (and often is) edited
independently of the actual Program/Combi it points to. The *real*
instrument banks are top-level siblings of `SLS1` inside `PCG1` (found by
scanning the whole file's top level, not just inside `SLS1`).

`CBK1` (Combi) and `MBK1`/`PBK1` (Program) banks all share **one record
shape**:

```
offset  field                     Combi value   Program value
0       u32be numRecords          128           128
4       u32be bytesPerRecord      7810          4960
8..     `numRecords` records, `bytesPerRecord` bytes each
```

**Corrected 2026-08-08** (was previously documented as a 12-byte header
with a leading "count (unknown)" field) -- same fix, same cause, as
§3.1/§4.1's identical correction: the extra field never existed, it was a
misreading canceled out by an unrelated chunk-level bug until that bug was
fixed. Confirmed directly against a real 36MB backup with this 8-byte
shape: all 20 Program banks and all 14 Combi banks decode with
`numRecords`/`bytesPerRecord` exactly as expected, and the resulting
Program/Combi counts (2,560 / 1,792) exactly match the real physical
maximums (20×128 / 14×128). Same unexplained 4-byte gap as §3.1 between
the last record and the chunk's own declared end.

**Confirmed directly** (real Kronos hardware behavior we confirmed
2026-08-07, not derived from parsing): a bank is the
unit's atomic storage granularity -- its capacity is a fixed 128 slots,
and a bank is always either fully populated or entirely absent from a
given backup, never partially saved. This is why `numRecords` above reads
exactly 128 for every real Program/Combi bank this project has ever
parsed, rather than something that just happened to be 128 in the files
examined so far. It also sharpens what "a bank is missing from this
backup" can mean in practice -- see the Internals pane
(`docs/content/overview/_index.md`) and open question #13 below: the only
real absence a backup can have is a whole bank chunk missing entirely,
never a partial one.

Each record's name is a **fixed 24-byte field starting 4 bytes into the
record** -- space/NUL-padded, but **not NUL-terminated**: a full-length
24-character name has no terminator at all, so trailing NUL/space must be
trimmed rather than scanned-for. `parseNamedBanks()` in `PcgFile.cpp`
handles both bank types uniformly; a slot's `bank`/`number` (from SBK1,
§4.3) directly index `[bank][number]` into whichever list matches its
type. Whether a bank is tagged `MBK1` or `PBK1` turned out to be
irrelevant to name lookup -- just two tag values for the identical record
shape. The tag itself is understood (via an external reference, §7) to
signal which sound engine that bank's Programs use; see §5.2 below.

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

**Confirmed directly** (2026-08-07): which sound engine a
Program bank uses (HD-1 vs EXi, see §7's `MBK1`/`PBK1` note) is a *global,
per-bank* setting on the unit itself -- Programs within one bank can't
individually be assigned to different engines. Combined with the
whole-bank-or-nothing storage granularity noted above, this means a
Program bank chunk found in a file is always a complete, single-engine
128-slot unit; this project's own `ProgramBankType`
(`src/kronos/PcgFile.h`) is tracked per bank for exactly this reason,
never per record. (This confirms the *behavior* -- one engine per bank, no
partial banks -- not the specific `MBK1`=EXi/`PBK1`=HD-1 tag mapping
itself, which remains externally sourced only; see §7.)

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
(`DaBlick/PCG-Tools`, see `docs/references/README.md`) -- both sources
agree at every point they overlap.

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

These 8 codes are a *different number space* from this project's own PBK1
file-order Program bank index (`ProgramInfo::bank`) -- they coincide for
INT-A..D (both happen to use 0..3) but diverge for the other 4 (e.g.
USER-D is file-order index 11, but Timbre code 20). `PcgFile.cpp`'s
`kConfirmedTimbreBanks` table pairs each confirmed code with its file-order
index so Combi-usage counting (`combiUsagesForProgram()`/
`combiUsageCounts()`, backing the Programs table's `#CMB` column, the
Program usage panel, and Duplicates' per-copy reference counts) can
translate between the two and cover all 8 confirmed banks correctly, not
just the INT-A..D range where the numbers happen to match (fixed
2026-08-08 -- previously only INT-A..D actually fed into usage counting,
even though USER-A/D/F/AA's codes were already sitting right here,
confirmed but unused for that purpose).

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

`docs/references/PCG-Structure-Kronos-DaBlick.txt` (see
`docs/references/README.md` for origin/license) goes further than this
project has in a few areas. Recorded here for later, even though nothing
below is wired into `PcgFile.cpp` yet:

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
  -- likely engine-dependent -- but not confirmed or acted on yet. The
  underlying *behavior* this describes -- engine assignment is a global,
  per-bank setting, never mixed within a bank -- **is** independently
  confirmed directly (§5.2); only the specific claim that the `MBK1`/
  `PBK1` tag is what encodes it remains externally sourced only.
- **A possible third Set List slot type -- bit width CONFIRMED 2026-08-08,
  a real Song-type slot still not reproduced**: this project's SBK1
  parsing (§4.3) used to read a single bit (`isProgram`: 1=Program,
  0=Combi). This external doc's claim of a byte with three possible
  values (`00=Combi, 01=Program, 02=Song`) is now independently confirmed
  by a *second*, separate source -- Korg's own SysEx parameter
  documentation (`docs/external/KORG/SetList.txt`) -- and this project's
  own decoder has been corrected to match (§4.3). What's still open: no
  real file has been seen with a slot actually carrying type value 2, so
  whether Set List slots genuinely *can* reference a Song/sequence
  directly (vs. that value simply being reserved/unused in practice) isn't
  confirmed, just the bit layout that would represent it if it exists.
- **`DKT1` (Drum Kits) / `WSQ1` (Wave Sequences)**: confirmed to contain
  `DBK1`/`WBK1` sub-bank chunks following the same general
  numRecords/bytesPerRecord header shape as every other bank type in this
  format (§5's now-corrected 2-field, 8-byte version, not the original
  3-field guess -- see §5's own correction note; not independently
  re-verified for DKT1/WSQ1 specifically, but the pattern has now held for
  every other chunk type checked) -- still entirely unparsed by this
  project (open question §8.5), but now known to at least share the
  familiar shape rather than being a total unknown. Unlike Programs/Combis' uniform
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

1. **RESOLVED (2026-08-08), see §1.2**: the 4-byte field is not an
   ambiguous prefix *before* the tag -- it's a fixed 12-byte header's third
   word (`tag`, `size`, `dwX`), always right after `size` and right before
   content. Its own *meaning* is still a completely open question (a
   running byte offset? An index? Untested) -- only its position and
   fixed width are confirmed now, not what it contains.
2. **RESOLVED (2026-08-08)**: there is no separate `used`/`count` field --
   see §3.1/§4.1/§5's corrected header shapes. It was a misreading of an
   unrelated chunk-level field (`dwX`, open question #1) that bled into
   this project's understanding of SDB1/SBK1/PBK1/MBK1/CBK1's own content,
   caused by a bug in chunk-level parsing that happened to cancel out
   end-to-end until that bug was fixed on its own.
3. Byte +17's bits 0-2 (§4.3) -- **still open**, though bit 3 is now
   resolved (see §4.3: Keyboard Track, bits 3-0). Korg's own SysEx
   parameter documentation (`docs/external/KORG/SetList.txt`) plus a
   direct byte-level check confirm bits 3-0 of this byte are Keyboard
   Track (4 bits, `00~0F` = track 1-16) -- an exact bit-width match for
   what was flagged unexplained here, consistent with real files showing
   isolated non-zero values there independent of Font size/Transpose (e.g.
   `0x08`). Not yet wired into `SlotParams`/decoded anywhere in the app
   (nothing needs it yet), and the remaining bits 0-2 of this same byte are
   still genuinely unaccounted for.
4. Exactly which of the 20 PRG1 banks maps to which *display label* --
   the lookup mechanism itself is confirmed (§5.3); the specific label
   order (§5.2) is a positional assumption pending further verification.
   See #13 below for a more fundamental version of the same uncertainty.
5. `DKT1` (Drum Kits), `WSQ1` (Wave Sequences), `GLB1`, `DPI1`, and `INI1`
   (§7, tag observed once, never by this project directly) -- entirely
   unexplored. Unknown whether Set List slots can reference these
   directly (if so, the instrument-name lookup has a gap there too).
6. The older SoundQuest `.SQS` backup dialect (`LIST`/`FORM`/`BANK`
   wrapping, seen in some third-party backup tools) is structurally
   different from the `KORG`/`PCG1` dialect this document/parser covers --
   never tested against it, likely needs its own separate reverse-
   engineering pass if ever needed.
7. Reported (not yet reproduced): leading spaces disappearing from
   Comment text somewhere in a round-trip through the app. Neither the
   read nor write path does any trimming in code, so the cause -- if
   real -- isn't obvious from inspection alone.
8. The remaining Combi Timbre bank codes (§6.2): `INT-E/F/G` and
   `USER-B/C/E/G` are strongly implied by the confirmed codes either side
   of them, but not independently verified the same rigorous way.
9. **Bit layout RESOLVED (2026-08-08)**, real occurrence still unconfirmed:
   the third SBK1 slot type ("Song", §7) is now correctly readable (Type
   is 2 bits, not the 1 this project originally decoded) -- see §4.3. No
   real file has been seen with a Song-type slot yet, so whether this
   value actually occurs in practice remains open.
10. Whether the external reference's `21`-Program-banks `DIV1` reading
    (§7) points at a real 21st bank this project's chunk scan is missing.
11. The file-header checksum flag (§1.1, byte offset 8) -- our real
    sample reads `0x01` ("checksum present" per the external reference),
    but where any such checksum would actually live, and over what range
    of bytes, hasn't been investigated at all.
12. The apparent second `SLS1`/`PRG1`/`MBK1`/`PBK1` sequence right after
    an `INI1` chunk in the external reference's example (§7) -- a real
    second copy of something, or an artifact of how that document's own
    notes are ordered? Not investigated against a real file.
13. **A more fundamental version of #4, surfaced 2026-08-07**: every Program/
    Combi bank "index" this project uses anywhere is actually just that
    bank's *position* among however many PRG1/CBK1 sub-bank chunks were
    found in the file, in file order -- not a confirmed bank identity tied
    to anything in the bytes themselves. This has been silently correct so
    far only because every real file examined happened to contain a
    complete, canonically-ordered set of banks. If a real backup can omit
    banks (plausible -- Kronos backup tools appear to let you choose which
    data to include when saving), a file missing one bank would silently
    relabel every later bank as one position earlier than its real
    identity, with nothing in this project currently able to detect it.
    Each PRG1/CBK1 sub-bank chunk's own first 4 bytes (see #2's `used`/
    `count` field -- currently read and discarded, "meaning not understood
    yet") are a real candidate for a per-chunk identity field that would
    fix this properly. Not yet investigated with real test data that's
    actually missing a known bank.

## 9. Where this is implemented

- `src/kronos/PcgFile.{h,cpp}` -- the parser itself: chunk-tag scanning,
  SDB1/SBK1/CBK1/MBK1/PBK1 record parsing, the instrument-name
  cross-reference.
- `src/bridge/EditorBridge.{h,cpp}` -- exposes parsed data (and edits: Set
  List move/copy, Program copy, and Set List slot Comment/Color/Volume --
  the latter three via `getSongRecordBytes`/`putSongRecordBytes`, writing
  straight into the loaded file's own raw bytes) to the web UI, plus
  `saveFileAs()` to write a dataset's edited bytes back to a file
  (`PcgFile::save()`, a verbatim write of the retained buffer -- no Save UI
  wired up yet, see STATE.md).
- `tools/generate_setlist_test_matrix.{js,cpp}` -- hardware-validation
  helpers, not part of the shipped app: generate a matrix of Setlist
  Comment/Color/Volume/Font-size test permutations into a scratch file, for
  checking against a real Kronos by eye (see STATE.md's "First real
  save-to-disk piece" entry).
- See the top-level `README.md` for how to build/run the app, and
  `STATE.md` for current project status and the same open questions in
  project-planning form.
