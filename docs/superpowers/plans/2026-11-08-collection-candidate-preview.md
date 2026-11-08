# Collection candidate preview (#111, first increment)

The confirmed case-answer design calls for local selection before controlled publication. This increment implements selection, source deduplication and issue association without a network write. Contribution templates and licensing remain an external prerequisite for publication; this PR uses Refs #111 and does not close it.

## Design and choices

Reuse completed collection manifests from `editorial_inputs.verify_inputs` instead of querying or modifying PostgreSQL. An operator supplies concise candidate descriptions and a local GitHub issue snapshot. No model invents answers, no original post text is copied, and no scheduler is changed. The CLI has no publish command or subprocess/network dependency.

Exact normalized question titles associate existing open or closed issues; explicit issue numbers handle paraphrases. Ambiguous matches stop for operator choice. Candidate identity is the normalized question plus source IDs, independent of input ordering or collection window. Repeated source IDs across inputs collapse. Existing candidate markers in issue bodies suppress previously submitted candidates. Fuzzy automatic matching is rejected because it could silently merge different questions.

## Tasks

1. Write failing dependency-free tests for completed-input validation, filtering, ordering/idempotence, duplicate sources, exact/explicit/ambiguous issue association, previous markers, private output and raw-text exclusion.
2. Implement `scripts/knowledge_candidates.py`, with CLI `scripts/knowledge-candidates.py`; validate local input paths and fields, rehash collection inputs, whitelist output fields, write content-addressed preview under ignored `data/knowledge-candidates/previews/` with 0600/0700 modes.
3. Wire `pnpm knowledge:candidates` and tests into check/check:public. Document local selection format, read-only issue snapshot, manual review and remaining publication prerequisite.
4. Run focused tests and project checks; review outgoing diff and staged public-file gate. Deliver a partial PR, merge if verified and permitted, and record remaining #111 dependency.

## Validation focus

Tests use synthetic local collections, never real case conclusions. Check unsafe IDs, missing source IDs, symlinks, broad file permissions, malformed snapshot records, ambiguous/closed issue matches, changed pinned inputs and stable output across reruns. No database behavior changes in this increment.
