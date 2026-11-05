import type { Metadata } from "next";
import contract from "../../../../public/contract/v1/index.json";
import { bilingual } from "@/lib/i18n";
import { href } from "@/lib/routes";
import { getLocale } from "@/lib/locale";
import { pageMetadata } from "@/lib/seo";
import s from "../legal.module.css";
import c from "./contract.module.css";

export const dynamic = "force-dynamic";

// Generated downloads are language-neutral resources.
const indexUrl = "/contract/v1/index.json";

const copy = bilingual({
  en: {
    title: "Public data contract",
    description: "Entity schemas, field grades, identifiers and version rules for SurviAGI data.",
    lead: "Generated from the ontology: the published field names, types and evidence grades that readers can depend on.",
    contract: "Contract", ontology: "Ontology", downloads: "Download", index: "Contract index", api: "HTTP interface (OpenAPI 3.1)",
    entities: "Entities", entity: "Entity / JSON Schema", identifier: "Identifier field", snapshot: "Snapshot file", nested: "Not a standalone snapshot collection",
    grades: "Field grades", gradeLead: "Each schema property carries x-grade. A quote checked against its source does not establish that the source's claim is true.",
    rules: "Missing values and compatibility", versions: "Four separate versions",
    versionBody: "Search and record responses return versions.contract (wire format), versions.ontology (type definition), versions.method (analysis method) and versions.data (the loaded release). The contract version shown here belongs to this code build; a loaded data release can carry an earlier contract version.",
    breaking: "A breaking change moves to a new major path, such as /contract/v2/. Readers may ignore new fields in a minor version. Check x-key-optional for explicitly optional keys and x-shape for views whose nested fields are not frozen.",
    ids: "Stable identifiers", idBody: "Use the identifier field listed below, rather than a name or translated label. Observation merges retain old identifiers in merged_from on the surviving record. Not every schema is available as a standalone snapshot or Agent record; use the OpenAPI for supported reads.",
    scope: "Scope", scopeBody: "Articles are served from the editorial store and do not yet have an entity schema in this contract. Retired level collections are listed in the index. This page describes the current contract, not a promise that every entity has published records.",
    agents: "Agent connection guide",
  },
  "zh-CN": {
    title: "公开数据契约",
    description: "SurviAGI 数据的实体结构、字段分级、编号与版本规则。",
    lead: "由本体生成：明确公开字段的名称、类型和证据分级，供读取方依赖。",
    contract: "契约", ontology: "本体", downloads: "下载", index: "契约索引", api: "HTTP 接口（OpenAPI 3.1）",
    entities: "实体", entity: "实体 / JSON Schema", identifier: "编号字段", snapshot: "快照文件", nested: "不作为独立快照集合发布",
    grades: "字段分级", gradeLead: "每个 schema 属性都有 x-grade。引文与来源核对一致，不代表来源的主张已被证实。",
    rules: "缺失值与兼容性", versions: "四个独立版本",
    versionBody: "搜索和详情响应返回 versions.contract（传输格式）、versions.ontology（类型定义）、versions.method（分析方法）与 versions.data（当前加载的数据版本）。此页展示的是本次代码构建的契约版本；加载的数据版本可能使用更早的契约。",
    breaking: "破坏性变更使用新的主版本路径，例如 /contract/v2/。读取方可忽略小版本新增字段。明确可选的键见 x-key-optional；嵌套字段尚未固定的视图见 x-shape。",
    ids: "稳定编号", idBody: "请使用下表的编号字段，不要以名称或译名作编号。观察合并后，保留记录的 merged_from 保存旧编号。并非每种 schema 都有独立快照或 Agent 详情入口；可用读取接口以 OpenAPI 为准。",
    scope: "覆盖范围", scopeBody: "文章来自 editorial 存储，目前尚无本契约内的实体 schema。退役的等级集合列在索引中。此页说明当前契约，不代表所有实体都有已发布的记录。",
    agents: "Agent 接入指南",
  },
});

export async function generateMetadata(): Promise<Metadata> {
  const { language } = await getLocale();
  return pageMetadata({ language, path: "/contract", title: copy[language].title, description: copy[language].description });
}

export default async function ContractPage() {
  const { language } = await getLocale();
  const t = copy[language];
  return <article className={`${s.page} ${c.page}`}>
    <h1 className={s.title}>{t.title}</h1>
    <p className={s.updated}>{t.contract} {contract.contract_version} · {t.ontology} {contract.ontology_version}</p>
    <p className={s.paragraph}>{t.lead}</p>
    <h2 className={s.heading}>{t.downloads}</h2>
    <ul className={c.list}>
      <li><a href={indexUrl}>{t.index} · {contract.contract_version}</a></li>
      <li><a href={contract.openapi}>{t.api}</a></li>
      <li><a href={href(language, "/agents")}>{t.agents}</a></li>
    </ul>
    <h2 className={s.heading}>{t.grades}</h2>
    <p className={s.paragraph}>{t.gradeLead}</p>
    <dl className={c.grades}>{Object.entries(contract.grades).map(([grade, description]) =>
      <div key={grade}><dt><code>{grade}</code></dt><dd>{description[language]}</dd></div>
    )}</dl>
    <h2 className={s.heading}>{t.rules}</h2>
    <ul className={c.list}>{contract.wire_rules[language].map((rule) => <li key={rule}>{rule}</li>)}</ul>
    <p className={s.paragraph}>{t.breaking}</p>
    <h2 className={s.heading}>{t.versions}</h2>
    <p className={s.paragraph}>{t.versionBody}</p>
    <h2 className={s.heading}>{t.ids}</h2>
    <p className={s.paragraph}>{t.idBody}</p>
    <h2 className={s.heading}>{t.entities}</h2>
    <div className={c.tableScroll} tabIndex={0} role="region" aria-label={t.entities}>
      <table className={c.table}>
        <thead><tr><th scope="col">{t.entity}</th><th scope="col">{t.identifier}</th><th scope="col">{t.snapshot}</th></tr></thead>
        <tbody>{contract.entities.map((entity) => <tr key={entity.name}>
          <th scope="row"><a href={entity.schema}>{entity.title[language]}</a><br /><code>{entity.name}</code></th>
          <td><code>{entity.identifier}</code></td><td>{entity.snapshot_file ? <code>{entity.snapshot_file}</code> : t.nested}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <h2 className={s.heading}>{t.scope}</h2>
    <p className={s.paragraph}>{t.scopeBody}</p>
  </article>;
}
