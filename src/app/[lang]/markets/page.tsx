import type { Metadata } from "next";
import { Stat } from "@/components/blueprint";
import { Screen } from "@/components/home/reveal";
import { getLocale } from "@/lib/locale";
import { datasetLd, pageMetadata } from "@/lib/seo";
import { JsonLd } from "@/components/json-ld";
import {
  activitiesOfMarket,
  markets,
  marketSlug,
  observationsOfMarket,
  observationsPublished,
  occupationsOfMarket,
  snapshotExists,
  updateCountByMarket,
} from "@/lib/snapshot";
import {
  DataPageLinks,
  NoSnapshot,
  PageHeader,
  Provenance,
  dataStyles as s,
} from "@/components/data-page";
import { ObservationOverview } from "@/components/observation-ledger";
import { count, fill, indexCopy } from "./copy";
import { MarketsExplorer, type MarketRow } from "./markets-explorer";
import x from "./markets.module.css";

/** Rendered per request from the loaded data release, never at build time. */
export const dynamic = "force-dynamic";

/**
 * The market axis.
 *
 * A market is a kind of work a business sells, and it is where an AI update
 * actually lands: a model that transcribes meetings lands on a kind of work,
 * not on a job title. Occupations are reached through it, never the other way
 * round, so this index is the one that matches how the evidence arrives.
 *
 * The page's claim is a ratio, and it is stated as numbers before it is stated
 * as a table: most markets have no collected update at all. Everything below is computed
 * here, on the server, and handed to the interactive part as plain rows — the
 * snapshot module reads from disk and can never cross into a client component.
 */

export async function generateMetadata(): Promise<Metadata> {
  const { language } = await getLocale();
  const c = indexCopy[language];
  return pageMetadata({ language, path: "/markets", title: c.title, description: c.lead });
}

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function MarketsPage({ searchParams }: Props) {
  const { q } = await searchParams;
  const initialQuery = typeof q === "string" ? q.slice(0, 100) : "";
  const { language } = await getLocale();
  const c = indexCopy[language];
  if (!snapshotExists()) {
    return (
      <div className={s.page}>
        <PageHeader eyebrow={c.eyebrow} title={c.title} lead={c.lead} />
        <NoSnapshot language={language} />
      </div>
    );
  }

  const updatesOf = updateCountByMarket();
  const published = observationsPublished();
  const ledgers = markets().map((market) => observationsOfMarket(market.id));
  const rows: MarketRow[] = markets().map((market, i) => {
    const activities = activitiesOfMarket(market.id);
    const name = (language === "zh-CN" ? market.zh_cn : market.en) ?? market.en;
    return {
      id: market.id,
      slug: marketSlug(market.id),
      en: market.en,
      zh: market.zh_cn ?? market.en,
      name,
      total: activities.length,
      scored: activities.filter((a) => (a.updates ?? 0) > 0).length,
      updates: updatesOf.get(market.id) ?? 0,
      occupations: occupationsOfMarket(market.id).length,
      observations: published ? ledgers[i].length : null,
    };
  });

  const activitiesTotal = rows.reduce((sum, row) => sum + row.total, 0);
  const withUpdates = rows.filter((row) => row.updates > 0).length;
  const blank = rows.length - withUpdates;
  // An update that bears on work in two markets is counted in each, so this is
  // the sum of the rows, and the note says what it is a sum of.
  const updatesTotal = rows.reduce((sum, row) => sum + row.updates, 0);

  return (
    <div className={s.page}>
      <JsonLd data={datasetLd(language, { name: c.title, description: c.lead, path: "/markets" })} />
      <PageHeader eyebrow={c.eyebrow} title={c.title} lead={c.lead} />

      <Screen className={x.stats}>
        <div className={x.rise}>
          <Stat
            label={c.statMarkets}
            tone="plain"
            value={count(rows.length)}
            note={fill(c.statMarketsNote, { n: count(activitiesTotal) })}
          />
        </div>
        <div className={x.rise}>
          <Stat
            label={c.statCovered}
            value={count(withUpdates)}
            unit={`/ ${count(rows.length)}`}
            note={fill(c.statCoveredNote, { n: count(blank) })}
            /* The rest are not a measured zero and not a finding about AI:
               they are the limit of what was collected, which is `warning`. */
            tone="warning"
          />
        </div>
        <div className={x.rise}>
          <Stat
            label={c.statUpdates}
            value={count(updatesTotal)}
            note={c.statUpdatesNote}
            tone={updatesTotal === 0 ? "plain" : "signal"}
          />
        </div>
      </Screen>

      <ObservationOverview byPage={ledgers} kind="markets" language={language} />

      {rows.length === 0 ? (
        <p>{c.empty}</p>
      ) : (
        <MarketsExplorer rows={rows} language={language} initialQuery={initialQuery} />
      )}

      <Provenance language={language} />
      <DataPageLinks language={language} current="markets" />
    </div>
  );
}
