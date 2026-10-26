#!/usr/bin/env node
// Assembles the WorkBuddy connector packages and the HTTP Skill from integrations/workbuddy/ into the
// ignored out/workbuddy/, in the layout WorkBuddy's open platform expects: <connector>/connector-meta.json,
// mcp.json, token-schema.json (token connectors), icon.svg and skills/<name>/SKILL.md. The sources use other
// names (mcp-server.json, skill/) because the public-file gate keeps any mcp.json or skills/ out of Git.
//   node scripts/pack-workbuddy.mjs            then zip each folder under out/workbuddy/ for upload
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE = join(ROOT, "integrations", "workbuddy");
const OUT = join(ROOT, "out", "workbuddy");

rmSync(OUT, { recursive: true, force: true });
for (const connector of ["surviagi", "surviagi-submit"]) {
  const from = join(SOURCE, connector);
  const to = join(OUT, connector);
  mkdirSync(join(to, "skills", connector === "surviagi" ? "surviagi-search" : "surviagi-submit"), { recursive: true });
  const meta = JSON.parse(readFileSync(join(from, "connector-meta.json"), "utf8"));
  if (meta.source !== connector) throw new Error(`${connector}: connector-meta.json names source ${meta.source}`);
  writeFileSync(join(to, "connector-meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  writeFileSync(join(to, "mcp.json"), `${JSON.stringify(JSON.parse(readFileSync(join(from, "mcp-server.json"), "utf8")), null, 2)}\n`);
  if (existsSync(join(from, "token-schema.json"))) cpSync(join(from, "token-schema.json"), join(to, "token-schema.json"));
  else if (meta.auth_mode === "token") throw new Error(`${connector}: auth_mode token without token-schema.json`);
  cpSync(join(ROOT, "src", "app", "icon.svg"), join(to, "icon.svg"));
  cpSync(join(from, "skill", "SKILL.md"), join(to, "skills", connector === "surviagi" ? "surviagi-search" : "surviagi-submit", "SKILL.md"));
}
cpSync(join(SOURCE, "skill-http", "surviagi-http"), join(OUT, "surviagi-http"), { recursive: true });
console.log(`WorkBuddy packages written to ${OUT}`);
