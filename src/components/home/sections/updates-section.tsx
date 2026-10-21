"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { bilingual, type Language } from "@/lib/i18n";
import { updateHref } from "@/lib/routes";
import type { HomeData, HomeRow, HomeUpdate } from "@/lib/home-data";
import { LEVEL_NAMES, TIER_NAMES, WEEKDAYS, isoDay, levelClass, pick } from "./levels";
import frame from "./section.module.css";
import s from "./updates-section.module.css";

/**
 * Module 01. The globe cut open along time: columns are dates, rows are
 * domains, and every mark is one update bearing on one kind of work. The panel
 * beside it lists what the selected day's updates did, in full.
 */
const copy = bilingual({
  en: {
    eyebrow: "LATEST UPDATES",
    title: "In {days} days, {n} AI updates bear on specific work",
    lead: "{orgs} companies. {works} kinds of work. {domains} domains. Scroll to replay it day by day.",
    note: "Across: date · Rows: domain · Mark height: accepted level · Outline: claimed level",
    companies: "Company",
    perDay: "Updates per day",
    updates: "Updates",
    works: "Work reached",
    pinned: "Pinned",
    firstAny: "First reached by an update",
    firstL2: "First at L2",
    firstL3: "First at L3",
    byCompany: "Company",
    byKind: "Type",
    claimed: "Claimed",
    accepted: "Accepted",
    firstAt: "First at L{n}",
    more: "+{n} more",
    sources: "{n} source(s)",
    original: "Title and summary in the original",
    source: "Open →",
    none: "No update bore on specific work this day.",
    undated: "undated",
    chartLabel: "Updates by date and domain",
  },
  "zh-CN": {
    eyebrow: "最新更新",
    title: "{days} 天内，{n} 条 AI 更新涉及具体工作",
    lead: "{orgs} 家公司，{works} 项工作，{domains} 个领域。向下滚动，逐日回看。",
    note: "横轴：日期 · 行：领域 · 柱高：采信级别 · 线框：宣称级别",
    companies: "公司",
    perDay: "每天更新数",
    updates: "更新",
    works: "涉及的工作",
    pinned: "已固定",
    firstAny: "首次有更新涉及",
    firstL2: "首次达到 L2",
    firstL3: "首次达到 L3",
    byCompany: "公司",
    byKind: "类型",
    claimed: "宣称",
    accepted: "采信",
    firstAt: "首次达到 L{n}",
    more: "+{n} 项工作",
    sources: "{n} 个来源",
    original: "标题与摘要为原文",
    source: "打开 →",
    none: "这一天没有涉及具体工作的更新。",
    undated: "未标日期",
    chartLabel: "按日期和领域排列的更新",
  },
});

const VW = 820, LX = 150, RX = VW - 12, STRIP = 58, TOP = 96, RH = 34, U = 7.5;
const FILL = { l1: "var(--ah-color-control)", l2: "#4f7d58", l3: "var(--ah-color-signal)" } as const;

type Mark = { row: HomeRow; x: number; y: number; w: number; cx: number; cy: number; day: number; domain: number };

export function UpdatesSection({ data, language, index }: { data: HomeData; language: Language; index: string }) {
  const c = copy[language];
  const svgRef = useRef<SVGSVGElement>(null);
  const [org, setOrg] = useState<string | null>(null);
  const [pin, setPin] = useState(false);

  const model = useMemo(() => {
    const workById = new Map(data.works.map((w) => [w.id, w]));
    const updateById = new Map(data.updates.map((u) => [u.id, u]));
    const perDomain = new Map<string, number>();
    for (const w of data.works) perDomain.set(w.domainId, (perDomain.get(w.domainId) ?? 0) + 1);
    const domains = [...perDomain.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => ({ id }));
    const rowOf = new Map(domains.map((d, i) => [d.id, i]));
    const cw = (RX - LX) / data.days;

    const cells = new Map<string, HomeRow[]>();
    const rowsOfUpdate = new Map<string, HomeRow[]>();
    for (const r of data.rows) {
      (rowsOfUpdate.get(r.update) ?? rowsOfUpdate.set(r.update, []).get(r.update)!).push(r);
      const u = updateById.get(r.update), w = workById.get(r.work);
      if (!u?.date || !w) continue;
      const key = `${u.day}|${rowOf.get(w.domainId)}`;
      (cells.get(key) ?? cells.set(key, []).get(key)!).push(r);
    }
    const marks: Mark[] = [];
    for (const [key, list] of cells) {
      const [day, domain] = key.split("|").map(Number);
      list.sort((a, b) => b.accepted - a.accepted || b.claimed - a.claimed);
      const pitch = Math.min(4, (cw - 3) / list.length), w = Math.max(1, pitch - 1);
      const x0 = LX + day * cw + (cw - list.length * pitch) / 2, base = TOP + (domain + 1) * RH - 1;
      list.forEach((row, j) => marks.push({ row, x: x0 + j * pitch, y: base, w, cx: x0 + j * pitch + w / 2, cy: base - (row.accepted * U) / 2, day, domain }));
    }

    const orgs = new Map<string, number>();
    const perDay = Array.from({ length: data.days }, () => new Map<string, number>());
    for (const u of data.updates) {
      orgs.set(u.org, (orgs.get(u.org) ?? 0) + 1);
      if (u.date) perDay[u.day].set(u.org, (perDay[u.day].get(u.org) ?? 0) + 1);
    }
    const orgList = [...orgs.entries()].sort((a, b) => b[1] - a[1]);
    const dayTotals = perDay.map((m) => [...m.values()].reduce((a, b) => a + b, 0));

    // The earliest dated update that took a kind of work to each threshold.
    const first = [1, 2, 3].map(() => new Map<string, { day: number; update: string }>());
    for (const r of data.rows) {
      const u = updateById.get(r.update);
      if (!u?.date) continue;
      first.forEach((map, i) => {
        if (r.accepted < i + 1) return;
        const seen = map.get(r.work);
        if (!seen || u.day < seen.day) map.set(r.work, { day: u.day, update: r.update });
      });
    }
    const lastDay = dayTotals.reduce((keep, n, i) => (n ? i : keep), 0);
    return { workById, updateById, domains, cw, marks, orgList, perDay, dayTotals, dayMax: Math.max(1, ...dayTotals), rowsOfUpdate, first, lastDay };
  }, [data]);

  const [day, setDay] = useState(model.lastDay);

  // As a scene, the scroll is time: the block pins and the cursor walks the window from its first day to its last.
  useEffect(() => {
    const block = svgRef.current?.closest("[data-travel]");
    if (!block) return;
    const onScene = (e: Event) => { if (!pin) setDay(Math.round((e as CustomEvent<number>).detail * model.lastDay)); };
    block.addEventListener("scene", onScene);
    return () => block.removeEventListener("scene", onScene);
  }, [pin, model.lastDay]);
  const height = TOP + model.domains.length * RH + 8;

  const items = useMemo(() => {
    const list = data.updates.filter((u) => u.date && u.day === day && (!org || u.org === org)).map((u) => {
      const rows = [...(model.rowsOfUpdate.get(u.id) ?? [])].sort((a, b) => b.accepted - a.accepted || b.claimed - a.claimed);
      return { u, rows, top: Math.max(...rows.map((r) => r.accepted)) };
    });
    return list.sort((a, b) => b.top - a.top || b.rows.length - a.rows.length);
  }, [data.updates, day, org, model]);

  const shown = new Set(items.map((x) => x.u.id));
  const firsts = model.first.map((map) => [...map.values()].filter((f) => f.day === day && shown.has(f.update)).length);
  const tally = (key: (u: HomeUpdate) => string | null) => {
    const m = new Map<string, number>();
    for (const { u } of items) { const k = key(u); if (k) m.set(k, (m.get(k) ?? 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(" · ");
  };
  const hotDomains = new Set(items.flatMap((x) => x.rows.map((r) => model.workById.get(r.work)?.domainId)));
  const date = isoDay(data.start, day);
  const weekday = WEEKDAYS[language][new Date(`${date}T00:00:00Z`).getUTCDay()];

  const dayAt = (clientX: number) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * VW;
    return Math.max(0, Math.min(data.days - 1, Math.floor((x - LX) / model.cw)));
  };

  return (
    <section id="updates" className={frame.sec}>
      <div className={frame.eyebrow}>[ {index} ] &nbsp;{c.eyebrow}</div>
      <h2 className={frame.h2}>{c.title.replace("{days}", String(data.days)).split("{n}")[0]}<b>{data.updates.length}</b>{c.title.replace("{days}", String(data.days)).split("{n}")[1]}</h2>
      <p className={frame.lead}>{c.lead.replace("{orgs}", String(new Set(data.updates.map((u) => u.org)).size)).replace("{works}", String(data.works.length)).replace("{domains}", String(Object.keys(data.domains).length))}</p>
      <p className={frame.note}>{c.note}</p>

      <div className={s.orgs}>
        <span className={frame.mono}>{c.companies}</span>
        {model.orgList.map(([name, n]) => (
          <button key={name} type="button" aria-pressed={org === name} className={`${frame.chip} ${org === name ? frame.chipOn : ""}`} onClick={() => setOrg(org === name ? null : name)}>{name} · {n}</button>
        ))}
      </div>

      <div className={`${frame.stage} ${s.wrap}`}>
        <div className={s.chart}>
          <svg ref={svgRef} viewBox={`0 0 ${VW} ${height}`} width="100%" role="img" aria-label={c.chartLabel}
            onMouseMove={(e) => { if (!pin) setDay(dayAt(e.clientX)); }}
            onClick={(e) => { const d = dayAt(e.clientX); setPin(!(pin && d === day)); setDay(d); }}>
            {model.perDay.map((byOrg, i) => {
              const x = LX + i * model.cw + 3, w = model.cw - 6, dd = new Date(`${isoDay(data.start, i)}T00:00:00Z`);
              let y = 12 + STRIP;
              return (
                <g key={i}>
                  {model.orgList.map(([name]) => {
                    const n = byOrg.get(name);
                    if (!n) return null;
                    const h = (n / model.dayMax) * STRIP;
                    y -= h;
                    return <rect key={name} x={x} y={y} width={w} height={Math.max(h - 1, 1)} className={`${s.seg} ${org && org !== name ? s.dim : ""}`} />;
                  })}
                  {model.dayTotals[i] > 0 && <text x={x + w / 2} y={y - 5} textAnchor="middle">{model.dayTotals[i]}</text>}
                  <text x={x + w / 2} y={TOP - 10} textAnchor="middle" className={i === day ? s.hot : undefined}>{dd.getUTCDate()}</text>
                  {dd.getUTCDate() === 1 && <line x1={LX + i * model.cw} x2={LX + i * model.cw} y1={TOP - 22} y2={height} className={s.month} />}
                </g>
              );
            })}
            <text x={LX - 12} y={12 + STRIP} textAnchor="end">{c.perDay}</text>
            <text x={LX - 12} y={TOP - 10} textAnchor="end">{data.start.slice(5).replace("-", "/")} – {isoDay(data.start, data.days - 1).slice(5).replace("-", "/")}</text>
            {model.domains.map((d, i) => {
              const y = TOP + (i + 1) * RH;
              return (
                <g key={d.id}>
                  <line x1={LX} x2={RX} y1={y} y2={y} className={s.rule} />
                  <text x={LX - 12} y={y - 6} textAnchor="end" className={`${s.dom} ${hotDomains.has(d.id) ? s.hot : ""}`}>{pick(data.domains[d.id], language)}</text>
                </g>
              );
            })}
            <rect x={LX + day * model.cw} y={6} width={model.cw} height={height - 6} className={s.cursor} />
            {model.marks.map((m, i) => {
              const u = model.updateById.get(m.row.update), w = model.workById.get(m.row.work);
              return (
                <g key={i} className={org && u?.org !== org ? s.dim : s.mk}>
                  <title>{`${w ? pick(w.name, language) : ""} · ${u?.org ?? ""} · ${m.row.claimed > m.row.accepted ? `${c.claimed} L${m.row.claimed} · ` : ""}${c.accepted} L${m.row.accepted}`}</title>
                  <rect x={m.x} y={m.y - m.row.accepted * U} width={m.w} height={m.row.accepted * U} fill={FILL[levelClass(m.row.accepted)]} />
                  {m.row.claimed > m.row.accepted && <rect x={m.x} y={m.y - m.row.claimed * U} width={m.w} height={(m.row.claimed - m.row.accepted) * U} className={s.claim} />}
                </g>
              );
            })}
          </svg>
        </div>

        <aside className={s.side} aria-live="polite">
          <div className={s.head}>
            <span className={frame.mono}>{weekday}{org ? ` · ${org}` : ""}{pin && <> · <span className={s.sigText}>{c.pinned}</span></>}</span>
            <strong>{date}</strong>
            <div className={s.nums}>
              <div><span className={frame.mono}>{c.updates}</span><b>{items.length}</b></div>
              <div><span className={frame.mono}>{c.works}</span><b>{new Set(items.flatMap((x) => x.rows.map((r) => r.work))).size}</b></div>
            </div>
            {items.length > 0 && (
              <p className={s.first}>
                {c.firstAny} <b>{firsts[0]}</b> · {c.firstL2} <b>{firsts[1]}</b> · {c.firstL3} <b className={s.sigText}>{firsts[2]}</b><br />
                <span className={frame.mono}>{c.byCompany}</span> {tally((u) => u.org)}<br />
                <span className={frame.mono}>{c.byKind}</span> {tally((u) => (u.kind ? pick(u.kind, language) : null))}
              </p>
            )}
          </div>
          <div className={s.list}>
            {items.length === 0 && <div className={`${s.upd} ${frame.mono}`}>{c.none}</div>}
            {items.map(({ u, rows, top }) => {
              const body = (
                <>
                  <div className={s.h}>
                    <span className={frame.mono}>{u.org}{u.kind ? ` · ${pick(u.kind, language)}` : ""}</span>
                    <span className={`${s.tag} ${s[levelClass(top)]}`}>L{top} {LEVEL_NAMES[language][top]}</span>
                  </div>
                  <div className={s.t}>{u.title}</div>
                  {u.summary && <div className={s.sum}>{u.summary}</div>}
                  {rows.slice(0, 5).map((r, n) => {
                    const w = model.workById.get(r.work);
                    const firstHere = r.accepted >= 2 && model.first[Math.min(r.accepted, 3) - 1].get(r.work)?.update === u.id;
                    return (
                      <div key={`${r.work}-${n}`} className={s.w}>
                        <i className={`${s.bar} ${r.claimed > r.accepted ? s.barClaim : ""}`} style={{ height: r.accepted * 5, background: FILL[levelClass(r.accepted)], ["--over" as string]: `${(r.claimed - r.accepted) * 5}px` }} />
                        <span>{w ? pick(w.name, language) : r.work}<small>{w ? pick(w.market, language) : ""}{firstHere && <> · <u>{c.firstAt.replace("{n}", String(r.accepted))}</u></>}</small></span>
                        {r.claimed > r.accepted
                          ? <em className={s.c}>{c.claimed} L{r.claimed} · {c.accepted} L{r.accepted}</em>
                          : <em>L{r.accepted}{r.tier !== "T3" ? ` · ${TIER_NAMES[language][r.tier] ?? r.tier}` : ""}</em>}
                      </div>
                    );
                  })}
                  {rows.length > 5 && <div className={s.more}>{c.more.replace("{n}", String(rows.length - 5))}</div>}
                  <div className={s.ft}>
                    <span>{rows.every((r) => r.tier === "T3") ? TIER_NAMES[language].T3 : TIER_NAMES[language].T2} · {c.sources.replace("{n}", String(u.sources))} · {c.original}</span>
                    {u.url && <span>{c.source}</span>}
                  </div>
                </>
              );
              return u.url
                ? <Link key={u.id} className={s.upd} href={updateHref(language, u.id)}>{body}</Link>
                : <div key={u.id} className={s.upd}>{body}</div>;
            })}
          </div>
        </aside>
      </div>
    </section>
  );
}
