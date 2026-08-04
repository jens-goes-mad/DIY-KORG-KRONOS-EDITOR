# External references (community/vendor documents)

Distinct from `docs/references/` (independent *reverse-engineering* projects): these are
community/vendor-authored documents about how the Kronos itself behaves, found while
researching the physical-bank-placement question raised on the
`explore/sqlite-patch-datastore` branch (see `STATE.md`'s "EXPLORATION" section). Kept
here for stability (the source pages can move or disappear) and so the reasoning behind
that exploration doesn't live only in chat history.

## Korg-Kronos-Parameter-Guide-Program-Bank-Types-excerpt.txt

- **Origin**: official Korg documentation -- the **KRONOS Parameter Guide**
  (`KRONOS_Param_Guide_E11.pdf`, page 17-18, "Program Bank Contents" section),
  fetched 2026-08-02. This is a text excerpt, not the full ~20MB/1187-page manual, kept
  lightweight in git on purpose.
- **Why it matters here**: this is Korg's own official confirmation, the strongest kind
  of source this project uses -- directly states "Banks can contain either HD-1 Programs
  or EXi Programs, but not both" (validating `ProgramBankType` below), and goes further
  than anything else found here: a factory-default table naming the *specific* engine per
  bank (INT-D=AL-1, INT-E=AL-1 and CX-3, INT-F=STR-1, USER-A=MS-20EX & PolysixEX,
  USER-B=MOD-7, etc.) -- real ground truth for a future finer-grained-than-HD-1/EXi
  classification, not built yet (see the file's own closing notes for what's reconciled
  vs. still open).
- **Caveat**: explicitly the *factory default* layout -- the same manual confirms bank
  type (and by extension real-world bank contents) is user-reconfigurable per bank via
  Global mode, and the Synthify community document below independently confirms real
  long-used units routinely drift from this layout. A strong default/fallback label set,
  not a guarantee for any specific real file.

## Korg-Kronos-Parameter-Guide-Category-excerpt.txt

- **Origin**: official Korg documentation -- the **KRONOS Parameter Guide**
  (`KRONOS_Param_Guide_E11.pdf`, page 18 "Category" + page 811 "Global P3: Category
  Name"), fetched 2026-08-03.
- **Why it matters here**: found while researching what's known about Category (a
  per-Program/Combi attribute for browsing sounds by type -- Keyboard, Bass, Strings,
  etc. -- independent of bank/number). Turns out to be the SAME shape of problem as
  Bank type: a small per-record index (Main Category 0-17, Sub Category 0-7, separate
  tables for Programs vs. Combis) whose *name* comes from a per-unit-customizable table
  in Global settings ("you can change the names of any of the categories... including
  BOTH the factory and user categories") -- directly relevant to what has to be
  checked/reassigned when moving a Program or Combi between two different datasets
  whose category tables don't match.
- **Not yet located in raw bytes at all**: unlike Bank type, no byte offset for
  Category/Sub-Category is known in either a Program or Combi record -- not in this
  project's own findings, not in the Synthify PCG File Structures spreadsheet, not in
  DaBlick's reverse-engineering notes. Same status as `GLB1` overall (see
  docs/README.md's chunk tree): entirely unexplored. Two concrete, not-yet-started
  follow-ups this points at: locating Category's byte offset per record (needs the same
  purpose-built test file approach used for Font size/Transpose/Combi Timbre refs), and
  parsing `GLB1` itself, at minimum enough to extract the category name tables.

## Synthify-Process-for-loading-Kronos-programs-with-no-free-banks-2021.pdf

- **Origin**: [synthify.com/Kronos_SW_dev](https://www.synthify.com/Kronos_SW_dev/),
  "Process for integrating new programs into a Kronos with no available program banks
  (2021)", fetched 2026-08-02.
- **Why it matters here**: an independent, real-world confirmation of the exact
  physical-placement problem this project's own "patch manager" exploration ran into --
  a Program can only be loaded into a bank of the matching type (HD-1 vs EXi), and moving
  a Program to a new bank/number requires re-mapping every Combi Timbre reference to it
  (the document walks through doing this by hand with the third-party PCGtools). Confirms
  the constraint is real and already a lived pain point for Kronos owners, not just a
  theoretical concern.

## Synthify-Kronos-PCG-File-Structures.xlsx

- **Origin**: [synthify.com/Kronos_SW_dev](https://www.synthify.com/Kronos_SW_dev/),
  "Overview of PCG File Format (based on examination of Kronos PCG files from OS 2.1) --
  Partial information, not guaranteed correct! (April 2014)", fetched 2026-08-02.
- **Why it matters here**: gives the mechanism behind HD-1 vs EXi bank typing --
  an HD-1 Program record is 4960 bytes total (independently matching this project's own
  already-confirmed stride, e.g. `findDuplicatePrograms()` hashing ~12.7MB across ~2560
  records), while an EXi Program record is a different, smaller 3706 bytes. Combined with
  `docs/references/PCG-Structure-Kronos-DaBlick.txt`'s existing `MBK1`=EXi / `PBK1`=HD-1
  chunk-tag note, this gives two independent, already-parsed signals for bank type --
  see `src/kronos/ProgramDecoder.h`'s `classifyProgramBankType()`.
- **Caveat, in the source's own words**: "Note: The value used in the PCG is not the
  correct PBK (HD-1) program size. Either ignore this value, or pad the HD-1 structure to
  be the same size as Exi" -- i.e. don't hardcode either byte count as authoritative;
  always trust the file's own declared per-bank stride (which this project's parser
  already does), and treat the 4960/3706 figures only as an expected-value cross-check.
- **Not yet verified against a real Kronos backup file**: the underlying model (a bank is
  either HD-1 or EXi, never mixed) is now officially confirmed -- see the Korg Parameter
  Guide excerpt above. What's still unverified is specifically this project's own
  *byte-level detection mechanism* (the `MBK1`/`PBK1` chunk tag, and the 4960/3706-byte
  stride figures) against real file bytes -- no `.PCG` file was available in the
  environment this was implemented in (real files are `.gitignore`'d and never
  committed). `classifyProgramBankType()` is covered by a synthetic unit test
  (`tests/pcg_file_test.cpp`) exercising both the match and mismatch cases mechanically,
  but re-verify the mechanism itself against a real backup's actual chunk tags/strides
  before relying on it for anything beyond its own unit test, per this project's usual
  "no guessing" standard.
