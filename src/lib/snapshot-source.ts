import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";
import type { Manifest, Payload } from "./snapshot";

/** One release ready to swap in: the dataset and the id the release is known by. */
export type Loaded = { payload: Payload; releaseId: string };

/** The collections of a release and how each is shaped; mirrors `COLLECTIONS` in scripts/data_pipeline/kg.py. */
const LISTS = ["markets", "tasks", "events", "models", "sources", "topics"] as const;
const CHAIN_LISTS = ["activities", "gates", "events", "evidence", "gate_edges"] as const;
const SINGLES = ["coverage", "progress"] as const;

/** `<generated_at UTC YYYYMMDDTHHMMSSZ>-<content_sha256[:8]>`, the id `kg.py` gives a release. */
export function releaseIdOf(manifest: Pick<Manifest, "generated_at" | "content_sha256">): string {
  const stamp = new Date(manifest.generated_at).toISOString().replace(/[-:]|\.\d+/g, "");
  return `${stamp}-${manifest.content_sha256.slice(0, 8)}`;
}

// ---------------------------------------------------------------- database ----

const pools = new Map<string, Pool>();

/** One small pool per connection string, kept for the life of the process. */
async function pool(url: string): Promise<Pool> {
  const found = pools.get(url);
  if (found) return found;
  const { Pool } = await import("pg");
  const created = new Pool({
    connectionString: url,
    max: 2,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    query_timeout: 60000,
    application_name: "openaiwill-site",
  });
  // An idle connection dropped by the server is reported here; unhandled it would end the process.
  created.on("error", (error) => console.error(`[data-release] idle connection error: ${error.message}`));
  pools.set(url, created);
  return created;
}

/** The id of the active release, or null when none is active. Throws when the database cannot be reached. */
export async function activeReleaseId(url: string): Promise<string | null> {
  const result = await (await pool(url)).query<{ release_id: string }>("SELECT release_id FROM kg.active");
  return result.rows[0]?.release_id ?? null;
}

/** Reassemble the active release as `unpack` in kg.py does. Null when there is no active release. */
export async function loadFromDatabase(url: string): Promise<Loaded | null> {
  const db = await pool(url);
  const active = await db.query<{ seq: number; release_id: string; manifest: Manifest }>(
    "SELECT seq, release_id, manifest FROM kg.active",
  );
  const release = active.rows[0];
  if (!release) return null;
  const rows = await db.query<{ collection: string; ord: number; doc: unknown }>(
    "SELECT rr.collection, rr.ord, d.doc FROM kg.release_rows rr JOIN kg.docs d USING (sha256) " +
      "WHERE rr.release_seq = $1 ORDER BY rr.collection, rr.ord",
    [release.seq],
  );
  const grouped = new Map<string, unknown[]>();
  for (const row of rows.rows) {
    const list = grouped.get(row.collection);
    if (list) list.push(row.doc);
    else grouped.set(row.collection, [row.doc]);
  }
  const list = (name: string) => grouped.get(name) ?? [];
  const single = (name: string) => {
    const docs = list(name);
    if (docs.length !== 1) throw new Error(`release ${release.release_id}: ${name} must be one document, found ${docs.length}`);
    return docs[0];
  };
  const known = new Set<string>([...LISTS, ...SINGLES, ...CHAIN_LISTS.map((n) => `chain.${n}`)]);
  for (const name of grouped.keys()) {
    if (!known.has(name)) throw new Error(`release ${release.release_id}: unknown collection ${name}`);
  }
  const payload = {
    chain: Object.fromEntries(CHAIN_LISTS.map((n) => [n, list(`chain.${n}`)])),
    manifest: release.manifest,
    markets: list("markets"),
    tasks: list("tasks"),
    events: list("events"),
    coverage: single("coverage"),
    progress: single("progress"),
    sources: list("sources"),
    topics: list("topics"),
  } as unknown as Payload;
  return { payload, releaseId: release.release_id };
}

// ------------------------------------------------------------------- files ----

/** The published snapshot files; null when the directory holds no manifest. A malformed file throws. */
export function loadFromFiles(dir: string): Loaded | null {
  const path = (name: string) => join(/* turbopackIgnore: true */ dir, `${name}.json`);
  if (!existsSync(path("manifest"))) return null;
  const read = (name: string): unknown => {
    try {
      return JSON.parse(readFileSync(path(name), "utf8"));
    } catch (error) {
      throw new Error(`${path(name)}: ${(error as Error).message}`);
    }
  };
  const manifest = read("manifest") as Manifest;
  const payload = {
    chain: read("chain"),
    manifest,
    markets: read("markets"),
    tasks: read("tasks"),
    events: read("events"),
    coverage: read("coverage"),
    progress: read("progress"),
    sources: read("sources"),
    // A snapshot written before topics were published has no such file.
    topics: existsSync(path("topics")) ? read("topics") : [],
  } as Payload;
  return { payload, releaseId: releaseIdOf(manifest) };
}
