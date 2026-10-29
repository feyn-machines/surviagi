import { readFileSync } from "node:fs";
import { join } from "node:path";

// Explicit public sources only. Never enumerate a directory or accept a source path from a request.
export function agentPackage(name: string): Buffer | null {
  if (!["surviagi-http.zip", "surviagi.zip", "surviagi-submit.zip"].includes(name)) return null;
  // Literal paths also keep Next's file tracer from scanning unrelated workspace directories.
  const sources = {
    httpSkill: readFileSync(join(process.cwd(), "integrations/workbuddy/skill-http/surviagi-http/SKILL.md")),
    httpScript: readFileSync(join(process.cwd(), "integrations/workbuddy/skill-http/surviagi-http/scripts/surviagi.py")),
    searchMeta: readFileSync(join(process.cwd(), "integrations/workbuddy/surviagi/connector-meta.json")),
    searchMcp: readFileSync(join(process.cwd(), "integrations/workbuddy/surviagi/mcp-server.json")),
    searchSkill: readFileSync(join(process.cwd(), "integrations/workbuddy/surviagi/skill/SKILL.md")),
    submitMeta: readFileSync(join(process.cwd(), "integrations/workbuddy/surviagi-submit/connector-meta.json")),
    submitMcp: readFileSync(join(process.cwd(), "integrations/workbuddy/surviagi-submit/mcp-server.json")),
    submitSkill: readFileSync(join(process.cwd(), "integrations/workbuddy/surviagi-submit/skill/SKILL.md")),
    token: readFileSync(join(process.cwd(), "integrations/workbuddy/surviagi-submit/token-schema.json")),
    icon: readFileSync(join(process.cwd(), "src/app/icon.svg")),
  };
  if (name === "surviagi-http.zip") return zip([
    ["surviagi-http/SKILL.md", sources.httpSkill],
    ["surviagi-http/scripts/surviagi.py", sources.httpScript],
  ]);
  const submit = name === "surviagi-submit.zip";
  const entries: [string, Buffer][] = [
    ["connector-meta.json", submit ? sources.submitMeta : sources.searchMeta],
    ["mcp.json", submit ? sources.submitMcp : sources.searchMcp],
    ["icon.svg", sources.icon],
    [`skills/${submit ? "surviagi-submit" : "surviagi-search"}/SKILL.md`, submit ? sources.submitSkill : sources.searchSkill],
  ];
  if (submit) entries.push(["token-schema.json", sources.token]);
  return zip(entries);
}

// ZIP's stored method needs no runtime dependency or temporary files. Fixed timestamps make downloads reproducible.
function zip(entries: [string, Buffer][]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [path, data] of entries) {
    const name = Buffer.from(path);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(33, 12); // 1980-01-01
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    header.copy(directory, 6, 4, 28);
    directory.writeUInt32LE(offset, 42);
    local.push(header, name, data);
    central.push(directory, name);
    offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
