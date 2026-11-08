# Knowledge import implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task.

**Goal:** Deliver #104: pinned Git import, retained history, shared search and fail-closed withdrawals.

**Architecture:** Trusted website code reads only formal JSON Git blobs at a full commit SHA. A hash-bound artifact retains all revisions and reverse edges; request-scoped readers reload an independent shared withdrawal baseline and recompute closure over the candidate graph.

**Tech Stack:** TypeScript, Node.js built-ins, existing knowledge contract; no content code execution.

**Spec:** [Knowledge contract](../../development/knowledge-contract.md), issue #104.

## Global constraints

- Only website development; synthetic tests are not evidence or knowledge content.
- Never execute content scripts, follow latest main, or activate a candidate implicitly.
- Current heads only in search; exact historical reads retained; baseline errors close knowledge reads.
- No production deployment, shared-file initialization or schedule changes in this item.

## Review focus

- A rollback artifact must still apply current withdrawals.
- New candidate edges must propagate old withdrawal roots.
- A cache must match the exact requested SHA and pass integrity/contract checks.
- Malformed paths, symlinks, executable blobs and resource budgets must fail before parsing.
- Markdown is inert text with HTML escaping, without automatic URL interpretation.

## Task 1: controlled import and immutable artifact

- [ ] Add failing synthetic tests for formal layout, full SHA, history and corruption.
- [ ] Implement importer, artifact integrity, Git blob adapter and explicit CLI output.
- [ ] Run knowledge tests; verify unavailable source permits only verified same-SHA cache.

## Task 2: request-scoped shared reads

- [ ] Add failing tests for v2/v1, current search, language/filter handling, missing/corrupt baseline and transitive withdrawal including new candidate edges.
- [ ] Implement baseline validation and read/search with metadata, status-only withdrawal and safe text rendering.
- [ ] Run knowledge tests, full pnpm check and staged public-file gate.

## Task 3: review and delivery

- [ ] Document importer/runtime APIs and operational boundaries.
- [ ] Fresh independent branch review; fix substantive findings and rerun checks.
- [ ] Push, create Closes #104 PR, verify labels/checks, self-merge and report goal step.
