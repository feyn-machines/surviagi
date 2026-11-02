import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Bar, Block, Stat } from "@/components/blueprint";
import { Screen } from "@/components/home/reveal";
import { termNameOrRaw } from "@/components/ontology-labels";
import { getLocale } from "@/lib/locale";
import { breadcrumbLd, pageMetadata } from "@/lib/seo";
import { JsonLd } from "@/components/json-ld";
import { siteNavCopy } from "@/lib/site-nav";
import { href } from "@/lib/routes";
import { indexable } from "@/lib/site-pages";
import {
  activitiesOfMarket,
  activityAnchor,
  linksOfWork,
  manifest,
  markets,
  marketSlug,
  occupationsOfMarket,
  occupationSlug,
} from "@/lib/snapshot";
import {
  DataPageLinks,
  Missing,
  PageHeader,
  Provenance,
  TableScroll,
  dataStyles as s,
  isoDate,
} from "@/components/data-page";
import { updateDateLabel } from "@/lib/update-date";
import { count, detailCopy, fill } from "../copy";
import x from "../markets.module.css";
import { Activities, type ActivityView, type UpdateView } from "./activities";

/** Rendered per request from the loaded data release, never at build time. */
export const dynamic = "force-dynamic";

/**
 * One market: its kinds of work, the collected updates that bear on each one,
 * and the occupations it reaches.
 *
 * Nothing here is scored. A reader checks the claim themselves: the kind of
 * work, the update, who said it and when, and a link out to the original post.
 */

type Props = { params: Promise<{ id: string }> };

function marketForSlug(slug: string) {
  return markets().find((market) => marketSlug(market.id) === slug);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { language } = await getLocale();
  const c = detailCopy[language];
  const id = (await params).id;
  const market = marketForSlug(id);
  if (!market) notFound();
  const name = (language === "zh-CN" ? market.zh_cn : market.en) ?? market.en;
  return pageMetadata({
    language,
    path: `/markets/${id}`,
    title: `${name} · ${c.metaSuffix}`,
    description: fill(c.metaDescription, { name, count: market.activities }),
    // A market no update bears on has nothing of its own to show yet.
    index: indexable.market(market.id),
    markdown: true,
  });
}

export default async function MarketPage({ params }: Props) {
  const { language } = await getLocale();
  const c = detailCopy[language];
  const market = marketForSlug((await params).id);

  if (!market) notFound();

  const name = (language === "zh-CN" ? market.zh_cn : market.en) ?? market.en;
  const activities: ActivityView[] = activitiesOfMarket(market.id).map((activity) => ({
    id: activity.activity_id,
    anchor: activityAnchor(activity.activity_id, market.id),
    name: (language === "zh-CN" ? activity.label_zh_cn : activity.label_en) ?? activity.label_en,
    tasks: activity.tasks,
    updates: linksOfWork(activity.activity_id).flatMap((row, index): UpdateView[] => [
      {
        key: `${row.event_id}-${index}`,
        eventId: row.event_id,
        title: row.title,
        url: row.source_urls[0] ?? null,
        org: row.org_name,
        when: updateDateLabel(row, language),
        alsoBy: null,
      },
      // A post by someone else that says the same: recorded, not verified.
      ...(row.confirmations ?? []).map((v) => ({
        key: `${row.event_id}-${index}-${v.source_id}`,
        eventId: null,
        title: fill(c.alsoSays, {
          handle: v.handle ?? v.account_key,
          nature: termNameOrRaw("post_nature", v.post_nature, language),
          title: row.title,
        }),
        url: v.url,
        org: null,
        when: isoDate(v.posted_at),
        alsoBy: v.handle ?? v.account_key,
      })),
    ]),
  }));

  const served = occupationsOfMarket(market.id);
  const withUpdates = activities.filter((activity) => activity.updates.some((u) => u.alsoBy === null));
  const updateIds = new Set(
    activities.flatMap((activity) => activity.updates.flatMap((u) => (u.eventId ? [u.eventId] : []))),
  );
  return (
    <div className={s.page}>
      <JsonLd data={breadcrumbLd(language, [{ name: siteNavCopy[language].markets, path: "/markets" }, { name, path: `/markets/${(await params).id}` }])} />
      <Link className="oaw-back" href={href(language, "/markets")}>
        {c.back}
      </Link>
      <PageHeader
        eyebrow={c.eyebrow}
        title={name}
        lead={c.lead}
        // The page's answer in one dated sentence with its numbers, the line an engine can quote.
        note={fill(updateIds.size === 0 ? c.answerNone : c.answer, {
          date: manifest()?.generated_at.slice(0, 10) ?? "",
          name,
          n: count(activities.length),
          scored: count(withUpdates.length),
          updates: count(updateIds.size),
        })}
      />

      <Screen className={x.stats}>
        <div className={x.rise}>
          <Stat
            label={c.statActivities}
            tone="plain"
            value={count(activities.length)}
            note={fill(c.statActivitiesNote, { n: count(withUpdates.length) })}
          />
        </div>
        <div className={x.rise}>
          <Stat
            label={c.statUpdates}
            value={count(updateIds.size)}
            note={c.statUpdatesNote}
            tone={updateIds.size === 0 ? "plain" : "signal"}
          />
        </div>
        <div className={x.rise}>
          <Stat
            label={c.statOccupations}
            value={count(served.length)}
            note={c.statOccupationsNote}
            tone="plain"
          />
        </div>
      </Screen>

      <Block title={c.activitiesTitle} lead={c.activitiesLead}>
        {activities.length === 0 ? (
          <p className={s.note}>{c.activitiesNone}</p>
        ) : (
          <Activities activities={activities} language={language} />
        )}
      </Block>

      <Block title={c.occupationsTitle} lead={c.occupationsLead}>
        {served.length === 0 ? (
          <div className={x.empty}>
            <p className={x.emptyTitle}>{c.occupationsNone}</p>
            <p className={x.emptyWhy}>{c.occupationsWhy}</p>
          </div>
        ) : (
          <TableScroll label={c.occupationsLabel}>
            <thead>
              <tr>
                <th scope="col">{c.colOccupation}</th>
                <th scope="col">{c.colConfidence}</th>
              </tr>
            </thead>
            <tbody>
              {served.map((edge) => (
                <tr key={edge.occupation_id}>
                  <th scope="row" className={x.plain}>
                    <Link href={href(language, `/occupations/${occupationSlug(edge.occupation_id)}`)}>
                      {(language === "zh-CN" ? edge.occupation_zh_cn : edge.occupation_en) ??
                        edge.occupation_en}
                    </Link>
                  </th>
                  <td>
                    {edge.confidence === null ? (
                      <Missing reason={c.noReading} language={language} inline />
                    ) : (
                      <span className={x.levelCell}>
                        <span className={x.rung}>{edge.confidence.toFixed(2)}</span>
                        <span className={x.track}>
                          <Bar share={edge.confidence} />
                        </span>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        )}
      </Block>

      <Provenance language={language} />
      <DataPageLinks language={language} current="markets" />
    </div>
  );
}
