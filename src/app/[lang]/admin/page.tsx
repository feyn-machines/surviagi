import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader, bilingual, dataStyles as d, formatNumber, isoDate } from "@/components/data-page";
import { appEnabled } from "@/lib/app-config";
import { adminGroups, adminQuestions, subscriberCounts, type AdminGroup, type AdminQuestion } from "@/lib/app-store";
import { adminOrNull, appPool } from "@/lib/auth";
import { getLocale } from "@/lib/locale";
import { Decide, DecideQuestion } from "./decide";
import s from "./admin.module.css";

/** The one page that reads the visitor's session, so it is rendered per request and never cached. */
export const dynamic = "force-dynamic";

const CSV_PATH = "/api/admin/subscribers";

const copy = bilingual({
  en: {
    title: "Admin",
    pending: "Pending",
    decided: "Decided",
    subscribers: "Subscribers {total} · Updates {updates} · Weekly {weekly}",
    download: "Download CSV",
    person: "Person",
    organization: "Company",
    requests: "{n} requests",
    request: "1 request",
    approved: "Approved",
    rejected: "Rejected",
    imported: "Imported",
    earlierApproved: "Approved before",
    earlierRejected: "Rejected before",
    empty: "Nothing to review",
    tabs: "View",
    questions: "Questions",
    accepted: "Accepted",
    why: "Why it matters",
    gap: "What is missing",
    leads: "Leads",
    related: "Records searched",
    viaApi: "via API key",
  },
  "zh-CN": {
    title: "后台",
    pending: "待审核",
    decided: "已处理",
    subscribers: "订阅 {total} · 网站更新 {updates} · 周报 {weekly}",
    download: "下载名单",
    person: "人物",
    organization: "公司",
    requests: "{n} 人提交",
    request: "1 人提交",
    approved: "已通过",
    rejected: "已拒绝",
    imported: "已导入",
    earlierApproved: "此前已通过",
    earlierRejected: "此前已拒绝",
    empty: "没有待审核的申请",
    tabs: "视图",
    questions: "研究问题",
    accepted: "已纳入",
    why: "研究意义",
    gap: "资料缺口",
    leads: "线索",
    related: "已检索记录",
    viaApi: "通过 API Key",
  },
});

export async function generateMetadata(): Promise<Metadata> {
  const { language } = await getLocale();
  return { title: copy[language].title, robots: { index: false, follow: false } };
}

const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));

export default async function AdminPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { language } = await getLocale();
  const c = copy[language];
  if (!appEnabled()) notFound();
  if (!(await adminOrNull(new Request("http://internal/", { headers: await headers() })))) notFound();

  const asked = (await searchParams).view;
  const view = asked === "decided" || asked === "questions" ? asked : "pending";
  const db = appPool();
  const [groups, questions, counts] = await Promise.all([
    view === "questions" ? Promise.resolve([]) : adminGroups(db, view),
    view === "questions" ? Promise.all([adminQuestions(db, "pending"), adminQuestions(db, "decided")]).then((both) => both.flat()) : Promise.resolve([]),
    subscriberCounts(db),
  ]);
  const base = language === "zh-CN" ? "/zh-CN/admin" : "/admin";

  return (
    <div className={s.page}>
      <PageHeader eyebrow={c.title} title={c.title} />
      <div className={s.bar}>
        <nav className={s.tabs} aria-label={c.tabs}>
          <Link className={s.tab} href={{ pathname: base, query: { view: "pending" } }} aria-current={view === "pending" ? "page" : undefined}>{c.pending}</Link>
          <Link className={s.tab} href={{ pathname: base, query: { view: "decided" } }} aria-current={view === "decided" ? "page" : undefined}>{c.decided}</Link>
          <Link className={s.tab} href={{ pathname: base, query: { view: "questions" } }} aria-current={view === "questions" ? "page" : undefined}>{c.questions}</Link>
        </nav>
        <p className={s.counts}>
          <span>{fill(c.subscribers, { total: formatNumber(counts.total), updates: formatNumber(counts.updates), weekly: formatNumber(counts.weekly) })}</span>
          <a href={CSV_PATH}>{c.download}</a>
        </p>
      </div>
      {view === "questions" ? (
        questions.length === 0 ? (
          <p className={`${d.note} ${s.none}`}>{c.empty}</p>
        ) : (
          <ul className={s.list}>
            {questions.map((question) => <QuestionItem key={question.id} question={question} language={language} />)}
          </ul>
        )
      ) : groups.length === 0 ? (
        <p className={`${d.note} ${s.none}`}>{c.empty}</p>
      ) : (
        <ul className={s.list}>
          {groups.map((group) => (
            <Group key={`${group.handle}:${group.ownerKind}:${group.status}:${group.decidedAt ?? ""}`} group={group} language={language} />
          ))}
        </ul>
      )}
    </div>
  );
}

function Group({ group, language }: { group: AdminGroup; language: "en" | "zh-CN" }) {
  const c = copy[language];
  return (
    <li className={s.group}>
      <div className={s.head}>
        <a className={s.handle} href={`https://x.com/${group.handle}`} target="_blank" rel="noreferrer">@{group.displayHandle}</a>
        <span className={s.meta}>{c[group.ownerKind]}</span>
        <span className={s.meta}>{group.count === 1 ? c.request : fill(c.requests, { n: group.count })}</span>
        <span className={s.meta}>{isoDate(group.firstAt)}</span>
        {group.status === "pending" && group.earlier ? (
          <span className={`${s.meta} ${s.status}`} data-status={group.earlier}>
            {group.earlier === "approved" ? c.earlierApproved : c.earlierRejected}
          </span>
        ) : null}
        {group.status !== "pending" ? (
          <>
            <span className={`${s.meta} ${s.status}`} data-status={group.status}>{c[group.status]}</span>
            {group.decidedBy ? <span className={s.meta}>{group.decidedBy}</span> : null}
            <span className={s.meta}>{isoDate(group.decidedAt)}</span>
            {group.importedAt ? <span className={s.meta}>{c.imported} {isoDate(group.importedAt)}</span> : null}
          </>
        ) : null}
      </div>
      {group.reason ? <p className={s.reasonText}>{group.reason}</p> : null}
      <details className={s.requests}>
        <summary>{group.count === 1 ? c.request : fill(c.requests, { n: group.count })}</summary>
        <ul>
          {group.requests.map((request, index) => (
            <li key={index}>
              <span>{request.name}</span>
              <span className={s.meta}>{request.email}</span>
              <span className={s.meta}>{isoDate(request.createdAt)}</span>
              {request.note ? <span className={s.note}>{request.note}</span> : null}
            </li>
          ))}
        </ul>
      </details>
      {group.status === "pending" ? <Decide handle={group.handle} ownerKind={group.ownerKind} language={language} /> : null}
    </li>
  );
}

function QuestionItem({ question, language }: { question: AdminQuestion; language: "en" | "zh-CN" }) {
  const c = copy[language];
  return (
    <li className={s.group}>
      <div className={s.head}>
        <span className={s.handle}>{question.question}</span>
        <span className={s.meta}>{question.name}</span>
        <span className={s.meta}>{question.email}</span>
        <span className={s.meta}>{isoDate(question.createdAt)}</span>
        {question.via === "api" ? <span className={s.meta}>{c.viaApi}</span> : null}
        {question.status !== "pending" ? (
          <>
            <span className={`${s.meta} ${s.status}`} data-status={question.status === "accepted" ? "approved" : "rejected"}>
              {question.status === "accepted" ? c.accepted : c.rejected}
            </span>
            {question.decidedBy ? <span className={s.meta}>{question.decidedBy}</span> : null}
            <span className={s.meta}>{isoDate(question.decidedAt)}</span>
          </>
        ) : null}
      </div>
      {question.reason ? <p className={s.reasonText}>{question.reason}</p> : null}
      <dl className={s.fields}>
        <dt>{c.why}</dt>
        <dd>{question.why}</dd>
        <dt>{c.gap}</dt>
        <dd>{question.gap}</dd>
        {question.leads ? (
          <>
            <dt>{c.leads}</dt>
            <dd>{question.leads}</dd>
          </>
        ) : null}
        {question.related.length > 0 ? (
          <>
            <dt>{c.related}</dt>
            <dd>{question.related.join(" · ")}</dd>
          </>
        ) : null}
      </dl>
      {question.status === "pending" ? <DecideQuestion id={question.id} language={language} /> : null}
    </li>
  );
}
