/**
 * Runs once when the server starts; requests wait for it to finish. The work is
 * in `instrumentation-node.ts`, loaded only for the Node.js runtime so the Edge
 * bundle never sees `node:path`, `node:fs` or `pg`.
 * See docs/superpowers/specs/2026-10-03-server-database-and-data-releases-design.md.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  await (await import("./instrumentation-node")).loadData();
}
