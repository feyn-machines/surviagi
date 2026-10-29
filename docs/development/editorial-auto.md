# Automatic article production

`pnpm editorial:auto` turns one completed collection window into, at most, one
new bilingual article preview waiting for human review. It runs on this machine
when someone starts it; there is no schedule, and a failure here never touches
the daily data release. Readers' requests never start it.

It drives the stages of the [run ledger](editorial-run-ledger.md) in order and
uses the existing [prepublication writer](editorial-publishing.md):

| Stage | What happens | Ends the run when |
| --- | --- | --- |
| topic_selection | A model reads the window's original posts, every existing article and earlier selections, and applies the `surviagi-editorial` skill. | No qualifying topic or evidence-only (`no_topic`); a revision of an existing article or a claim still to be checked (`held`); an article id or topic already written or in progress (`held`, `duplicate_topic`). |
| evidence_brief | A model opens primary sources and returns the shared claim register and outline. The cutoff is the time this stage finishes. | The brief's gate is `hold`, or fewer than two sourced claims are usable (`insufficient_evidence`). |
| draft_en, draft_zh | Two independent model calls write each language from the brief only, with private style examples retrieved separately per language. | The output is malformed (retried, then `failed`). |
| preflight | Deterministic checks, then a model review. | Any hard failure: a citation not in the brief, an outline claim or source left out, a held claim or source used, different source sets between languages, a dead (404/410) source. A blocking model finding also holds. Unreachable sources are retried. |
| prepublish | Writes the package (Markdown, evidence report, manifest) and calls `editorial-publish.mjs`. Records each style example actually used against the published hash. | Without `--confirm-public-preview` the run waits here. A pointer conflict, withdrawal or package rejection holds. |
| agent_verify | Reads both languages back through `/api/agent/record` (status `preview`, exact revision, exact content hash) and finds the revision through `/api/agent/search`. | A mismatch is retried, then `failed`. |
| review_queue | Confirms the preview pointer is this version, unapproved and not withdrawn: it is in the review desk. | Withdrawn or superseded before review (`held`). |

Deterministic failures cannot be cleared by a model judgment. Only new articles
are produced automatically; revising an existing article stays an operator task.
The run never approves anything: bilingual approval in `/admin/editorial` is the
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
tunnel and reads back from the public site.

The run key is the input, the skill version (a hash of the skill files), the
policy version and the model. Repeating the same command resumes that run: a
finished stage is not repeated, its private output is reused only while its hash
still matches the ledger, and a second process on the same run is refused. A
changed skill or model is a new run, but it cannot pick a topic that another run
has published or is still producing.

## Cost and retries

Each model stage reserves a fixed amount, which is also the harness's
`--max-budget-usd` cap: selection 3, evidence 4, each draft 2, review 1.5 (USD).
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
