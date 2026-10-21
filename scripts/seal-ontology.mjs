#!/usr/bin/env node
// Seals the current schema and data as the next ontology release. The release
// inherits every record of the previous one; a version that already exists is
// never overwritten.
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { schema, validateSchema } from "./lib/ontology-schema.mjs";
import { sealPackage } from "./lib/ontology-package.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releases = join(root, "datasets/ontology/releases");
const problems = validateSchema();
if (problems.length) throw new Error("Schema is not valid:\n" + problems.map((p) => `  - ${p}`).join("\n"));

const byVersion = (a, b) => a.localeCompare(b, undefined, { numeric: true });
const sealed = (await readdir(releases)).filter((name) => /^v\d+\.\d+\.\d+$/.test(name)).sort(byVersion);
const previous = sealed.at(-1);
if (!previous) throw new Error("No previous release to inherit from");
if (byVersion(`v${schema.version}`, previous) <= 0) throw new Error(`Schema version ${schema.version} is not newer than ${previous}`);
const previousDir = join(releases, previous);
const kinds = Object.entries(schema.classes).filter(([, body]) => body.kind).length;

const manifest = await sealPackage({
  schema, previousDir, dataDir: join(root, "datasets/ontology/data"), outputDir: join(releases, `v${schema.version}`),
  attachments: {
    "market-catalog.md": await readFile(join(previousDir, "market-catalog.md"), "utf8"),
    "occupation-catalog.md": await readFile(join(previousDir, "occupation-catalog.md"), "utf8"),
    "CHANGELOG.md": await readFile(join(root, "datasets/ontology/schema/CHANGELOG.md"), "utf8"),
    "README.md": `# openaiwill 本体 v${schema.version}\n\n本地本体草案；结构版本不表示语义已穷尽或已生产发布。\n\n` +
      `## 阅读顺序\n\n1. [schema.json](schema.json)：唯一的类型定义。${Object.keys(schema.classes).length} 个类（其中 ${kinds} 个概念类）、` +
      `${Object.keys(schema.properties).length} 个属性、${Object.keys(schema.relations).length} 个关系、` +
      `${Object.keys(schema.vocabularies).length} 个词表、${schema.constraints.length} 条约束。\n` +
      `2. [ontology.ttl](ontology.ttl)：同一份 schema 的标准格式导出（RDFS/OWL、SKOS、SHACL）。\n` +
      `3. [data-format.json](data-format.json)：封存数据文件每一行的格式，由 schema 生成。\n` +
      `4. [赛道目录](market-catalog.md)与[职业及全部任务目录](occupation-catalog.md)。\n\n` +
      `概念在 concepts.jsonl，层级关系在 relations.jsonl，外部映射在 external_mappings.jsonl；闸门在 gates.json，公司名单在 organizations.json；` +
      `reference_* 是来源系统的参考数据。人物、账号、帖子、更新、模型、供应商的实例在数据库里，不在本包。\n\n` +
      `本包继承 ${previous} 的全部数据文件，逐字节相同，所有 ID 不变。manifest.json 记录来源版本的根哈希和每个文件的哈希；` +
      `manifest.sha256 用于完整性检查，不是身份签名。\n\n` +
      `O*NET 来源采用 CC BY 4.0；中文职业译名和编辑目录为改编/自有草案。ISIC 仅含代码和层级。详情见 sources.jsonl。\n`,
  },
});
console.log(JSON.stringify({ sealed: `v${manifest.version}`, inherits: previous, counts: manifest.counts, schema: manifest.schema_counts }, null, 2));
