"use client";

import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
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
    previewState: "Public preprint · not approved",
    approvedState: "Approved version",
    cutoff: "Evidence cutoff",
    hash: "Content hash",
    scope: "Review scope",
    scopes: { readability: "Readability", language_quality: "Language quality", factual_accuracy: "Factual accuracy", source_quality: "Source quality", publication: "Publication" },
    decision: "Decision recorded",
    decisions: { comment: "Comment", request_revision: "Request revision", hold: "Hold", approve: "Approve this version", withdraw: "Withdraw this article" },
    publishBoundary: "Approval switches the approved-version pointer. A withdrawal decision is only a review record; use the bilingual withdrawal action below to remove the article from public access.",
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
    approveBoth: "Approve this bilingual version",
    approveHelp: "The latest human decision for both English and Chinese must be “Approve this version”. This switches the approved-version pointer used by the regular Articles listing and feeds.",
    approving: "Approving…",
    approved: "Both language reviews passed. This version is now the approved version.",
    alreadyApproved: "This version was already approved.",
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
    previewState: "公开预发布 · 尚未批准",
    approvedState: "已批准版本",
    cutoff: "证据截止时间",
    hash: "内容 hash",
    scope: "审核范围",
    scopes: { readability: "可读性", language_quality: "语言表达", factual_accuracy: "事实准确性", source_quality: "来源质量", publication: "发布范围" },
    decision: "记录审核决定",
    decisions: { comment: "留下意见", request_revision: "要求修改", hold: "暂缓", approve: "记录批准意见", withdraw: "记录撤回意见" },
    publishBoundary: "批准会切换正式版本指针。撤回决定本身只写审核记录；请在下方通过双语撤回操作将文章从公开访问中移除。",
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
    approveBoth: "批准此双语版本",
    approveHelp: "中英文两种语言都必须分别有最新的人工作出“批准此版本”的决定。此操作会切换常规文章栏目和 feed 使用的正式版本指针。",
    approving: "正在批准…",
    approved: "中英文审核均已通过，此版本现为正式批准版本。",
    alreadyApproved: "此版本已经批准。",
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
const decisions: Decision[] = ["comment", "request_revision", "hold", "approve", "withdraw"];
const feedbackIssues: FeedbackIssue[] = ["evidence_boundary", "structure", "clarity", "specificity", "tone", "redundancy", "headline", "natural_language", "other"];
const articleGenres: ArticleGenre[] = ["event_thread", "product_comparison", "capability_explainer", "workflow", "other"];

export function EditorialReviewDesk({ articleId, version, language }: { articleId: string; version: number; language: Language }) {
  const c = copy[language];
  const [hashes, setHashes] = useState<Partial<Record<Language, string>>>({});
  const [approving, setApproving] = useState(false);
  const [approvalMessage, setApprovalMessage] = useState("");
  const [approvalError, setApprovalError] = useState(false);
  const [approvedNow, setApprovedNow] = useState(false);
  const [pointers, setPointers] = useState<{ previewVersion: number | null; approvedVersion: number | null } | null>(null);
  const [withdrawalReason, setWithdrawalReason] = useState("");
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawalMessage, setWithdrawalMessage] = useState("");
  const [withdrawalError, setWithdrawalError] = useState(false);
  const withdrawalHead = pointers?.previewVersion ?? pointers?.approvedVersion ?? null;
  const onWithdrawalHead = withdrawalHead === version;
  const onHash = useCallback((itemLanguage: Language, hash: string) => {
    setHashes((previous) => previous[itemLanguage] === hash ? previous : { ...previous, [itemLanguage]: hash });
  }, []);

  const onPointers = useCallback((value: { previewVersion: number | null; approvedVersion: number | null }) => {
    setPointers((previous) => previous?.previewVersion === value.previewVersion && previous.approvedVersion === value.approvedVersion ? previous : value);
  }, []);

  async function withdraw() {
    if (!pointers || withdrawalReason.trim().length < 20 || !window.confirm(c.confirmWithdrawal)) return;
    setWithdrawing(true);
    setWithdrawalMessage("");
    setWithdrawalError(false);
    try {
      const response = await fetch("/api/admin/editorial/withdraw", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ articleId, expectedPreviewVersion: pointers.previewVersion, expectedApprovedVersion: pointers.approvedVersion, reason: withdrawalReason }),
      });
      const result = await response.json().catch(() => ({})) as { error?: string; publicationChanged?: boolean };
      if (!response.ok) {
        setWithdrawalError(true);
        setWithdrawalMessage(result.error === "bilingual_withdrawal_required" ? c.needBothWithdrawals
          : result.error === "stale_publication" ? c.withdrawalConflict : c.withdrawalFailed);
        return;
      }
      setWithdrawalMessage(result.publicationChanged ? c.withdrawn : c.alreadyWithdrawn);
      setPointers(null);
    } catch {
      setWithdrawalError(true);
      setWithdrawalMessage(c.withdrawalFailed);
    } finally {
      setWithdrawing(false);
    }
  }

  async function approve() {
    if (!hashes.en || !hashes["zh-CN"]) return;
    setApproving(true);
    setApprovalMessage("");
    setApprovalError(false);
    try {
      const response = await fetch("/api/admin/editorial/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ articleId, version, contentSha256: hashes }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as { error?: string };
        setApprovalError(true);
        setApprovalMessage(result.error === "bilingual_approval_required"
          ? c.needBothApprovals
          : result.error === "stale_preview" ? c.approvalConflict : c.approvalFailed);
        return;
      }
      const result = await response.json() as { publicationChanged?: boolean };
      setApprovedNow(true);
      setApprovalMessage(result.publicationChanged ? c.approved : c.alreadyApproved);
    } catch {
      setApprovalError(true);
      setApprovalMessage(c.approvalFailed);
    } finally {
      setApproving(false);
    }
  }

  return (
    <div className={styles.desk}>
      <section className={styles.approval} aria-label={c.approveBoth}>
        <p>{c.approveHelp}</p>
        <button type="button" onClick={() => void approve()} disabled={approving || !hashes.en || !hashes["zh-CN"]}>
          {approving ? c.approving : c.approveBoth}
        </button>
        {approvalMessage ? <p role={approvalError ? "alert" : "status"}>{approvalMessage}</p> : null}
      </section>
      <div className={styles.panels}>
        <LanguagePanel articleId={articleId} version={version} language="en" onHash={onHash} onPointers={onPointers} approvedNow={approvedNow} />
        <LanguagePanel articleId={articleId} version={version} language="zh-CN" onHash={onHash} onPointers={onPointers} approvedNow={approvedNow} />
      </div>
      <section className={styles.approval} aria-label={c.withdrawalTitle}>
        <h3>{c.withdrawalTitle}</h3>
        <p>{c.withdrawalHelp}</p>
        <p>{c.cutoff}: {pointers?.previewVersion ? `preview v${pointers.previewVersion}` : "no preview"}; {pointers?.approvedVersion ? `approved v${pointers.approvedVersion}` : "no approved version"}</p>
        {!onWithdrawalHead ? <p>{c.wrongWithdrawalVersion}</p> : null}
        <label htmlFor="editorial-withdrawal-reason">{c.withdrawalReason}</label>
        <p>{c.withdrawalReasonHelp}</p>
        <textarea id="editorial-withdrawal-reason" value={withdrawalReason} maxLength={1000} minLength={20} rows={3} onChange={(event) => setWithdrawalReason(event.target.value)} />
        <button type="button" onClick={() => void withdraw()} disabled={withdrawing || !pointers || !onWithdrawalHead || withdrawalReason.trim().length < 20}>
          {withdrawing ? c.withdrawing : c.withdraw}
        </button>
        {withdrawalMessage ? <p role={withdrawalError ? "alert" : "status"}>{withdrawalMessage}</p> : null}
      </section>
    </div>
  );
}

function LanguagePanel({ articleId, version, language, onHash, onPointers, approvedNow }: { articleId: string; version: number; language: Language; onHash: (language: Language, hash: string) => void; onPointers: (pointers: { previewVersion: number | null; approvedVersion: number | null }) => void; approvedNow: boolean }) {
  const c = copy[language];
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
  const [decision, setDecision] = useState<Decision>("comment");
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
    <section className={styles.panel} lang={language} aria-labelledby={`review-${language}`}>
      <header className={styles.panelHeader}>
        <div>
          <p className={styles.language}>{c.language} · v{article.version}</p>
          <h3 id={`review-${language}`}>{article.title}</h3>
          <p className={styles.summary}>{article.summary}</p>
        </div>
        <span className={styles.state} data-state={status}>
          {status === "approved" ? c.approvedState : c.previewState}
        </span>
      </header>
      <dl className={styles.metadata}>
        <div><dt>{c.hash}</dt><dd title={article.contentSha256}>{article.contentSha256.slice(0, 16)}</dd></div>
        <div><dt>{c.cutoff}</dt><dd><time dateTime={article.sourceCutoff}>{article.sourceCutoff.slice(0, 10)}</time></dd></div>
      </dl>
      <div className={styles.previewHeading}>
        <h4>{article.title}</h4>
        <a href={previewPath} target="_blank" rel="noreferrer">{c.preview}</a>
      </div>
      <iframe className={styles.preview} src={previewPath} title={`${c.language}: ${article.title}`} loading="lazy" />

      <form className={styles.form} onSubmit={(event) => void submit(event)}>
        <label htmlFor={scopeId}>{c.scope}</label>
        <select id={scopeId} value={scope} onChange={(event) => setScope(event.target.value as Scope)}>
          {scopes.map((value) => <option key={value} value={value}>{c.scopes[value]}</option>)}
        </select>
        <label htmlFor={decisionId}>{c.decision}</label>
        <select id={decisionId} value={decision} onChange={(event) => setDecision(event.target.value as Decision)}>
          {decisions.map((value) => <option key={value} value={value}>{c.decisions[value]}</option>)}
        </select>
        <p className={styles.boundary}>{c.publishBoundary}</p>
        <label htmlFor={noteId}>{c.note}</label>
        <textarea id={noteId} value={note} maxLength={4000} required rows={3} onChange={(event) => setNote(event.target.value)} />

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

        <label htmlFor={editId}>{c.edit}</label>
        <p className={styles.help}>{c.editHelp}</p>
        <textarea className={styles.markdown} id={editId} value={edit} maxLength={96 * 1024} rows={16} onChange={(event) => setEdit(event.target.value)} />
        <button className={styles.save} type="submit" disabled={saving || note.trim() === ""}>{saving ? c.saving : c.save}</button>
        {message ? <p className={styles.message} role={conflict ? "alert" : "status"}>{message}</p> : null}
      </form>

      <section className={styles.history} aria-labelledby={`history-${language}`}>
        <h4 id={`history-${language}`}>{c.history}</h4>
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
      </section>
    </section>
  );
}
