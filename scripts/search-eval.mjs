#!/usr/bin/env node
// Agent search evaluation (Issue #30): asks a running site the questions of scripts/tests/fixtures/search-eval.json
// with the search's default record types and reports how many find a record bearing on what they are about in the first k results. Relevance is read from
// the snapshot the site loaded, never from the search response itself.
//
//   node scripts/search-eval.mjs --base http://127.0.0.1:3000 [--snapshot DIR] [--k 5] [--json]
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const EVAL_FILE = join(ROOT, "scripts", "tests", "fixtures", "search-eval.json");

const readJson = (dir, name) => {
  const path = join(dir, `${name}.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
};

/** For each record id of the snapshot, the occupations and markets it bears on. */
export function concernsOf(snapshotDir) {
  const work = readJson(snapshotDir, "work") ?? readJson(snapshotDir, "chain")?.activities?.map((a) => ({ id: a.activity_id, market_id: a.market_id })) ?? [];
  const marketOf = new Map(work.map((w) => [w.id ?? w.activity_id, w.market_id]));
  const out = new Map();
  for (const e of readJson(snapshotDir, "events") ?? []) {
    out.set(e.event_id, new Set((e.work ?? []).map((w) => marketOf.get(w.activity_id)).filter(Boolean)));
  }
  for (const t of readJson(snapshotDir, "topics") ?? []) out.set(t.topic_id, new Set(t.about?.id ? [t.about.id] : []));
  for (const o of readJson(snapshotDir, "observations") ?? []) {
    const ids = new Set();
    for (const c of o.concerns ?? []) {
      if (c.kind === "occupation") ids.add(c.concept_id);
      if (c.kind === "work" && marketOf.get(c.concept_id)) ids.add(marketOf.get(c.concept_id));
    }
    for (const id of [o.observation_id, ...(o.merged_from ?? [])]) out.set(id, ids);
  }
  return out;
}

/** Runs every question against `base`; returns per-question results and the hit rate overall and per language. */
export async function evaluate({ base, snapshotDir, k, evalFile = EVAL_FILE, headers = {} }) {
  const set = JSON.parse(readFileSync(evalFile, "utf8"));
  const depth = k ?? set.k;
  const concerns = concernsOf(snapshotDir);
  const rows = [];
  for (const q of set.questions) {
    const params = new URLSearchParams({ query: q.query, limit: String(depth), language: q.language });
    const res = await fetch(`${base}/api/agent/search?${params}`, { headers });
    if (res.status !== 200) throw new Error(`${q.id}: search answered ${res.status}`);
    const body = await res.json();
    const results = body.results.slice(0, depth);
    const rank = results.findIndex((r) => q.expect.some((id) => concerns.get(r.id)?.has(id)));
    rows.push({
      id: q.id,
      language: q.language,
      query: q.query,
      total: body.total,
      hit: rank >= 0,
      rank: rank >= 0 ? rank + 1 : null,
      types: results.map((r) => r.type),
      /** Results whose title is in the language asked for, as the response labels it. */
      titles_in_language: results.filter((r) => (r.title_language ?? "en") === q.language).length,
    });
  }
  const rate = (list) => (list.length ? list.filter((r) => r.hit).length / list.length : null);
  return {
    k: depth,
    questions: rows.length,
    hit_rate: rate(rows),
    by_language: Object.fromEntries(["en", "zh-CN"].map((l) => [l, rate(rows.filter((r) => r.language === l))])),
    mrr: rows.reduce((sum, r) => sum + (r.rank ? 1 / r.rank : 0), 0) / Math.max(1, rows.length),
    rows,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : fallback;
  };
  const base = arg("base", null);
  if (!base) {
    console.error("usage: node scripts/search-eval.mjs --base URL [--snapshot DIR] [--k N] [--json]");
    process.exit(2);
  }
  const report = await evaluate({
    base,
    snapshotDir: arg("snapshot", process.env.SNAPSHOT_DIR ?? join(ROOT, "datasets", "published", "latest")),
    k: arg("k", null) ? Number(arg("k")) : undefined,
  });
  if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else {
    for (const r of report.rows) console.log(`${r.hit ? "hit " : "miss"} ${r.rank ?? "-"}  ${r.language.padEnd(5)} ${r.total.toString().padStart(4)}  ${r.query}  [${r.types.join(",")}]`);
    const pct = (v) => (v === null ? "—" : `${Math.round(v * 100)}%`);
    console.log(`hit@${report.k}: ${pct(report.hit_rate)} (en ${pct(report.by_language.en)}, zh-CN ${pct(report.by_language["zh-CN"])}), MRR ${report.mrr.toFixed(2)}`);
  }
}
