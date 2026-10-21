import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Bar, Blank, Block, Stat } from "@/components/blueprint";
import { Screen } from "@/components/home/reveal";
import { termNameOrRaw } from "@/components/ontology-labels";
import { getLocale } from "@/lib/locale";
import { breadcrumbLd, pageMetadata } from "@/lib/seo";
import { JsonLd } from "@/components/json-ld";
import { siteNavCopy } from "@/lib/site-nav";
import { href } from "@/lib/routes";
import {
  activitiesOfMarket,
  activityAnchor,
  evidenceForActivity,
  events,
  gates as allGates,
  gatesOfActivity,
  manifest,
  markets,
  marketSlug,
  occupationsOfMarket,
  occupationSlug,
  progress,
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
import { count, detailCopy, fill } from "../copy";
import x from "../markets.module.css";
import { Activities, type ActivityView } from "./activities";

/** Rendered per request from the loaded data release, never at build time. */
export const dynamic = "force-dynamic";

/**
 * One market: its activities, the readings behind each one, and the
 * occupations it reaches.
 *
 * This is the page where a reader can check the chain themselves — activity,
 * level, the tier that capped it, the update it came from, and a link out to
 * the original post. Everything above it on the site is a fold of these rows,
 * so the readings sit inside the activity they belong to rather than in a
 * second table that repeats the same 700 rows in a different order.
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
    markdown: true,
  });
}

export default async function MarketPage({ params }: Props) {
  const { language } = await getLocale();
  const c = detailCopy[language];
  const market = marketForSlug((await params).id);

  if (!market) notFound();

  const name = (language === "zh-CN" ? market.zh_cn : market.en) ?? market.en;
  const sourceUrl = new Map(events().map((event) => [event.event_id, event.source_urls?.[0] ?? null]));
  const caps = progress()?.tier_caps ?? {};
  const levels = Object.fromEntries(
    Object.entries(progress()?.levels ?? {}).map(([rung, words]) => [rung, words[language]]),
  );

  const gateById = new Map(allGates().map((gate) => [gate.gate_id, gate]));

  const activities: ActivityView[] = activitiesOfMarket(market.id).map((activity) => ({
    id: activity.activity_id,
    anchor: activityAnchor(activity.activity_id, market.id),
    name: (language === "zh-CN" ? activity.label_zh_cn : activity.label_en) ?? activity.label_en,
    rung: activity.level === null ? null : Math.floor(activity.level),
    gated: activity.gated,
    // Named, not counted: the snapshot publishes which gate holds which
    // activity, and "held by a rule" is only useful once the rule is on screen.
    //
    // Only for an activity the gate state actually holds. The edges also carry
    // candidates that no review has applied yet, and printing those under a
    // row that is not held would state a rule that is not in force.
    gates: (activity.gated ? gatesOfActivity(activity.activity_id) : []).flatMap((id) => {
      const gate = gateById.get(id);
      if (!gate) return [];
      return [{
        id,
        label: (language === "zh-CN" ? gate.label_zh_cn : gate.label_en) ?? gate.label_en,
        definition:
          (language === "zh-CN" ? gate.definition_zh_cn : gate.definition_en) ??
          gate.definition_en,
      }];
    }),
    tasks: activity.tasks,
    readings: evidenceForActivity(activity.activity_id).flatMap((row, index) => [
      {
        key: `${row.event_id}-${index}`,
        published: row.level,
        publishedRung: row.level === null ? null : Math.floor(row.level),
        judged: row.observed_level,
        tier: row.evidence_tier,
        tierName: termNameOrRaw("evidence_tier", row.evidence_tier, language),
        tierCap: (caps as Record<string, number>)[row.evidence_tier] ?? null,
        title: row.title,
        url: sourceUrl.get(row.event_id) ?? null,
        when: isoDate(row.occurred_at),
      },
      // A post by someone else that confirmed this reading counts toward the level in its own right.
      ...(row.confirmations ?? []).map((v) => {
        const tierCap = (caps as Record<string, number>)[v.evidence_tier] ?? null;
        return {
          key: `${row.event_id}-${index}-${v.source_id}`,
          published: v.level,
          publishedRung: v.level === null ? null : Math.floor(v.level),
          judged: v.observed_level,
          tier: v.evidence_tier,
          tierName: termNameOrRaw("evidence_tier", v.evidence_tier, language),
          // The cap note names the tier, so it is shown only when the tier is what held the reading down.
          tierCap: tierCap !== null && v.level === tierCap ? tierCap : null,
          title: fill(c.confirms, {
            handle: v.handle ?? v.account_key,
            nature: termNameOrRaw("post_nature", v.post_nature, language),
            title: row.title,
          }),
          url: v.url,
          when: isoDate(v.posted_at),
        };
      }),
    ]),
  }));

  const served = occupationsOfMarket(market.id);
  const scored = activities.filter((activity) => activity.rung !== null);
  const readings = activities.flatMap((activity) => activity.readings);
  // The cap is the single largest effect in the method: a vendor's own claim
  // cannot carry a reading past what its tier allows, however sure the judge was.
  const cutBack = readings.filter(
    (reading) =>
      reading.judged !== null && reading.published !== null && reading.judged > reading.published,
  ).length;
  const topRung = scored.reduce<number | null>(
    (best, activity) =>
      activity.rung === null ? best : best === null ? activity.rung : Math.max(best, activity.rung),
    null,
  );
  const gatedCount = activities.filter((activity) => activity.gated).length;
  // Only the gates that hold something here, with the count that belongs to
  // this market rather than the snapshot-wide one.
  const heldHere = new Map<string, number>();
  for (const activity of activities) {
    for (const gate of activity.gates) {
      heldHere.set(gate.id, (heldHere.get(gate.id) ?? 0) + 1);
    }
  }
  const gatesHere = allGates().filter((gate) => heldHere.has(gate.gate_id));

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
        note={fill(topRung === null ? c.answerNone : c.answer, {
          date: manifest()?.generated_at.slice(0, 10) ?? "",
          name,
          n: count(activities.length),
          scored: count(scored.length),
          top: topRung ?? 0,
          readings: count(readings.length),
        })}
      />

      <Screen className={x.stats}>
        <div className={x.rise}>
          <Stat
            label={c.statActivities}
            tone={gatedCount > 0 ? "warning" : "plain"}
            value={count(activities.length)}
            note={
              fill(c.statActivitiesNote, { n: count(scored.length) }) +
              (gatedCount > 0 ? ` · ${fill(c.statGatedNote, { n: count(gatedCount) })}` : "")
            }
          />
        </div>
        <div className={x.rise}>
          <Stat
            label={c.statTop}
            value={topRung === null ? <Blank reason={c.statTopBlank} /> : `L${topRung}`}
            note={topRung === null ? c.statTopBlank : levels[String(topRung)]}
            tone={topRung === null ? "plain" : "signal"}
          />
        </div>
        <div className={x.rise}>
          <Stat
            label={c.statReadings}
            value={count(readings.length)}
            note={fill(c.statReadingsNote, { n: count(cutBack) })}
            tone={cutBack > 0 ? "warning" : "signal"}
          />
        </div>
      </Screen>

      <Block title={c.activitiesTitle} lead={c.activitiesLead}>
        {activities.length === 0 ? (
          <p className={s.note}>{c.activitiesNone}</p>
        ) : (
          <Activities activities={activities} levels={levels} language={language} />
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

      {gatesHere.length > 0 ? (
        <Block title={c.gatesTitle} lead={c.gatesLead} id="gates">
          <TableScroll label={c.gatesTitle}>
            <thead>
              <tr>
                <th scope="col">{c.colGate}</th>
                <th scope="col">{c.colType}</th>
                <th scope="col">{c.colStatus}</th>
                <th scope="col" className="oaw-num">
                  {c.colHolds}
                </th>
              </tr>
            </thead>
            <tbody>
              {gatesHere.map((gate) => (
                <tr key={gate.gate_id}>
                  <th scope="row" className={x.plain}>
                    {(language === "zh-CN" ? gate.label_zh_cn : gate.label_en) ?? gate.label_en}
                    <span className={x.sub}>
                      {(language === "zh-CN" ? gate.definition_zh_cn : gate.definition_en) ??
                        gate.definition_en}
                    </span>
                  </th>
                  <td>{termNameOrRaw("gate_type", gate.gate_type, language)}</td>
                  <td>
                    {gate.status ?? <Missing reason={c.noReading} language={language} inline />}
                  </td>
                  <td className="oaw-num">{count(heldHere.get(gate.gate_id) ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        </Block>
      ) : null}

      <Provenance language={language} />
      <DataPageLinks language={language} current="markets" />
    </div>
  );
}
