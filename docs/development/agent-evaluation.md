# Agent evaluation protocol v1

Issue #33 tracks implementation and acceptance. This protocol fixes the questions,
client matrix and scoring before collecting results. It is not a completed
client baseline or an implementation of usage telemetry.

## Fixed questions

Run every row in both languages, without adding the site name. Keep the wording
and IDs stable when comparing versions. Record the exact returned record IDs
against the pinned public data release; never invent an ID for a missing entity.
Expected records below are relevance criteria, not assertions that coverage exists.

| ID | English | 简体中文 | Expected records and answer limits |
| --- | --- | --- | --- |
| occupation-accounting | Will AI replace accountants? | AI 会取代会计吗？ | Observations concerning `oaw:occupation:13-2011.00`; distinguish accounting tasks from the entire occupation and avoid replacement predictions. |
| occupation-support | What evidence shows AI resolving customer support tickets? | 有哪些 AI 处理客服工单的证据？ | Observations concerning `oaw:occupation:43-4051.00`, including conditions and outcomes. |
| occupation-software | Where do coding agents still fail? | 编程 Agent 仍会在哪些地方失败？ | Observations concerning `oaw:occupation:15-1252.00` or `15-1251.00` (with the same occupation prefix), explicitly describing failures or limits; do not infer failure from silence. |
| occupation-legal | What evidence exists for AI contract review? | AI 合同审查有哪些证据？ | Lawyer/paralegal observations (`oaw:occupation:23-1011.00`, `oaw:occupation:23-2011.00`), with source type and review state. |
| occupation-design | How are graphic designers using AI? | 平面设计师在怎样使用 AI？ | Observations concerning `oaw:occupation:27-1024.00`; separate personal use from production adoption. |
| company-openai | What has OpenAI said about AI use at work? | OpenAI 对 AI 工作应用有哪些说法？ | Published updates/observations attributed to OpenAI; source account such as `x:OpenAI` only if present. Company claims are not independent verification. |
| company-anthropic | What independent evidence exists about Anthropic tools at work? | Anthropic 工具的工作应用有哪些独立证据？ | Relevant observations with independent evidence; return an explicit coverage gap if only vendor claims exist. |
| model | What evidence of work performance exists for Claude models? | Claude 模型的工作表现有哪些证据？ | Exact published `model:` record IDs and linked observations; distinguish versions and benchmark results from production use. |
| topic-support | What disagreements are there about AI replacing customer support? | 对 AI 取代客服有哪些争议？ | Relevant topic records and supporting/contrary sources, with the topic's exact ID. Do not manufacture a dispute. |
| topic-software | What is debated about autonomous coding agents? | 自主编程 Agent 有哪些争议？ | Relevant topic records, claims and evidence links; distinguish the site's summary from source quotations. |
| recent | What changed in AI software development in the last 30 days? | 最近 30 天 AI 软件开发有什么变化？ | Dated observations/updates in the fixed window and their source URLs; report the cutoff, not only the request date. |
| negative-control | What evidence exists for AI replacing underwater basket weavers on Mars? | AI 取代火星水下篮子编织工有哪些证据？ | Explicit no-evidence/unsupported answer; no invented observations, sources or replacement probability. |

The existing 24-question [search fixture](../../scripts/tests/fixtures/search-eval.json)
and [runner](../../scripts/search-eval.mjs) remain the occupation/market retrieval
subset. They measure hit@5 and MRR using snapshot mappings. They do not yet score
company/model questions, source citation quality or client behavior. Do not feed
this table into that scorer without extending its relevance labels.

## Client matrix and run record

Use two actual MCP clients: Claude Desktop and Cursor; use a Skill with HTTP as
the third path. Alternatives require naming the actual client and version in the
report. A direct JSON-RPC request is protocol testing, not desktop acceptance.
No client has been newly tested by publishing this protocol.

| Path | Connection | Discovery | Invocation | Final answer |
| --- | --- | --- | --- | --- |
| Claude Desktop / MCP | Public `/api/mcp`, client and transport version | Capture `search` and `get_record` tool discovery | Search, then read exact record IDs | Check source links and qualifications |
| Cursor / MCP | Same endpoint and release | Same discovery check | Same fixed questions and reads | Same checks |
| Skill / HTTP | Record Skill revision and Agent harness version | Record endpoint discovery from the Skill | `/api/agent/search`, then record reads | Same checks; distinguish Skill loading from endpoint access |

Save local reports under ignored `data/agent-evaluation/`. Include UTC run time,
code commit, client/model/Skill versions, tool schema version, data release ID,
ontology/contract versions, snapshot hash and evidence cutoff. Pin the recent
window to `[cutoff - 30 days, cutoff]` for all clients. Record failed, skipped and
unsupported cases separately. Capture per-question search/read status, returned
IDs, relevant rank, source links, answer and error category. Raw answers and
client configuration stay local; sanitize before publishing a summary.

Report connection and discovery success by client; tool success as successful
calls / attempted calls; question completion as completed / all 24 language
cases. Report retrieval hit@5/MRR only for labeled applicable cases. Separately
report answers with valid source links / completed evidence-bearing answers,
and answers preserving source type, conditions, review state and uncertainty.
The negative control passes only with an explicit coverage limitation and no
fabrication; exclude it from evidence citation denominators. Skips never count
as successes. A result URL pointing only to the site homepage is not a source
citation. Check quoted claims against the exact records read.

A baseline summary must show every client's tested/failed/skipped counts,
language breakdown, misses, source citation failures, release identifiers and
limitations. Repeat after interface or contract changes and compare the same
question set on the same release to isolate code effects. For a new data release,
report the coverage change separately. Do not copy the historical #30 scores as
a fresh #33 end-to-end baseline.

## Anonymous usage observation requirements

The confirmed design permits anonymous aggregate statistics and no-result query
text for 90 days. This section specifies the implementation boundary; it does
not enable collection. Never retain user/account IDs, API keys, IP addresses,
client fingerprints or successful query text in the evaluation usage store.

Aggregate by UTC day, transport, allowlisted tool, record type, result-count
bucket and allowlisted error category. Use fixed categories for invalid input,
rate limiting, unknown record and internal failure; never store raw exception
messages or arbitrary request paths. Count request-level and tool-level errors
separately so retries and MCP envelopes do not inflate completed questions.

No-result text must pass redaction for credentials, emails, URLs and identifying
strings before persistence; uncertain text is dropped while the no-result count
is retained. Bound length and normalize whitespace/case before grouping. A hash
of raw text is not anonymization. Expire both aggregate rows and sanitized text
at 90 days; deletion must run on writes/reads or the existing maintenance path,
without creating a scheduled task. Test the time boundary and rejected inputs.
Public summaries contain counts and manually reviewed generic gap themes only,
never raw query lists. Restrict local top-miss reports to sanitized text.

Feed reviewed misses into source/panel gap analysis (#22/#23): first distinguish
missing records from matching/language failures (#29/#30), then propose candidate
sources through the existing review process. A miss never triggers collection or
adds an account automatically.

Search Console query/page impressions and clicks and Cloudflare AI crawler counts
are separate discovery signals. When authorized data is available, record its
date range, extraction date and coverage limits. Do not treat crawler requests as
Agent users, clicks as successful tool calls, or missing access as zero traffic.

## Delivery status

This change delivers the fixed bilingual question set and repeatable manual
client/scoring protocol. The full scripted suite, first real client baseline,
privacy-preserving usage store, retention verification and reviewed top-miss
report remain acceptance work under #33. Existing search tooling remains usable:

```sh
pnpm search:eval --base http://127.0.0.1:4173 --snapshot datasets/published/latest --json
```

Use a server loaded from that exact snapshot. If 4173 belongs to another session,
leave it alone and record an alternative port. Save the JSON locally; the current
runner does not itself prove release equality or attach all run metadata above.
