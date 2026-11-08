# Knowledge publication contract v1

This is the website-owned contract for issue [#103](https://github.com/feyn-machines/surviagi/issues/103). It defines publication inputs, not capability facts or permission to publish. It does not extend the `kg` ontology, reuse private `app.questions`, or make merging a content PR equivalent to verification. The authoritative executable definition and exported TypeScript types are in `src/lib/knowledge/contract.ts`.

## Identity, language and lifecycle

IDs are `knowledge:<kind>:<slug>` with `question`, `case`, `answer`, or `update`, and a lowercase ASCII hyphenated slug. A stable ID identifies an entity, never a language or content version. References always contain both `id` and `revision`; bare IDs cannot silently follow a newer answer.

A revision contains exactly `id`, `revision`, `kind`, `date` (real `YYYY-MM-DD` calendar date), `text`, and `facts`. `text` contains exactly `en` and `zh-CN`, each with nonempty `title` and `body` (inert Markdown). Both languages ship together. Language-independent facts, dates, conditions, checks and exact references live once in `facts`, and are included in the same revision hash as both bodies. The body presents the complete localized explanation; shared descriptive metadata retains the contributor's canonical wording. Translators must preserve its meaning in each body. A machine validates structure and shared references, **not translation fidelity, truth or sufficiency of evidence**. Those remain content-review duties.

Draft and pending-review files are not valid publication revisions. The import adapter must select only the explicit formal content tree, not Issue comments or arbitrary working files. A head selects the current formal revision; superseded revisions remain in the bundle. One answer entity per question supplies its current answer through that answer entity's head. No answer means “awaiting investigation”; do not invent one. Changing the task beyond comparability creates a new question ID. References to question revisions preserve historical scope.

`revisionHash(revision)` excludes only the top-level `revision` field. Canonical JSON v1 recursively sorts object keys by JavaScript UTF-16 code-unit order, preserves array order and Unicode strings without normalization, and uses JSON serialization for finite numbers, booleans and null. Hash UTF-8 bytes with SHA-256; encode as `sha256:<64 lowercase hex>`. Both languages and all facts therefore change the revision. Non-JSON values are rejected. This hash is separate from the knowledge Git SHA, website integration commit and release/index hashes (the fixed-version importer owns those).

## Formal directory layout and normalized bundle

The independent knowledge repository uses these literal directories:

```text
questions/<slug>/head.json
questions/<slug>/revisions/<64-hex>/record.json
cases/<slug>/head.json
cases/<slug>/revisions/<64-hex>/record.json
answers/<slug>/head.json
answers/<slug>/revisions/<64-hex>/record.json
updates/<slug>/head.json
updates/<slug>/revisions/<64-hex>/record.json
withdrawals.json
```

Each `record.json` is one complete bilingual revision. `<64-hex>` is the revision hash without `sha256:`. `head.json` contains exactly `id` and `head` (the full hash). `withdrawals.json` is the array described below. The website's later import adapter must enforce path/ID/hash correspondence, strict JSON, file allowlists, size budgets and no symlinks/path traversal before assembling the normalized bundle. This item provides the in-memory contract and offline bundle CLI, not a Git fetcher or directory importer.

A normalized bundle contains exactly:

- `contractVersion`: `"1.0.0"`.
- `records`: entities `{ id, head, revisions }`; each revision belongs to its entity and kind. Duplicate IDs/revisions and unknown heads fail validation.
- `withdrawals`: append-only entries `{ target: { id, revision }, date, reason }`, each referencing an existing exact revision. Reasons are public-safe summaries. Withdrawing an entire entity requires enumerating its retained revisions; future affected revisions must also be considered by the importer/runtime withdrawal policy.

Every accepted bundle retains all previously published entities and revisions, including withdrawn ones. Always pass the last accepted bundle for incremental integration:

```sh
pnpm knowledge:check candidate.json --previous accepted.json
pnpm knowledge:test
```

Without `--previous`, the CLI explicitly reports initial-publication validation only; a self-consistent rewritten history cannot be detected without a trusted baseline. The validator rejects removed entities/revisions, hash changes, same-hash rewrites and removed/changed withdrawal entries. New revisions and head changes do not mutate old content. The baseline must come from the accepted website knowledge version, never an untrusted candidate's own claim. Changing the contract version needs an explicit website migration.

## Required facts by kind

All fields below are required; empty lists express an explicitly empty set. `unknown(T)` means `{ value: T | null, unknownReason: string | null }`: null requires a nonempty reason; a known value requires a null reason. Observed zero stays zero. Dates in unknown wrappers use the same calendar-date rules. No omitted fields stand for “none”.

### Question

`direction`, `work`, `context`, `deliverable`, nonempty `boundaries`, and `issue`. The Issue is a public `https://github.com/feyn-machines/surviagi-knowledge/issues/<number>` discussion. Directions are descriptive IDs, not a new ontology or automatic empty navigation categories. The localized bodies describe the question, intended use, acceptance requirements and boundaries.

### Case

A case represents one identifiable attempt or one explicit external report, including a failure. It requires:

| Field | Required contents |
| --- | --- |
| `question` | Exact question revision |
| `inputs` | `materials`, `quantity: unknown(number)`, `availability`, `missing[]`, `rights` |
| `goal` | `deliverable`, `purpose`, nonempty `criteria[]`, `checker`, `method` |
| `method` | Nonempty `tools[{name, version: unknown(string)}]`, `execution`, nonempty `steps[]`, `promptsOrCode: unknown(string)` |
| `environment` | `software[]`, `hardware: unknown(string)`, `permissions[]`, `network: unknown(string)` |
| `human` | `preparation`, `guidance`, `selection`, `modification`, `acceptance`: each `unknown(string)`; unknown never means zero human effort |
| `result` | `artifacts[{url, description, rights}]`, `summary`, nonempty `checks[{criterion, outcome, detail, report}]`, `failures[]`, `untested[]`, `attempts: unknown(number)`, `selection: unknown(string)` |
| `cost` | `durationSeconds: unknown(number)`, `amount: unknown(number)`, `currency: unknown(string)`, `scope` |
| `sources` | Nonempty `[{author, url, published: unknown(date), attempted: unknown(date), collected: date}]`; publication, attempt and collection dates remain distinct |
| `verification` | Separate `claims`, `artifactChecks`, `reproductions` lists, described below |
| `conditions` | Nonempty applicable-condition descriptions |

All numbers are finite and nonnegative. Check outcomes are `pass`, `fail`, `partial`, `not_tested`, `unknown`; `report` is an HTTPS URL or null. Each acceptance criterion must be accounted for in checks or explicitly described as untested in content review; matching prose semantically is not automated.

`verification.claims` is nonempty `[{actor, statement, report, date}]` and states who claims what. `artifactChecks` is `[{actor, date, scope, report}]`. `reproductions` is `[{actor, date, scope, report, independent: unknown(boolean), outcome}]`, where outcome is `success`, `partial`, `failure` or `unknown`. The latter two lists may be empty. None is a ladder, score or single “verified” badge. Report URLs do not prove checking took place; inspection of a rendering cannot prove dimensions or editable topology. Independent reproduction is recorded explicitly, never inferred from account count or a merged PR.

### Answer

`question`, nonempty `cases[]`, nonempty `judgments[{statement, evidence[]}]`, nonempty `conditions[]`, `canDo[]`, `cannotDo[]`, `unknown[]`, `methods[]`, `disputes[]`, `gaps[]`, nonempty `authors[]`, and nonempty `reviews[{actor, date, scope, report}]`. Every critical judgment must reference specific exact cases included in the answer. Cases must concern the same question ID. Conflicts and negative cases remain visible; a review record does not imply human or professional validation. Record the reviewer's identity/nature and scope honestly in the body/report. Each language's body supplies the concise conclusion and full synthesis, limitations, methods, disputes and gaps.

### Update

`question`, `answer` (exact revision), nonempty `cases[]`, `nature`, `occurred: unknown(date)`, `change`, and `comparison` (object or null). Cases must concern that question and belong to the exact answer's evidence.

Nature is one of `new_evidence`, `capability_progress`, `scope_expansion`, `failure`, `correction`, `withdrawal`, `new_case`, `unverified`, `backfill`, `translation`, `format`. Backfill, translation and formatting are explicitly distinct from progress and should not rise in “latest substantive changes”. Occurrence time remains distinct from revision/update publication date.

`capability_progress` and `scope_expansion` require `comparison: { before, task, conditions, requirements, checks, support }`. `before` is a different exact answer revision for the same question; the update's answer is “after”. Nonempty descriptions record task comparability, conditions, output requirements and checking method; `support` is a nonempty set of exact cases from the update. Other natures require `comparison: null`. Content review must decide whether the stated comparison and new evidence actually justify a progress claim; a validator cannot establish that from text.

## Withdrawal and trust boundaries

Withdrawals retain history, take precedence over heads, and propagate through exact revision references. A current head depending directly or indirectly on withdrawn content fails publication validation unless it is also explicitly withdrawn or replaced with a corrected revision that removes the bad dependency. Historical revisions may keep those edges; the runtime must hide affected bodies/summaries on historical reads as well. A correction can remove a bad case without erasing the old answer. Search uses current formal heads only, subject to withdrawal filtering.

The independent **website-owned shared withdrawal baseline** and fail-closed runtime behavior are a separate importer/release task: it must survive website rollbacks, recompute dependency closure for each candidate, and apply before every HTML/Markdown/Agent response. The content repository's withdrawal list cannot authorize reversal of that baseline. This validator alone does not hide an already deployed page or erase Git history. A head change cannot undo a tombstone. Removing an invalid source from future conclusions requires a new reviewed revision.

Only inert Markdown and credential-free absolute HTTPS links are accepted. Raw HTML, embeds/images, reference-style links, local/relative links, executable URL schemes and extra fields such as remote includes fail validation. First-version assets are external links with explicit rights; future controlled rendering needs its own allowlist. This syntax gate does not replace escaping/sanitization in the eventual renderer, URL/resource policies or content review. Importers must not execute knowledge-repository scripts, hooks, generators or package installs. The CLI reads only local regular JSON files (16 MiB maximum each); it never fetches links or runs models, crawls, content experiments, database writes or publication.

The contract tests use visibly synthetic, original descriptions constructed in test code; they are not real samples and must never be indexed or presented as capability evidence.
