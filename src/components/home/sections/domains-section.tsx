"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { bilingual, type Language } from "@/lib/i18n";
import { marketHref, workHref } from "@/lib/routes";
import type { HomeData, HomeWork } from "@/lib/home-data";
import { LEVEL_NAMES, levelClass, pick } from "./levels";
import frame from "./section.module.css";
import s from "./domains-section.module.css";

/**
 * Module 02. One chart on one ruler, so domains can be compared: every row
 * shares the L0-L5 axis and is drawn as a progress bar filled to its highest
 * accepted level. Two levels only - domains, then the markets inside one. Work
 * is never listed by name here: a count per level is as far down as this goes.
 */
const copy = bilingual({
  en: {
    eyebrow: "PROGRESS BY DOMAIN",
    title: "{n} domains reached by updates, {m} with work at L3",
    lead: "The furthest any domain has reached is L{max}. Pick a domain to see its markets.",
    note: "One cell: one kind of work · Filled: accepted level · Dashed: claimed, not accepted · Select a domain for its markets",
    domain: "Domain",
    market: "Market",
    work: "work",
    updates: "updates",
    still: "L0–L2: a person is still doing the work",
    gone: "From L3: a person is no longer doing it",
    back: "← All domains",
    inDomain: "{markets} markets and {works} kinds of work reached, from {updates} updates.",
    claimed: "Claimed L{n}",
    open: "Show the markets in {name}",
  },
  "zh-CN": {
    eyebrow: "领域的进度",
    title: "{n} 个领域已有更新涉及，{m} 个领域有工作达到 L3",
    lead: "走得最远的领域到 L{max}。选一个领域，看它的赛道。",
    note: "一格：一项工作 · 实心：采信级别 · 虚线：宣称未采信 · 点领域查看赛道",
    domain: "领域",
    market: "赛道",
    work: "项工作",
    updates: "条更新",
    still: "L0–L2，人仍在干这件活",
    gone: "L3 起，人不再干这件活",
    back: "← 全部领域",
    inDomain: "{markets} 条赛道、{works} 项工作已有更新涉及，来自 {updates} 条更新。",
    claimed: "宣称 L{n}",
    open: "查看 {name} 的赛道",
  },
});

const LEVELS = [0, 1, 2, 3, 4, 5];
/** One cell plus its gap, in px, and the fewest cells a level is ever given. */
const PITCH = 14, MIN_SLOTS = 4;

type Group = { id: string; name: string; works: HomeWork[]; top: number; updates: number };

export function DomainsSection({ data, language, index }: { data: HomeData; language: Language; index: string }) {
  const c = copy[language];
  const ref = useRef<HTMLElement>(null);
  const [open, setOpen] = useState<string | null>(null);

  const model = useMemo(() => {
    const claimed = new Map<string, number>(), updatesOf = new Map<string, Set<string>>();
    for (const r of data.rows) {
      claimed.set(r.work, Math.max(claimed.get(r.work) ?? 0, r.claimed));
      (updatesOf.get(r.work) ?? updatesOf.set(r.work, new Set()).get(r.work)!).add(r.update);
    }
    const group = (works: HomeWork[], key: (w: HomeWork) => string, name: (w: HomeWork) => string): Group[] => {
      const by = new Map<string, HomeWork[]>();
      for (const w of works) (by.get(key(w)) ?? by.set(key(w), []).get(key(w))!).push(w);
      return [...by.entries()].map(([id, list]) => ({
        id, name: name(list[0]), works: list, top: Math.max(...list.map((w) => w.level)),
        updates: new Set(list.flatMap((w) => [...(updatesOf.get(w.id) ?? [])])).size,
      })).sort((a, b) => b.top - a.top || b.works.length - a.works.length);
    };
    return { claimed, updatesOf, group };
  }, [data.rows]);

  const domains = useMemo(
    () => model.group(data.works, (w) => w.domainId, (w) => pick(data.domains[w.domainId], language)),
    [model, data, language],
  );
  const current = open ? domains.find((d) => d.id === open) ?? null : null;
  const markets = useMemo(
    () => (current ? model.group(current.works, (w) => w.market.en, (w) => pick(w.market, language)) : []),
    [model, current, language],
  );

  // One row is one progress bar made of small cells: every level holds the same
  // number of slots, so the row reads as a single strip from L0 to L5. A filled
  // cell is one kind of work at that level; a dashed cell is a level only claimed.
  const count = (works: HomeWork[], l: number) =>
    works.filter((w) => w.level === l || (w.level < l && (model.claimed.get(w.id) ?? 0) === l)).length;
  // Slots per level follow the data: a level few kinds of work stand at gets a
  // short stretch of the bar, so L0 and L1 do not take the room L2 needs.
  const slots = LEVELS.map((l) => Math.max(MIN_SLOTS, 1 + Math.max(...domains.map((d) => count(d.works, l)))));
  const columns = { gridTemplateColumns: `210px ${slots.map((n) => `${n * PITCH + 10}px`).join(" ")} minmax(0, 1fr)` };
  const band = (works: HomeWork[], link = false) => LEVELS.map((l) => {
    const here = works.filter((w) => w.level === l);
    const over = works.filter((w) => w.level < l && (model.claimed.get(w.id) ?? 0) === l);
    const empty = Math.max(0, slots[l] - here.length - over.length);
    return (
      <div key={l} className={`${s.cell} ${l === 3 ? s.cut : ""}`}>
        {here.map((w) => (link
          ? <Link key={w.id} href={workHref(language, w.id)} className={`${s.sq} ${s[levelClass(l)]}`} title={`${pick(w.name, language)} · L${l}`} aria-label={`${pick(w.name, language)} · L${l}`} />
          : <i key={w.id} className={`${s.sq} ${s[levelClass(l)]}`} title={`${pick(w.name, language)} · L${l}`} />))}
        {over.map((w) => <i key={w.id} className={`${s.sq} ${s.cl}`} title={`${pick(w.name, language)} · ${c.claimed.replace("{n}", String(l))}`} />)}
        {Array.from({ length: empty }, (_, i) => <i key={i} className={s.sq} aria-hidden="true" />)}
      </div>
    );
  });
  const meta = (g: Group) => <div className={`${s.meta} ${frame.mono}`}><b className={s[levelClass(g.top)]}>L{g.top}</b> · {g.works.length} {c.work} · {g.updates} {c.updates}</div>;

  const go = (id: string | null) => { setOpen(id); ref.current?.scrollIntoView({ block: "start" }); };
  const n3 = domains.filter((d) => d.top >= 3).length;
  const most = [...domains].sort((a, b) => b.works.length - a.works.length)[0];

  return (
    <section id="domains" className={frame.sec} ref={ref}>
      <div className={frame.eyebrow}>[ {index} ] &nbsp;{c.eyebrow}</div>
      <h2 className={frame.h2}><b>{domains.length}</b>{c.title.split("{n}")[1].split("{m}")[0]}<b>{n3}</b>{c.title.split("{m}")[1]}</h2>
      <p className={frame.lead}>{c.lead.replace("{all}", String(data.catalogueDomains)).replace("{n}", String(domains.length)).replace("{top}", most?.name ?? "").replace("{k}", String(most?.works.length ?? 0)).replace("{max}", String(Math.max(0, ...domains.map((d) => d.top))))}</p>
      <p className={frame.note}>{c.note}</p>

      <div className={`${frame.stage} ${s.chart}`}>
        <div className={s.sticky}>
        {current && (
          <div className={s.crumb}>
            <button type="button" className={`${frame.chip} ${s.back}`} onClick={() => go(null)}>{c.back}</button>
            <strong>{current.name}</strong>
            <span className={`${s.tag} ${s[levelClass(current.top)]}`}>L{current.top} {LEVEL_NAMES[language][current.top]}</span>
            <span className={s.crumbNote}>{c.inDomain.replace("{markets}", String(markets.length)).replace("{works}", String(current.works.length)).replace("{updates}", String(current.updates))}</span>
          </div>
        )}
        <div className={`${s.row} ${s.axis}`} style={columns}>
          <div className={frame.mono}>{current ? c.market : c.domain}</div>
          {LEVELS.map((l) => <div key={l} className={`${s.cell} ${s.tick} ${l === 3 ? s.cut : ""}`}><b>L{l}</b><span>{LEVEL_NAMES[language][l]}</span></div>)}
          <div />
        </div>
        <div className={`${s.row} ${s.caption}`} style={columns}>
          <div />
          <div className={s.still}>{c.still}</div>
          <div className={s.gone}>{c.gone}</div>
          <div />
        </div>
        </div>

        {!current && domains.map((d) => (
          <button key={d.id} type="button" className={`${s.row} ${s.pick}`} style={columns} onClick={() => go(d.id)} aria-label={c.open.replace("{name}", d.name)}>
            <div className={s.name}>{d.name}</div>
            {band(d.works)}
            {meta(d)}
          </button>
        ))}

        {current && markets.map((m) => (
          <div key={m.id} className={`${s.row} ${s.mrow}`} style={columns}>
            <div className={s.name}><Link className={s.go} href={marketHref(language, m.works[0].marketId)}>{m.name} <span aria-hidden="true">→</span></Link></div>
            {band(m.works, true)}
            {meta(m)}
          </div>
        ))}
      </div>
    </section>
  );
}
