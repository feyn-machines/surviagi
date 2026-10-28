"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { approvalSelectionKey, makeApprovalBatch, selectedApprovalItems } from "@/lib/editorial-batch";
import { queueLanguages, type EditorialQueueItem, type QueueView } from "@/lib/editorial-queue";
import { localizedPath, type Language } from "@/lib/i18n";
import s from "./review.module.css";

const labels = {
  en: {
    pending: "To review", reviewed: "Approved · awaiting publication", published: "Published",
    help: "Each row is one language draft. Open it to read, leave feedback or approve.",
    approvedHelp: "These drafts are approved and need no further review. Open the other language to finish publication.",
    publishedHelp: "Both languages are live in Articles. Open a version to see its review history or manage withdrawal.",
    english: "English", chinese: "Chinese", all: "All languages", search: "Search articles", filter: "Draft language",
    review: "Read & review", history: "Read & view history", waiting: "Other language still needs approval", ready: "Both approved · finish publication",
    approve: "Approve selected drafts", sending: "Saving…", select: "Select reviewed drafts", cancel: "Cancel selection", selected: "selected",
    empty: "No drafts to review", emptyHelp: "Approved drafts are under Approved or Published. New versions will appear here.",
    noMatch: "No matching articles", noneReviewed: "No drafts waiting for the other language", nonePublished: "No published articles yet",
    pendingState: "Awaiting review", request_revision: "Changes requested", hold: "On hold", approvedState: "Approved",
    failed: "Could not confirm approval. Reload and retry; completed approvals will not be duplicated.", reload: "Reload status",
    conflict: "Version changed. Reload and review the current text.", not_found: "This version is no longer public.", unavailable: "Temporarily unavailable. Retry after reloading.",
    success: "Approval saved. The draft has left To review; the other language still needs approval.",
    live: "Both languages approved. The article is now published.", batchSuccess: "Approvals saved. Completed drafts have left To review.",
    next: "Review other language", public: "Open published article", version: "Version", clear: "Clear filters", limit: "Select up to 50 drafts per batch.",
  },
  "zh-CN": {
    pending: "待审核", reviewed: "已批准 · 待发布", published: "已发布",
    help: "每行是一种语言的稿件。打开后阅读正文、留下意见或批准。",
    approvedHelp: "这里的稿件已经批准，无需重复审核。继续审核另一种语言即可完成发布。",
    publishedHelp: "中英文已进入正式文章栏目。可查看审核记录或管理撤回。",
    english: "英文", chinese: "中文", all: "全部语言", search: "搜索文章", filter: "稿件语言",
    review: "阅读并审核", history: "阅读与审核记录", waiting: "等待另一种语言批准", ready: "双语已批准 · 待完成发布",
    approve: "批准所选稿件", sending: "正在保存…", select: "选择已读稿件", cancel: "取消选择", selected: "项已选",
    empty: "没有待审核稿件", emptyHelp: "已完成的稿件可在「已批准」或「已发布」查看。新版本会出现在这里。",
    noMatch: "没有匹配的文章", noneReviewed: "没有等待另一种语言的已批准稿", nonePublished: "暂无正式发布的文章",
    pendingState: "等待审核", request_revision: "要求修改", hold: "已暂缓", approvedState: "已批准",
    failed: "暂时无法确认批准结果。请重新加载后重试，已完成的批准不会重复记录。", reload: "重新加载状态",
    conflict: "版本已变化，请重新加载并审核最新正文。", not_found: "此版本已不再公开。", unavailable: "暂时无法处理，请重新加载后重试。",
    success: "批准已保存，该稿件已移出待审核；另一种语言仍需审核。",
    live: "中英文均已批准，文章已正式发布。", batchSuccess: "批准已保存，完成的稿件已移出待审核。",
    next: "审核另一种语言", public: "查看正式文章", version: "版本", clear: "清除筛选", limit: "每次最多选择 50 份稿件。",
  },
} as const;

export function EditorialBatchQueue({ articles, language, view, notice }: { articles: EditorialQueueItem[]; language: Language; view: QueueView; notice: string }) {
  const c = labels[language];
  const router = useRouter();
  const [refreshing, startTransition] = useTransition();
  const [selected, setSelected] = useState<string[]>([]);
  const [selecting, setSelecting] = useState(false);
  const [pending, setPending] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [message, setMessage] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const base = localizedPath(language, "/admin/editorial");
  const rows = queueLanguages(articles, view);
  const pendingRows = queueLanguages(articles, "pending");
  const validSelection = selected.filter((key) => pendingRows.some((row) => approvalSelectionKey(row.article, row.language) === key));
  const matches = (item: EditorialQueueItem) => `${item.title} ${item.chineseTitle}`.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim());
  const visible = rows.filter((row) => (filter === "all" || row.language === filter) && matches(row.article));
  const published = articles.filter((item) => item.published && matches(item));
  const counts = { pending: pendingRows.length, reviewed: queueLanguages(articles, "reviewed").length, published: articles.filter((item) => item.published).length };
  const href = (item: EditorialQueueItem, draftLanguage: Language) => `${base}?articleId=${encodeURIComponent(item.articleId)}&version=v${item.version}&reviewLanguage=${draftLanguage}&view=${view}` as Route;
  const busy = pending || refreshing;
  const reload = () => startTransition(() => router.refresh());

  async function submit() {
    const items = selectedApprovalItems(validSelection, articles);
    if (!items.length || items.length > 50) return;
    setPending(true); setErrors([]); setMessage("");
    try {
      const response = await fetch("/api/admin/editorial/approve-batch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(makeApprovalBatch(items)) });
      const result = await response.json() as { results?: { articleId: string; version: number; language: Language; status: string; publicationChanged: boolean }[] };
      if (!response.ok || !result.results) throw new Error("unavailable");
      const failures = result.results.filter((item) => !["approved", "already_approved", "language_approved", "already_language_approved"].includes(item.status));
      setErrors(failures.map((item) => {
        const article = articles.find((a) => a.articleId === item.articleId && a.version === item.version);
        return `${item.language === "en" ? article?.title : article?.chineseTitle} · ${item.language === "en" ? c.english : c.chinese}: ${item.status === "conflict" ? c.conflict : item.status === "not_found" ? c.not_found : c.unavailable}`;
      }));
      if (failures.length < result.results.length) setMessage(result.results.some((item) => item.publicationChanged) ? c.live : c.batchSuccess);
      setSelected(failures.map((item) => approvalSelectionKey(item, item.language)));
      if (!failures.length) setSelecting(false);
      reload();
    } catch { setErrors([c.failed]); }
    finally { setPending(false); }
  }

  return <section aria-label={language === "en" ? "Review queue" : "审核队列"} aria-busy={busy}>
    <nav className={s.tabs} aria-label={language === "en" ? "Article status" : "文章状态"}>
      {(["pending", "reviewed", "published"] as const).map((tab) => <Link key={tab} href={`${base}?view=${tab}` as Route} aria-current={view === tab ? "page" : undefined} onClick={() => { setSelected([]); setSelecting(false); setMessage(""); setErrors([]); }}>{c[tab]} <span>{counts[tab]}</span></Link>)}
    </nav>
    {(message || notice === "approved" || notice === "published") && <p className={s.notice} role="status">{message || (notice === "published" ? c.live : c.success)}</p>}
    {errors.length > 0 && <div className={s.error} role="alert">{errors.map((error) => <p key={error}>{error}</p>)}<button className={s.save} onClick={reload} disabled={busy}>{c.reload}</button></div>}
    <p className={s.queueHelp}>{view === "pending" ? c.help : view === "reviewed" ? c.approvedHelp : c.publishedHelp}</p>
    <div className={s.toolbar}>
      <label>{c.search}<input type="search" value={query} onChange={(event) => { setQuery(event.target.value); setSelected([]); }} /></label>
      {view !== "published" && <label>{c.filter}<select value={filter} onChange={(event) => { setFilter(event.target.value); setSelected([]); }}><option value="all">{c.all}</option><option value="en">{c.english}</option><option value="zh-CN">{c.chinese}</option></select></label>}
      {view === "pending" && counts.pending > 0 && <button className={s.save} disabled={busy} onClick={() => { setSelecting(!selecting); setSelected([]); }}>{selecting ? c.cancel : c.select}</button>}
    </div>
    {(view === "published" ? published.length === 0 : visible.length === 0) ? <div className={s.empty}>
      <h2>{query || filter !== "all" ? c.noMatch : view === "pending" ? c.empty : view === "reviewed" ? c.noneReviewed : c.nonePublished}</h2>
      {view === "pending" && !query && filter === "all" && <p>{c.emptyHelp}</p>}
      {(query || filter !== "all") && <button className={s.save} onClick={() => { setQuery(""); setFilter("all"); }}>{c.clear}</button>}
    </div> : <ul className={s.queue}>
      {view === "published" ? published.map((article) => <li className={s.queueItem} key={`${article.articleId}:${article.version}`}>
        <div className={s.rowContent}><p className={s.languageLabel}>{c.published} · {c.version} {article.version} · EN / 中文</p><h2>{language === "en" ? article.title : article.chineseTitle}</h2><p>{language === "en" ? article.summary : article.chineseSummary}</p></div>
        <div className={s.rowActions}><Link className={s.open} href={href(article, language)}>{c.history} →</Link><Link className={s.open} href={localizedPath(language, `/articles/approved/${article.articleId}`) as Route}>{c.public} ↗</Link></div>
      </li>) : visible.map(({ article, language: draftLanguage }) => {
        const key = approvalSelectionKey(article, draftLanguage);
        const title = draftLanguage === "en" ? article.title : article.chineseTitle;
        const decision = draftLanguage === "en" ? article.enDecision : article.chineseDecision;
        return <li className={s.queueItem} key={key}>
          {selecting && view === "pending" && <input className={s.selectDraft} type="checkbox" aria-label={`${c.approve}: ${title} · ${draftLanguage}`} checked={validSelection.includes(key)} disabled={busy || (validSelection.length >= 50 && !validSelection.includes(key))} onChange={(event) => setSelected((current) => event.target.checked ? [...current, key] : current.filter((value) => value !== key))} />}
          <div className={s.rowContent}><p className={s.languageLabel}>{draftLanguage === "en" ? c.english : c.chinese} · {c.version} {article.version} <span className={s.state} data-state={view === "reviewed" ? "approved" : "preview"}>{view === "reviewed" ? c.approvedState : decision === "request_revision" ? c.request_revision : decision === "hold" ? c.hold : c.pendingState}</span></p>
            <h2 lang={draftLanguage}><Link href={href(article, draftLanguage)}>{title}</Link></h2><p lang={draftLanguage}>{draftLanguage === "en" ? article.summary : article.chineseSummary}</p>
            {view === "reviewed" && <p className={s.waiting}>{article.enApproved && article.chineseApproved ? c.ready : c.waiting}</p>}
          </div>
          <div className={s.rowActions}><Link className={s.open} href={href(article, draftLanguage)}>{view === "pending" ? c.review : c.history} →</Link>
            {view === "reviewed" && !(article.enApproved && article.chineseApproved) && <Link className={s.open} href={href(article, draftLanguage === "en" ? "zh-CN" : "en")}>{c.next} →</Link>}
          </div>
        </li>;
      })}
    </ul>}
    {selecting && view === "pending" && <div className={s.selectionBar}><p>{validSelection.length} {c.selected}<small>{c.limit}</small></p><button className={s.primary} onClick={() => void submit()} disabled={busy || !validSelection.length}>{busy ? c.sending : `${c.approve} (${validSelection.length})`}</button></div>}
  </section>;
}
