# CLAUDE.md

Durable, project-level guidance for AI-assisted work on this repo. For current status,
what's built, and open questions, read `STATE.md` first -- it's kept up to date and is
more detailed than this file. For the file format itself, `docs/README.md`.

## The core method: no guessing, ever

This entire project is a from-scratch reverse-engineering of an undocumented binary
format. The one rule that has made it work: **never present a byte offset, formula, or
field meaning as fact unless it's been checked against real ground truth** -- either data
the project owner gives directly (a known song/Program/Combi name, a purpose-built test
file with stated values), or independent cross-verification against an external source
(see `docs/references/`). Several early findings in this project turned out to be
misreadings of *other* fields' data (Font size was originally misattributed to the
Color-sweep test's own edge cases) -- caught and corrected because every claim got
checked, not assumed. When a hypothesis can't be verified yet, say so explicitly rather
than picking the most plausible-looking guess.

When you derive a new offset/formula, verify it by actually running the parser (a
standalone `clang++`-compiled smoke test against `PcgFile.cpp`, or a Python script
against the raw file) against real bytes -- not just by reasoning about hex dumps.

## Collaboration norms established over this project

- **Only commit/push when explicitly asked.** Building and verifying freely; committing
  is a separate, explicit step every time.
- **Small iterations are preferred** over big-bang changes, especially for new
  architecture (see the componentization/decoder work below) -- ship one small proven
  piece, confirm it in tests and real UI, then extend.
- **Don't build for hypothetical future needs.** An encoder/write-path only gets built
  once there's a concrete feature that needs it (see the decoder/encoder architecture
  below) -- e.g. `setlist-comment.js` has an encoder because Comment/Font-size editing
  is a real feature; a hypothetical Program-renaming encoder doesn't exist yet because
  nothing uses it yet.
- **Verify claims by actually running code**, not just by writing it and reading it back.
  This project's standard pattern: a throwaway smoke-test binary/script, run against real
  sample files, output inspected directly -- for both C++ and the frontend's pure codec
  functions (Node can run ES modules directly, or a quick CommonJS-adapted copy works
  around this environment's older Node version).
- **Keep the docs in sync by hand.** `docs/README.md` (the canonical file-format
  reference) and `docs/content/format/index.md` (its Hugo-site mirror) are two separate
  files with no automated sync -- update both together. Same for the Hugo Overview page
  (`docs/content/overview/_index.md`): keep its "what's confirmed" summary current after
  refactors or new findings, not just STATE.md.
- **Real Kronos data makes tests worth trusting.** Test fixtures (in JS component test
  harnesses, in C++ smoke tests) should be real bytes extracted from an actual backup
  file where possible, not invented data -- see `frontend/components/kronos/
  setlist-comment.test.html`'s fixture for the pattern.

## Current architecture direction (as of 2026-08-01)

Both frontend and backend are moving toward small, focused, independently-testable
decoder/encoder units instead of one big eager parse. Full rationale in
`docs/content/components/index.md` and the decision record in `STATE.md`'s
"ARCHITECTURE: DECODER/ENCODER REFACTOR" section. Short version:

- Frontend: `frontend/components/{kronos,generic}/*.js` -- each a pure codec
  (`decode`/`encode`, no DOM) plus a component (DOM only, operates on decoded state)
  plus a standalone `.test.html` harness (no native build, no CHOC, just a static file
  server). `setlist-comment.js` is the first one built this way.
- Backend (in progress): `PcgFile` is moving from eager full-file parsing (with raw
  bytes discarded after parsing) to retaining raw bytes as the one canonical copy, with
  small per-record decoders computing structure on demand. Sequencing: Program decoder
  first (read-only: table row + content hash for dedup), then Combi, then Set List slot,
  each proven out with tests and real UI before moving to the next. No encoders until a
  real write feature needs one.

This shape is explicitly not committed to being final -- revisit it if the Program
decoder doesn't feel right once it's built.
