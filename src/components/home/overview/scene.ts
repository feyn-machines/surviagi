import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { HomeData, HomeRow, HomeUpdate, HomeWork } from "@/lib/home-data";

/**
 * The globe, as an imperative three.js scene. React owns the HUD and hears
 * about every state change through `onChange`; this file owns the sphere, the
 * five latitude bands on it, the links between them and the camera.
 *
 * Every object drawn stands for one row of the snapshot: a domain, a market, a
 * kind of work, an update or a company. Nothing is drawn for work no update
 * bears on.
 */

export type NodeKind = "domain" | "market" | "work" | "update" | "org";
export const KINDS: NodeKind[] = ["domain", "market", "work", "update", "org"];

export type Filters = { levels: number[]; orgs: string[]; domains: string[]; several: boolean; capped: boolean };
export const NO_FILTERS: Filters = { levels: [], orgs: [], domains: [], several: false, capped: false };

export type NodeRef = { id: string; kind: NodeKind; name: string };

export type PanelItem = NodeRef & {
  level?: number;
  claimed?: number;
  accepted?: number;
  tier?: string;
  date?: string | null;
};

export type Panel = NodeRef & {
  trail: NodeRef[];
  lit: Record<NodeKind, number>;
  groups: { kind: NodeKind; count: number; items: PanelItem[] }[];
  work?: { level: number; claimed: number };
  update?: { date: string | null; org: string; url: string | null; sources: number };
};

export type View = {
  day: number;
  playing: boolean;
  counts: Record<NodeKind, number>;
  l3: number;
  capped: number;
  today: number;
  ticker: { org: string; title: string } | null;
  panel: Panel | null;
  /** The updates of the chosen day, once a day has been picked on the timeline. */
  dayList: (NodeRef & { org: string })[] | null;
};

export type Hover = {
  x: number;
  y: number;
  kind: NodeKind;
  name: string;
  level?: number;
  claimed?: number;
  updates?: number;
  date?: string | null;
  org?: string;
};

export type SceneText = {
  domainLabel: (name: string, level: number, works: number) => string;
  orgLabel: (name: string, updates: number) => string;
  pulseMeta: (org: string, claimed: number, accepted: number) => string;
};

export type SceneClasses = {
  label: string;
  org: string;
  hot: string;
  dim: string;
  pulse: string;
  pulseCap: string;
  out: string;
};

export type SceneOptions = {
  canvas: HTMLCanvasElement;
  labels: HTMLElement;
  data: HomeData;
  lang: "en" | "zh";
  text: SceneText;
  classes: SceneClasses;
  reducedMotion: boolean;
  onChange: (view: View) => void;
  onHover: (hover: Hover | null) => void;
  onDock: (docked: boolean) => void;
};

export type OverviewScene = {
  dispose: () => void;
  select: (id: string | null) => void;
  back: () => void;
  backTo: (steps: number) => void;
  setDay: (day: number) => void;
  stepDay: (delta: number) => void;
  togglePlay: () => void;
  setFilters: (filters: Filters) => void;
  search: (text: string) => NodeRef[];
  reset: () => void;
  projectWork: (workId: string) => [number, number] | null;
  options: { orgs: { name: string; n: number }[]; domains: { id: string; name: string; n: number }[]; perDay: number[] };
};

type Mat = THREE.MeshBasicMaterial | THREE.LineBasicMaterial;

type Label = { el: HTMLDivElement; pos: THREE.Vector3; show: boolean; tight: boolean; dieAt: number };

type SceneNode = {
  kind: NodeKind;
  id: string;
  name: string;
  pos: THREE.Vector3;
  group: THREE.Group;
  body: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  edge: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial> | null;
  claim: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial> | null;
  up: SceneLink[];
  down: SceneLink[];
  on: boolean;
  lit: boolean;
  depth: number;
  alpha: number;
  level: number;
  claimed: number;
  height: number;
  work: HomeWork | null;
  update: HomeUpdate | null;
  label: Label | null;
};

type SceneLink = {
  a: SceneNode;
  b: SceneNode;
  kind: "tree" | "ev" | "org";
  row: HomeRow | null;
  line: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  ghost: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  on: boolean;
  lit: boolean;
  depth: number;
  opacity: number;
  pulseAt: number;
};

const W = 170;
const LH = 2.4;
const R = 60;
const RAD = Math.PI / 180;
const LAT: Record<NodeKind, number> = { domain: 60, market: 40, work: 14, update: -14, org: -34 };
const STEP = 1150;
const GAPX = 1.6;

/** A point on the sphere: x runs round the equator, z nudges the latitude. */
function onSphere(x: number, kind: NodeKind, z = 0, r = R): THREE.Vector3 {
  const lon = (x / W) * Math.PI * 2;
  const lat = (LAT[kind] - z * 0.8) * RAD;
  return new THREE.Vector3(Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon)).multiplyScalar(r);
}

/** A strip that follows the sphere along one latitude. */
function band(x0: number, x1: number, kind: NodeKind, half: number, r = R + 0.7) {
  const n = Math.max(2, Math.ceil((x1 - x0) / 2));
  const position: number[] = [];
  const index: number[] = [];
  const top: THREE.Vector3[] = [];
  const bottom: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n;
    const a = onSphere(x, kind, -half, r);
    const b = onSphere(x, kind, half, r);
    position.push(a.x, a.y, a.z, b.x, b.y, b.z);
    top.push(a);
    bottom.push(b);
    if (i < n) index.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.setIndex(index);
  return { geometry, outline: [...top, ...bottom.reverse(), top[0]] };
}

export function createScene(o: SceneOptions): OverviewScene {
  const { data, lang, canvas } = o;
  const last = data.days - 1;

  // Colours come from the design tokens on the page, so the scene follows them.
  const style = getComputedStyle(canvas);
  const token = (name: string, fallback: string) => new THREE.Color(style.getPropertyValue(name).trim() || fallback);
  const C = {
    bg: token("--ah-color-bg", "#161715"),
    line: token("--ah-color-line", "#393d36"),
    control: token("--ah-color-control", "#697463"),
    signal: token("--ah-color-signal", "#82c38c"),
    warn: token("--ah-color-warning", "#d8b46a"),
    subtle: token("--ah-color-subtle", "#929b8c"),
    text: token("--ah-color-text", "#f9f9f9"),
    surface: token("--ah-color-surface-active", "#232b23"),
  };
  const bodyColor = [
    C.surface,
    C.bg.clone().lerp(C.control, 0.28),
    C.bg.clone().lerp(C.signal, 0.36),
    C.signal,
    C.signal,
    C.signal,
  ];

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(C.bg);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(36, 1, 1, 900);
  const HOME = new THREE.Vector3(0, 78, 236);
  const TARGET = new THREE.Vector3(0, 2, 0);
  camera.position.copy(HOME);
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(TARGET);
  controls.enableDamping = true;
  controls.enableZoom = false; // the wheel scrolls the page
  controls.enablePan = false;
  controls.autoRotate = !o.reducedMotion;
  controls.autoRotateSpeed = 0.5;
  let fly: THREE.Vector3 | null = null;
  const onControlStart = () => {
    controls.autoRotate = false;
    fly = null;
  };
  controls.addEventListener("start", onControlStart);

  const lineMat = (color: THREE.Color, opacity: number) =>
    new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });

  const labels: Label[] = [];
  function addLabel(cls: string, pos: THREE.Vector3, text: string, tight = false): Label {
    const el = document.createElement("div");
    el.className = cls ? `${o.classes.label} ${cls}` : o.classes.label;
    el.textContent = text;
    o.labels.append(el);
    const label = { el, pos, show: true, tight, dieAt: 0 };
    labels.push(label);
    return label;
  }

  // The sphere, its graticule and the L3 line over the work belt.
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(R - 0.4, 64, 48), new THREE.MeshBasicMaterial({ color: C.bg.clone().lerp(C.surface, 0.35) })));
  {
    const pts: THREE.Vector3[] = [];
    for (let lat = -75; lat <= 75; lat += 15) {
      for (let i = 0; i < 96; i++) {
        for (const j of [i, i + 1]) {
          const a = (j / 96) * Math.PI * 2;
          const c = Math.cos(lat * RAD);
          pts.push(new THREE.Vector3(c * Math.sin(a), Math.sin(lat * RAD), c * Math.cos(a)).multiplyScalar(R));
        }
      }
    }
    for (let lon = 0; lon < 360; lon += 15) {
      for (let i = 0; i < 48; i++) {
        for (const j of [i, i + 1]) {
          const b = (-80 + (j / 48) * 160) * RAD;
          const a = lon * RAD;
          pts.push(new THREE.Vector3(Math.cos(b) * Math.sin(a), Math.sin(b), Math.cos(b) * Math.cos(a)).multiplyScalar(R));
        }
      }
    }
    scene.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), lineMat(C.line, 0.55)));
    const ring = band(-W / 2, W / 2, "work", 13, R + 2.5 * LH);
    scene.add(
      new THREE.Mesh(ring.geometry, new THREE.MeshBasicMaterial({ color: C.signal, transparent: true, opacity: 0.09, side: THREE.DoubleSide, depthWrite: false })),
      new THREE.Line(new THREE.BufferGeometry().setFromPoints(ring.outline), lineMat(C.signal, 0.6)),
    );
  }

  // ---------- nodes and links ----------
  const nodes: SceneNode[] = [];
  const byId = new Map<string, SceneNode>();
  const links: SceneLink[] = [];
  const unit = new THREE.BoxGeometry(1, 1, 1);
  unit.translate(0, 0.5, 0);
  const unitEdges = new THREE.EdgesGeometry(unit);
  const UP = new THREE.Vector3(0, 1, 0);

  function addNode(
    kind: NodeKind,
    id: string,
    name: string,
    pos: THREE.Vector3,
    size: [number, number, number],
    color: THREE.Color,
    edgeColor: THREE.Color | null,
    strip?: ReturnType<typeof band>,
  ): SceneNode {
    const group = new THREE.Group();
    const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1 });
    const body = new THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>(strip ? strip.geometry : unit, material);
    let edge: SceneNode["edge"] = null;
    if (strip) {
      material.side = THREE.DoubleSide;
      edge = new THREE.Line(new THREE.BufferGeometry().setFromPoints(strip.outline), lineMat(edgeColor ?? C.signal, 0.8));
    } else {
      group.position.copy(pos);
      group.quaternion.setFromUnitVectors(UP, pos.clone().normalize());
      body.scale.set(...size);
      if (edgeColor) {
        edge = new THREE.LineSegments(unitEdges, lineMat(edgeColor, 0.8));
        edge.scale.copy(body.scale);
      }
    }
    group.add(body);
    if (edge) group.add(edge);
    scene.add(group);
    const node: SceneNode = {
      kind, id, name, pos, group, body, edge, claim: null, up: [], down: [],
      on: true, lit: false, depth: 0, alpha: 1, level: 0, claimed: 0, height: 0, work: null, update: null, label: null,
    };
    body.userData.node = node;
    nodes.push(node);
    byId.set(id, node);
    return node;
  }

  function addLink(a: SceneNode, b: SceneNode, kind: SceneLink["kind"], row: HomeRow | null): SceneLink {
    const ua = a.pos.clone().normalize();
    const ub = b.pos.clone().normalize();
    const angle = ua.angleTo(ub);
    const axis = new THREE.Vector3().crossVectors(ua, ub);
    if (axis.lengthSq() < 1e-8) axis.set(1, 0, 0);
    axis.normalize();
    const n = Math.max(6, Math.ceil(angle / 0.06));
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      pts.push(ua.clone().applyAxisAngle(axis, angle * t).multiplyScalar(R + 1 + Math.sin(Math.PI * t) * (1.5 + angle * 5)));
    }
    const geometry = new THREE.BufferGeometry().setFromPoints(pts);
    const line = new THREE.Line(geometry, lineMat(C.subtle, 0));
    const ghost = new THREE.Line(geometry, lineMat(C.text, 0.2));
    ghost.material.depthFunc = THREE.GreaterDepth; // the part of a lit link that runs behind the sphere
    ghost.visible = false;
    scene.add(line, ghost);
    const link: SceneLink = { a, b, kind, row, line, ghost, on: true, lit: false, depth: 0, opacity: 0, pulseAt: 0 };
    a.down.push(link);
    b.up.push(link);
    links.push(link);
    return link;
  }

  // Domains → markets → work: a tree laid out along x so links run mostly straight down.
  const byDomain = new Map<string, HomeWork[]>();
  for (const w of data.works) {
    const list = byDomain.get(w.domainId);
    if (list) list.push(w);
    else byDomain.set(w.domainId, [w]);
  }
  const domainList = [...byDomain.entries()].sort((a, b) => b[1].length - a[1].length);
  const weight = (n: number) => Math.max(n, 3.2);
  {
    const total = domainList.reduce((s, [, l]) => s + weight(l.length), 0);
    let x0 = -W / 2;
    for (const [domainId, list] of domainList) {
      const w = ((W - GAPX * domainList.length) * weight(list.length)) / total;
      const name = data.domains[domainId]?.[lang] ?? domainId;
      const dn = addNode("domain", `d:${domainId}`, name, onSphere(x0 + w / 2, "domain", 0, R + 0.7), [0, 0, 0], C.surface, C.signal, band(x0, x0 + w, "domain", 4));
      dn.label = addLabel("", dn.pos, name, true);
      const byMarket = new Map<string, HomeWork[]>();
      for (const work of list) {
        const key = work.market.en;
        const l = byMarket.get(key);
        if (l) l.push(work);
        else byMarket.set(key, [work]);
      }
      const markets = [...byMarket.values()].sort((a, b) => b.length - a.length);
      const ordered = markets.flatMap((l) => l.sort((a, b) => b.level - a.level));
      const cols = Math.max(1, Math.floor(w / 3.4));
      const rows = Math.ceil(ordered.length / cols);
      const xOf = new Map<string, number>();
      const zOf = new Map<string, number>();
      ordered.forEach((work, i) => {
        xOf.set(work.id, x0 + (w * (Math.floor(i / rows) + 0.5)) / cols);
        zOf.set(work.id, ((i % rows) - (rows - 1) / 2) * 4.2);
      });
      markets.forEach((works, mi) => {
        const mx = works.reduce((s, work) => s + (xOf.get(work.id) ?? 0), 0) / works.length;
        const mn = addNode("market", `m:${domainId}|${works[0].market.en}`, works[0].market[lang], onSphere(mx, "market", ((mi % 3) - 1) * 6.5), [2.6, 0.8, 2.6], C.surface, C.signal);
        addLink(dn, mn, "tree", null);
        for (const work of works) {
          const wn = addNode("work", work.id, work.name[lang], onSphere(xOf.get(work.id) ?? 0, "work", zOf.get(work.id) ?? 0), [2.2, 1, 2.2], bodyColor[work.level] ?? C.signal, C.signal);
          wn.work = work;
          wn.claim = new THREE.LineSegments(unitEdges, lineMat(C.warn, 0.85));
          wn.group.add(wn.claim);
          addLink(mn, wn, "tree", null);
        }
      });
      x0 += w + GAPX;
    }
  }

  // Companies and their updates.
  const byOrg = new Map<string, HomeUpdate[]>();
  for (const u of data.updates) {
    const l = byOrg.get(u.org);
    if (l) l.push(u);
    else byOrg.set(u.org, [u]);
  }
  const orgList = [...byOrg.entries()].sort((a, b) => b[1].length - a[1].length);
  {
    const ow = (n: number) => Math.max(n, 16);
    const total = orgList.reduce((s, [, l]) => s + ow(l.length), 0);
    let x0 = -W / 2;
    for (const [name, list] of orgList) {
      const w = ((W - GAPX * orgList.length) * ow(list.length)) / total;
      const on = addNode("org", `o:${name}`, name, onSphere(x0 + w / 2, "org", 0, R + 0.7), [0, 0, 0], C.surface, C.text, band(x0, x0 + w, "org", 4));
      on.label = addLabel(o.classes.org, on.pos, o.text.orgLabel(name, list.length));
      list.sort((a, b) => a.day - b.day);
      const cols = Math.max(1, Math.floor(w / 2));
      const rows = Math.ceil(list.length / cols);
      list.forEach((u, i) => {
        const un = addNode("update", u.id, u.title, onSphere(x0 + (w * (Math.floor(i / rows) + 0.5)) / cols, "update", ((i % rows) - (rows - 1) / 2) * 2.4), [1.1, 1.1, 1.1], C.subtle, null);
        un.update = u;
        addLink(un, on, "org", null);
      });
      x0 += w + GAPX;
    }
  }
  for (const row of data.rows) {
    const work = byId.get(row.work);
    const update = byId.get(row.update);
    if (!work || !update) continue;
    addLink(work, update, "ev", row);
    if (row.tier !== "T3") update.body.material.color.copy(C.signal);
  }
  const works = nodes.filter((n) => n.kind === "work");
  const perDay = Array.from({ length: data.days }, () => 0);
  for (const u of data.updates) if (u.date) perDay[u.day]++;

  // ---------- state ----------
  let day = last;
  let dayOpen = false;
  let selected: SceneNode | null = null;
  let selectedAt = 0;
  const trail: SceneNode[] = [];
  let filters: Filters = NO_FILTERS;
  let playing = false;
  let playTimer = 0;
  const stepTimers: number[] = [];
  let hold = 0;
  let first = true;
  let docked = false;
  let dockT = -1;
  let disposed = false;

  const ref = (n: SceneNode): NodeRef => ({ id: n.id, kind: n.kind, name: n.name });
  const count = (kind: NodeKind, lit = false) => nodes.reduce((s, n) => s + (n.kind === kind && n.on && (!lit || n.lit) ? 1 : 0), 0);
  const domainOf = (n: SceneNode) => n.work?.domainId ?? "";

  function panel(): Panel | null {
    const sel = selected;
    if (!sel) return null;
    const lit = Object.fromEntries(KINDS.map((k) => [k, count(k, true)])) as Record<NodeKind, number>;
    const groups: Panel["groups"] = [];
    for (const kind of KINDS) {
      if (kind === sel.kind) continue;
      const list = nodes.filter((n) => n.kind === kind && n.lit);
      if (!list.length) continue;
      if (kind === "work") list.sort((a, b) => b.level - a.level);
      const items = list.slice(0, 40).map((n): PanelItem => {
        const item: PanelItem = ref(n);
        if (kind === "work") {
          const row = sel.kind === "update" ? sel.up.find((l) => l.a === n)?.row : null;
          if (row) Object.assign(item, { claimed: row.claimed, accepted: row.accepted, tier: row.tier });
          else item.level = n.level;
        } else if (kind === "update") {
          const row = sel.kind === "work" ? sel.down.find((l) => l.b === n)?.row : null;
          if (row) Object.assign(item, { claimed: row.claimed, accepted: row.accepted, tier: row.tier });
          item.date = n.update?.date ?? null;
        }
        return item;
      });
      groups.push({ kind, count: list.length, items });
    }
    const out: Panel = { ...ref(sel), trail: trail.map(ref), lit, groups };
    if (sel.kind === "work") out.work = { level: sel.level, claimed: sel.claimed };
    if (sel.update) out.update = { date: sel.update.date, org: sel.update.org, url: sel.update.url, sources: sel.update.sources };
    return out;
  }

  function apply() {
    const narrowed = filters.levels.length > 0 || filters.orgs.length > 0 || filters.domains.length > 0 || filters.several || filters.capped;
    for (const n of nodes) {
      n.lit = false;
      if (n.update) n.on = n.update.day <= day && (!filters.orgs.length || filters.orgs.includes(n.update.org));
    }
    for (const l of links) {
      l.lit = false;
      if (l.row) l.on = l.b.on && (!filters.several || l.row.tier !== "T3") && (!filters.capped || l.row.claimed > l.row.accepted);
    }
    for (const n of works) {
      n.level = 0;
      n.claimed = 0;
      for (const l of n.down) {
        if (!l.on || !l.row) continue;
        n.level = Math.max(n.level, l.row.accepted);
        n.claimed = Math.max(n.claimed, l.row.claimed);
      }
      // The last day follows the published level, which also counts evidence the snapshot does not list.
      if (day === last && n.level && n.work && !filters.several && !filters.capped && !filters.orgs.length) n.level = n.work.level;
      n.on = n.level > 0 && (!filters.levels.length || filters.levels.includes(n.level)) && (!filters.domains.length || filters.domains.includes(domainOf(n)));
      n.body.material.color.copy(bodyColor[n.level] ?? bodyColor[1]);
    }
    for (const l of links) if (l.kind === "ev") l.on = l.on && l.a.on;
    // A narrowed view keeps only the updates that still reach some work.
    if (narrowed) for (const n of nodes) if (n.kind === "update") n.on = n.on && n.up.some((l) => l.on);
    for (const l of links) if (l.kind === "org") l.on = l.a.on;
    for (const kind of ["market", "domain", "org"] as const) {
      for (const n of nodes) {
        if (n.kind !== kind) continue;
        n.on = kind === "org" ? n.up.some((l) => l.a.on) : n.down.some((l) => l.b.on);
      }
    }
    for (const l of links) if (l.kind === "tree") l.on = l.a.on && l.b.on;
    if (selected && !selected.on) {
      selected = null;
      trail.length = 0;
    }
    if (selected) {
      // Light the chain: up from the selection, and down from it.
      selected.lit = true;
      selected.depth = 0;
      for (const dir of ["up", "down"] as const) {
        let front: SceneNode[] = [selected];
        while (front.length) {
          const next: SceneNode[] = [];
          for (const n of front) {
            for (const l of n[dir]) {
              if (!l.on) continue;
              const other = dir === "up" ? l.a : l.b;
              l.lit = true;
              l.depth = n.depth + 1;
              if (!other.lit) {
                other.lit = true;
                other.depth = n.depth + 1;
                next.push(other);
              }
            }
          }
          front = next;
        }
      }
    }
    for (const n of nodes) {
      if (n.kind === "domain" && n.label) {
        const under = n.down.flatMap((l) => l.b.down.map((m) => m.b)).filter((w) => w.on);
        n.label.show = n.on;
        if (n.on) n.label.el.textContent = o.text.domainLabel(n.name, Math.max(...under.map((w) => w.level)), under.length);
      } else if (n.kind === "org" && n.label) n.label.show = n.on;
      else if (n.label) n.label.show = false;
      if ((n.kind === "domain" || n.kind === "org") && n.label) {
        n.label.el.classList.toggle(o.classes.dim, !!selected && !n.lit);
        n.label.el.classList.toggle(o.classes.hot, n.lit);
      }
    }
    if (selected) {
      for (const [kind, max, lift] of [["market", 6, 1.03], ["work", 4, 1.13]] as const) {
        const list = nodes.filter((n) => n.kind === kind && n.lit);
        if (list.length > max) continue;
        for (const n of list) {
          n.label ??= addLabel(o.classes.hot, n.pos.clone().multiplyScalar(lift), n.name);
          n.label.show = true;
        }
      }
      fly = new THREE.Vector3();
      for (const n of nodes) if (n.lit) fly.addScaledVector(n.pos, n === selected ? 12 : 1);
      fly.y = Math.max(fly.y, 0) * 0.4 + fly.length() * 0.2;
      fly.normalize();
    }
    selectedAt = performance.now();
    const todays = nodes.filter((n) => n.update && n.on && n.update.date && n.update.day === day);
    o.onChange({
      day,
      playing,
      counts: Object.fromEntries(KINDS.map((k) => [k, count(k)])) as Record<NodeKind, number>,
      l3: works.filter((n) => n.on && n.level >= 3).length,
      capped: works.filter((n) => n.on && n.claimed > n.level).length,
      today: perDay[day] ?? 0,
      ticker: todays[0]?.update ? { org: todays[0].update.org, title: todays[0].update.title } : null,
      panel: panel(),
      dayList: dayOpen && !selected ? todays.map((n) => ({ ...ref(n), org: n.update?.org ?? "" })) : null,
    });
  }

  function go(node: SceneNode | null) {
    if (node && selected && node !== selected) trail.push(selected);
    if (!node) trail.length = 0;
    selected = node;
    apply();
  }

  // ---------- playback: each day's updates fire one at a time ----------
  function fire(link: SceneLink) {
    const now = performance.now();
    const row = link.row;
    if (!row || !link.b.update) return;
    link.pulseAt = now;
    for (const out of link.b.down) out.pulseAt = now;
    const cls = row.claimed > row.accepted ? `${o.classes.pulse} ${o.classes.pulseCap}` : o.classes.pulse;
    const label = addLabel(cls, link.a.pos.clone().multiplyScalar(1.1), link.a.name);
    const meta = document.createElement("small");
    meta.textContent = o.text.pulseMeta(link.b.update.org, row.claimed, row.accepted);
    label.el.append(meta);
    label.dieAt = now + STEP + 500;
  }

  /** Advances one day and returns how long that day stays on screen. */
  function tick(): number {
    if (day >= last) {
      if (++hold < 5) return 900;
      hold = 0;
      day = -1;
    }
    day++;
    apply();
    const seen = new Set<SceneNode>();
    const candidates: SceneLink[] = [];
    for (const l of links) {
      if (l.kind !== "ev" || !l.on || !l.b.update?.date || l.b.update.day !== day || seen.has(l.a)) continue;
      seen.add(l.a);
      candidates.push(l);
    }
    const eye = camera.position.clone().normalize();
    const facing = (l: SceneLink) => Math.round(((l.a.pos.dot(eye) + l.b.pos.dot(eye)) / R) * 2.5);
    candidates.sort((x, y) => facing(y) - facing(x) || (y.row?.accepted ?? 0) - (x.row?.accepted ?? 0));
    const shown = candidates.slice(0, 4);
    shown.forEach((l, i) => {
      if (i === 0) fire(l);
      else stepTimers.push(window.setTimeout(() => fire(l), i * STEP));
    });
    return Math.max(700, shown.length * STEP + 250);
  }

  function stop() {
    if (!playing) return;
    playing = false;
    window.clearTimeout(playTimer);
    stepTimers.forEach((t) => window.clearTimeout(t));
    stepTimers.length = 0;
  }
  function play() {
    if (playing || disposed) return;
    playing = true;
    if (day >= last) hold = 4; // wrap on the first tick instead of blanking the globe now
    const run = () => {
      if (!playing) return;
      playTimer = window.setTimeout(run, tick());
    };
    playTimer = window.setTimeout(run, 300);
  }

  // ---------- pointer ----------
  const ray = new THREE.Raycaster();
  const mouse = new THREE.Vector2();
  function pick(e: PointerEvent): SceneNode | null {
    const rect = canvas.getBoundingClientRect();
    mouse.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(mouse, camera);
    const hit = ray.intersectObjects(nodes.filter((n) => n.on).map((n) => n.body), false)[0];
    return (hit?.object.userData.node as SceneNode | undefined) ?? null;
  }
  let down: [number, number] | null = null;
  const onDown = (e: PointerEvent) => {
    down = [e.clientX, e.clientY];
  };
  const onUp = (e: PointerEvent) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
    const node = pick(e);
    if (node) stop();
    go(node);
  };
  const onMove = (e: PointerEvent) => {
    const n = pick(e);
    canvas.style.cursor = n ? "pointer" : "grab";
    if (!n) return o.onHover(null);
    const hover: Hover = { x: e.clientX, y: e.clientY, kind: n.kind, name: n.name };
    if (n.kind === "work") Object.assign(hover, { level: n.level, claimed: n.claimed, updates: n.down.filter((l) => l.on).length });
    if (n.update) Object.assign(hover, { date: n.update.date, org: n.update.org });
    if (n.kind === "org") hover.updates = n.up.filter((l) => l.on).length;
    o.onHover(hover);
  };
  const onLeave = () => o.onHover(null);
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerleave", onLeave);

  // ---------- frame ----------
  const v = new THREE.Vector3();
  let raf = 0;
  let width = 0;
  let height = 0;
  function frame() {
    raf = requestAnimationFrame(frame);
    const w = window.innerWidth;
    const h = window.innerHeight;
    const now = performance.now();
    if (w !== width || h !== height) {
      width = w;
      height = h;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    // Scrolling down shrinks and fades the overview; the page takes over.
    const t = Math.min(1, window.scrollY / (h * 1.05));
    const eased = t * t * (3 - 2 * t);
    if (eased !== dockT) {
      dockT = eased;
      camera.zoom = 1 - 0.45 * eased;
      camera.updateProjectionMatrix();
      canvas.style.opacity = String(1 - eased);
    }
    if (t > 0.3 !== docked) {
      docked = t > 0.3;
      o.onDock(docked);
      if (docked) {
        stop();
        o.onHover(null);
        day = last; // docked: the full current state, no replay
        apply();
      } else if (!o.reducedMotion && !selected) play();
    }
    for (let i = labels.length - 1; i >= 0; i--) {
      const l = labels[i];
      if (!l.dieAt) continue;
      if (now > l.dieAt) {
        l.el.remove();
        labels.splice(i, 1);
      } else if (now > l.dieAt - 700) l.el.classList.add(o.classes.out);
    }
    if (eased >= 1) return; // fully handed over: nothing to draw

    if (fly) {
      controls.autoRotate = false;
      const distance = camera.position.length();
      const current = camera.position.clone().normalize();
      if (current.angleTo(fly) < 0.01) fly = null;
      else camera.position.copy(current.lerp(fly, o.reducedMotion ? 1 : 0.07).normalize().multiplyScalar(distance));
    }
    controls.update();
    const ramp = (depth: number) => (first || o.reducedMotion ? 1 : Math.min(1, Math.max(0, (now - selectedAt - depth * 260) / 320)));
    const ease = (k: number) => (first || o.reducedMotion ? 1 : k);
    for (const n of nodes) {
      n.group.visible = n.on;
      if (!n.on) continue;
      const target = !selected ? 1 : n.lit ? 0.22 + 0.78 * ramp(n.depth) : 0.13;
      n.alpha += (target - n.alpha) * ease(0.2);
      n.body.material.opacity = n.alpha;
      if (n.edge) n.edge.material.opacity = n.alpha * (n.kind === "work" && n.level < 3 ? 0.6 : 0.9);
      if (n.kind === "work" && n.edge && n.claim) {
        const accepted = n.level * LH;
        const claimed = Math.max(n.claimed, n.level) * LH;
        n.height += (accepted - n.height) * ease(0.15);
        n.body.scale.y = n.edge.scale.y = Math.max(n.height, 0.01);
        n.claim.visible = claimed - n.height > 0.1;
        n.claim.position.y = n.height;
        n.claim.scale.set(2.2, Math.max(claimed - n.height, 0.01), 2.2);
        n.claim.material.opacity = n.alpha * 0.85;
      }
    }
    for (const l of links) {
      const base = !l.on ? 0 : l.kind === "tree" ? (selected ? 0.07 : 0.3) : 0;
      const target = l.on && l.lit ? Math.max(base, 0.85 * ramp(l.depth)) : base;
      l.opacity += (target - l.opacity) * ease(0.25);
      const pulse = l.on && l.pulseAt ? Math.max(0, Math.min(1, 1.6 - (now - l.pulseAt) / 1000)) : 0;
      const shown = Math.max(l.opacity, pulse * 0.9);
      l.line.visible = shown > 0.01;
      l.line.material.opacity = shown;
      const hot = l.lit || pulse > 0;
      l.line.material.color.copy(!hot ? C.subtle : !l.row ? C.text : l.row.tier !== "T3" ? C.signal : l.row.claimed > l.row.accepted ? C.warn : C.text);
      l.line.renderOrder = l.lit ? 2 : 0;
      l.ghost.visible = l.on && l.lit && l.opacity > 0.3;
      if (l.ghost.visible) l.ghost.material.color.copy(l.line.material.color);
    }
    first = false;
    renderer.render(scene, camera);
    const reach = camera.position.length();
    for (const l of labels) {
      v.copy(l.pos).project(camera);
      const facing = l.pos.dot(camera.position) > (l.tight ? R * reach * 0.5 : R * R * 1.02);
      const show = l.show && facing && v.z < 1 && Math.abs(v.x) < 1.2 && Math.abs(v.y) < 1.2;
      l.el.style.display = show ? "" : "none";
      if (show) {
        l.el.style.left = `${((v.x + 1) / 2) * w}px`;
        l.el.style.top = `${((1 - v.y) / 2) * h}px`;
      }
    }
  }

  if (!o.reducedMotion) play();
  apply();
  frame();

  return {
    options: {
      orgs: orgList.map(([name, l]) => ({ name, n: l.length })),
      domains: domainList.map(([id, l]) => ({ id, name: data.domains[id]?.[lang] ?? id, n: l.length })),
      perDay,
    },
    select(id) {
      const node = id ? (byId.get(id) ?? null) : null;
      if (node) stop();
      else dayOpen = false; // closing the panel closes the day list behind it too
      go(node);
    },
    back() {
      selected = trail.pop() ?? null;
      apply();
    },
    backTo(steps) {
      for (let i = steps; i > 1; i--) trail.pop();
      selected = trail.pop() ?? null;
      apply();
    },
    setDay(next) {
      stop();
      day = Math.max(0, Math.min(last, next));
      // Picking a day asks what happened on it: the panel lists that day's updates.
      dayOpen = true;
      selected = null;
      trail.length = 0;
      apply();
    },
    stepDay(delta) {
      stop();
      day = Math.max(0, Math.min(last, day + delta));
      apply();
    },
    togglePlay() {
      if (playing) stop();
      else {
        dayOpen = false;
        play();
      }
      apply();
    },
    setFilters(next) {
      filters = next;
      apply();
    },
    search(text) {
      const needle = text.trim().toLowerCase();
      if (!needle) return [];
      return nodes
        .filter((n) => n.on && n.name.toLowerCase().includes(needle))
        .sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind))
        .slice(0, 10)
        .map(ref);
    },
    reset() {
      selected = null;
      dayOpen = false;
      trail.length = 0;
      fly = null;
      camera.position.copy(HOME);
      controls.target.copy(TARGET);
      controls.autoRotate = !o.reducedMotion;
      apply();
      if (!o.reducedMotion) play();
    },
    projectWork(workId) {
      const node = byId.get(workId);
      if (!node || node.kind !== "work") return null;
      v.copy(node.pos).multiplyScalar(1.06).project(camera);
      return [((v.x + 1) / 2) * window.innerWidth, ((1 - v.y) / 2) * window.innerHeight];
    },
    dispose() {
      disposed = true;
      stop();
      cancelAnimationFrame(raf);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
      controls.removeEventListener("start", onControlStart);
      controls.dispose();
      scene.traverse((object) => {
        const drawn = object as THREE.Mesh<THREE.BufferGeometry, Mat | Mat[]>;
        drawn.geometry?.dispose();
        const material = drawn.material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material?.dispose();
      });
      renderer.dispose();
      for (const l of labels) l.el.remove();
      labels.length = 0;
    },
  };
}
