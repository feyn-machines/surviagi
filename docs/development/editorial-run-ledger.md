# Local editorial run ledger

The run ledger is the private state and cost record for the first-stage article
workflow. It does not read collection data, call a model, publish a preprint, or
approve an article. A later orchestrator must perform those actions and report
their hashes and identifiers to this ledger.

The database is created at ignored local path
**data/editorial/runs.sqlite3**, with a private directory and file permissions.
It stores collection and topic identifiers, content hashes, stage/model
identifiers, state transitions, budget reservations and actual cost in integer
micro-USD (one unit is USD 0.000001). It never stores source captures, article
text, prompts, credentials or arbitrary error messages.

## Start a run

Use the completed collection run identifier and the SHA-256 of its immutable
input manifest. The topic key is a stable, normalized identifier, not a title
or article body. Skill, policy and model-profile versions are required:

~~~sh
pnpm editorial:run create \
  --input-ref collection-20261028 \
  --input-sha256 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  --topic-key ai-image-api-costs \
  --skill-version editorial-v1 \
  --policy-version prepublish-v1 \
  --model-version writer-model-v1 \
  --budget-microusd 5000000 \
  --max-attempts 3
~~~

An identical input, topic, skill, policy and model profile reuses the same run.
Changing any of those values starts a distinct run. Repeating the same run with
a different budget or retry cap is rejected instead of silently changing its
limits. The budget and retry cap are policy decisions: to authorize changed
limits, bump `--policy-version` so the new run is explicit. The recorded model
identifier may include its provider path, such as `openai/gpt-4.1`.

If selection produces no qualifying topic, record that result without creating
draft stages:

~~~sh
pnpm editorial:run create \
  --input-ref collection-20261028 \
  --input-sha256 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  --skill-version editorial-v1 \
  --policy-version prepublish-v1 \
  --model-version writer-model-v1 \
  --budget-microusd 5000000 \
  --no-topic
~~~

## Record stages

Stages must succeed in order: **topic_selection**, **evidence_brief**,
**draft_en**, **draft_zh**, **preflight**, **prepublish**, **agent_verify**, and
**review_queue**. Model-assisted stages require a model identifier and positive
cost reservation. The ledger checks the run budget before a stage starts; on
completion it records actual cost. If actual cost exceeds the remaining budget,
it records the overrun and holds the run.

For example, after a topic-selection operation has actually completed:

~~~sh
pnpm editorial:run stage-start RUN_ID topic_selection \
  --input-sha256 INPUT_HASH --model-id MODEL_ID --reserve-microusd 150000
pnpm editorial:run stage-finish RUN_ID topic_selection \
  --outcome succeeded --actual-microusd 127000 --output-sha256 RESULT_HASH
~~~

The same pattern records the evidence brief and two drafts. Record short,
non-sensitive error codes with **--outcome failed** or **--outcome held**; do not
pass prompt text, raw provider errors, source quotes or article text. After an
external preprint operation succeeds, record its exact public article ID and
version on the prepublish stage:

~~~sh
pnpm editorial:run stage-finish RUN_ID prepublish \
  --outcome succeeded --output-sha256 PACKAGE_HASH \
  --article-id ai-image-api-costs --article-version 1
~~~

That command records a result; it does not publish. **show RUN_ID** prints the
run, latest stage states and append-only transition events without private
article content.

## Pause and recovery

- **pause RUN_ID** pauses between stages. It refuses to pause an active stage.
- **resume RUN_ID** resumes a paused run.
- If the process stopped while a stage was marked running, **resume** marks that
  attempt interrupted and conservatively counts its reserved budget as spent.
  Retry the same stage only if the run still has an attempt and budget remaining.
- A failed attempt can be retried only up to the run's fixed **max_attempts**.
  A held or budget-held run is terminal; correct the evidence/input or budget
  policy, then start a new versioned run.
- An intentional revision uses a changed input hash or skill/policy/model version.
  Existing stage outputs and public article versions are never overwritten by
  this ledger.

The current ledger records an operator's stage result; it does not yet verify
that a preflight was sound, that a URL resolves, that a publication transaction
succeeded, or that Agent search found the article. Those integrations and their
failure-path acceptance remain part of Issue #11. No scheduled job is created
or triggered by these commands.
