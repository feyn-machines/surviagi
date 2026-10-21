"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Route } from "next";
import Link from "next/link";
import { bilingual, type Language } from "@/lib/i18n";
import { marketHref, updateHref, workHref } from "@/lib/routes";
import type { HomeData } from "@/lib/home-data";
import { LEVEL_NAMES, pick } from "./levels";
import frame from "./section.module.css";
import s from "./graph-section.module.css";

/**
 * Module 05. The record as a knowledge graph: every company, update, kind of
 * work, market and domain in the snapshot is a node, every relation between two
 * of them is an edge, and the layout is whatever those edges pull it into.
 * Selecting a node keeps its neighbours and lists its relations as triples.
 */
const copy = bilingual({
  en: {
    eyebrow: "KNOWLEDGE GRAPH",
    title: "{n} nodes, {e} relations",
    lead: "Every conclusion traces back to its source. Pick a node to start.",
    note: "Select a node for its relations · Drag to move · Buttons to zoom",
    types: "Company|Update|Work|Market|Domain",
    relations: "publishes|bears on|belongs to|belongs to",
    schema: "Types and relations",
    hint: "Select a node in the graph.",
    source: "Source ↗",
    open: "Open its page →",
    more: "+{n} more",
    clear: "Clear",
    reset: "Fit",
    claimed: "claimed L{c}",
    canvas: "Knowledge graph of the record",
  },
  "zh-CN": {
    eyebrow: "知识图谱",
    title: "{n} 个节点，{e} 条关系",
    lead: "每一条结论都能顺着关系查回来源。点一个节点开始。",
    note: "点节点查看其关系 · 拖动移动 · 按钮缩放",
    types: "公司|更新|工作|赛道|领域",
    relations: "发布|涉及|属于|属于",
    schema: "类型与关系",
    hint: "在图中点一个节点。",
    source: "来源 ↗",
    open: "打开它的页面 →",
    more: "另有 {n} 个",
    clear: "取消选择",
    reset: "适应",
    claimed: "宣称 L{c}",
    canvas: "记录的知识图谱",
  },
});

type GNode = { id: number; kind: number; name: string; note: string; level: number; url: string | null; href: Route | null; r: number; x: number; y: number; vx: number; vy: number; fixed: boolean };
type GLink = { a: number; b: number; rel: number; level: number; claimed: number };

const RADIUS = [12, 3.6, 6.5, 7.5, 12];
const REST = [90, 60, 46, 80];
const HEIGHT = 660, SHOWN = 7;

function build(data: HomeData, language: Language) {
  const nodes: GNode[] = [], links: GLink[] = [];
  const index = new Map<string, number>();
  const add = (kind: number, key: string, name: string, note = "", level = 0, url: string | null = null, href: Route | null = null) => {
    const k = `${kind}:${key}`;
    let id = index.get(k);
    if (id === undefined) {
      id = nodes.length;
      // A golden-angle spiral: the same start every time, so the layout is repeatable.
      const a = id * 2.39996, d = 16 * Math.sqrt(id + 1);
      nodes.push({ id, kind, name, note, level, url, href, r: RADIUS[kind], x: Math.cos(a) * d, y: Math.sin(a) * d, vx: 0, vy: 0, fixed: false });
      index.set(k, id);
    }
    return id;
  };
  const seen = new Set<string>();
  const link = (a: number, b: number, rel: number, level = 0, claimed = 0) => {
    const k = `${a}-${b}`;
    if (seen.has(k)) return;
    seen.add(k);
    links.push({ a, b, rel, level, claimed });
  };
  const updateOf = new Map(data.updates.map((u) => [u.id, u]));
  const workOf = new Map(data.works.map((w) => [w.id, w]));
  for (const r of data.rows) {
    const u = updateOf.get(r.update), w = workOf.get(r.work);
    if (!u || !w) continue;
    const company = add(0, u.org, u.org);
    const update = add(1, u.id, u.title, `${u.org} · ${u.date ?? ""}`, 0, u.url, updateHref(language, u.id));
    const work = add(2, w.id, pick(w.name, language), `L${w.level} ${LEVEL_NAMES[language][w.level]}`, w.level, null, workHref(language, w.id));
    const market = add(3, w.market.en, pick(w.market, language), "", 0, null, marketHref(language, w.marketId));
    const domain = add(4, w.domainId, pick(data.domains[w.domainId], language));
    link(company, update, 0);
    link(update, work, 1, r.accepted, r.claimed);
    link(work, market, 2, w.level);
    link(market, domain, 3);
  }
  const near: number[][] = nodes.map(() => []);
  links.forEach((l, i) => { near[l.a].push(i); near[l.b].push(i); });
  return { nodes, links, near };
}

export function GraphSection({ data, language, index }: { data: HomeData; language: Language; index: string }) {
  const c = copy[language];
  const graph = useMemo(() => build(data, language), [data, language]);
  const canvas = useRef<HTMLCanvasElement>(null);
  const api = useRef<{ select: (id: number | null) => void; zoom: (f: number) => void; fit: () => void } | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    // The simulation moves its own copy; the memoised graph stays as built.
    const nodes = graph.nodes.map((n) => ({ ...n }));
    const { links, near } = graph;
    const css = getComputedStyle(el);
    const token = (name: string) => css.getPropertyValue(name).trim();
    const col = { text: token("--ah-color-text"), muted: token("--ah-color-muted"), control: token("--ah-color-control"), signal: token("--ah-color-signal"), market: token("--ah-color-attention"), domain: token("--ah-color-correction"), warn: token("--ah-color-warning"), bg: token("--ah-color-surface"), l2: "#4f7d58" };
    // One colour per type, used for the node and for its label alike.
    const hue = (n: GNode) => [col.text, col.muted, col.signal, col.market, col.domain][n.kind];
    const fill = (level: number) => (level >= 3 ? col.signal : level === 2 ? col.l2 : col.control);

    let width = 0, scale = 1, tx = 0, ty = 0, alpha = 1, raf = 0, picked: number | null = null, hover: number | null = null, fitted = false;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const resize = () => {
      width = el.clientWidth;
      el.width = width * dpr; el.height = HEIGHT * dpr;
      if (!fitted) { tx = width / 2; ty = HEIGHT / 2; }
      draw();
    };
    const fit = () => {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const n of nodes) { x0 = Math.min(x0, n.x); x1 = Math.max(x1, n.x); y0 = Math.min(y0, n.y); y1 = Math.max(y1, n.y); }
      scale = Math.min((width - 80) / (x1 - x0 || 1), (HEIGHT - 80) / (y1 - y0 || 1), 2.2);
      tx = width / 2 - ((x0 + x1) / 2) * scale; ty = HEIGHT / 2 - ((y0 + y1) / 2) * scale;
      fitted = true;
    };

    const tick = () => {
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          let dx = b.x - a.x, dy = b.y - a.y;
          if (!dx && !dy) { dx = 0.1; dy = 0.1; }
          const d2 = Math.max(36, dx * dx + dy * dy);
          if (d2 > 160000) continue;
          const f = ((a.r + b.r) * 46 * alpha) / d2;
          a.vx -= dx * f; a.vy -= dy * f; b.vx += dx * f; b.vy += dy * f;
        }
      }
      for (const l of links) {
        const a = nodes[l.a], b = nodes[l.b];
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
        const f = ((d - REST[l.rel]) / d) * 0.05 * alpha;
        a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
      }
      for (const n of nodes) {
        if (n.fixed) { n.vx = 0; n.vy = 0; continue; }
        n.vx = (n.vx - n.x * 0.006 * alpha) * 0.62; n.vy = (n.vy - n.y * 0.006 * alpha) * 0.62;
        n.x += n.vx; n.y += n.vy;
      }
      alpha *= 0.986;
    };

    const label = (n: GNode, strong: boolean) => {
      ctx.font = `${strong ? 600 : 400} ${(n.kind === 4 || n.kind === 0 ? 12 : 11) / scale}px ${css.fontFamily}`;
      const text = n.name.length > 34 ? `${n.name.slice(0, 33)}…` : n.name;
      const x = n.x + Math.max(n.r, (n.r * 0.72) / scale) + 4 / scale, y = n.y + 4 / scale;
      ctx.lineWidth = 3 / scale; ctx.strokeStyle = col.bg; ctx.strokeText(text, x, y);
      ctx.fillStyle = hue(n); ctx.fillText(text, x, y);
    };

    // Nodes keep their size on screen however far the graph is zoomed out.
    const rad = (n: GNode) => Math.max(n.r, (n.r * 0.72) / scale);

    function draw() {
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx!.clearRect(0, 0, width, HEIGHT);
      ctx!.translate(tx, ty); ctx!.scale(scale, scale);
      const focus = picked ?? hover;
      const lit = new Set<number>();
      if (focus !== null) { lit.add(focus); for (const i of near[focus]) { lit.add(links[i].a); lit.add(links[i].b); } }
      for (const l of links) {
        const on = focus !== null && (l.a === focus || l.b === focus);
        if (focus !== null && !on) { ctx!.globalAlpha = 0.05; ctx!.strokeStyle = col.muted; ctx!.lineWidth = 0.6 / scale; }
        else if (on) { ctx!.globalAlpha = 0.95; ctx!.strokeStyle = l.rel === 1 && l.claimed > l.level ? col.warn : l.level >= 2 ? fill(l.level) : col.muted; ctx!.lineWidth = 1.5 / scale; }
        else { ctx!.globalAlpha = l.level >= 3 ? 0.75 : 0.22; ctx!.strokeStyle = l.level >= 3 ? col.signal : col.muted; ctx!.lineWidth = (l.level >= 3 ? 1.3 : 0.8) / scale; }
        ctx!.setLineDash(on && l.rel === 1 && l.claimed > l.level ? [4 / scale, 3 / scale] : []);
        ctx!.beginPath(); ctx!.moveTo(nodes[l.a].x, nodes[l.a].y); ctx!.lineTo(nodes[l.b].x, nodes[l.b].y); ctx!.stroke();
      }
      ctx!.setLineDash([]);
      for (const n of nodes) {
        ctx!.globalAlpha = focus !== null && !lit.has(n.id) ? 0.22 : 1;
        ctx!.beginPath();
        if (n.kind === 4) ctx!.rect(n.x - rad(n), n.y - rad(n), rad(n) * 2, rad(n) * 2); else ctx!.arc(n.x, n.y, rad(n), 0, Math.PI * 2);
        if (n.kind === 3 || n.kind === 4) { ctx!.fillStyle = col.bg; ctx!.fill(); ctx!.lineWidth = 1.6 / scale; ctx!.strokeStyle = hue(n); ctx!.stroke(); }
        else { ctx!.fillStyle = n.kind === 0 ? col.text : n.kind === 1 ? col.muted : fill(n.level); ctx!.fill(); }
        if (n.id === picked) { ctx!.lineWidth = 2 / scale; ctx!.strokeStyle = col.text; ctx!.beginPath(); ctx!.arc(n.x, n.y, rad(n) + 4 / scale, 0, Math.PI * 2); ctx!.stroke(); }
      }
      ctx!.globalAlpha = 1;
      for (const n of nodes) {
        if (focus === null ? n.kind === 0 || n.kind === 4 : n.id === focus) label(n, true);
      }
      if (focus !== null) {
        const around = [...lit].filter((i) => i !== focus).sort((a, b) => nodes[b].r - nodes[a].r).slice(0, 16);
        for (const i of around) label(nodes[i], false);
      }
    }

    const loop = () => {
      if (alpha > 0.02) {
        for (let i = 0; i < 4; i++) tick();
        if (!dragging) fit();
        draw();
        raf = requestAnimationFrame(loop);
      } else raf = 0;
    };
    const wake = (a: number) => { alpha = Math.max(alpha, a); if (!raf) raf = requestAnimationFrame(loop); };

    const at = (e: PointerEvent) => {
      const box = el.getBoundingClientRect();
      const x = (e.clientX - box.left - tx) / scale, y = (e.clientY - box.top - ty) / scale;
      let best: number | null = null, bestD = Infinity;
      for (const n of nodes) {
        const d = Math.hypot(n.x - x, n.y - y) - rad(n);
        if (d < 7 / scale && d < bestD) { best = n.id; bestD = d; }
      }
      return { x, y, id: best };
    };
    let dragging: { node: number | null; x: number; y: number; moved: boolean } | null = null;
    const down = (e: PointerEvent) => { const p = at(e); dragging = { node: p.id, x: e.clientX, y: e.clientY, moved: false }; el.setPointerCapture(e.pointerId); };
    const move = (e: PointerEvent) => {
      if (!dragging) {
        const id = at(e).id;
        if (id !== hover) { hover = id; el.style.cursor = id === null ? "grab" : "pointer"; if (!raf) draw(); }
        return;
      }
      const dx = e.clientX - dragging.x, dy = e.clientY - dragging.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) dragging.moved = true;
      if (!dragging.moved) return;
      dragging.x = e.clientX; dragging.y = e.clientY;
      if (dragging.node !== null) { const n = nodes[dragging.node]; n.fixed = true; n.x += dx / scale; n.y += dy / scale; wake(0.08); }
      else { tx += dx; ty += dy; }
      if (!raf) draw();
    };
    const up = (e: PointerEvent) => {
      if (!dragging) return;
      if (dragging.node !== null) nodes[dragging.node].fixed = false;
      if (!dragging.moved) { picked = dragging.node; setSelected(picked); }
      dragging = null; el.releasePointerCapture(e.pointerId);
      if (!raf) draw();
    };
    const leave = () => { if (hover !== null) { hover = null; if (!raf) draw(); } };

    api.current = {
      select: (id) => {
        picked = id; setSelected(id);
        if (id !== null) { tx = width / 2 - nodes[id].x * scale; ty = HEIGHT / 2 - nodes[id].y * scale; }
        if (!raf) draw();
      },
      zoom: (f) => { const next = Math.min(6, Math.max(0.3, scale * f)); tx = width / 2 - ((width / 2 - tx) / scale) * next; ty = HEIGHT / 2 - ((HEIGHT / 2 - ty) / scale) * next; scale = next; if (!raf) draw(); },
      fit: () => { fit(); if (!raf) draw(); },
    };

    const observer = new ResizeObserver(resize);
    observer.observe(el);
    el.addEventListener("pointerdown", down); el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up); el.addEventListener("pointerleave", leave);
    // Settle most of the way before the first frame, so the graph does not open as a knot.
    for (let i = 0; i < 160; i++) tick();
    resize(); fit(); wake(alpha);
    return () => {
      cancelAnimationFrame(raf); observer.disconnect();
      el.removeEventListener("pointerdown", down); el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up); el.removeEventListener("pointerleave", leave);
      api.current = null;
    };
  }, [graph]);

  const { nodes, links, near } = graph;
  if (!nodes.length) return null;
  const types = c.types.split("|"), relations = c.relations.split("|");
  const node = selected !== null ? nodes[selected] : null;
  const title = c.title.replace("{n}", `|${nodes.length}|`).replace("{e}", `|${links.length}|`).split("|");
  // The selected node's relations as triples, grouped by relation and direction.
  const groups = node
    ? [0, 1, 2, 3].flatMap((rel) => [true, false].map((out) => ({
        rel, out,
        items: near[node.id].map((i) => links[i]).filter((l) => l.rel === rel && (out ? l.a : l.b) === node.id)
          .map((l) => ({ l, other: nodes[out ? l.b : l.a] })).sort((a, b) => b.l.level - a.l.level || b.other.level - a.other.level),
      }))).filter((g) => g.items.length)
    : [];

  return (
    <section id="graph" className={frame.sec}>
      <div className={frame.eyebrow}>[ {index} ] &nbsp;{c.eyebrow}</div>
      <h2 className={frame.h2}>{title.map((part, i) => (i % 2 ? <b key={i}>{part}</b> : part))}</h2>
      <p className={frame.lead}>{c.lead}</p>
      <p className={frame.note}>{c.note}</p>

      <div className={`${frame.stage} ${s.wrap}`}>
        <div className={s.canvas}>
          <canvas ref={canvas} style={{ height: HEIGHT }} role="img" aria-label={c.canvas} />
          <div className={s.tools}>
            <button type="button" className={frame.chip} onClick={() => api.current?.zoom(1.3)} aria-label="+">+</button>
            <button type="button" className={frame.chip} onClick={() => api.current?.zoom(1 / 1.3)} aria-label="−">−</button>
            <button type="button" className={frame.chip} onClick={() => api.current?.fit()}>{c.reset}</button>
          </div>
        </div>

        <aside className={s.side}>
          {node ? (
            <>
              <div className={s.head}>
                <div className={s.row}><span className={frame.mono}><i className={`${s.key} ${s[`k${node.kind}`]}`} />{types[node.kind]}</span><button type="button" className={frame.chip} onClick={() => api.current?.select(null)}>{c.clear}</button></div>
                <strong>{node.name}</strong>
                {node.note && <span className={frame.mono}>{node.note}</span>}
                {node.href && <Link className={`${frame.mono} ${s.go}`} href={node.href}>{c.open}</Link>}
                {node.url && <a className={`${frame.mono} ${s.go}`} href={node.url} target="_blank" rel="noreferrer">{c.source}</a>}
              </div>
              <div className={s.list}>
                {groups.map((g) => (
                  <div key={`${g.rel}-${g.out}`}>
                    <div className={`${s.group} ${frame.mono}`}>{g.out ? `${relations[g.rel]} → ${types[g.rel + 1]}` : `${types[g.rel]} → ${relations[g.rel]}`}<b>{g.items.length}</b></div>
                    {g.items.slice(0, SHOWN).map(({ l, other }) => (
                      <button key={other.id} type="button" className={s.item} onClick={() => api.current?.select(other.id)}>
                        <span><i className={`${s.key} ${s[`k${other.kind}`]}`} />{other.name}</span>
                        {l.rel === 1 && <small className={l.claimed > l.level ? s.warn : ""}>L{l.level}{l.claimed > l.level ? ` · ${c.claimed.replace("{c}", String(l.claimed))}` : ""}</small>}
                      </button>
                    ))}
                    {g.items.length > SHOWN && <div className={`${s.more} ${frame.mono}`}>{c.more.replace("{n}", String(g.items.length - SHOWN))}</div>}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className={`${s.group} ${frame.mono}`}>{c.schema}</div>
              {types.map((name, k) => (
                <div key={k} className={s.schema}>
                  <div className={s.type}><i className={`${s.key} ${s[`k${k}`]}`} /><span>{name}</span><b>{nodes.filter((n) => n.kind === k).length}</b></div>
                  {k < 4 && <div className={`${s.rel} ${frame.mono}`}>↓ {relations[k]} <b>{links.filter((l) => l.rel === k).length}</b></div>}
                </div>
              ))}
              <p className={s.hint}>{c.hint}</p>
            </>
          )}
        </aside>
      </div>
    </section>
  );
}
