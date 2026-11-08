# Knowledge reads for Agents

The public read-only MCP endpoint `/api/mcp` exposes `search_knowledge`. Its plain HTTP counterpart is `GET /api/agent/knowledge`. Both use the imported knowledge reader used by page/Markdown consumers, without models, collection, sign-in or keys. Existing `search`, legacy question records and private `submit_question` requests retain their meaning.

Search arguments: `query` (1–1000 characters), `language` (`en` default or `zh-CN`), optional `kind` (`question`, `case`, `answer`, `update`), `direction` (exact slug), `nature` (update nature), `limit` (1–100, default 20) and `cursor`. Search matches the requested language's title/body and returns current heads only. Nature/direction filters use the shared reader's exact semantics. The response has `results`, `total`, `next_cursor`, `commit`, `websiteCommit`, `indexHash`, `generation` and `language`, including for zero matches.

Pass `next_cursor` with the same query/language/filters for another page. It is bound to the artifact and the complete withdrawal baseline. A changed knowledge version, withdrawal baseline or filter yields HTTP 400 (`invalid`); restart without the cursor. The page size may change. Cursors are opaque pagination positions, not authorization credentials.

Use MCP `get_record` or `GET /api/agent/record` with a `knowledge:<kind>:<slug>` id. Add `revision=sha256:<64 lowercase hex>` for an exact historical revision. Omitting it reads the loaded head. A missing revision is 404, never replaced by another. A visible record contains the full localized `record.text` and shared `record.facts`: case conditions, tools, human involvement, cost/unknowns, source URLs, and separate claims/checks/reproductions are preserved. Status is `current` or `superseded`. Cite the stable id, exact revision, language and knowledge commit; retain the conditions and source attribution when answering.

Every response reloads the independent withdrawal baseline. A withdrawn revision or dependent returns identity, provenance, `status: withdrawn` and `reason`, with no title/body/facts. Missing/invalid artifacts or baselines fail closed as HTTP 503; MCP reports a tool error. Every knowledge HTTP/MCP response is `no-store`. Existing anonymous read rate limits apply. Historical Git objects and responses already received by third parties cannot be erased by this filter.

Examples:

```text
GET /api/agent/knowledge?query=Blender&kind=case&language=en&limit=10
GET /api/agent/record?id=knowledge:case:example&revision=sha256:<revision>&language=zh-CN
MCP search_knowledge {"query":"Blender","kind":"case","language":"en"}
MCP get_record {"id":"knowledge:case:example","revision":"sha256:<revision>","language":"en"}
```

These are interface examples, not published knowledge claims.

Runtime reads a local verified import from `KNOWLEDGE_ARTIFACT_PATH` (default `data/knowledge/current.json`) and the shared baseline from `KNOWLEDGE_WITHDRAWALS_PATH` (default `/opt/openaiwill/shared/knowledge-withdrawals.json`). Set trusted absolute paths when assembling a deployment; callers cannot select them. No fallback fetch, empty-baseline inference or activation happens on a request. The release integration and baseline initialization belong to #112. This change does not publish real knowledge or implement the page routes owned by the UI items.

Tests compare bilingual HTTP and MCP responses with the same shared reader (the page/Markdown content source), exercise exact v1 after v2, facts, pagination/limits and live dependency withdrawal. The built-server acceptance uses port 3456. Real content, rendered page routes and production release acceptance remain with their owning items.
