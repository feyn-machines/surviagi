import { join } from "node:path";
import { dataRelease, replaceSnapshot } from "./lib/snapshot";
import { activeReleaseId, loadFromDatabase, loadFromFiles } from "./lib/snapshot-source";

const START_ATTEMPTS = 5;
const START_RETRY_MS = 2000;

/**
 * Loads the data release and keeps it current. `register()` waits for it, so a
 * server that cannot load its data does not stay up.
 */
export async function loadData() {
  try {
    await load();
  } catch (error) {
    // The standalone server is already listening when this runs and would answer every
    // request with a 500 for good. A server that cannot load its data must not stay up.
    console.error(`[data-release] cannot load the data release, exiting: ${(error as Error).message}`);
    process.exit(1);
  }
}

async function load() {
  const url = process.env.DATABASE_URL;
  if (!url && process.env.SITE_REQUIRE_DATABASE === "1") {
    throw new Error("SITE_REQUIRE_DATABASE is on but DATABASE_URL is not set");
  }
  if (!url) {
    // Development, tests and CI: the published snapshot files, or no data at all.
    // The ignore comment keeps the file tracer from copying the whole project beside the server.
    const dir = process.env.SNAPSHOT_DIR ?? join(/* turbopackIgnore: true */ process.cwd(), "datasets", "published", "latest");
    try {
      const loaded = loadFromFiles(dir);
      replaceSnapshot(loaded?.payload ?? null, { releaseId: loaded?.releaseId ?? null, source: loaded ? "files" : "none" });
    } catch (error) {
      // A malformed snapshot must not take the site down; the pages show the gap.
      console.error(`[data-release] snapshot files not loaded: ${(error as Error).message}`);
      replaceSnapshot(null, { releaseId: null, source: "none" });
    }
    return;
  }

  // A database that stays unreachable throws here and stops the server; an empty one is the no-data state.
  // A few attempts first: a database container may come up a moment after the site.
  let first: Awaited<ReturnType<typeof loadFromDatabase>> = null;
  for (let attempt = 1; ; attempt += 1) {
    try {
      first = await loadFromDatabase(url);
      break;
    } catch (error) {
      if (attempt >= START_ATTEMPTS) throw error;
      console.error(`[data-release] load attempt ${attempt}/${START_ATTEMPTS} failed: ${(error as Error).message}`);
      await new Promise((resolve) => setTimeout(resolve, START_RETRY_MS));
    }
  }
  replaceSnapshot(first?.payload ?? null, { releaseId: first?.releaseId ?? null, source: "database" });
  console.log(`[data-release] loaded ${first?.releaseId ?? "no active release"} from the database`);

  const seconds = Number(process.env.SNAPSHOT_POLL_SECONDS);
  const interval = (Number.isFinite(seconds) && seconds > 0 ? seconds : 30) * 1000;
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const id = await activeReleaseId(url);
      if (id && id !== dataRelease().releaseId) {
        const next = await loadFromDatabase(url);
        if (next && next.releaseId !== dataRelease().releaseId) {
          replaceSnapshot(next.payload, { releaseId: next.releaseId, source: "database" });
          console.log(`[data-release] now serving ${next.releaseId}`);
        }
      }
    } catch (error) {
      console.error(`[data-release] poll failed, keeping ${dataRelease().releaseId ?? "no data"}: ${(error as Error).message}`);
    } finally {
      busy = false;
    }
  }, interval).unref();
}
