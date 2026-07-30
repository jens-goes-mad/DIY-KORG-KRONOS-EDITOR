# External references

Third-party reverse-engineering notes kept here for stability (upstream files can move or
disappear) and to cross-check this project's own from-scratch findings against an
independent source. Nothing in this project's own parser (`src/kronos/PcgFile.cpp`) is
copied from these -- they're cross-references, not a source of implementation code.

## PCG-Structure-Kronos-DaBlick.txt

- **Origin**: [`DaBlick/PCG-Tools`](https://github.com/DaBlick/PCG-Tools), file
  `Documentation/PCG Structure Kronos.txt`, fetched 2026-07-30.
- **License**: the source repository is licensed [LGPL-3.0](https://github.com/DaBlick/PCG-Tools/blob/master/LICENSE).
- **Why it matters here**: an independent reverse-engineering of the same `.PCG` format,
  going deeper into areas this project hadn't reached yet (DIV1 header/bank-count table,
  MBK1=EXi vs PBK1=HD-1 bank typing, a possible third Set-List-slot type "Song" beyond
  Program/Combi, and -- most usefully -- the Combi Timbre record layout, including a
  status byte this project had only seen as an unexplained value before). Cross-checked
  against this project's own real Combi samples before trusting any of it; see
  `docs/README.md`'s Combi Timbre section for what was confirmed and what's still only
  this source's claim, not independently re-derived.
