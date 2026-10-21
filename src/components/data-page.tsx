import type { ReactNode } from "react";
import type { Route } from "next";
import Link from "next/link";
import { bilingual, type Language } from "@/lib/i18n";
import { href } from "@/lib/routes";
import { manifest as dataManifest } from "@/lib/snapshot";
import { termName } from "./ontology-labels";
import styles from "./data-page.module.css";

export { styles as dataStyles };

/**
 * The shared data blocks (`oaw-table-wrap`, `oaw-status`, `oaw-definition`,
 * `oaw-gap`, `oaw-back`, `oaw-sr-only`) live in globals.css and are used as
 * they are; this module adds only the layout these pages need on top.
 */

/**
 * Both languages, enforced by the type. The helper itself now lives in
 * `@/lib/i18n`, so pages outside this folder can declare copy without
 * importing from a data-page component; it stays exported here because the
 * data pages reach for it alongside the blocks below.
 */
export { bilingual };

/**
 * Units for counted values. English needs the singular for one, Chinese uses
 * the same measure word either way, so both are written out rather than
 * guessed at the call site.
 */
const unitWords = {
  edges: { en: ["edge", "edges"], "zh-CN": ["条", "条"] },
  tasks: { en: ["task", "tasks"], "zh-CN": ["项", "项"] },
  sources: { en: ["source", "sources"], "zh-CN": ["个", "个"] },
  items: { en: ["item", "items"], "zh-CN": ["条", "条"] },
} as const;

export function Unit({
  kind,
  count,
  language,
}: {
  kind: keyof typeof unitWords;
  count: number;
  language: Language;
}) {
  const [one, many] = unitWords[kind][language];
  return <span className="oaw-unit">{Math.abs(count) === 1 ? one : many}</span>;
}

/** One grouping for both languages, so a number never changes shape mid-page. */
const numberFormat = new Intl.NumberFormat("en-US");

export function formatNumber(value: number): string {
  return numberFormat.format(value);
}

/** `2026-09-21`, in UTC, so the same row reads the same everywhere. */
export function isoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

/**
 * "Stage 3" in English, "阶段 3 · 自主试点" in Chinese: the number is the value
 * and the name comes from the published autonomy_stage vocabulary, which is
 * written in Chinese only in this version of the schema.
 */
export function stageLabel(stage: number, language: Language, prefix: string): string {
  const name = termName("autonomy_stage", String(stage), language);
  return name && name !== String(stage) ? `${prefix} ${stage} · ${name}` : `${prefix} ${stage}`;
}

/** `2026-09-21 16:56 UTC`. */
export function isoDateTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const text = date.toISOString();
  return `${text.slice(0, 10)} ${text.slice(11, 16)} UTC`;
}

const shared = bilingual({
  en: {
    noSnapshotEyebrow: "NO PUBLISHED SNAPSHOT",
    noSnapshotTitle: "There is no published snapshot to read yet.",
    noSnapshotBody:
      "This page renders a snapshot exported from the local data pipeline. Nothing has been exported to this site yet, so there are no markets, occupations, updates or coverage numbers to show. This is an empty state, not a result: it does not mean that nothing was found.",
    noSnapshotReason: "reason: datasets/published/latest/manifest.json is absent",
    provenanceTitle: "Where this page's numbers come from",
    snapshotVersion: "Snapshot",
    generatedAt: "Generated",
    ontologyVersion: "Ontology",
    schemaVersion: "Ontology schema",
    methodVersion: "Method version",
    contentHash: "Content SHA-256",
    rowCounts: "Rows in this snapshot",
    caveatsTitle: "How far to trust these numbers",
    caveatsLead: "Every number here is an estimate proposed by a machine. None has been confirmed by a person.",
    caveatsOpen: "All {n} limits",
    caveatsSource: "Published with the snapshot, not written for this page.",
    moreTitle: "The rest of the data pages",
    markets: "Markets",
    occupations: "Occupations",
    gates: "Non-technical conditions",
    updates: "AI updates",
    method: "Method and coverage",
    noValue: "no value",
  },
  "zh-CN": {
    noSnapshotEyebrow: "尚未发布快照",
    noSnapshotTitle: "目前没有可读取的已发布快照。",
    noSnapshotBody:
      "本页读取由本地数据流程导出的快照。目前还没有任何内容导出到网站，因此没有能力、职业、事件或覆盖面数字可展示。这是空状态，不是结论：它并不表示「什么都没找到」。",
    noSnapshotReason: "原因：datasets/published/latest/manifest.json 不存在",
    provenanceTitle: "本页数字的出处",
    snapshotVersion: "快照版本",
    generatedAt: "生成时间",
    ontologyVersion: "本体版本",
    schemaVersion: "本体 schema",
    methodVersion: "方法版本",
    contentHash: "内容 SHA-256",
    rowCounts: "本快照记录数",
    caveatsTitle: "这些数字该信到什么程度",
    caveatsLead: "本页每一个数字都是机器提议的估计，没有一条经过人工确认。",
    caveatsOpen: "全部 {n} 条限度",
    caveatsSource: "以下说明随快照一起发布，不是为本页另写的文案。",
    moreTitle: "其他数据页",
    markets: "赛道",
    occupations: "职业",
    gates: "非技术门槛",
    updates: "AI 更新",
    method: "方法与覆盖面",
    noValue: "无数值",
  },
});

const countLabels = bilingual({
  en: {
    "chain.activities": "work in markets",
    "chain.evidence": "evidence",
    "chain.events": "updates that landed on work",
    "chain.gates": "non-technical conditions",
    "chain.gate_edges": "non-technical condition-to-work edges",
    markets: "market-to-occupation edges",
    tasks: "work-to-task edges",
    events: "updates",
    models: "models",
    sources: "source accounts",
    topics: "topics",
    coverage: "coverage record",
    progress: "progress record",
  },
  "zh-CN": {
    "chain.activities": "赛道里的工作",
    "chain.evidence": "证据",
    "chain.events": "涉及工作的更新",
    "chain.gates": "非技术门槛",
    "chain.gate_edges": "非技术门槛—工作边",
    markets: "赛道—职业边",
    tasks: "工作—任务边",
    events: "更新",
    models: "模型",
    sources: "来源账号",
    topics: "话题",
    coverage: "覆盖面记录",
    progress: "进度记录",
  },
});

export function PageHeader({
  eyebrow,
  title,
  lead,
  note,
}: {
  eyebrow: string;
  title: ReactNode;
  lead?: string;
  note?: ReactNode;
}) {
  return (
    <header className={styles.header}>
      <p className={styles.eyebrow}>{eyebrow}</p>
      <h1 className={styles.title}>{title}</h1>
      {lead ? <p className={styles.lead}>{lead}</p> : null}
      {note ? <p className={styles.note}>{note}</p> : null}
    </header>
  );
}

export function Section({
  id,
  eyebrow,
  title,
  note,
  action,
  children,
}: {
  id?: string;
  eyebrow?: string;
  title: string;
  note?: ReactNode;
  /** Shown at the end of the title row. */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={styles.section} id={id}>
      <div className={styles.sectionHead}>
        {eyebrow ? <p className={styles.eyebrow}>{eyebrow}</p> : null}
        {action ? (
          <div className={styles.sectionTitleRow}>
            <h2 className={styles.sectionTitle}>{title}</h2>
            {action}
          </div>
        ) : (
          <h2 className={styles.sectionTitle}>{title}</h2>
        )}
        {note ? <p className={styles.note}>{note}</p> : null}
      </div>
      {children}
    </section>
  );
}

/** A table that scrolls inside its own frame so the page body never does. */
export function TableScroll({
  label,
  caption,
  children,
}: {
  label: string;
  caption?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`oaw-table-wrap ${styles.tableWrap}`} role="region" aria-label={label} tabIndex={0}>
      <table className="oaw-table">
        {caption ? <caption>{caption}</caption> : null}
        {children}
      </table>
    </div>
  );
}

/**
 * An absent value. Never a zero: the dash says there is no number and the
 * reason says why, which are two different facts about the same cell.
 */
export function Missing({
  reason,
  language,
  inline,
}: {
  reason: string;
  language: Language;
  inline?: boolean;
}) {
  const c = shared[language];
  return (
    <span className={inline ? `${styles.missing} ${styles.missingInline}` : styles.missing}>
      <span aria-hidden="true">—</span>
      <span className="oaw-sr-only">{c.noValue}</span>
      <span className={styles.missingReason}>{reason}</span>
    </span>
  );
}

/**
 * A state mark. The word is the state; the shape repeats it so the mark is
 * never the only thing carrying meaning.
 */
export function Status({
  shape = "solid",
  children,
}: {
  shape?: "solid" | "estimate" | "attention" | "pending" | "missing";
  children: ReactNode;
}) {
  const modifier = shape === "solid" ? "" : ` oaw-status-${shape}`;
  return <span className={`oaw-status${modifier}`}>{children}</span>;
}

export function Gap({
  eyebrow,
  title,
  children,
  reason,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
  reason?: string;
}) {
  return (
    <div className={`oaw-gap ${styles.gap}`}>
      <p className="oaw-gap-label">{eyebrow}</p>
      <h3>{title}</h3>
      {children}
      {reason ? <p className="oaw-gap-reason">{reason}</p> : null}
    </div>
  );
}

/** The snapshot's own caveats, in the reader's language, verbatim. */
/**
 * The limits, as one line plus the full list behind a disclosure.
 *
 * All nine were printed in full at the foot of every data page: around 2,600
 * characters of prose a reader met before any number they came for. The limits
 * still have to be reachable from every page - that is the point of the project -
 * but a wall that is scrolled past is not the same as a caveat that is read.
 */
export function Caveats({ language }: { language: Language }) {
  const c = shared[language];
  const list = dataManifest()?.caveats?.[language] ?? [];
  if (list.length === 0) return null;
  return (
    <aside className={styles.caveats} aria-label={c.caveatsTitle}>
      <details>
        <summary className={styles.caveatsSummary}>
          <span className={styles.eyebrow}>{c.caveatsTitle}</span>
          <span className={styles.caveatsLead}>{c.caveatsLead}</span>
          <span className={styles.caveatsMore}>
            {c.caveatsOpen.replace("{n}", String(list.length))}
          </span>
        </summary>
        <ul>
          {list.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <p className={styles.note}>{c.caveatsSource}</p>
      </details>
    </aside>
  );
}

/** The versions and the hash behind everything on the page. */
export function Provenance({ language }: { language: Language }) {
  const c = shared[language];
  const manifest = dataManifest();
  if (!manifest) return null;
  const counts = Object.entries(manifest.counts);
  return (
    <section className={styles.section} aria-label={c.provenanceTitle}>
      <div className="oaw-definition">
        <p className="oaw-definition-title">{c.provenanceTitle}</p>
        <dl>
          <dt>{c.snapshotVersion}</dt>
          <dd className={styles.mono}>{manifest.snapshot_version}</dd>
          <dt>{c.generatedAt}</dt>
          <dd className={styles.mono}>
            {isoDateTime(manifest.generated_at) ?? (
              <Missing reason={c.noValue} language={language} inline />
            )}
          </dd>
          <dt>{c.ontologyVersion}</dt>
          <dd className={styles.mono}>{manifest.ontology_version}</dd>
          <dt>{c.schemaVersion}</dt>
          <dd className={styles.mono}>{manifest.schema_version}</dd>
          <dt>{c.methodVersion}</dt>
          <dd className={styles.mono}>{manifest.method_version}</dd>
          <dt>{c.contentHash}</dt>
          <dd className={`${styles.mono} ${styles.wrapAnywhere}`}>{manifest.content_sha256}</dd>
          {counts.length > 0 ? (
            <>
              <dt>{c.rowCounts}</dt>
              <dd className={styles.mono}>
                {counts
                  .map(([key, value]) => {
                    const label =
                      (countLabels[language] as Record<string, string | undefined>)[key] ?? key;
                    return `${formatNumber(value)} ${label}`;
                  })
                  .join(" · ")}
              </dd>
            </>
          ) : null}
        </dl>
      </div>
    </section>
  );
}

/** The bilingual empty state for a site with nothing published yet. */
export function NoSnapshot({ language }: { language: Language }) {
  const c = shared[language];
  return (
    <Gap eyebrow={c.noSnapshotEyebrow} title={c.noSnapshotTitle} reason={c.noSnapshotReason}>
      <p>{c.noSnapshotBody}</p>
    </Gap>
  );
}


/** Cross links between the five data pages, in the order of the header nav. */
export function DataPageLinks({
  language,
  current,
}: {
  language: Language;
  // Three of the five links pointed at routes that were never built. A nav that
  // sends a reader to a 404 is worse than a shorter nav.
  current: "markets" | "occupations" | "updates";
}) {
  const c = shared[language];
  const all = [
    { key: "markets" as const, href: href(language, "/markets"), label: c.markets },
    { key: "occupations" as const, href: href(language, "/occupations"), label: c.occupations },
    { key: "updates" as const, href: href(language, "/updates"), label: c.updates },
  ] satisfies { key: typeof current; href: Route; label: string }[];
  return (
    <nav className={styles.links} aria-label={c.moreTitle}>
      {all
        .filter((item) => item.key !== current)
        .map((item) => (
          <Link key={item.key} href={item.href}>
            {item.label} →
          </Link>
        ))}
    </nav>
  );
}

/**
 * Marks text shown in a language the reader did not ask for.
 *
 * The note used to be written per call site as "published in Chinese only",
 * which is right when an English page falls back to Chinese and exactly wrong
 * in the other direction - a Chinese page was showing English text captioned
 * "only Chinese was published". A false statement about provenance is worse
 * than no statement, so the sentence is built from the language actually being
 * shown rather than assumed.
 */
export function OriginalLanguage({
  shown,
  reading,
}: {
  /** The language the text in front of this marker is actually written in. */
  shown: Language;
  /** The language the reader asked for. */
  reading: Language;
}) {
  if (shown === reading) return null;
  const note =
    reading === "en"
      ? shown === "zh-CN"
        ? "Published in Chinese only in this version of the ontology schema; the original is shown above, unchanged."
        : "Published in English only in this version of the ontology schema; the original is shown above, unchanged."
      : shown === "en"
        ? "在当前版本的语义模型中，该词条只发布了英文；上方为原文，未作改动。"
        : "在当前版本的语义模型中，该词条只发布了中文；上方为原文，未作改动。";
  return (
    <span className={styles.original} lang={reading}>
      {note}
    </span>
  );
}
