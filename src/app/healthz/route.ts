import { appEnabled } from "@/lib/app-config";
import { appPool } from "@/lib/auth";
import { dataRelease } from "@/lib/snapshot";

export const dynamic = "force-dynamic";

// Well under the container healthcheck's 3 s timeout: a user database that hangs must not make the container unhealthy.
const APP_CHECK_MS = 1000;

/** Whether the user database answers. Only the message of a failure is logged; the answer is a boolean. */
async function appHealth(): Promise<{ enabled: false } | { enabled: true; ok: boolean }> {
  if (!appEnabled()) return { enabled: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      appPool().query("SELECT 1 FROM app.admins LIMIT 1"),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), APP_CHECK_MS);
      }),
    ]);
    return { enabled: true, ok: true };
  } catch (error) {
    console.error(`[healthz] user database check failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return { enabled: true, ok: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Which code build is answering and which data release it is serving. The release
 * id is fixed when the build runs. With `SITE_REQUIRE_DATABASE=1` a server that is
 * not serving a release from the database answers 503, so a misconfigured one
 * cannot pass for a healthy one. The user database is reported (`app`) but never
 * decides the status: the public site must stay up without it; a release check
 * reads `app.ok`.
 */
export async function GET() {
  const data = dataRelease();
  const required = process.env.SITE_REQUIRE_DATABASE === "1";
  const ok = !required || (data.source === "database" && data.releaseId !== null);
  return Response.json(
    { ok, release: process.env.RELEASE_ID ?? "dev", data, app: await appHealth() },
    { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
