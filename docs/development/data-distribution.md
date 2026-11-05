# Public data distribution — implementation contract

Status: proposed implementation contract, 2026-11-05. No download or change-feed endpoint is delivered by this document. Tracks [#31](https://github.com/feyn-machines/surviagi/issues/31), alongside the [public contract work](https://github.com/feyn-machines/surviagi/issues/27).

The [confirmed evidence-ledger design](../superpowers/specs/2026-11-02-evidence-ledger-redesign.md) authorizes public bulk downloads under CC BY 4.0. Data remains outside GitHub. Distribution is a website service over published releases; it must never read collection archives, application accounts, editorial reviews or local pipeline tables.

## Versioned downloads

Proposed paths are `/data/releases/{release_id}/manifest.json` and `/data/releases/{release_id}/{collection}.jsonl`. A discovery document at `/data/releases/latest.json` resolves the active release to its immutable manifest URL. These paths are not current API documentation.

A request resolves one exact published release before reading rows. Promotion during a request cannot mix releases. A missing release returns 404; an unavailable database returns 503, never an empty successful export. Candidate releases not yet promoted are not downloadable. A rollback changes discovery but does not rewrite a previously published export. Publication history must therefore be distinct from the currently active pointer.

Export only explicitly allowed collection/field projections, reviewed against the public contract. A collection present in the internal release is not automatically downloadable. Do not serve `kg.docs`, arbitrary JSON files, raw posts, internal source metadata or retired level/gate collections wholesale. Third-party source links and short attributed quotations retain their provenance; CC BY does not grant rights to third-party originals. Article export waits for #27's article contract and must respect withdrawal rules; private and withdrawn text cannot be made immutable downloads by accident.

Each export manifest records:

| Field | Meaning |
| --- | --- |
| `distribution_version` | Export-format version, separate from source data version |
| `release_id` | Exact published data release |
| `generated_at` | Original data generation time in UTC |
| `contract_version` | Contract governing the exported rows |
| `ontology_version` | Ontology used by that data release |
| `license` | `CC-BY-4.0` and license URL |
| `collections` | Named files with URL, row count, byte count, SHA-256 and versioned schema URL/hash |

Export hashes cover exact uncompressed UTF-8 bytes, with one JSON value per line and LF after every row. Empty collections are zero bytes and zero rows. Stable ID ordering and a deterministic serializer make retries byte-identical. Hash the exported projection, not the internal source payload: their hashes need not match. Keep schema artifacts for each supported contract version; today's schema cannot silently validate yesterday's release. Missing required schema or invalid rows blocks publication of the entire export.

Publish files and schemas first, then atomically expose their manifest. Never expose a partially generated collection. Store artifacts outside the repository and deployment source upload. Generate once per release, outside page requests; stream downloads rather than assembling a database-wide response in web process memory.

## Change subscriptions

The old issue wording mentions level changes. The confirmed redesign retires levels: new feeds describe published observations and company updates, plus corrections/removals, without rebuilding a level feed.

Proposed paths: `/data/changes/feed.xml` (RSS), `/data/changes/atom.xml` and `/data/changes/feed.json` (JSON Feed). All representations use the same publication change log. A feed entry is identified by release, collection, entity ID and change kind; its timestamp is publication time, distinct from the source's original time. Compare consecutive published export projections; record additions, updates and removals. Repeated polling and promotion retries must not duplicate entries. Rollbacks are explicit activation notices, not fabricated new observations.

Entries carry stable entity ID, data version, change kind, source attribution, page link and Markdown link where that public representation exists. Do not invent `/raw.md` URLs for entities lacking that representation. Removal entries retain identifiers and a public reason, not withdrawn text. Feed titles/descriptions are escaped for the selected format and language.

Filters use exact public IDs: `company`, `occupation`, `topic`, plus `lang=en|zh-CN`. Combined filters intersect. Resolve membership from published relationships only; reject malformed/unsupported filters with 400 and document unknown-ID behavior consistently. Never treat a company name substring as an ID match. Corrections that move an entity out of a filter must be visible to its previous subscribers as removal notices.

Feeds are bounded recent windows, not lossless replication. Responses advertise the retention window and the manifest discovery URL; clients needing a complete dataset resynchronize from a versioned export. A future paginated change API must define durable cursors before claiming lossless subscription. RSS/Atom/JSON Feed are polling addresses; they do not register emails or create scheduled tasks.

## Citation, caching and acceptance

Suggested dataset citation: “SurviAGI, data release {release_id}, entity {entity_id}, {versioned manifest URL}, accessed {UTC date}, CC BY 4.0.” Include source attribution and mark modifications when redistributing derived data. Link to `https://creativecommons.org/licenses/by/4.0/`. Download documentation must distinguish project-authored data from third-party content and preserve supplied notices.

Immutable artifacts use content ETags and long public caching; discovery and feeds use short public caching with conditional GET. Errors must not receive immutable cache headers. Bound filter inputs, feed size, concurrent streams and per-client request rates; return 429 with Retry-After. Cached artifacts should avoid repeated database reads. Verify quotas with the deployed proxy's trusted client-address configuration, rather than accepting arbitrary forwarding headers.

Implementation acceptance must include:

- An independent client downloads a pinned release, verifies byte counts and SHA-256, counts JSONL rows and validates every row against the pinned schema.
- Tests promote another release between manifest and collection requests; all pinned bytes remain unchanged. Unknown, unpublished and unavailable releases produce distinct errors.
- Tests seed prohibited fields and private records and confirm they cannot appear in exports or feeds.
- Feed validators check RSS, Atom and JSON Feed; tests cover escaping, stable IDs, corrections, removal, rollback, all filters and links to real public representations.
- Load tests confirm conditional requests, cache isolation between filters/languages, bounded memory and 429 behavior without changing page availability.
- Bilingual `/agents`, `llms.txt` and sitemap advertise only implemented public entry points. Verify on port 4173 when available, respecting an existing service occupying it.

The current step only documents the protocol. Remaining delivery: public projections and schema alignment (#27), immutable artifact generation/storage and historical-release access, independent validation, publication change log and feeds, discovery links and production acceptance. No issue checkbox is satisfied by this document alone.
