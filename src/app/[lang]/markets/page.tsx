import type { Metadata } from "next";
import { Blank, Stat } from "@/components/blueprint";
import { Screen } from "@/components/home/reveal";
import { getLocale } from "@/lib/locale";
import { datasetLd, pageMetadata } from "@/lib/seo";
import { JsonLd } from "@/components/json-ld";
import {
  activitiesOfMarket,
  markets,
  marketSlug,
  occupationsOfMarket,
  progress,
  snapshotExists,
} from "@/lib/snapshot";
import {
  DataPageLinks,
  NoSnapshot,
  PageHeader,
  Provenance,
  dataStyles as s,
} from "@/components/data-page";
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
 * as a table: most markets have no reading at all. Everything below is computed
 * here, on the server, and handed to the interactive part as plain rows — the
 * snapshot module reads from disk and can never cross into a client component.
 */

export async function generateMetadata(): Promise<Metadata> {
  const { language } = await getLocale();
  const c = indexCopy[language];
  return pageMetadata({ language, path: "/markets", title: c.title, description: c.lead });
}

export default async function MarketsPage() {
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

  const rows: MarketRow[] = markets().map((market) => {
    const activities = activitiesOfMarket(market.id);
    const scored = activities.filter((a) => a.level !== null);
    const top = scored.length ? Math.max(...scored.map((a) => a.level ?? 0)) : null;
    const name = (language === "zh-CN" ? market.zh_cn : market.en) ?? market.en;
    return {
      id: market.id,
      slug: marketSlug(market.id),
      en: market.en,
      zh: market.zh_cn ?? market.en,
      name,
      total: activities.length,
      scored: scored.length,
      top,
      rung: top === null ? null : Math.floor(top),
      occupations: occupationsOfMarket(market.id).length,
    };
  });

  const levels = Object.fromEntries(
    Object.entries(progress()?.levels ?? {}).map(([rung, words]) => [rung, words[language]]),
  );
  const rungs = progress()?.stages ?? [];

  const activitiesTotal = rows.reduce((sum, row) => sum + row.total, 0);
  const withReading = rows.filter((row) => row.rung !== null).length;
  const blank = rows.length - withReading;
  const topRung = rows.reduce<number | null>(
    (best, row) => (row.rung === null ? best : best === null ? row.rung : Math.max(best, row.rung)),
    null,
  );
  const atTop = topRung === null ? 0 : rows.filter((row) => row.rung === topRung).length;

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
            value={count(withReading)}
            unit={`/ ${count(rows.length)}`}
            note={fill(c.statCoveredNote, { n: count(blank) })}
            /* The rest are not a measured zero and not a finding about AI:
               they are the limit of what was collected, which is `warning`. */
            tone="warning"
          />
        </div>
        <div className={x.rise}>
          <Stat
            label={c.statTop}
            tag={topRung === null ? undefined : fill(c.statTopTag, { n: count(atTop) })}
            value={topRung === null ? <Blank reason={c.statTopBlank} /> : `L${topRung}`}
            note={topRung === null ? c.statTopBlank : levels[String(topRung)]}
            tone={topRung === null ? "plain" : "signal"}
          />
        </div>
      </Screen>

      {rows.length === 0 ? (
        <p>{c.empty}</p>
      ) : (
        <MarketsExplorer rows={rows} rungs={rungs} levels={levels} language={language} />
      )}

      <Provenance language={language} />
      <DataPageLinks language={language} current="markets" />
    </div>
  );
}
