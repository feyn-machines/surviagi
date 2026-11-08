# Agent knowledge reading (#110)

The accepted issue requires a read-only adapter over the #104 reader, shared by HTTP and MCP. Keep legacy question and submission semantics unchanged. No model, crawler or knowledge-content work.

1. Add bounded, deterministic pagination to the shared reader while preserving its existing search API. Bind cursors to filters, artifact and withdrawal generation; reject stale cursors.
2. Load only the locally imported, verified artifact. Add `search_knowledge` and recognize `knowledge:*` in `get_record`, with an optional exact revision. Return localized full records including facts/conditions/sources and provenance. Missing artifact/baseline fails closed; never cache filtered bodies.
3. Test bilingual search, filters, pagination/limits, historical reads, withdrawal propagation and shared-reader equality. Verify HTTP/MCP dispatch and no-store behavior. Document API and deployment boundaries.
4. Run focused tests, pnpm check and staged public gate; obtain independent branch review; PR with Closes #110, squash merge when checks pass. No deployment in this item.

Interface choice: a separate knowledge search tool avoids changing the legacy search's record-type and question meaning. The existing record endpoint dispatches by the namespaced id. Web/Markdown consumers use the same reader; their route implementation belongs to the UI items.
