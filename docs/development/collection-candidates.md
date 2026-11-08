# Local collection candidate previews

`pnpm knowledge:candidates` prepares a private preview for #111. It does not write GitHub, call a model, query PostgreSQL, start collection or alter the twice-daily tasks. This is the first increment: controlled publication awaits the knowledge repository's contribution templates and content permission rules. A preview is unapproved operator prose, not a verified answer or a public-safe certification.

## Inputs

Use `pnpm editorial:inputs prepare --help` to pin completed official and panel collections from the same window. The preview reuses that manifest, validates it, rehashes its sources before and after processing, and accepts only numeric post IDs present in those collections. Incomplete, synthetic, changed or unsafe collection inputs fail validation. No backfill or collection is performed.

Create the local working directory and fetch a read-only snapshot of all existing issues, including closed questions:

```sh
mkdir -p data/knowledge-candidates
chmod 700 data/knowledge-candidates
(umask 077; gh issue list --repo feyn-machines/surviagi-knowledge --state all --limit 10000 --json number,title,body,state > data/knowledge-candidates/issues.json)
```

The operator must ensure this snapshot is complete and current; the preview never treats it as a transaction or a guarantee that no remote issue exists. Bodies are used locally for marker matching and are not copied into previews. Comments are not searched in this increment. No labels are set, and a suggested new issue does not authorize publication.

Store a UTF-8 JSON array in `data/knowledge-candidates/selections.json`, mode 0600. Each selected entry has:

| Field | Meaning |
| --- | --- |
| `include` | Boolean; false filters the entry out |
| `question` | The concrete question, max 256 characters |
| `summary` | An operator-written paraphrase of the lead, not a pasted source |
| `value` | Why this lead matters for a concrete task or deliverable |
| `conditions` | Known scope and conditions, explicitly recording unknowns |
| `gap` | What remains unverified or missing |
| `source_ids` | Nonempty array of numeric post ID strings in the pinned collection |
| `issue_number` | Optional explicit existing issue number for differently worded questions |

Summary, value, conditions and gap are required plain text, each at most 2000 characters. Unknown fields on selected entries are rejected; originals remain in collection storage. Rejected entries only need `include: false`. No real case content is supplied by the tool.

```sh
chmod 600 data/knowledge-candidates/selections.json
pnpm knowledge:candidates --input-id "$COLLECTION_INPUT_ID" \
  --selections data/knowledge-candidates/selections.json \
  --issues data/knowledge-candidates/issues.json
```

The input ID is the one returned by the existing editorial-input preparation command. Local input files must be under `data/`, regular files with private permissions, without symlinks. The CLI prints only the preview ID, count and unapproved status; inspect the private JSON locally. Errors do not echo source content.

## Matching and repeat runs

Question matching normalizes Unicode width, letter case and whitespace. It does not infer semantic equivalence or remove punctuation. Use `issue_number` to resolve paraphrases. Multiple matching titles stop for a choice; an explicit number must exist in the supplied snapshot. Both open and closed questions are eligible, and the preview does not reopen closed issues.

Selected entries for the same normalized question combine their source IDs. The original title is preserved; when spellings differ only in matching normalization, the lexicographically smallest original spelling is selected deterministically. Conflicting descriptions or target issues are refused. Duplicate source IDs across collection roles collapse. Candidate markers depend on normalized question and source IDs, not the collection window or source order. An exact candidate marker already in one issue body gives `already_recorded`. A separate stable `question_marker` links later source additions to the same question even if its issue title changed. A question marker, title or explicit number gives `append_to_issue`; otherwise the suggestion is `new_issue`. For an associated issue, canonical X source URLs already in its body are excluded from `new_source_ids`; when every selected source is present, the action is `already_recorded`. A future publisher must retain both markers and source URLs. Markers identify a lead and its sources, not a summary revision: editing prose alone does not request a new correction or grant new approval.

Previews are content-addressed JSON under ignored `data/knowledge-candidates/previews/`, with 0700 directories and 0600 files. They retain source links (`https://x.com/i/status/<id>`), operator summaries and pinned input/snapshot hashes, not original posts, issue bodies, file paths or databases. Repeating identical inputs produces the same file; tampering with it is refused. Changed issue snapshots or selections produce a different preview. This is local idempotence, not remote write idempotence.

## Before any future publication

A separate implementation must consume the actual knowledge contribution rules, re-fetch complete issues and comments, bind approval to exact summary hashes, recheck public boundaries, handle concurrent/retried writes and preserve markers in controlled create/append operations. It must prefer existing questions, publish only reviewed summaries and links, never set `f-ready` or trigger a case worker. None of those remote writes are implemented or exercised here. Human review remains necessary even when fields pass validation: a field name cannot establish privacy, accuracy or third-party reuse permission.

Run the dependency-free tests with `pnpm knowledge:candidates:test`; both project check commands include them. Database ingestion, migrations and daily pipeline code are unchanged by this increment.
