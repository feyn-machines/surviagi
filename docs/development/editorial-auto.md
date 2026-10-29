# Automatic article production

`pnpm editorial:auto` turns one completed collection window into, at most, one
bilingual article preview waiting for human review: a new article, or a new
version of an existing editorial article. It runs on this machine
when someone starts it; there is no schedule, and a failure here never touches
the daily data release. Readers' requests never start it.

It drives the stages of the [run ledger](editorial-run-ledger.md) in order and
uses the existing [prepublication writer](editorial-publishing.md):

| Stage | What happens | Ends the run when |
| --- | --- | --- |
| topic_selection | A model reads the window's original posts, every existing article and earlier selections, and applies the `surviagi-editorial` skill. Choosing is its job: the most valuable non-duplicate candidate with a primary source is written. | No qualifying topic or evidence-only (`no_topic`); a topic still to be checked (`held`); a topic or article already written or in progress (`held`, `duplicate_topic`); a revision whose target is not a live editorial article (`held`, `revision_target_missing`). |
| evidence_brief | A model opens primary sources and returns the shared claim register and outline. For a revision it also reads the current version of both languages (snapshotted with its pointers when the topic was chosen) and covers the whole revised article. The cutoff is the time this stage finishes. | The brief's gate is `hold`, or fewer than two sourced claims are usable (`insufficient_evidence`). |
| draft_en, draft_zh | Two independent model calls write each language from the brief only, with private style examples retrieved separately per language. A revision writer also gets the current text in its own language and returns the complete revised article. | The output is malformed (retried, then `failed`). |
| preflight | Deterministic checks, then a model review. If every failure is one a writer can fix (citations, claim coverage, held material, language parity, a blocking review finding), each affected language is corrected once from the findings and everything is checked again. | A failure that remains after the correction, or one no rewrite can fix (a dead 404/410 source). Unreachable sources are retried. |
| prepublish | Writes the package (Markdown, evidence report, manifest) and calls `editorial-publish.mjs`. A revision expects the pointers it was based on and becomes the next preview version; the approved version stays public until the new one is approved. Records each style example actually used against the published hash. | Without `--confirm-public-preview` the run waits here. A pointer conflict (someone published or approved in between), withdrawal or package rejection holds. |
| agent_verify | Reads both languages back through `/api/agent/record` (status `preview`, exact revision, exact content hash) and finds the revision through `/api/agent/search`. | A mismatch is retried, then `failed`. |
| review_queue | Confirms the preview pointer is this version, unapproved and not withdrawn: it is in the review desk. | Withdrawn or superseded before review (`held`). |

Deterministic failures cannot be cleared by a model judgment. Articles that
exist only as build-time Markdown under `docs/articles/` cannot take a new
version; the selection writes a new article that builds on them instead. Review
status is not a reason to stop: a revision of an approved article and a new
article both go to the review desk. The run never approves anything: bilingual approval in `/admin/editorial` is the
only path to the regular article list.

## Run it

~~~sh
# Selection to preflight only; nothing becomes public.
pnpm editorial:auto run --latest
# Same run, continued to a public preview on surviagi.com, then read back.
pnpm editorial:auto run --input editorial-input-<id> --target server --confirm-public-preview
~~~

`--latest` prepares the input manifest for the newest window with both an
official and a panel record and refuses an incomplete one, exactly like
`pnpm editorial:inputs prepare`. `--target local` (the default) writes to the
loopback database and reads back from `http://127.0.0.1:3000`, so start
`pnpm editorial:dev` first; `--target server` writes through the SSH database
tunnel and reads back from the public site. Use `--target server` even without
`--confirm-public-preview` when the run should de-duplicate against the live
article store; it reads but writes nothing until confirmed.

The run key is the input, the skill version (a hash of the skill files), the
policy version and the model. Repeating the same command resumes that run: a
finished stage is not repeated, its private output is reused only while its hash
still matches the ledger, and a second process on the same run is refused. A
changed skill or model is a new run, but it cannot pick a topic that another run
has published or is still producing.

## Cost and retries

Each model stage reserves a fixed amount, which is also the harness's
`--max-budget-usd` cap: selection 3, evidence 4, each draft 2 (USD). Preflight
reserves 3 for a review (capped at 0.8), at most one correction per language
(0.6 each) and a re-review.
The run budget defaults to USD 15 (`--budget-usd`). A stage that would exceed it
is not started (`budget_held`); one whose reported cost overruns it holds the
run. Retryable failures are tried up to `--max-attempts` (default 2) per stage.
The model is `claude-opus-5-5` unless `--model` names another.

The model runs as `claude -p` with read and web tools only, no shell and no file
writes, in a temporary directory outside the repository that holds just the
stage's inputs and the skill, and is removed afterwards. Collected posts are
treated as untrusted material.

## Inspect, pause, recover

~~~sh
pnpm editorial:auto show RUN_ID     # ledger state, stages, costs, selection
pnpm editorial:auto pause RUN_ID    # between stages
pnpm editorial:auto resume RUN_ID   # then run the same command again
~~~

Private outputs are under **data/editorial/runs/RUN_ID/** (directory 0700,
files 0600): the digest of posts, article index, selection, brief, both drafts,
preflight report and, once checked, the publishable package. A held stage keeps
its evidence as `brief.held.json` or `preflight.held.json`. A process that died
mid-stage is recovered by running the same command again: the interrupted
attempt is charged at its reservation and retried if attempts remain. If the
publisher committed but the process died before recording it, the retry finds
the identical version and records it instead of writing another.

A held, failed or budget-held run is final. Fix the cause, then start a new run
by changing the input window, the skill or `--model`; a held topic can be chosen
again by a later run.
