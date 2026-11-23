[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Gabutppi/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Gabutppi/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

# mend — one patch tool for every AI edit format

`mend` is a Node 22 command-line tool that applies AI-written edits to a
tree of text files, all or nothing. It reads a patch in one of four formats
and applies it exactly as SPEC.md (v1) of the
[hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
bounty defines:

- **Unified diffs** — with wrong line numbers (the hunk takes the occurrence
  nearest to its stated position), renames, creations, deletions, and
  `\ No newline at end of file` handling.
- **SEARCH/REPLACE blocks** — `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`,
  with the path taken from the nearest non-blank line above the block.
- **V4A patches** — `*** Begin Patch` / `*** End Patch`, with Add / Delete /
  Update sections, `*** Move to:`, `@@` anchors, a cursor, and
  `*** End of File` chunks.
- **JSON tool calls** — one JSON array of edit objects, or one edit object
  per line (`create`, `str_replace`, `insert`).

Matching is three-tiered (exact, then trailing whitespace ignored, then
leading and trailing whitespace ignored, with re-indentation at tier 2),
unless `--strict` limits it to exact matches.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` absent or `-` reads the patch from stdin.
- `--format` is `auto` (default), `unified`, `search-replace`, `v4a`, or `json`.
- `--check` reports what would change without writing anything.
- `--strict` matches tier 0 (exact) only.

Exit codes: `0` changed (or would change, with `--check`), `1` one or more
edits failed (nothing written), `2` usage / no patch / format / parse error.

## Results

- **100 of 100 practice checks pass** (practice score 1000), run twice with
  identical results (deterministic). The kit starter scores 24 of 100 (240)
  on the same set.
- 73 additional hand-written edge-case tests (CLI usage errors, format
  detection, unified/V4A/JSON corners, atomicity, output ordering) all pass.

Node 22, standard library only, nothing installed. `runner.ts` is the kit's
trial runner, kept as shipped.
