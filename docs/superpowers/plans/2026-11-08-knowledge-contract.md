# Knowledge content contract implementation plan

> Execute inline for website issue #103. Design basis: the approved case-answer redesign and its append-only revision rules. No knowledge content production or live publication.

1. Add synthetic contract tests for four record kinds, bilingual revisions, unknown values, exact references, updates, withdrawal and immutable history. Run them red before implementation.
2. Add a typed, strict JSON contract and a pure bundle validator under `src/lib/knowledge/`. Keep shared factual metadata outside translated prose; hash the complete bilingual revision. Preserve all prior revisions and monotonic withdrawal records. Return path-specific errors. No kg/app changes.
3. Add an offline JSON validation CLI and `knowledge:test` in normal verification. Document directory layout, IDs, hash algorithm, trust boundaries and downstream responsibilities. Verify focused tests, `pnpm check`, public-file gate and final diff.
4. Obtain independent branch review, resolve findings, push a PR with `Closes #103`; self-merge if checks pass and no hold. Report the goal step and local status. No production release in this item.

Review focus: duplicate IDs/revisions; dangling or wrong-kind references; changed/deleted history including tombstones; bilingual factual drift; capability progress without comparable before/after evidence; unsafe strings and unknown schema keys.
