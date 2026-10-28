"use client";

import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { localizedPath } from "@/lib/i18n";
import { languageApproved, type EditorialQueueItem, type QueueView } from "@/lib/editorial-queue";
import { makeApprovalBatch } from "@/lib/editorial-batch";
import styles from "./review.module.css";

type Language = "en" | "zh-CN";
type Scope = "readability" | "language_quality" | "factual_accuracy" | "source_quality" | "publication";
type Decision = "comment" | "request_revision" | "hold" | "approve" | "withdraw";
type Annotation = { annotation_id: string; review_id: string; paragraph_key: string; selected_text: string; context_before: string; context_after: string; comment: string };
type Review = { review_id: string; review_scope: Scope; decision: Decision; actor_kind: string; actor_id: string; note: string; created_at: string };
type Edit = { edit_id: string; review_id: string; before_markdown: string; after_markdown: string; unified_diff: string; created_at: string };
type FeedbackScope = "single_article" | "reusable_preference";
type FeedbackIssue = "evidence_boundary" | "structure" | "clarity" | "specificity" | "tone" | "redundancy" | "headline" | "natural_language" | "other";
type ArticleGenre = "event_thread" | "product_comparison" | "capability_explainer" | "workflow" | "other";
type Article = {
  articleId: string;
  version: number;
  language: Language;
  title: string;
  summary: string;
  markdown: string;
  contentSha256: string;
  sourceCutoff: string;
  createdAt: string;
  status: "preview" | "approved";
};
type Detail = { article: Article; currentPointers: { previewVersion: number | null; approvedVersion: number | null }; reviews: Review[]; annotations: Annotation[]; edits: Edit[] };

const copy = {
  en: {
    language: "English review",
    preview: "Open reader preview",
    loading: "Loading this version…",
    loadFailed: "This version is no longer public or could not be loaded. Refresh the article list.",
    previewState: "Public preprint · not yet published",
    approvedState: "Approved version",
    cutoff: "Evidence cutoff",
    hash: "Content hash",
    scope: "Review scope",
    scopes: { readability: "Readability", language_quality: "Language quality", factual_accuracy: "Factual accuracy", source_quality: "Source quality", publication: "Publication" },
    decision: "Decision recorded",
    decisions: { comment: "Comment", request_revision: "Request revision", hold: "Hold", approve: "Approve this version", withdraw: "Withdraw this article" },
    publishBoundary: "Each language approval is a separate private review record. The publish action below switches the approved-version pointer only after both languages have current approvals. A withdrawal decision alone does not remove the article; use the withdrawal action below.",
    note: "Review note",
    paragraph: "Paragraph key",
    quote: "Selected text",
    before: "Context before",
    after: "Context after",
    annotation: "Paragraph comment",
    edit: "Suggested full-text revision (Markdown)",
    editHelp: "The saved change is a private suggestion; it does not replace this version.",
    save: "Save review",
    saving: "Saving…",
    saved: "Review saved. Public article unchanged.",
    conflict: "The version or content hash changed. Reload the article list and review the current version.",
    failed: "Could not save the review. Try again.",
    paragraphRequired: "Add a paragraph key to save a paragraph comment.",
    history: "Review history for this language and version",
    noHistory: "No review notes yet.",
    actor: "Reviewer",
    annotations: "Paragraph comments",
    edits: "Suggested edits",
    original: "Before",
    revised: "Suggested text",
    approveBoth: "Publish bilingual version",
    approveHelp: "This action does not approve either language. First record a separate current approval in the English and Chinese panels. Publishing then moves this exact bilingual version into Articles and feeds.",
    approving: "Publishing…",
    approved: "Both language approvals passed. This version is now in Articles.",
    alreadyApproved: "This version is already in Articles.",
    needBothApprovals: "Record a current human approval for both languages before approving this version.",
    approvalConflict: "The public preview changed during review. Reload the article list and review the current version.",
    approvalFailed: "Could not approve the version. Try again.",
    withdrawalTitle: "Withdraw the public article",
    withdrawalHelp: "First record the latest publication-scope withdrawal decision for this exact version in both language panels. The action withdraws all versions and removes the article from public pages and Agent search.",
    withdrawalReason: "Public withdrawal reason",
    withdrawalReasonHelp: "20–1000 characters. This reason is stored with the private publication record.",
    withdraw: "Withdraw from public access",
    withdrawing: "Withdrawing…",
    withdrawn: "The article has been withdrawn from public access.",
    alreadyWithdrawn: "The article was already withdrawn.",
    needBothWithdrawals: "Record the latest publication-scope withdrawal decision for both languages on the current public version first.",
    withdrawalConflict: "Public pointers changed during review. Refresh the queue and review the current version.",
    withdrawalFailed: "Could not withdraw the article. Check the current review decisions and try again.",
    confirmWithdrawal: "Withdraw every public version of this article? This cannot be undone here.",
    wrongWithdrawalVersion: "Open the current public version in the queue before recording withdrawal decisions.",
    feedbackSample: "Curate as a private writing example",
    feedbackScope: "Reuse scope",
    singleArticle: "This article only",
    reusablePreference: "Reusable preference (explicitly stated)",
    feedbackIssue: "Problem type",
    feedbackIssues: { evidence_boundary: "Evidence boundary", structure: "Structure", clarity: "Clarity", specificity: "Specificity", tone: "Tone", redundancy: "Redundancy", headline: "Headline", natural_language: "Natural language", other: "Other" },
    articleGenre: "Article genre",
    articleGenres: { event_thread: "Event thread", product_comparison: "Product comparison", capability_explainer: "Capability explainer", workflow: "Workflow", other: "Other" },
    feedbackProblem: "What was wrong",
    feedbackBeforeExcerpt: "Original excerpt (exact text)",
    feedbackAfterExcerpt: "Suggested excerpt (exact text)",
    feedbackApplicability: "When this example applies",
    preferenceEvidence: "Exact preference quote from the review note",
    preferenceHelp: "A reusable preference must quote explicit wording from the source review. A one-off correction is never promoted automatically.",
    saveSample: "Save private example",
    sampleSaved: "Private example saved.",
    sampleFailed: "Could not save this example. Check the source edit and explicit applicability.",
    sampleDuplicate: "An example with this source, problem type and scope already exists.",
  },
  "zh-CN": {
    language: "中文审核",
    preview: "打开读者预览",
    loading: "正在加载此版本…",
    loadFailed: "此版本已不再公开或暂时无法读取，请刷新文章列表。",
    previewState: "公开预发布 · 尚未正式发布",
    approvedState: "已批准版本",
    cutoff: "证据截止时间",
    hash: "内容 hash",
    scope: "审核范围",
    scopes: { readability: "可读性", language_quality: "语言表达", factual_accuracy: "事实准确性", source_quality: "来源质量", publication: "发布范围" },
    decision: "记录审核决定",
    decisions: { comment: "留下意见", request_revision: "要求修改", hold: "暂缓", approve: "记录批准意见", withdraw: "记录撤回意见" },
    publishBoundary: "每种语言的批准分别保存为私有审核记录。只有中英文都针对当前内容分别批准后，下方的正式发布操作才会切换版本指针。单独记录撤回意见不会隐藏文章；请使用下方撤回操作。",
    note: "审核意见",
    paragraph: "段落标识",
    quote: "选中的原文",
    before: "前文上下文",
    after: "后文上下文",
    annotation: "段落批注",
    edit: "建议的全文修改（Markdown）",
    editHelp: "保存的修改仅是私有建议，不会覆盖当前版本。",
    save: "保存审核记录",
    saving: "正在保存…",
    saved: "审核记录已保存，公开文章未改变。",
    conflict: "版本或内容 hash 已变化。请刷新文章列表，再审核当前版本。",
    failed: "审核记录未能保存，请重试。",
    paragraphRequired: "请填写段落标识后再保存段落批注。",
    history: "此语言、此版本的审核记录",
    noHistory: "还没有审核记录。",
    actor: "审核人",
    annotations: "段落批注",
    edits: "建议修改",
    original: "修改前",
    revised: "修改建议",
    approveBoth: "正式发布双语文章",
    approveHelp: "此操作不会替任何语言批准稿件。请先在英文与中文栏分别记录当前版本的批准意见；两种语言都通过后，发布操作才会将该版本加入正式文章栏目与 feed。",
    approving: "正在发布…",
    approved: "中英文分别通过审核，文章已进入正式栏目。",
    alreadyApproved: "此版本已经在正式栏目中。",
    needBothApprovals: "请先分别为中英文版本记录最新的人工批准意见。",
    approvalConflict: "审核期间公开预览已变化。请刷新文章列表，重新审核当前版本。",
    approvalFailed: "批准失败，请重试。",
    withdrawalTitle: "撤回公开文章",
    withdrawalHelp: "先在中英文审核栏分别为当前这个确切版本记录最新的“发布范围 · 撤回”决定。执行后所有版本都会停止公开，并从文章页面和 Agent 搜索中移除。",
    withdrawalReason: "公开撤回原因",
    withdrawalReasonHelp: "20–1000 个字符。原因会与私有发布记录一同保存。",
    withdraw: "从公开访问中撤回",
    withdrawing: "正在撤回…",
    withdrawn: "文章已从公开访问中撤回。",
    alreadyWithdrawn: "文章此前已撤回。",
    needBothWithdrawals: "请先在中英文审核栏为当前公开版本分别记录最新的“发布范围 · 撤回”决定。",
    withdrawalConflict: "审核期间公开指针已变化。请刷新队列并审核当前版本。",
    withdrawalFailed: "撤回失败。请检查当前审核决定后重试。",
    confirmWithdrawal: "确认撤回本文的全部公开版本？此处无法撤销。",
    wrongWithdrawalVersion: "请先在文章队列打开当前公开版本，再记录撤回决定。",
    feedbackSample: "整理为私有写作样例",
    feedbackScope: "适用范围",
    singleArticle: "仅本文",
    reusablePreference: "可复用偏好（需明确表达）",
    feedbackIssue: "问题类型",
    feedbackIssues: { evidence_boundary: "证据边界", structure: "结构", clarity: "清晰度", specificity: "具体性", tone: "语气", redundancy: "重复", headline: "标题", natural_language: "语言自然度", other: "其他" },
    articleGenre: "文章体裁",
    articleGenres: { event_thread: "事件脉络", product_comparison: "产品比较", capability_explainer: "能力说明", workflow: "工作流程", other: "其他" },
    feedbackProblem: "原文问题",
    feedbackBeforeExcerpt: "原文摘录（需与审核文本一致）",
    feedbackAfterExcerpt: "修改摘录（需与审核文本一致）",
    feedbackApplicability: "此样例适用的情况",
    preferenceEvidence: "审核意见中的明确偏好原话",
    preferenceHelp: "可复用偏好必须引用原审核意见中的明确表述。单篇修正不会自动变成长期规则。",
    saveSample: "保存私有样例",
    sampleSaved: "私有样例已保存。",
    sampleFailed: "样例保存失败。请检查来源修改和适用条件。",
    sampleDuplicate: "此来源、问题类型与范围的样例已存在。",
  },
} as const;

const scopes: Scope[] = ["readability", "language_quality", "factual_accuracy", "source_quality", "publication"];
const decisions: Decision[] = ["request_revision", "comment", "hold", "withdraw"];
const feedbackIssues: FeedbackIssue[] = ["evidence_boundary", "structure", "clarity", "specificity", "tone", "redundancy", "headline", "natural_language", "other"];
const articleGenres: ArticleGenre[] = ["event_thread", "product_comparison", "capability_explainer", "workflow", "other"];

export function EditorialReviewDesk({ articleId, version, language, reviewLanguage, queueItem, returnView, reader }: {
  articleId: string; version: number; language: Language; reviewLanguage: Language; queueItem: EditorialQueueItem; returnView: QueueView; reader: ReactNode;
}) {
  const c = copy[language];
  const zh = language === "zh-CN";
  const router = useRouter();
  const base = localizedPath(language, "/admin/editorial");
  const [hash, setHash] = useState("");
  const [dirty, setDirty] = useState(false);
  const [approving, setApproving] = useState(false);
  const [approvalMessage, setApprovalMessage] = useState("");
  const [pointers, setPointers] = useState<{ previewVersion: number | null; approvedVersion: number | null } | null>(null);
  const [withdrawalReason, setWithdrawalReason] = useState("");
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawalMessage, setWithdrawalMessage] = useState("");
  const [withdrawalError, setWithdrawalError] = useState(false);
  const approved = languageApproved(queueItem, reviewLanguage);
  const bothApproved = queueItem.enApproved && queueItem.chineseApproved;
  const expectedHash = reviewLanguage === "en" ? queueItem.contentSha256 : queueItem.chineseHash;
  const onHash = useCallback((_language: Language, value: string) => setHash(value), []);
  const onPointers = useCallback((value: { previewVersion: number | null; approvedVersion: number | null }) => setPointers(value), []);
  const onDirty = useCallback((value: boolean) => setDirty(value), []);
  const onSaved = () => { setDirty(false); router.refresh(); };
  const canLeave = () => !dirty || window.confirm(zh ? "还有未保存的意见，确认离开？" : "Leave without saving your feedback?");
  const otherLanguage = reviewLanguage === "en" ? "zh-CN" : "en";
  const draftHref = (target: Language) => `${base}?articleId=${articleId}&version=v${version}&reviewLanguage=${target}&view=${returnView}` as Route;
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function approve() {
    if (!hash || hash !== expectedHash || dirty) return;
    setApproving(true); setApprovalMessage("");
    try {
      const response = await fetch("/api/admin/editorial/approve-batch", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(makeApprovalBatch([{ articleId, version, language: reviewLanguage,
          contentSha256: { en: queueItem.contentSha256, "zh-CN": queueItem.chineseHash } }])),
      });
      const result = await response.json() as { results?: { status: string; publicationChanged: boolean }[] };
      const item = result.results?.[0];
      if (!response.ok || !item) throw new Error("unavailable");
      if (!["approved", "already_approved", "language_approved", "already_language_approved"].includes(item.status)) {
        setApprovalMessage(item.status === "conflict" ? c.approvalConflict : c.approvalFailed);
        return;
      }
      const published = item.publicationChanged || item.status === "approved" || item.status === "already_approved";
      router.push(`${base}?view=pending&notice=${published ? "published" : "approved"}` as Route);
      router.refresh();
    } catch { setApprovalMessage(c.approvalFailed); }
    finally { setApproving(false); }
  }
  async function withdraw() {
    if (!pointers || withdrawalReason.trim().length < 20 || !window.confirm(c.confirmWithdrawal)) return;
    setWithdrawing(true); setWithdrawalMessage(""); setWithdrawalError(false);
    try {
      const response = await fetch("/api/admin/editorial/withdraw", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ articleId, expectedPreviewVersion: pointers.previewVersion, expectedApprovedVersion: pointers.approvedVersion, reason: withdrawalReason }),
      });
      const result = await response.json().catch(() => ({})) as { error?: string; publicationChanged?: boolean };
      if (!response.ok) {
        setWithdrawalError(true);
        setWithdrawalMessage(result.error === "bilingual_withdrawal_required" ? c.needBothWithdrawals : result.error === "stale_publication" ? c.withdrawalConflict : c.withdrawalFailed);
        return;
      }
      router.push(`${base}?view=${returnView}` as Route); router.refresh();
    } catch { setWithdrawalError(true); setWithdrawalMessage(c.withdrawalFailed); }
    finally { setWithdrawing(false); }
  }
  return <div className={styles.desk}>
    <div className={styles.detailNav}>
      <Link href={`${base}?view=${returnView}` as Route} onClick={(event) => { if (!canLeave()) event.preventDefault(); }}>{zh ? "← 返回队列" : "← Back to queue"}</Link>
      <span>{zh ? "版本" : "Version"} {version} · {queueItem.published ? (zh ? "已正式发布" : "Published") : (zh ? "公开预发布" : "Public preprint")}</span>
    </div>
    <nav className={styles.tabs} aria-label={zh ? "选择审核语言" : "Review language"}>
      {(["en", "zh-CN"] as const).map((target) => <Link key={target} href={draftHref(target)} aria-current={target === reviewLanguage ? "page" : undefined} onClick={(event) => { if (!canLeave()) event.preventDefault(); }}>
        {target === "en" ? (zh ? "英文" : "English") : (zh ? "中文" : "Chinese")} · {languageApproved(queueItem, target) ? (zh ? "✓ 已批准" : "✓ Approved") : (zh ? "待审核" : "To review")}
      </Link>)}
    </nav>
    {approved && <div className={styles.notice}>
      <p>{queueItem.published ? (zh ? "此版本已正式发布。" : "This version is published.") : bothApproved ? (zh ? "中英文均已批准，点击下方完成发布。" : "Both languages are approved. Finish publication below.") : (zh ? "此语言已批准，无需重复审核。还需另一种语言通过后，文章才会正式发布。" : "This draft is approved. The other language still needs approval before publication.")}</p>
      {!queueItem.published && !bothApproved && <Link href={draftHref(otherLanguage)} onClick={(event) => { if (!canLeave()) event.preventDefault(); }}>{zh ? "继续审核另一种语言 →" : "Review the other language →"}</Link>}
      {queueItem.published && <Link href={localizedPath(language, `/articles/approved/${articleId}`) as Route}>{zh ? "查看正式文章 →" : "Open published article →"}</Link>}
    </div>}
    <LanguagePanel articleId={articleId} version={version} language={reviewLanguage} uiLanguage={language} onHash={onHash} onPointers={onPointers} approvedNow={queueItem.published} onDirty={onDirty} onSaved={onSaved} reader={reader}
      approvalAction={<div className={styles.reviewActions}>
        {(!approved || (bothApproved && !queueItem.published)) && <>
          <div><strong>{bothApproved ? (zh ? "完成正式发布" : "Finish publication") : (zh ? `批准${reviewLanguage === "en" ? "英文" : "中文"}稿` : `Approve ${reviewLanguage === "en" ? "English" : "Chinese"} draft`)}</strong>
            <p>{zh ? "确认已阅读此语言正文。批准后返回队列；双语均通过时自动发布。" : "Confirm you have read this draft. Approval returns you to the queue and publishes once both languages pass."}</p></div>
          <button className={styles.primary} onClick={() => void approve()} disabled={approving || dirty || !hash || hash !== expectedHash}>{approving ? (zh ? "正在批准…" : "Approving…") : bothApproved ? (zh ? "完成发布并返回队列" : "Publish & return to queue") : (zh ? "批准并返回队列" : "Approve & return to queue")}</button>
        </>}
        {dirty && <p role="status">{zh ? "有未保存的意见。请先保存意见，再决定是否批准。" : "You have unsaved feedback. Save it before approving."}</p>}
        {hash && hash !== expectedHash && <p role="alert">{c.approvalConflict}</p>}
        {approvalMessage && <p role="alert">{approvalMessage} <button className={styles.save} onClick={() => router.refresh()}>{zh ? "重新加载状态" : "Reload status"}</button></p>}
      </div>} />
    <details className={styles.advanced}>
      <summary>{c.withdrawalTitle}</summary>
      <section className={styles.approval} aria-label={c.withdrawalTitle}>
        <p>{c.withdrawalHelp}</p>
        <p>{zh ? "在两种语言的「审核意见」里选择发布范围与撤回决定并保存，再执行撤回。" : "In each language’s feedback form, select Publication and Withdraw, save, then withdraw here."}</p>
        {(pointers?.previewVersion ?? pointers?.approvedVersion) !== version && <p>{c.wrongWithdrawalVersion}</p>}
        <label htmlFor="editorial-withdrawal-reason">{c.withdrawalReason}</label><p>{c.withdrawalReasonHelp}</p>
        <textarea id="editorial-withdrawal-reason" value={withdrawalReason} maxLength={1000} minLength={20} rows={3} onChange={(event) => setWithdrawalReason(event.target.value)} />
        <button onClick={() => void withdraw()} disabled={withdrawing || dirty || !pointers || (pointers.previewVersion ?? pointers.approvedVersion) !== version || withdrawalReason.trim().length < 20}>{withdrawing ? c.withdrawing : c.withdraw}</button>
        {withdrawalMessage && <p role={withdrawalError ? "alert" : "status"}>{withdrawalMessage}</p>}
      </section>
    </details>
  </div>;
}

function LanguagePanel({ articleId, version, language, uiLanguage, onHash, onPointers, approvedNow, onDirty, onSaved, approvalAction, reader }: {
  articleId: string; version: number; language: Language; uiLanguage: Language;
  onHash: (language: Language, hash: string) => void;
  onPointers: (pointers: { previewVersion: number | null; approvedVersion: number | null }) => void;
  approvedNow: boolean; onDirty: (dirty: boolean) => void; onSaved: () => void; approvalAction: ReactNode; reader: ReactNode;
}) {
  const c = copy[uiLanguage];
  const noteId = useId();
  const scopeId = useId();
  const decisionId = useId();
  const paragraphId = useId();
  const quoteId = useId();
  const beforeId = useId();
  const afterId = useId();
  const annotationId = useId();
  const editId = useId();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [edit, setEdit] = useState("");
  const [note, setNote] = useState("");
  const [paragraph, setParagraph] = useState("");
  const [quote, setQuote] = useState("");
  const [before, setBefore] = useState("");
  const [after, setAfter] = useState("");
  const [annotation, setAnnotation] = useState("");
  const [scope, setScope] = useState<Scope>("readability");
  const [decision, setDecision] = useState<Decision>("request_revision");
  const [curatingEdit, setCuratingEdit] = useState<Edit | null>(null);
  const [feedbackScope, setFeedbackScope] = useState<FeedbackScope>("single_article");
  const [feedbackIssue, setFeedbackIssue] = useState<FeedbackIssue>("clarity");
  const [articleGenre, setArticleGenre] = useState<ArticleGenre>("event_thread");
  const [feedbackProblem, setFeedbackProblem] = useState("");
  const [feedbackBeforeExcerpt, setFeedbackBeforeExcerpt] = useState("");
  const [feedbackAfterExcerpt, setFeedbackAfterExcerpt] = useState("");
  const [feedbackApplicability, setFeedbackApplicability] = useState("");
  const [preferenceEvidence, setPreferenceEvidence] = useState("");
  const [curating, setCurating] = useState(false);
  const [curationMessage, setCurationMessage] = useState("");
  const [curationError, setCurationError] = useState(false);
  const [savedSampleEditId, setSavedSampleEditId] = useState<string | null>(null);
  const [loadedKey, setLoadedKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [conflict, setConflict] = useState(false);
  const key = `${articleId}:v${version}:${language}`;
  const loading = loadedKey !== key;

  async function fetchDetail(): Promise<Detail> {
    const params = new URLSearchParams({ articleId, version: String(version), language });
    const response = await fetch(`/api/admin/editorial?${params}`, { cache: "no-store" });
    if (!response.ok) throw new Error("unavailable");
    return (await response.json()) as Detail;
  }

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const next = await fetchDetail();
        if (active) {
          setDetail(next);
          onHash(language, next.article.contentSha256);
          onPointers(next.currentPointers);
          setEdit(next.article.markdown);
          setMessage("");
          setConflict(false);
          setLoadedKey(key);
        }
      } catch {
        if (active) {
          setDetail(null);
          setMessage(c.loadFailed);
          setLoadedKey(key);
        }
      }
    };
    void load();
    return () => { active = false; };
    // The request key names all inputs used by fetchDetail and avoids a render-time state reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, onHash]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detail) return;
    setSaving(true);
    setMessage("");
    setConflict(false);
    const annotationReady = annotation.trim() !== "";
    if (annotationReady && paragraph.trim() === "") {
      setMessage(c.paragraphRequired);
      setSaving(false);
      return;
    }
    try {
      const response = await fetch("/api/admin/editorial", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          articleId,
          version,
          language,
          contentSha256: detail.article.contentSha256,
          reviewScope: scope,
          decision,
          note,
          ...(annotationReady ? { annotations: [{ paragraphKey: paragraph, selectedText: quote, contextBefore: before, contextAfter: after, comment: annotation }] } : {}),
          ...(edit !== detail.article.markdown ? { edit: { afterMarkdown: edit } } : {}),
        }),
      });
      if (response.status === 409 || response.status === 404) {
        setConflict(true);
        setMessage(c.conflict);
        return;
      }
      if (!response.ok) throw new Error("unavailable");
      const next = await fetchDetail();
      setDetail(next);
      setEdit(next.article.markdown);
      setNote("");
      setParagraph("");
      setQuote("");
      setBefore("");
      setAfter("");
      setAnnotation("");
      setMessage(c.saved);
      onSaved();
    } catch {
      setMessage(c.failed);
    } finally {
      setSaving(false);
    }
  }

  async function saveFeedbackSample(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!curatingEdit) return;
    setCurating(true);
    setCurationMessage("");
    setCurationError(false);
    try {
      const response = await fetch("/api/admin/editorial/feedback-samples", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceReviewId: curatingEdit.review_id,
          sourceEditId: curatingEdit.edit_id,
          language,
          feedbackScope,
          issueType: feedbackIssue,
          articleGenre,
          problem: feedbackProblem,
          beforeExcerpt: feedbackBeforeExcerpt,
          afterExcerpt: feedbackAfterExcerpt,
          applicability: feedbackApplicability,
          preferenceEvidence: feedbackScope === "reusable_preference" ? preferenceEvidence : null,
        }),
      });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) {
        setCurationError(true);
        setCurationMessage(result.error === "duplicate_sample" ? c.sampleDuplicate : c.sampleFailed);
        return;
      }
      setCurationMessage(c.sampleSaved);
      setSavedSampleEditId(curatingEdit.edit_id);
    } catch {
      setCurationError(true);
      setCurationMessage(c.sampleFailed);
    } finally {
      setCurating(false);
    }
  }

  if (loading) return <section className={styles.panel} aria-live="polite">{c.loading}</section>;
  if (!detail) return <section className={styles.panel} role="alert">{message || c.loadFailed}</section>;

  const article = detail.article;
  const status = approvedNow ? "approved" : article.status;
  const previewPath = `${language === "zh-CN" ? "/zh-CN" : ""}/articles/previews/${articleId}/v${version}`;

  return (
    <section className={styles.panel} lang={uiLanguage} aria-labelledby={`review-${language}`}>
      <header className={styles.panelHeader}>
        <div>
          <p className={styles.language}>{language === "en" ? (uiLanguage === "en" ? "English draft" : "英文稿") : (uiLanguage === "en" ? "Chinese draft" : "中文稿")} · v{article.version}</p>
          <h3 lang={language} id={`review-${language}`}>{article.title}</h3>
          <p className={styles.summary}>{article.summary}</p>
        </div>
        <span className={styles.state} data-state={status}>
          {status === "approved" ? c.approvedState : c.previewState}
        </span>
      </header>
      <dl className={styles.metadata}>

        <div><dt>{c.cutoff}</dt><dd><time dateTime={article.sourceCutoff}>{article.sourceCutoff.slice(0, 10)}</time></dd></div>
      </dl>
      <div className={styles.previewHeading}>
        <h4>{uiLanguage === "en" ? "Read this draft" : "阅读正文"}</h4>
        <a href={previewPath} target="_blank" rel="noreferrer">{c.preview}</a>
      </div>
      <article className={styles.reader} lang={language} aria-label={uiLanguage === "en" ? "Draft text" : "稿件正文"}>{reader}</article>

      {approvalAction}
      <details className={styles.advanced}>
      <summary>{uiLanguage === "en" ? "Leave feedback or request changes" : "审核意见与修改建议"}</summary>
      <form className={styles.form} onChange={() => onDirty(true)} onSubmit={(event) => void submit(event)}>
        <label htmlFor={scopeId}>{c.scope}</label>
        <select id={scopeId} value={scope} onChange={(event) => setScope(event.target.value as Scope)}>
          {scopes.map((value) => <option key={value} value={value}>{c.scopes[value]}</option>)}
        </select>
        <label htmlFor={decisionId}>{c.decision}</label>
        <select id={decisionId} value={decision} onChange={(event) => setDecision(event.target.value as Decision)}>
          {decisions.map((value) => <option key={value} value={value}>{c.decisions[value]}</option>)}
        </select>
        <p className={styles.help}>{uiLanguage === "en" ? "Feedback is private. Suggested edits do not change the public draft. A new decision replaces this language’s previous review decision." : "意见仅供内部使用，修改建议不会覆盖公开稿件。新的审核决定会替代此语言之前的审核决定。"}</p>
        <label htmlFor={noteId}>{c.note}</label>
        <textarea id={noteId} value={note} maxLength={4000} required rows={3} onChange={(event) => setNote(event.target.value)} />

        <details className={styles.advanced}><summary>{c.annotations}</summary>
        <fieldset className={styles.annotation}>
          <legend>{c.annotations}</legend>
          <label htmlFor={paragraphId}>{c.paragraph}</label>
          <input id={paragraphId} value={paragraph} maxLength={160} required={annotation.trim() !== ""} onChange={(event) => setParagraph(event.target.value)} />
          <label htmlFor={quoteId}>{c.quote}</label>
          <textarea id={quoteId} value={quote} maxLength={3000} rows={2} onChange={(event) => setQuote(event.target.value)} />
          <label htmlFor={beforeId}>{c.before}</label>
          <textarea id={beforeId} value={before} maxLength={600} rows={2} onChange={(event) => setBefore(event.target.value)} />
          <label htmlFor={afterId}>{c.after}</label>
          <textarea id={afterId} value={after} maxLength={600} rows={2} onChange={(event) => setAfter(event.target.value)} />
          <label htmlFor={annotationId}>{c.annotation}</label>
          <textarea id={annotationId} value={annotation} maxLength={3000} rows={2} onChange={(event) => setAnnotation(event.target.value)} />
        </fieldset>
        </details>
        <details className={styles.advanced}><summary>{c.edit}</summary>

        <label htmlFor={editId}>{c.edit}</label>
        <p className={styles.help}>{c.editHelp}</p>
        <textarea className={styles.markdown} id={editId} value={edit} maxLength={96 * 1024} rows={16} onChange={(event) => setEdit(event.target.value)} />
        </details>
        <button className={styles.save} type="submit" disabled={saving || note.trim() === ""}>{saving ? c.saving : c.save}</button>
        {message ? <p className={styles.message} role={conflict ? "alert" : "status"}>{message}</p> : null}
      </form>
      </details>

      <details className={styles.history} aria-labelledby={`history-${language}`}>
        <summary id={`history-${language}`}>{c.history} ({detail.reviews.length})</summary>
        {detail.reviews.length === 0 ? <p>{c.noHistory}</p> : detail.reviews.map((review) => (
          <article className={styles.review} key={review.review_id}>
            <p className={styles.reviewMeta}>{c.scopes[review.review_scope]} · {c.decisions[review.decision]} · {c.actor}: {review.actor_id} · {new Date(review.created_at).toLocaleString(language)}</p>
            <p className={styles.reviewNote}>{review.note}</p>
            {detail.annotations.filter((item) => item.review_id === review.review_id).map((item, index) => (
              <blockquote key={`${review.review_id}-annotation-${index}`}>
                <p>{item.selected_text}</p>
                <p>{item.comment}</p>
              </blockquote>
            ))}
            {detail.edits.filter((item) => item.review_id === review.review_id).map((item) => (
              <details key={item.edit_id}>
                <summary>{c.edits}</summary>
                <div className={styles.editHistory}>
                    <div><h5>{c.original}</h5><pre>{item.before_markdown}</pre></div>
                    <div><h5>{c.revised}</h5><pre>{item.after_markdown}</pre></div>
                </div>
                <button type="button" onClick={() => {
                  setCuratingEdit(item);
                  setCurationMessage("");
                  setCurationError(false);
                  setFeedbackScope("single_article");
                  setFeedbackIssue("clarity");
                  setArticleGenre("event_thread");
                  setFeedbackProblem("");
                  setFeedbackBeforeExcerpt("");
                  setFeedbackAfterExcerpt("");
                  setFeedbackApplicability("");
                  setPreferenceEvidence("");
                }}>
                  {savedSampleEditId === item.edit_id ? c.sampleSaved : c.feedbackSample}
                </button>
                {curatingEdit?.edit_id === item.edit_id && savedSampleEditId !== item.edit_id ? (
                  <form className={styles.form} onSubmit={(event) => void saveFeedbackSample(event)}>
                    <label htmlFor={`feedback-scope-${noteId}-${item.edit_id}`}>{c.feedbackScope}</label>
                    <select id={`feedback-scope-${noteId}-${item.edit_id}`} value={feedbackScope} onChange={(event) => setFeedbackScope(event.target.value as FeedbackScope)}>
                      <option value="single_article">{c.singleArticle}</option>
                      <option value="reusable_preference">{c.reusablePreference}</option>
                    </select>
                    <label htmlFor={`feedback-issue-${noteId}-${item.edit_id}`}>{c.feedbackIssue}</label>
                    <select id={`feedback-issue-${noteId}-${item.edit_id}`} value={feedbackIssue} onChange={(event) => setFeedbackIssue(event.target.value as FeedbackIssue)}>
                      {feedbackIssues.map((value) => <option key={value} value={value}>{c.feedbackIssues[value]}</option>)}
                    </select>
                    <label htmlFor={`feedback-genre-${noteId}-${item.edit_id}`}>{c.articleGenre}</label>
                    <select id={`feedback-genre-${noteId}-${item.edit_id}`} value={articleGenre} onChange={(event) => setArticleGenre(event.target.value as ArticleGenre)}>
                      {articleGenres.map((value) => <option key={value} value={value}>{c.articleGenres[value]}</option>)}
                    </select>
                    <label htmlFor={`feedback-problem-${noteId}-${item.edit_id}`}>{c.feedbackProblem}</label>
                    <textarea id={`feedback-problem-${noteId}-${item.edit_id}`} value={feedbackProblem} required minLength={10} maxLength={1200} rows={2} onChange={(event) => setFeedbackProblem(event.target.value)} />
                    <label htmlFor={`feedback-before-${noteId}-${item.edit_id}`}>{c.feedbackBeforeExcerpt}</label>
                    <textarea id={`feedback-before-${noteId}-${item.edit_id}`} value={feedbackBeforeExcerpt} required maxLength={3000} rows={2} onChange={(event) => setFeedbackBeforeExcerpt(event.target.value)} />
                    <label htmlFor={`feedback-after-${noteId}-${item.edit_id}`}>{c.feedbackAfterExcerpt}</label>
                    <textarea id={`feedback-after-${noteId}-${item.edit_id}`} value={feedbackAfterExcerpt} required maxLength={3000} rows={2} onChange={(event) => setFeedbackAfterExcerpt(event.target.value)} />
                    <label htmlFor={`feedback-applicability-${noteId}-${item.edit_id}`}>{c.feedbackApplicability}</label>
                    <textarea id={`feedback-applicability-${noteId}-${item.edit_id}`} value={feedbackApplicability} required minLength={10} maxLength={1200} rows={2} onChange={(event) => setFeedbackApplicability(event.target.value)} />
                    {feedbackScope === "reusable_preference" ? (
                      <>
                        <label htmlFor={`feedback-preference-${noteId}-${item.edit_id}`}>{c.preferenceEvidence}</label>
                        <p>{c.preferenceHelp}</p>
                        <textarea id={`feedback-preference-${noteId}-${item.edit_id}`} value={preferenceEvidence} required minLength={10} maxLength={1200} rows={2} onChange={(event) => setPreferenceEvidence(event.target.value)} />
                      </>
                    ) : null}
                    <button type="submit" disabled={curating}>{curating ? c.saving : c.saveSample}</button>
                    {curationMessage ? <p role={curationError ? "alert" : "status"}>{curationMessage}</p> : null}
                  </form>
                ) : null}
                {savedSampleEditId === item.edit_id ? <p role="status">{c.sampleSaved}</p> : null}
              </details>
            ))}
          </article>
        ))}
      </details>
    </section>
  );
}
