#!/usr/bin/env node
/** Run the local site with the private editorial database connection, without writing it to .env. */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { localEditorialDatabaseUrl } from "./editorial-publish.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const next = resolve(ROOT, "node_modules/next/dist/bin/next");
const child = spawn(process.execPath, [next, "dev", "-p", "3456"], {
  cwd: ROOT,
  env: { ...process.env, EDITORIAL_DATABASE_URL: localEditorialDatabaseUrl() },
  stdio: "inherit",
});
child.on("error", (error) => {
  console.error(`editorial dev could not start: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});
