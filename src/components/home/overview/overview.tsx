"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { updateHref, workHref } from "@/lib/routes";
import type { HomeData } from "@/lib/home-data";
import type { Language } from "@/lib/i18n";
import { WEEKDAYS, isoDay } from "@/components/home/sections/levels";
import { KIND_NAMES, LEVELS, TIERS, copy, fill } from "./copy";
import s from "./overview.module.css";
import { KINDS, NO_FILTERS, type Filters, type Hover, type NodeKind, type NodeRef, type OverviewScene, type PanelItem, type View } from "./scene";

/**
 * The homepage's first screen: a globe of domains, markets, work, updates and
 * companies. This component owns the HUD around it; `scene.ts` owns the globe.
 *
 * three.js is imported inside the effect, so none of it runs on the server and
 * none of it is in the first bundle. Scrolling down hands the page over: the
 * globe shrinks and fades and the HUD steps aside.
 */
export function Overview({ data, language }: { data: HomeData; language: Language }) {
  const c = copy[language];
  const levels = LEVELS[language];
  const tiers = TIERS[language];
  const kinds = KIND_NAMES[language];

  const canvas = useRef<HTMLCanvasElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const scene = useRef<OverviewScene | null>(null);

  const [view, setView] = useState<View | null>(null);
  const [options, setOptions] = useState<OverviewScene["options"] | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [docked, setDocked] = useState(false);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [find, setFind] = useState("");
  const [found, setFound] = useState<NodeRef[] | null>(null);
  const [open, setOpen] = useState<"org" | "domain" | null>(null);

  useEffect(() => {
    let cancelled = false;
    let made: OverviewScene | null = null;
    const text = copy[language];
    const names = LEVELS[language];
    void import("./scene").then(({ createScene }) => {
      if (cancelled || !canvas.current || !labels.current) return;
      try {
        made = createScene({
          canvas: canvas.current,
          labels: labels.current,
          data,
          lang: language === "zh-CN" ? "zh" : "en",
          reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
          classes: { label: s.label, org: s.labelOrg, hot: s.labelHot, dim: s.labelDim, pulse: s.labelPulse, pulseCap: s.labelPulseCap, out: s.labelOut },
          text: {
            domainLabel: (name, level, n) => fill(text.domainLabel, { name, level, n }),
            orgLabel: (name, n) => `${name} · ${n}`,
            pulseMeta: (org, claimed, accepted) =>
              claimed > accepted
                ? `${org} · ${text.claimed} L${claimed} · ${text.accepted} L${accepted}`
                : `${org} · ${text.accepted} L${accepted} ${names[accepted] ?? ""}`,
          },
          onChange: setView,
          onHover: setHover,
          onDock: setDocked,
        });
      } catch {
        return; // no WebGL: the page below still carries every number in text
      }
      scene.current = made;
      setOptions(made.options);
      window.__oawProjectWork = made.projectWork;
    });
    return () => {
      cancelled = true;
      made?.dispose();
      scene.current = null;
      delete window.__oawProjectWork;
    };
  }, [data, language]);

  const applyFilters = useCallback((next: Filters) => {
    setFilters(next);
    scene.current?.setFilters(next);
  }, []);

  const select = useCallback((id: string | null) => {
    setFind("");
    setFound(null);
    scene.current?.select(id);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const api = scene.current;
      if (!api || docked) return;
      const target = e.target as HTMLElement | null;
      if (target?.tagName === "INPUT") {
        if (e.key === "Escape") {
          setFind("");
          setFound(null);
          target.blur();
        }
        return;
      }
      if (e.key === " ") {
        e.preventDefault();
        api.togglePlay();
      } else if (e.key === "Escape") api.select(null);
      else if (e.key === "Backspace") {
        e.preventDefault();
        api.back();
      } else if (e.key === "/") {
        e.preventDefault();
        findInput.current?.focus();
      } else if (e.key === "ArrowLeft") api.stepDay(-1);
      else if (e.key === "ArrowRight") api.stepDay(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [docked]);

  const dateOf = (day: number) => new Date(`${isoDay(data.start, day)}T00:00:00Z`);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const toggle = <T,>(list: T[], value: T) => (list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);

  const itemMeta = (item: PanelItem) => {
    if (item.accepted != null && item.claimed != null) {
      return item.claimed > item.accepted ? (
        <span className={s.warn}>{`${c.claimed} L${item.claimed} · ${c.accepted} L${item.accepted} · ${tiers[item.tier ?? ""] ?? ""}`}</span>
      ) : (
        <>
          {`${c.accepted} L${item.accepted}`}
          {item.tier && item.tier !== "T3" ? <span className={s.sig}>{` · ${tiers[item.tier] ?? item.tier}`}</span> : null}
        </>
      );
    }
    if (item.level != null) return `L${item.level}`;
    if (item.kind === "update") return item.date ?? c.undated;
    return null;
  };

  const today = view ? dateOf(Math.max(0, view.day)) : null;
  const panel = view?.panel ?? null;
  const dayList = panel ? null : (view?.dayList ?? null);
  const panelOpen = Boolean(panel || dayList);
  const counters: { key: string; label: string; value: number; tone?: string; kind?: NodeKind; sub?: string }[] = view
    ? [
        { key: "update", label: c.cUpdate, value: view.counts.update, kind: "update" },
        { key: "work", label: c.cWork, value: view.counts.work, kind: "work", sub: fill(c.cWorkSub, { n: data.catalogueWorks }) },
        { key: "l3", label: c.cL3, value: view.l3, tone: s.sigBox },
        { key: "capped", label: c.cCapped, value: view.capped, tone: s.warnBox },
        { key: "domain", label: c.cDomain, value: view.counts.domain, kind: "domain" },
        { key: "market", label: c.cMarket, value: view.counts.market, kind: "market" },
        { key: "org", label: c.cOrg, value: view.counts.org, kind: "org" },
        { key: "today", label: c.cToday, value: view.today },
      ]
    : [];
  const filtered = filters.levels.length + filters.orgs.length + filters.domains.length > 0 || filters.several || filters.capped;

  return (
    <>
      <section className={`${s.root} ${docked ? s.docked : ""}`} aria-label={c.stageLabel}>
        <canvas ref={canvas} className={s.canvas} />
        <div ref={labels} className={s.labels} aria-hidden="true" />

        <header className={s.hud}>
          <div className={s.mono}>{fill(c.eyebrow, { date: data.generatedAt, n: data.orgsTracked, start: data.start })}</div>
          <h1 className={s.headline}>{c.headline}</h1>
          <p className={s.subtitle}>{c.subtitle}</p>
          <p className={s.supporting}>{c.supporting}</p>
          {view ? (
            <p className={s.mono}>
              {fill(c.ticker, { n: view.today })}
              {view.ticker ? ` · ${view.ticker.org} — ${view.ticker.title.slice(0, 40)}` : ""}
            </p>
          ) : null}
        </header>

        {view && today ? (
          <div className={s.counters}>
            <div className={s.wide}>
              <strong>{iso(today)}</strong>
              <small>
                {fill(c.dayOf, {
                  weekday: WEEKDAYS[language][today.getUTCDay()],
                  day: view.day + 1,
                  days: data.days,
                })}
              </small>
            </div>
            {counters.map((box) => (
              <div key={box.key} className={box.tone}>
                <span className={s.mono}>{box.label}</span>
                <strong>{box.value}</strong>
                <small>{panel && box.kind ? fill(c.related, { n: panel.lit[box.kind] }) : (box.sub ?? " ")}</small>
              </div>
            ))}
          </div>
        ) : null}

        <div className={`${s.top} ${panelOpen ? s.topShifted : ""}`}>
          <button type="button" className={s.button} onClick={() => scene.current?.reset()}>
            {c.reset}
          </button>
        </div>

        <div className={s.legend}>
          <div><i className={s.keyLit} />{c.legendLit}</div>
          <div><i className={s.keyCapped} />{c.legendCapped}</div>
          <div><i className={s.keySeveral} />{c.legendSeveral}</div>
          <div><i className={s.keyLine} />{c.legendLine}</div>
        </div>

        <div className={s.bar}>
          <div className={s.group}>
            <input
              ref={findInput}
              className={s.find}
              value={find}
              placeholder={c.search}
              aria-label={c.search}
              autoComplete="off"
              onChange={(e) => {
                setFind(e.target.value);
                setFound(e.target.value.trim() ? (scene.current?.search(e.target.value) ?? []) : null);
              }}
            />
            {found ? (
              <div className={`${s.pop} ${s.found}`}>
                {found.length ? (
                  found.map((n) => (
                    <button type="button" key={n.id} className={s.option} onClick={() => select(n.id)}>
                      <span className={s.clip}>{n.name}</span>
                      <small>{kinds[n.kind]}</small>
                    </button>
                  ))
                ) : (
                  <div className={s.empty}>{c.noMatch}</div>
                )}
              </div>
            ) : null}
          </div>
          <div className={s.group}>
            <span className={s.mono}>{c.acceptedLevel}</span>
            {[1, 2, 3].map((l) => (
              <button
                type="button"
                key={l}
                className={`${s.button} ${filters.levels.includes(l) ? s.on : ""}`}
                aria-pressed={filters.levels.includes(l)}
                onClick={() => applyFilters({ ...filters, levels: toggle(filters.levels, l) })}
              >
                L{l}
              </button>
            ))}
          </div>
          <div className={s.group}>
            <button type="button" className={`${s.button} ${filters.capped ? s.on : ""}`} aria-pressed={filters.capped} onClick={() => applyFilters({ ...filters, capped: !filters.capped })}>
              {c.fCapped}
            </button>
            <button type="button" className={`${s.button} ${filters.several ? s.on : ""}`} aria-pressed={filters.several} onClick={() => applyFilters({ ...filters, several: !filters.several })}>
              {c.fSeveral}
            </button>
          </div>
          <div className={s.group}>
            {(["org", "domain"] as const).map((which) => {
              const chosen = which === "org" ? filters.orgs : filters.domains;
              const list = which === "org" ? (options?.orgs ?? []).map((x) => ({ id: x.name, name: x.name, n: x.n })) : (options?.domains ?? []);
              return (
                <div key={which} className={s.drop}>
                  <button type="button" className={`${s.button} ${chosen.length ? s.on : ""}`} aria-expanded={open === which} onClick={() => setOpen(open === which ? null : which)}>
                    {which === "org" ? c.fOrg : c.fDomain}
                    {chosen.length ? ` · ${chosen.length}` : ""}
                  </button>
                  {open === which ? (
                    <div className={s.pop}>
                      {list.map((x) => (
                        <button
                          type="button"
                          key={x.id}
                          className={`${s.option} ${chosen.includes(x.id) ? s.chosen : ""}`}
                          aria-pressed={chosen.includes(x.id)}
                          onClick={() => applyFilters(which === "org" ? { ...filters, orgs: toggle(filters.orgs, x.id) } : { ...filters, domains: toggle(filters.domains, x.id) })}
                        >
                          <span>{x.name}</span>
                          <small>{x.n}</small>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
          <button type="button" className={s.button} disabled={!filtered} onClick={() => applyFilters(NO_FILTERS)}>
            {c.fClear}
          </button>
          <span className={s.keys}>{c.keys}</span>
        </div>

        <div className={s.time}>
          <button type="button" className={s.button} aria-label={view?.playing ? c.pause : c.play} onClick={() => scene.current?.togglePlay()}>
            {view?.playing ? "❚❚" : "▶"}
          </button>
          <div className={s.calendar} style={{ gridTemplateColumns: `repeat(${data.days}, 1fr)` }}>
            {(options?.perDay ?? []).map((n, i) => {
              const d = dateOf(i);
              const max = Math.max(1, ...(options?.perDay ?? [1]));
              const state = view && i === view.day ? s.current : view && i < view.day ? s.past : "";
              return (
                <button type="button" key={i} className={`${s.day} ${state}`} title={fill(c.dayUpdates, { date: iso(d), n })} onClick={() => scene.current?.setDay(i)}>
                  <i style={{ height: `${Math.round((n / max) * 100)}%` }} />
                  <span>{d.getUTCDate() === 1 || i === 0 ? `${d.getUTCMonth() + 1}/` : ""}{d.getUTCDate()}</span>
                </button>
              );
            })}
          </div>
        </div>

        {hover ? (
          <div className={s.tip} style={{ left: Math.min(hover.x + 14, (typeof window === "undefined" ? 1200 : window.innerWidth) - 330), top: hover.y + 14 }}>
            <span className={s.mono}>{kinds[hover.kind]}</span>
            <strong>{hover.name}</strong>
            {hover.kind === "work" && hover.level != null ? (
              <>
                {`${c.accepted} L${hover.level} ${levels[hover.level] ?? ""}`}
                {(hover.claimed ?? 0) > hover.level ? <span className={s.warn}>{` · ${c.claimed} L${hover.claimed}`}</span> : null}
                <br />
                {fill(c.updatesN, { n: hover.updates ?? 0 })}
              </>
            ) : hover.kind === "update" ? (
              `${hover.date ?? c.undated} · ${hover.org ?? ""}`
            ) : hover.kind === "org" ? (
              fill(c.updatesN, { n: hover.updates ?? 0 })
            ) : null}
          </div>
        ) : null}

        <aside className={`${s.panel} ${panelOpen ? s.panelOpen : ""}`} aria-label={c.panelLabel} aria-hidden={!panelOpen}>
          {dayList && today ? (
            <>
              <div className={s.nav}>
                <button type="button" className={s.button} onClick={() => scene.current?.select(null)}>
                  {c.close}
                </button>
              </div>
              <div className={s.mono}>{c.dayPanel}</div>
              <h2 className={s.panelTitle}>{`${iso(today)} UTC`}</h2>
              <div>
                <div className={`${s.mono} ${s.groupTitle}`}>{`${kinds.update} · ${dayList.length}`}</div>
                {dayList.map((item) => (
                  <button type="button" key={item.id} className={s.row} onClick={() => select(item.id)}>
                    <span>{item.name}</span>
                    <span className={s.meta}>{item.org}</span>
                  </button>
                ))}
                {dayList.length === 0 ? <div className={s.rowMore}>{c.dayEmpty}</div> : null}
              </div>
            </>
          ) : null}
          {panel ? (
            <>
              <div className={s.nav}>
                <button type="button" className={s.button} onClick={() => scene.current?.back()}>
                  {panel.trail.length ? fill(c.backTo, { name: panel.trail[panel.trail.length - 1].name.slice(0, 18) }) : c.backOverview}
                </button>
                <button type="button" className={s.button} onClick={() => scene.current?.select(null)}>
                  {c.close}
                </button>
              </div>
              {panel.trail.length ? (
                <div className={s.crumb}>
                  {panel.trail.slice(-3).map((n, i, shown) => (
                    <span key={n.id}>
                      <button type="button" onClick={() => scene.current?.backTo(shown.length - i)}>{n.name.slice(0, 14)}</button>
                      {" › "}
                    </span>
                  ))}
                  <b>{panel.name.slice(0, 14)}</b>
                </div>
              ) : null}
              <div className={s.mono}>{kinds[panel.kind]}</div>
              <h2 className={s.panelTitle}>{panel.name}</h2>
              <div className={s.path}>
                {KINDS.map((k) => (
                  <div key={k} className={k === panel.kind ? s.me : ""}>
                    <strong>{panel.lit[k]}</strong>
                    <span>{kinds[k]}</span>
                  </div>
                ))}
              </div>
              {panel.work ? (
                <>
                  <div className={s.fact}>
                    <span>
                      {c.accepted} <b className={s.sig}>{`L${panel.work.level} ${levels[panel.work.level] ?? ""}`}</b>
                    </span>
                    {panel.work.claimed > panel.work.level ? <span className={s.warn}>{`${c.claimed} L${panel.work.claimed}`}</span> : null}
                  </div>
                  {panel.work.claimed > panel.work.level ? <p className={s.note}>{c.publisherOnly}</p> : null}
                  <p className={s.source}><Link href={workHref(language, panel.id)}>{c.openWork}</Link></p>
                </>
              ) : null}
              {panel.update ? (
                <>
                  <div className={s.mono}>{`${panel.update.date ?? c.undated} · ${panel.update.org}`}</div>
                  {panel.update.url ? (
                    <p className={s.source}>
                      <Link href={updateHref(language, panel.id)}>{c.openUpdate}</Link>{" · "}
                      <a href={panel.update.url} target="_blank" rel="noopener noreferrer">{c.source}</a>
                    </p>
                  ) : null}
                  <div className={s.mono}>{c.original}</div>
                </>
              ) : null}
              {panel.groups.map((g) => (
                <div key={g.kind}>
                  <div className={`${s.mono} ${s.groupTitle}`}>{`${kinds[g.kind]} · ${g.count}`}</div>
                  {g.items.map((item) => (
                    <button type="button" key={item.id} className={s.row} onClick={() => select(item.id)}>
                      <span>{item.name}</span>
                      <span className={s.meta}>{itemMeta(item)}</span>
                    </button>
                  ))}
                  {g.count > g.items.length ? <div className={s.rowMore}>{fill(c.more, { n: g.count - g.items.length })}</div> : null}
                </div>
              ))}
            </>
          ) : null}
        </aside>
      </section>
      {/* The stage is fixed; this keeps the first screen's height in the page flow. */}
      <div className={s.spacer} aria-hidden="true" />
    </>
  );
}
