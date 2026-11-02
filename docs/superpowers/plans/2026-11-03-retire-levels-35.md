# Retiring the L0–L5 levels (Issue #35): delivery order

Design: [evidence-ledger redesign, section 9](../specs/2026-11-02-evidence-ledger-redesign.md). This plan lists where levels and the takeover progress are read, what replaces each, and the order in which they come out, so that every step ships on its own and no published address turns into a 404.

## Where levels are read

| Surface | Files (under `src/` unless noted) | Replacement |
| --- | --- | --- |
| Agent search and records | `lib/agent-search.ts`, `lib/agent-api.ts`, `app/[lang]/agents/copy.ts` | `evidence` type deprecated, then removed one contract minor later; observations (#29) |
| `llms.txt` | `app/llms.txt/route.ts` | counts of collected updates; observation statistics (#32) |
| Public contract | `scripts/lib/public-contract.mjs`, `public/contract/v1/` | `retired_collections` already lists chain, markets, tasks, progress |
| Home page | ~~`components/home/**`~~ (removed), `lib/home-data.ts` (rewritten), `lib/level-names.ts` | question entry and four section entries (#32). **Done:** `app/[lang]/page.tsx` is a server page with two search forms (to `/occupations?q=`, `/markets?q=`), four section links, latest updates, topics argued both ways and latest articles; `components/home/reveal.tsx` and `sections/levels.ts` stay until the market, work and update pages stop using them |
| Market and work pages | `app/[lang]/markets/**`, `app/[lang]/work/[id]/**`, `components/work-grid.tsx`, `components/progress-compare.tsx` | market page with evidence sections; `/work/<id>` redirects (301) to its market |
| Occupation pages | `app/[lang]/occupations/**` | occupation page with evidence sections |
| Update pages and list | `app/[lang]/updates/**` | readings column and filter removed; page stays as the evidence record |
| SEO, sitemap, Markdown copies | `lib/seo.ts`, `app/sitemap.ts`, `lib/markdown-copy.ts`, `**/raw.md/route.ts` | sitemap rule of #36; `/work/` entries leave the sitemap when they redirect |
| Snapshot reader | `lib/snapshot.ts`, `lib/snapshot-source.ts` | **Done (contract 1.1.0):** the publisher adds `work.json` (kinds of work, ungraded, with update counts), `occupations.json` (tasks, `touched_tasks`, group, markets served) and `Event.work` (the update-to-work links with posts that also said so). Pages read only these; `chain`, `markets` and `progress` are read solely to fold a release made before them into the same shapes, and the deprecated Agent `evidence` record still reads `chain.evidence`. "Touched" is now any covering work linked, not every covering work levelled, so occupation counts rise (accountants 9 → 16 of 30) |
| Pipeline | `scripts/data_pipeline/{activity_state,gate_state,activity_mapping,gate_mapping,event_routing,judge,publish}.py`, `scripts/data_daily.py` | daily run stops activity levels and gate states; observation steps (#25) |
| Documents | whitepaper (`lib/whitepaper.ts`), `docs/` method pages | rewritten around observations; old designs marked superseded |

## Order

1. **Agent and `llms.txt`** (this change): evidence readings carry a `deprecated` notice, are not returned by default, and no longer put a level in a snippet; `llms.txt` drops the level definitions and the "furthest level" sentence.
2. **Pages**, with #32: home (done), market, occupation, update; `/work/<id>` to 301. Done per page group so that each lands with its replacement content.
3. **Pipeline**: stop the daily level and gate steps only after no page or response reads them, otherwise the pages would show stale numbers. Record the judgment calls saved.
   Order on the live site: release the code that reads the new collections first (it reads either shape), then let a daily data release carry them; only then stop publishing `chain`, `markets`, `tasks` and `progress` and drop the fallback. The daily run publishes from the main checkout, so that checkout has to be on a `main` that contains the new publisher before a data release can carry the new collections.
4. **Contract and snapshot**: remove the `evidence` type and the retired collections one contract minor version after step 1 has been live.
5. **Documents**: whitepaper, method pages, history markers.
