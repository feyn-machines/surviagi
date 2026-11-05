# Agent search index

Issue #30 uses a server-local index of the **loaded public release**. The HTTP
and MCP entry points share it through `agent-search.ts`. This is a keyword
candidate index, not vector search.

## Decision

The existing local pipeline's `scripts/data_pipeline/search_index.py` configures
Meilisearch to call its embedding server for both documents and queries. Moving
that configuration to production would add query-time model inference, another
service, and a second release lifecycle. It also indexes pipeline inputs rather
than exactly the public release. It is therefore not reused for public requests.

A vector file computed only for documents would not solve arbitrary bilingual
queries without a compatible query encoder. A future semantic path needs either
an explicitly approved query encoder or release-time semantic expansions that
can be searched without inference, plus a measured relevance improvement on the
same evaluation release. Neither is delivered here.

The current implementation builds character postings when the loaded release
changes. One-, two- and three-code-unit grams preserve the existing substring
semantics for Chinese, Latin text, punctuation and short queries. Longer terms
intersect postings and verify the exact substring. The union of term and alias
hits selects candidates; the existing field weights, rarity, occupation filter,
dates, explanations and tie-breaking rank those candidates unchanged. An absent
query term has no postings and triggers no collection, embedding or generation.
The cache key includes the release id and load timestamp; a reload replaces the
whole index, including removed records. No private collection store is queried.

## Validation and limits

`pnpm check` runs the offline postings tests via `i18n:test`. They compare all
substrings of bilingual fixtures with a linear scan, check release isolation,
and compare the production ranker using postings versus a reference scan for
all 24 evaluation questions with three filter combinations (72 comparisons).
The fixture corpus is synthetic; this proves equivalence, not semantic quality.
The built-site test also runs the 24 questions against the loaded snapshot and
reports hit@5 and MRR. Run `pnpm search:eval --base URL` for another server using
the matching local snapshot; scores from different releases are not comparable.

This index deliberately changes no relevance rules, so it claims no hit-rate
increase. Character postings consume memory and add work on the first search
after a release loads; capacity and latency need measurement on production-sized
releases before claiming a performance benefit. It is constructed in memory,
not stored as a separate published artifact. Editorial article search retains
its existing separate public-store path. Market/task synonyms, O*NET hierarchy
expansion and a semantic relevance comparison remain open under #30.
