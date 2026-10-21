import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Starts the built standalone server (`pnpm build` first) the way a release is assembled; shared by the site tests.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const STANDALONE = join(ROOT, ".next", "standalone");

export const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

let workDir = null;
let serverDir = null;
export const running = [];

/** The built server, copied beside `public/` and `.next/static` the way a release is assembled. */
export function assemble() {
  if (serverDir) return serverDir;
  assert.ok(existsSync(join(STANDALONE, "server.js")), "run `pnpm build` first");
  workDir = mkdtempSync(join(tmpdir(), "openaiwill-site-"));
  const server = join(workDir, "server");
  serverDir = server;
  cpSync(STANDALONE, server, { recursive: true, verbatimSymlinks: true });
  cpSync(join(ROOT, "public"), join(server, "public"), { recursive: true });
  mkdirSync(join(server, ".next"), { recursive: true });
  cpSync(join(ROOT, ".next", "static"), join(server, ".next", "static"), { recursive: true });
  return server;
}

/** Start the server on a free port and wait until it answers; returns its address and its process. */
export async function startServer(env, fixedPort) {
  const dir = assemble();
  const port = fixedPort ?? (await freePort());
  const childEnv = { ...process.env, ...env, PORT: String(port), HOSTNAME: "127.0.0.1", SITE_ENV: "preview", NODE_ENV: "production" };
  if (!env.DATABASE_URL) delete childEnv.DATABASE_URL;
  const proc = spawn(process.execPath, ["server.js"], { cwd: dir, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  proc.stdout.on("data", (chunk) => (log += chunk));
  proc.stderr.on("data", (chunk) => (log += chunk));
  running.push(proc);
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (proc.exitCode !== null) assert.fail(`the server exited with ${proc.exitCode}:\n${log}`);
    try {
      if ((await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(2000) })).status === 200) return { base, proc };
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`the server did not answer:\n${log}`);
}

/** Stop a server this file started, by its PID, and wait for it to be gone. */
export async function stop(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise((resolve) => proc.once("exit", resolve));
  proc.kill("SIGTERM");
  const grace = setTimeout(() => proc.kill("SIGKILL"), 5000);
  await exited;
  clearTimeout(grace);
}

/** The exit code of a server expected to stop by itself; fails when it is still up after `ms`. */
export function exitsWithin(proc, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the server was still running after ${ms} ms`)), ms);
    proc.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}


/** Stops every server this process started and removes the assembled copy. */
export async function cleanup() {
  for (const proc of running) await stop(proc);
  if (workDir) rmSync(workDir, { recursive: true, force: true });
}
