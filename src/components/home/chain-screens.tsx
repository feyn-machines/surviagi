"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { Language } from "@/lib/i18n";
import { href } from "@/lib/routes";
import { ProgressCompare, type CompareRow } from "@/components/progress-compare";
import { activityAnchor as anchor } from "@/lib/anchors";
import { Screen } from "./reveal";
import s from "./home.module.css";

/**
 * Screens 1-4: an update, the work it landed on, the markets that work belongs
 * to, and the occupation groups those markets serve.
 *
 * They are one component because they are one sentence. Picking a different
 * point on the axis has to change all four at once; splitting them would mean
 * lifting the selection into a context and re-deriving the same joins in four
 * places.
 *
 * Everything renders in its final state on the server for the default
 * selection, so the four screens are readable with JavaScript off. The
 * interaction adds the ability to choose a different update; it is not what
 * makes the content exist.
 */

export type HomeReading = {
  /** Key into `activities`; the labels are sent once, not once per reading. */
  id: string;
  /** What the site stands behind, after the evidence tier's cap. */
  level: number | null;
  /** What the judge read out of the update, before that cap. */
  judged: number | null;
  tier: string;
};

/** Activity labels, sent once. 710 readings point at 130 distinct activities. */
export type HomeActivity = {
  en: string;
  zh: string | null;
  market: string | null;
  /** How much real work this activity covers. An activity is abstract; the
   *  task count is the only thing on this screen with a unit a reader owns. */
  tasks: number;
  /** Gate names holding it, if any. An update can raise a reading on work that
   *  a gate caps at L3 regardless, and that contradiction belongs on the row. */
  gates: string[];
};

export type HomeEvent = {
  id: string;
  title: string;
  date: string | null;
  org: string | null;
  activities: number;
  markets: number;
  top: number | null;
  tier: string | null;
  urls: string[];
  readings: HomeReading[];
  marketIds: string[];
  groupIds: string[];
};

/**
 * Generic in the href so a row can narrow it to one family of routes. Build the
 * link with `href()` from `@/lib/routes` rather than casting with `as Route`,
 * which waves a dead path through as well, the rot that left three dead links
 * in this repo.
 */
export type HomeRow<T extends string = string> = CompareRow<T> & { id: string };

const COPY = {
  en: {
    s1Eyebrow: "01 — What just happened",
    s1Title: "Updates that landed on real work",
    s1Note: "{all} updates read. {n} landed on real work.",
    s1Axis: "Time axis of updates that produced a reading",
    axisHint: "taller = hit more work",
    axisUndated: "{n} undated",
    hit: "{n} pieces of work",
    across: "{n} markets",
    highest: "{level}",
    tier: "{tier}",
    source: "See the source ↗",
    sourceMore: "{n} sources",
    allUpdates: "All {n} updates →",
    s2Eyebrow: "02 — The work it landed on",
    s2Title: "What this update actually touched",
    s2Note: "Solid — what we publish. Dashed — what the judge read.",
    colWork: "Work",
    colPublished: "Published",
    colJudged: "Judged",
    colTier: "Tier",
    coversTasks: "covers {n} tasks",
    gatedMark: "barrier",
    gatedNote: "{n} of these face a non-technical barrier: however good the model, a person stays in the loop.",
    capNote: "{tier} is the vendor\u2019s own word. It stops at L{cap}. The judge put {n} of these higher.",
    capNoneNote: "Nothing here was capped.",
    andMore: "+{n} more on the market pages",
    s3Eyebrow: "03 — Which markets that work belongs to",
    s3Title: "The markets behind it",
    s3Note: "The same hundred squares, one row per market.",
    allMarkets: "All {n} markets →",
    s4Eyebrow: "04 — And which occupations",
    s4Title: "Who does this work for a living",
    s4Note: "All {n} groups. Marked ones this update reached.",
    findYours: "Find your own occupation →",
    noMarkets: "Not mapped to a market yet.",
    noDate: "no date recorded",
  },
  "zh-CN": {
    s1Eyebrow: "01 — 刚刚发生了什么",
    s1Title: "落到真实工作上的更新",
    s1Note: "读了 {all} 条更新，{n} 条真的打到了工作。",
    s1Axis: "产出过读数的更新的时间轴",
    axisHint: "越高，打到的工作越多",
    axisUndated: "{n} 条无时间",
    hit: "{n} 项工作",
    across: "{n} 个赛道",
    highest: "最高 {level}",
    tier: "{tier}",
    source: "看源头 ↗",
    sourceMore: "{n} 个来源",
    allUpdates: "全部 {n} 条更新 →",
    s2Eyebrow: "02 — 它打到了哪些工作",
    s2Title: "这条更新实际触到的东西",
    s2Note: "实心——我们发布的。虚线——判官给的。",
    colWork: "工作",
    colPublished: "发布值",
    colJudged: "判官值",
    colTier: "层级",
    coversTasks: "覆盖 {n} 项任务",
    gatedMark: "有非技术障碍",
    gatedNote: "其中 {n} 项有非技术障碍：模型再强，也离不开人。",
    capNote: "{tier} 是厂商自己说的，最多算到 L{cap}。这里有 {n} 条判官给得更高。",
    capNoneNote: "这里没有一条被压低。",
    andMore: "另有 {n} 条，在赛道页",
    s3Eyebrow: "03 — 这些工作属于哪些赛道",
    s3Title: "它背后的赛道",
    s3Note: "同样的一百格，一个赛道一行。",
    allMarkets: "全部 {n} 个赛道 →",
    s4Eyebrow: "04 — 又属于哪些职业",
    s4Title: "靠这份工作吃饭的是谁",
    s4Note: "{n} 个职业组全画。打点的是这条更新碰到的。",
    findYours: "找你自己的职业 →",
    noMarkets: "还没有映射到赛道。",
    noDate: "未记录日期",
  },
} as const;

function levelWord(
  value: number | null,
  words: Record<string, Record<string, string>>,
  language: Language,
): string | null {
  if (value === null) return null;
  const key = String(Math.floor(value));
  const word = words[key]?.[language];
  return word ? `L${key} · ${word}` : `L${key}`;
}

export function ChainScreens<M extends string, G extends string>({
  events,
  activities,
  markets,
  groups,
  levels,
  tierCaps,
  language,
  updatesTotal,
  marketsTotal,
}: {
  events: HomeEvent[];
  activities: Record<string, HomeActivity>;
  markets: Record<string, HomeRow<M>>;
  groups: HomeRow<G>[];
  levels: Record<string, Record<string, string>>;
  tierCaps: Record<string, number>;
  language: Language;
  updatesTotal: number;
  marketsTotal: number;
}) {
  const c = COPY[language];
  // The default is the most recent update that reached at least three pieces of
  // work: the newest update overall is often one that landed on a single
  // activity, which makes the three screens under it look like the method found
  // almost nothing.
  const initial = useMemo(() => {
    const newestFirst = [...events].reverse();
    const wide = (e: HomeEvent) => e.activities >= 3;
    // Two thirds of all readings are held below what the judge read, so an
    // update where nothing was capped is the ATYPICAL one - and screen 2's
    // most important sentence is the one explaining that gap. Opening on an
    // update with no capped reading hides the method's largest effect behind
    // an interaction the reader has no reason to perform.
    const capped = (e: HomeEvent) =>
      e.readings.some(
        (r) =>
          r.judged !== null && r.level !== null && Math.floor(r.judged) > Math.floor(r.level),
      );
    return (
      newestFirst.find((e) => wide(e) && capped(e)) ??
      newestFirst.find(wide) ??
      events[events.length - 1]
    )?.id ?? null;
  }, [events]);
  const [selectedId, setSelectedId] = useState<string | null>(initial);
  const selected = events.find((e) => e.id === selectedId) ?? events[events.length - 1];

  // Only dated updates can sit on a time axis. Two of the 256 carry no
  // occurred_at, and taking the range off events[0] put `Date.parse("")` -
  // NaN, coerced to the 1970 epoch - at one end: the span became fifty-six
  // years and every real date landed within a pixel of the right edge. An
  // undated update is not placed at a guessed date; it is left off the axis and
  // counted underneath it, which is what the rest of the site does with a
  // missing value.
  const dated = useMemo(
    () => events.filter((e) => e.date && Number.isFinite(Date.parse(e.date))),
    [events],
  );
  const undated = events.length - dated.length;
  const from = dated.length ? Date.parse(dated[0].date as string) : 0;
  const to = dated.length ? Date.parse(dated[dated.length - 1].date as string) : 0;
  const span = to - from;
  const first = dated[0]?.date?.slice(0, 10) ?? "";
  const last = dated[dated.length - 1]?.date?.slice(0, 10) ?? "";

  const marketRows = (selected?.marketIds ?? [])
    .map((id) => markets[id])
    .filter((row): row is HomeRow<M> => Boolean(row));
  const reachedGroups = new Set(selected?.groupIds ?? []);

  const shown = selected?.readings ?? [];
  const held = shown.filter(
    (r) => r.judged !== null && r.level !== null && Math.floor(r.judged) > Math.floor(r.level),
  );
  const capTier = held[0]?.tier ?? null;
  const gatedHere = shown.filter((r) => activities[r.id]?.gates?.length).length;

  return (
    <>
      {/* ---------------------------------------------------------------- 01 */}
      <Screen id="latest" className={s.screen}>
        <p className={s.eyebrow}>{c.s1Eyebrow}</p>
        <h2 className={s.h2}>{c.s1Title}</h2>
        <p className={s.note}>
          {c.s1Note
            .replace("{n}", String(events.length))
            .replace("{all}", String(updatesTotal))}
        </p>

        {/* A real time axis: every update sits at its own date, so the shape of
            the collection - three weeks, heavily clustered - is visible before
            a single label is read. The earlier build laid 256 squares out in a
            wrapping flex row, which threw the dates away and rendered as a
            180px smear that did not look clickable, let alone like a timeline. */}
        <div className={s.axis}>
          <ul className={s.plot} role="listbox" aria-label={c.s1Axis}>
            {dated.map((event, i) => {
              const on = event.id === selected?.id;
              const at = span > 0 ? (Date.parse(event.date as string) - from) / span : i / dated.length;
              return (
                <li
                  key={event.id}
                  className={`${s.tick}${on ? ` ${s.tickOn}` : ""}`}
                  style={{
                    ["--x" as string]: `${Math.min(99.6, Math.max(0, at * 100))}%`,
                    ["--i" as string]: i,
                    // Taller for an update that reached more work, so the axis
                    // carries the finding and not only the dates.
                    ["--h" as string]: `${Math.min(100, 24 + event.activities * 9)}%`,
                  }}
                >
                  <button
                    type="button"
                    role="option"
                    aria-selected={on}
                    className={s.tickHit}
                    onMouseEnter={() => setSelectedId(event.id)}
                    onFocus={() => setSelectedId(event.id)}
                    onClick={() => setSelectedId(event.id)}
                  >
                    <span className={s.tickLine} aria-hidden="true" />
                    <span className={s.tickNode} aria-hidden="true" />
                    <span className="oaw-sr-only">
                      {event.date?.slice(0, 10) ?? c.noDate} · {event.title}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className={s.axisEnds} aria-hidden="true">
            <span>{first}</span>
            <span className={s.axisHint}>
              {c.axisHint}
              {undated > 0 ? ` · ${c.axisUndated.replace("{n}", String(undated))}` : ""}
            </span>
            <span>{last}</span>
          </div>
        </div>

        {selected ? (
          <article className={s.card}>
            <p className={s.cardMeta}>
              {selected.date?.slice(0, 10) ?? c.noDate}
              {selected.org ? ` · ${selected.org}` : ""}
            </p>
            <h3 className={s.cardTitle}>{selected.title}</h3>
            <p className={s.cardStats}>
              {c.hit.replace("{n}", String(selected.activities))} ·{" "}
              {c.across.replace("{n}", String(selected.markets))}
              {selected.top !== null
                ? ` · ${c.highest.replace("{level}", levelWord(selected.top, levels, language) ?? "")}`
                : ""}
              {selected.tier ? ` · ${c.tier.replace("{tier}", selected.tier)}` : ""}
            </p>
            {selected.urls.length > 0 ? (
              <p className={s.cardLinks}>
                <a href={selected.urls[0]} rel="nofollow noopener noreferrer" target="_blank">
                  {c.source}
                </a>
                {selected.urls.length > 1 ? (
                  <span className={s.cardMore}>
                    {c.sourceMore.replace("{n}", String(selected.urls.length))}
                  </span>
                ) : null}
              </p>
            ) : null}
          </article>
        ) : null}

        <p className={s.exit}>
          <Link className="text-link" href={href(language, "/updates")}>
            {c.allUpdates.replace("{n}", String(updatesTotal))}
          </Link>
        </p>
      </Screen>

      {/* ---------------------------------------------------------------- 02 */}
      <Screen className={s.screen}>
        <p className={s.eyebrow}>{c.s2Eyebrow}</p>
        <h2 className={s.h2}>{c.s2Title}</h2>
        <p className={s.note}>{c.s2Note}</p>

        <ul className={s.fan}>
          {shown.map((row, i) => {
            const activity = activities[row.id];
            const name =
              (language === "zh-CN" ? activity?.zh : activity?.en) ?? activity?.en ?? row.id;
            const published = row.level === null ? 0 : Math.floor(row.level);
            const judged = row.judged === null ? 0 : Math.floor(row.judged);
            return (
              <li key={`${row.id}-${i}`} className={s.fanRow} style={{ ["--i" as string]: i }}>
                <span className={s.fanName}>
                  {activity?.market ? (
                    <Link
                      href={href(language, `/markets/${activity.market.replace(/^oaw:market:/, "")}#${anchor(
                        row.id,
                        activity.market,
                      )}`)}
                    >
                      {name}
                    </Link>
                  ) : (
                    name
                  )}
                </span>
                <span className={s.fanBar} aria-hidden="true">
                  {[0, 1, 2, 3, 4].map((step) => (
                    <span
                      key={step}
                      className={`${s.step}${step < published ? ` ${s.stepOn}` : ""}${
                        step >= published && step < judged ? ` ${s.stepJudged}` : ""
                      }`}
                    />
                  ))}
                </span>
                <span className={s.fanLevel}>
                  {levelWord(row.level, levels, language) ?? "—"}
                  <span className={s.fanTasks}>
                    {c.coversTasks.replace("{n}", String(activity?.tasks ?? 0))}
                  </span>
                </span>
                <span className={s.fanTier}>
                  {row.tier}
                  {activity?.gates?.length ? (
                    <span className={s.fanGate} title={activity.gates.join(" · ")}>
                      {c.gatedMark}
                    </span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>

        {gatedHere > 0 ? (
          <p className={s.gatedNote}>
            {c.gatedNote.replace("{n}", String(gatedHere))}
          </p>
        ) : null}

        <p className={s.capNote}>
          {held.length > 0 && capTier
            ? c.capNote
                .replace("{tier}", capTier)
                .replace("{cap}", String(tierCaps[capTier] ?? ""))
                .replace("{n}", String(held.length))
            : c.capNoneNote}
        </p>
        {selected && selected.activities > shown.length ? (
          <p className={s.exit}>
            {c.andMore.replace("{n}", String(selected.activities - shown.length))}
          </p>
        ) : null}
      </Screen>

      {/* ---------------------------------------------------------------- 03 */}
      <Screen className={s.screen}>
        <p className={s.eyebrow}>{c.s3Eyebrow}</p>
        <h2 className={s.h2}>{c.s3Title}</h2>
        <p className={s.note}>{c.s3Note}</p>
        {marketRows.length === 0 ? (
          <p className={s.note}>{c.noMarkets}</p>
        ) : (
          <ProgressCompare rows={marketRows} language={language} />
        )}
        <p className={s.exit}>
          <Link className="text-link" href={href(language, "/markets")}>
            {c.allMarkets.replace("{n}", String(marketsTotal))}
          </Link>
        </p>
      </Screen>

      {/* ---------------------------------------------------------------- 04 */}
      <Screen className={s.screen}>
        <p className={s.eyebrow}>{c.s4Eyebrow}</p>
        <h2 className={s.h2}>{c.s4Title}</h2>
        <p className={s.note}>{c.s4Note.replace("{n}", String(groups.length))}</p>
        <ProgressCompare rows={groups} language={language} mark={reachedGroups} />
        <p className={s.exit}>
          <Link className="text-link" href={href(language, "/occupations")}>
            {c.findYours}
          </Link>
        </p>
      </Screen>
    </>
  );
}
