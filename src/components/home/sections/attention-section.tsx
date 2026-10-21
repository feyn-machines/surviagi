"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { bilingual, type Language } from "@/lib/i18n";
import { updateHref } from "@/lib/routes";
import type { HomeData, HomeUpdate } from "@/lib/home-data";
import { LEVEL_NAMES, TIER_NAMES, levelClass, pick } from "./levels";
import frame from "./section.module.css";
import s from "./attention-section.module.css";

/**
 * Module 04. Attention against level. Every update is one dot: across, how many
 * times its source posts were viewed (log scale); down, the band of the level it
 * was accepted at. Views never enter a level, and the figure shows it - the most
 * viewed updates and the highest accepted ones are different updates.
 */
const copy = bilingual({
  en: {
    eyebrow: "ATTENTION AND LEVEL",
    title: "Most watched: {max} views, L{maxLevel}. Furthest along: {topViews} views, L{top}",
    lead: "Attention never counts toward a level.",
    note: "One dot: one update · Across: views, log scale · Bands: accepted level · Select a dot to open the update",
    all: "All",
    views: "views",
    likes: "likes",
    median: "median",
    updates: "updates",
    mostViewed: "Most viewed",
    highest: "Accepted at L{l}",
    work: "kinds of work",
    claimed: "Claimed L{c} · Accepted L{a}",
    source: "Select the dot to open this update →",
    undated: "Undated",
    axis: "Views of the source posts",
    hint: "Point at a dot to read the update. Select it to open the source.",
  },
  "zh-CN": {
    eyebrow: "关注度与级别",
    title: "最受关注的更新：{max} 次浏览，L{maxLevel}。走得最远的更新：{topViews} 次浏览，L{top}",
    lead: "热度不计入级别。",
    note: "一点：一条更新 · 横轴：浏览量，对数刻度 · 分栏：采信级别 · 点击打开这条更新",
    all: "全部",
    views: "次浏览",
    likes: "次点赞",
    median: "中位数",
    updates: "条更新",
    mostViewed: "浏览最多",
    highest: "按 L{l} 采信",
    work: "项工作",
    claimed: "宣称 L{c} · 采信 L{a}",
    source: "点击这个点，打开这条更新 →",
    undated: "无日期",
    axis: "来源帖子的浏览量",
    hint: "指向一个点查看这条更新，点击打开这条更新。",
  },
});

const VW = 760, LX = 78, RX = VW - 18, TOP = 14;
const LOG_MIN = 2, LOG_MAX = 8.25, BINS = 44, R = 5.4, PITCH = 13, FOOT = 24;
const TICKS = [2, 3, 4, 5, 6, 7, 8];

/** Compact counts written by hand, so server and browser print the same text. */
function compact(n: number, language: Language): string {
  const f = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)).replace(/\.0+$|(\.\d*?)0+$/, "$1");
  if (language === "zh-CN") return n >= 1e8 ? `${f(n / 1e8)} 亿` : n >= 1e4 ? `${f(n / 1e4)} 万` : String(n);
  return n >= 1e6 ? `${f(n / 1e6)}M` : n >= 1e3 ? `${f(n / 1e3)}K` : String(n);
}
const median = (list: number[]) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];

type Dot = { u: HomeUpdate; views: number; level: number; claimed: number; tier: string; works: number; x: number; y: number };

export function AttentionSection({ data, language, index }: { data: HomeData; language: Language; index: string }) {
  const c = copy[language];
  const [kind, setKind] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  const { dots, bands, height, kinds } = useMemo(() => {
    const by = new Map<string, { level: number; claimed: number; tier: string; works: Set<string> }>();
    for (const r of data.rows) {
      const m = by.get(r.update) ?? by.set(r.update, { level: 0, claimed: 0, tier: "T3", works: new Set() }).get(r.update)!;
      m.level = Math.max(m.level, r.accepted);
      m.claimed = Math.max(m.claimed, r.claimed);
      if (r.tier < m.tier) m.tier = r.tier;
      m.works.add(r.work);
    }
    const all: Dot[] = [];
    for (const u of data.updates) {
      const m = by.get(u.id);
      if (!m || !u.views || !m.level) continue;
      all.push({ u, views: u.views, level: m.level, claimed: m.claimed, tier: m.tier, works: m.works.size, x: 0, y: 0 });
    }
    if (!all.length) return { dots: all, bands: [], height: 0, kinds: [] };
    const binOf = (v: number) => Math.min(BINS - 1, Math.max(0, Math.floor(((Math.log10(v) - LOG_MIN) / (LOG_MAX - LOG_MIN)) * BINS)));
    const levels = [...new Set(all.map((d) => d.level))].sort((a, b) => b - a);
    const bands: { level: number; base: number; n: number; median: number }[] = [];
    for (const level of levels) {
      const y = bands.length ? bands[bands.length - 1].base + FOOT : TOP;
      const list = all.filter((d) => d.level === level).sort((a, b) => a.views - b.views);
      const stack = new Map<number, number>();
      for (const d of list) { const b = binOf(d.views); stack.set(b, (stack.get(b) ?? 0) + 1); }
      const h = Math.max(4, ...stack.values()) * PITCH + 12;
      const base = y + h;
      const seen = new Map<number, number>();
      for (const d of list) {
        const b = binOf(d.views), i = seen.get(b) ?? 0;
        seen.set(b, i + 1);
        d.x = LX + ((b + 0.5) / BINS) * (RX - LX);
        d.y = base - R - 1 - i * PITCH;
      }
      bands.push({ level, base, n: list.length, median: median(list.map((d) => d.views)) });
    }
    const tally = new Map<string, { id: string; name: string; n: number }>();
    for (const d of all) {
      if (!d.u.kindId || !d.u.kind) continue;
      const k = tally.get(d.u.kindId) ?? tally.set(d.u.kindId, { id: d.u.kindId, name: pick(d.u.kind, language), n: 0 }).get(d.u.kindId)!;
      k.n += 1;
    }
    return { dots: all, bands, height: bands[bands.length - 1].base + FOOT + 46, kinds: [...tally.values()].filter((k) => k.n >= 8).sort((a, b) => b.n - a.n) };
  }, [data, language]);


  if (!dots.length) return null;

  const xOf = (log: number) => LX + ((log - LOG_MIN) / (LOG_MAX - LOG_MIN)) * (RX - LX);
  const ranked = [...dots].sort((a, b) => b.views - a.views);
  const topLevel = bands[0].level;
  const atTop = ranked.filter((d) => d.level === topLevel);
  const shown = hover ? dots.find((d) => d.u.id === hover) : undefined;
  const title = c.title.replace("{max}", "|" + compact(ranked[0].views, language) + "|").replace("{maxLevel}", String(ranked[0].level))
    .replace("{top}", String(topLevel)).replace("{topViews}", "|" + compact(atTop[0].views, language) + "|").split("|");

  const item = (d: Dot) => {
    const body = (
      <>
        <div className={s.h}><b>{compact(d.views, language)}</b><span className={`${s.tag} ${s[levelClass(d.level)]}`}>L{d.level}</span></div>
        <div className={s.t}>{d.u.title}</div>
        <div className={frame.mono}>{d.u.org} · {d.u.date ?? c.undated}{d.u.kind ? ` · ${pick(d.u.kind, language)}` : ""}</div>
      </>
    );
    return d.u.url
      ? <Link key={d.u.id} className={s.item} href={updateHref(language, d.u.id)}>{body}</Link>
      : <div key={d.u.id} className={s.item}>{body}</div>;
  };

  return (
    <section id="attention" className={frame.sec}>
      <div className={frame.eyebrow}>[ {index} ] &nbsp;{c.eyebrow}</div>
      <h2 className={frame.h2}>{title.map((part, i) => (i % 2 ? <b key={i}>{part}</b> : part))}</h2>
      <p className={frame.lead}>{c.lead.replace("{n}", String(dots.length)).replace("{sum}", compact(dots.reduce((sum, d) => sum + d.views, 0), language)).replace("{medians}", bands.map((b) => `L${b.level} ${compact(b.median, language)}`).join(language === "zh-CN" ? "，" : ", "))}</p>
      <p className={frame.note}>{c.note}</p>

      <div className={s.kinds}>
        <button type="button" className={`${frame.chip} ${kind === null ? frame.chipOn : ""}`} onClick={() => setKind(null)}>{c.all} {dots.length}</button>
        {kinds.map((k) => (
          <button key={k.id} type="button" className={`${frame.chip} ${kind === k.id ? frame.chipOn : ""}`} aria-pressed={kind === k.id} onClick={() => setKind(kind === k.id ? null : k.id)}>{k.name} {k.n}</button>
        ))}
      </div>

      <div className={`${frame.stage} ${s.wrap}`}>
        <div className={s.chart}>
          <svg viewBox={`0 0 ${VW} ${height}`} width="100%" role="img" aria-label={c.axis} onMouseLeave={() => setHover(null)}>
            {TICKS.map((t) => (
              <g key={t}>
                <line className={s.rule} x1={xOf(t)} x2={xOf(t)} y1={TOP} y2={height - 46} />
                <text x={xOf(t)} y={height - 30} textAnchor="middle">{compact(10 ** t, language)}</text>
              </g>
            ))}
            <text x={RX} y={height - 8} textAnchor="end" className={s.axisName}>{c.axis} →</text>
            {bands.map((b) => (
              <g key={b.level}>
                <line className={`${s.base} ${b.level >= 3 ? s.cut : ""}`} x1={0} x2={RX} y1={b.base} y2={b.base} />
                <text x={0} y={b.base - 22} className={`${s.lv} ${b.level >= 3 ? s.sig : ""}`}>L{b.level}</text>
                <text x={0} y={b.base - 7}>{b.n} {c.updates}</text>
                <path className={s.med} d={`M${xOf(Math.log10(b.median))} ${b.base + 2} l4 6 h-8 z`} />
                <text x={xOf(Math.log10(b.median)) + 9} y={b.base + 12}>{c.median} {compact(b.median, language)}</text>
              </g>
            ))}
            {dots.map((d) => {
              const off = kind !== null && d.u.kindId !== kind;
              const dot = (
                <circle
                  cx={d.x} cy={d.y} r={hover === d.u.id ? R + 2 : R}
                  className={`${s.dot} ${s[levelClass(d.level)]} ${off ? s.dim : ""} ${hover === d.u.id ? s.hot : ""}`}
                  onMouseEnter={() => setHover(d.u.id)}
                />
              );
              return d.u.url
                ? <a key={d.u.id} href={updateHref(language, d.u.id)} aria-label={`${d.u.title} · ${compact(d.views, language)} ${c.views} · L${d.level}`} onFocus={() => setHover(d.u.id)}>{dot}</a>
                : <g key={d.u.id}>{dot}</g>;
            })}
          </svg>
        </div>

        <aside className={s.side}>
          {shown ? (
            <div className={s.detail}>
              <div className={frame.mono}>{shown.u.org} · {shown.u.date ?? c.undated}{shown.u.kind ? ` · ${pick(shown.u.kind, language)}` : ""}</div>
              <strong>{compact(shown.views, language)}</strong>
              <div className={frame.mono}>{c.views}{shown.u.likes != null ? ` · ${compact(shown.u.likes, language)} ${c.likes}` : ""}</div>
              <h3>{shown.u.title}</h3>
              <p>{shown.u.summary}</p>
              <div className={s.facts}>
                <span className={`${s.tag} ${s[levelClass(shown.level)]}`}>L{shown.level} {LEVEL_NAMES[language][shown.level]}</span>
                <span className={frame.mono}>{TIER_NAMES[language][shown.tier] ?? shown.tier}</span>
                <span className={frame.mono}>{shown.works} {c.work}</span>
                {shown.claimed > shown.level && <span className={`${frame.mono} ${s.warn}`}>{c.claimed.replace("{c}", String(shown.claimed)).replace("{a}", String(shown.level))}</span>}
              </div>
              <div className={`${frame.mono} ${s.go}`}>{c.source}</div>
            </div>
          ) : (
            <>
              <div className={`${s.group} ${frame.mono}`}>{c.highest.replace("{l}", String(topLevel))}</div>
              {atTop.slice(0, 3).map(item)}
              <div className={`${s.group} ${frame.mono}`}>{c.mostViewed}</div>
              {ranked.slice(0, 3).map(item)}
              <p className={s.hint}>{c.hint}</p>
            </>
          )}
        </aside>
      </div>
    </section>
  );
}
