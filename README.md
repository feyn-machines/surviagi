# SurviAGI

Project name: **SurviAGI** (The AGI Survival Guide; 新人类 AI 生存指南). Domain: **[surviagi.com](https://surviagi.com)**. Earlier names: openaiwill (until 2026-10-08; openaiwill.com redirects here) / WillAI / AgentHowTo. The repository was renamed from `openaiwill` to `surviagi` on 2026-10-08. Internal identifiers (database names, container names, the language cookie) keep the earlier name.

SurviAGI is an initiative to make progress toward AI independently completing major work more transparent and credible. We actively collect and analyze AI developments; the website is a product carrying this initiative. Community contributions help fill gaps and correct the analysis; reporting and auditing support that purpose. See the [whitepaper](docs/whitepaper.md). Domain ownership does not establish that the website has been deployed.

## Run locally

Requires Node.js 22+ and pnpm 10.28.2.

```sh
pnpm install
pnpm dev
```

Open http://localhost:3456. Both `pnpm dev` and `pnpm start` use port 3456.

```sh
pnpm lint
pnpm typecheck
pnpm metadata:check
pnpm build
pnpm start
```

Run `pnpm check` for the full local verification set, including public-file checks, security regression tests and design resources. After staging, run `pnpm security:staged` to inspect the exact proposed commit contents. No collection or upload credentials are needed to run the current website.

Local Codex and Claude Code entry points share one project guide: `AGENTS.md` directs Codex to `CLAUDE.md`, which Claude Code reads directly. Both remain local and excluded from Git under this project's publication policy; see [development and publication](docs/development/local-collection-and-publishing.md).

## Current scope

Next.js App Router, TypeScript, plain responsive CSS. Routes: `/`, `/domains`, `/domains/[slug]`, `/check`, `/updates`. The home page and market pages read the sourced market directory.
The checker and update feed are explicitly marked as not connected. The frontend has no connected model, database, authentication, notifications or deployment. Local collection tooling has been tested separately; its private runtime and credentials are excluded from this repository.

The confirmed first-stage data loop is **local collection → local processing → PostgreSQL import → metrics → progress → verification**. A dedicated local PostgreSQL instance, immutable imports and synthetic end-to-end simulation are implemented; see [the runnable local pipeline](docs/development/local-data-pipeline.md) and [verified results](docs/data/local-pipeline-simulation-2026-09-12.md). A verified saved-archive adapter and [real-data pilot](docs/data/real-data-calculation-2026-09-12.md) now import 2,707 sources and calculate source metrics plus explicit AI judgment scenarios. Automatic event extraction and a calibrated production estimation method remain pending. Next.js remains the web application, with no database connection yet.

## Product direction

The core product estimates progress toward AI independently completing major production and service work. A 0–100 simulation combines fixed market weight points with AI-estimated completion states, supported by obtainable events, company adoption and community signals. Source identity, claim verification, observed reaction and simulated state remain separate. Initial weights and estimates may be proposed by AI with explicit assumptions and scenario ranges. The existing frontend and startup-risk framing are earlier prototypes. Official company/product X accounts remain the primary update entry point. The confirmed public brand is openaiwill and the domain is `openaiwill.com`; DNS, TLS and deployment have not been verified as part of the naming decision.

- Separate official announcements from editorial judgments.
- Record what changed, when, what the source claims, and who can use it.
- Preserve sources, dates, availability conditions, coverage gaps and correction history.
- Idea submissions are private by default; do not publish them as SEO pages.
- Account and event datasets come before further page design.
- Configure canonical URLs, sitemap and social metadata against the actual hostname before publishing. Do not invent live verdicts for placeholder content.

The next data layer will connect company adoption, metric snapshots and event evidence to versioned world scope, AI state estimates and simulation updates. A future progress overview and explanatory graph should use the same evidence records; weekly reports and publication are outside the current data system. Work is forward-only from activation; historical collection is out of current scope and may later use reviewed community contributions. The production inference engine, daily scheduler, community intake and publishing integration are not implemented. A local database, synthetic regression and a real-archive pilot are now available separately. An unpublished AI-proposed scope, weights and initial pilot now exist; production scope and scores remain inactive. Social-signal calibration can proceed separately.

- [100-point simulation model and adoption signals](docs/data/takeover-simulation-v0.3.md)
- Simulation contract v0.3 (`datasets/takeover-simulation.v0.3.json`, local only)
- [Retained event and community observation layer](docs/data/takeover-progress-framework-v1.md)
- Observable-data methodology (`datasets/takeover-methodology.v0.2.json`, local only)
- Bounded metric-field verification (`datasets/evidence/social-metric-field-probe-2026-09-12.json`, local only)
- [AI-progress knowledge base v1 design](docs/data/ai-progress-knowledge-graph-v1.md)
- [Weekly WeChat article template](docs/data/weekly-wechat-template.md)
- [Domain glossary](CONTEXT.md)

## Next steps

1. Expand reviewed event-to-work mappings beyond the current 12-source, nine-event software example.
2. Evaluate and calibrate the explicit AI judgment method before treating a score as a production baseline.
3. Add subsequent real observations and distinguish evidence changes from corrections or method changes. Website integration is a separate later step.

## First data pilot

The [2026-09-12 collection and simulation report](docs/data/collection-and-simulation-pilot-2026-09-12.md) contains 57 retained official X posts, 30 Reddit posts, 13 event groups, two adopter-confirmation records and a reproducible historical AI estimate. X coverage is partial after a rate limit. Its 13/16 self-designed work groups and 24.3-point result are not the v1 source baseline. V1 now preserves [a16z source groupings and provenance](docs/data/a16z-source-baseline-v1.md); production scores remain empty. The expanded people watchlist (`docs/research/ai-people-x-lists-2026-09-12.md`, local only) is separate from collection activation.

## Official account registry

Checked on 2026-09-11: **13 companies, 51 enabled X accounts and 8 held records**. Each company can have multiple model, product, developer, research, platform and newsroom accounts. Enabled accounts have a matching numeric X user ID and identity evidence from official sites or verified official X relationships. This is an initial source list, not complete company/product coverage or a collection of verified capability events.

- [Readable official account list](docs/data/official-x-accounts.md)
- Collector-compatible account JSON (`datasets/official-x-accounts.json`, local only)
- Coverage gaps (`datasets/official-x-account-gaps.json`, local only)
- Identity observations (`datasets/evidence/x-account-profile-checks-2026-09-11.json`, local only)
- Official X account relationships (`datasets/evidence/x-account-relationships-2026-09-11.json`, local only)

## Product scope

Track AI companies' capability and product announcements through official evidence, including Google, OpenAI, Anthropic and Chinese companies. Keep companies, products, domains, source posts and normalized events distinct. Existing market pages remain a prototype; company pages and a connected update feed remain to be implemented.

## Ontology v1.0.0

The standalone ontology (`datasets/ontology/README.md`, local only) defines work, markets and occupations with five concept kinds and four typed relationships. It preserves all 20,796 concept IDs and 20,733 relationship IDs from the original catalog, together with source definitions and external classification mappings. It contains no event, metric, progress or weighting data.

Start with the model (`datasets/ontology/releases/v1.0.0/model.json`, local only), JSON Schema (`datasets/ontology/releases/v1.0.0/schema.json`, local only), full catalogs (`datasets/ontology/README.md`, local only) and version rules (`datasets/ontology/VERSIONING.md`, local only). `pnpm ontology:test` and `pnpm ontology:check` verify the independent contract and sealed package. Some concepts still have names and classification positions only; definition coverage is reported explicitly. The complete ontology is also imported into the [local PostgreSQL mirror](docs/development/local-data-pipeline.md).

## Database design

The [first-stage PostgreSQL design](docs/superpowers/specs/2026-09-12-postgresql-business-schema-design.md) covers local collection and processing, data import, metric calculation and progress calculation. It models people, organizations, products, source accounts, evidence, events, tags and values, using direct business table names in `public`. Agent reporting, login and API keys are outside this phase; weekly reports and publication workflows are outside this data system. The original [SQL draft](docs/data/postgresql-business-schema-draft.sql) is retained as design history; [versioned migrations](db/migrations/001_business_schema.sql) and [immutability guards](db/migrations/002_immutable_imports.sql) are now applied to the dedicated local PostgreSQL instance. Run `pnpm data:setup`, `pnpm data:test` and `pnpm data:simulate`; [the runbook](docs/development/local-data-pipeline.md) explains inputs, calculations and history. The previously confirmed **Better Auth + Google sign-in** for obtaining Agent reporting keys remains a later-phase choice.

## Historical platform data v0.0.1

The versioned platform dataset (`datasets/platform/README.md`, local only) retains the original mixed draft: a complete O*NET 31.0 occupation/task projection (23 groups, 1,016 occupations, 18,838 tasks) and an AI-proposed market catalog (40 domains, 265 submarkets, 614 work items), with coverage references for all 22 ISIC Rev.5 sections. Initial weights carry their methods and draft status; capability progress remains unknown. The data is a sealed local draft, and the website has not yet adopted it. New ontology work uses the standalone package above; the old runtime contracts have not been revised in this ontology-only change.

Read the market catalog (`datasets/platform/releases/v0.0.1/market-catalog.md`, local only), occupation catalog (`datasets/platform/releases/v0.0.1/occupation-catalog.md`, local only) and major/minor/patch policy (`datasets/platform/VERSIONING.md`, local only). `pnpm platform:test` and `pnpm platform:check` validate the contract and releases, and are included in `pnpm check`.

## Market directory

The earlier frontend directory has 20 editorial markets in six browsing groups, informed by a16z research, YC profiles and product websites. It is not an original a16z taxonomy or a measure of global economic coverage. The v1 industry reference (`datasets/a16z-industry-reference.v1.json`, local only) preserves the nine original industry headings in the a16z GDPval chart. The app-spending reference (`datasets/a16z-market-reference.v1.json`, local only) remains separate; this source correction has not changed the frontend.

- [Readable market directory](docs/metadata/market-directory.md)
- [Source and selection method](docs/metadata/methodology.md)
- [Machine-readable directory](src/content/markets.json)
- YC research (`docs/research/startup-market-sources.md`, local only)

Run `pnpm metadata:check` to validate the earlier frontend directory's bilingual content, category relationships, source references, examples, and absence of unsupported coverage verdicts. Its official-update links and replacement assessments remain empty. This command does not validate all newer datasets; see the [2026-09-12 metadata reconfirmation](docs/data/metadata-reconfirmation-2026-09-12.md) for current source references, account and people counts, pilot links and pending work.

## Languages

English is the default. Current pages render on the server using the browser's `Accept-Language` preference, respecting quality weights. Chinese preferences receive Simplified Chinese; unsupported languages fall back to English. This does not infer physical location. The existing frontend headline predates the openaiwill naming decision; the new tagline is not yet finalized. Separate indexable locale URLs, manual language selection, and Traditional Chinese are future work.

## Public source and private inputs

The public repository contains application code and reviewed documentation. `datasets/` and `docs/research/` remain local and are not included in a fresh clone, including static reference catalogs and historical releases. Restore trusted private inputs locally only when operating the data pipeline; do not stage them. References to those paths in older documentation describe local resources.

Run `pnpm install --frozen-lockfile` and `pnpm check:public` to validate the public source without private datasets. The website builds without a published snapshot and displays its existing no-data state. `pnpm check` remains the complete local validation command when private data is available. See [the publication boundary](SECURITY.md) and [local collection and publishing](docs/development/local-collection-and-publishing.md).

## Open source and security

Project code is licensed under MIT. Local datasets retain their applicable source licenses and are not distributed here. Local agent instructions, skills, environments, credentials, collection archives and research drafts are excluded from new commits. Older public commits may retain files removed from the current tree; this cleanup does not rewrite history. See [SECURITY.md](SECURITY.md). Verification is local: `pnpm check` validates public paths, common credential patterns, dataset contracts, lint, types and build, and `pnpm check:full` adds the real PostgreSQL tests. The repository does not rely on hosted CI. No credentials are required to run the current scaffold.

## Design resources

The confirmed Tensorlake-inspired direction is initialized in [DESIGN.md](DESIGN.md) and the [design system resource package](design/system-v1/README.md). Open the [interactive specimen](design/system-v1/preview.html) for typography, colors, diagrams, component states and motion. Run `pnpm design:build` after editing its sources and `pnpm design:check` to verify resources. The existing business routes have not yet adopted this system.
