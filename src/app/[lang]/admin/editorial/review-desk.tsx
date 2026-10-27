"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import styles from "./review.module.css";

type Language = "en" | "zh-CN";
type Scope = "readability" | "language_quality" | "factual_accuracy" | "source_quality";
type Decision = "comment" | "request_revision" | "hold" | "approve" | "withdraw";
type Annotation = { annotation_id: string; review_id: string; paragraph_key: string; selected_text: string; context_before: string; context_after: string; comment: string };
type Review = { review_id: string; review_scope: Scope; decision: Decision; actor_kind: string; actor_id: string; note: string; created_at: string };
type Edit = { edit_id: string; review_id: string; before_markdown: string; after_markdown: string; unified_diff: string; created_at: string };
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
type Detail = { article: Article; reviews: Review[]; annotations: Annotation[]; edits: Edit[] };

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
    scopes: { readability: "Readability", language_quality: "Language quality", factual_accuracy: "Factual accuracy", source_quality: "Source quality" },
    decision: "Decision recorded",
    decisions: { comment: "Comment", request_revision: "Request revision", hold: "Hold", approve: "Approve this version", withdraw: "Withdraw this article" },
    publishBoundary: "Approval and withdrawal are recorded for review history only. This action does not publish or withdraw the public article.",
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
    scopes: { readability: "可读性", language_quality: "语言表达", factual_accuracy: "事实准确性", source_quality: "来源质量" },
    decision: "记录审核决定",
    decisions: { comment: "留下意见", request_revision: "要求修改", hold: "暂缓", approve: "记录批准意见", withdraw: "记录撤回意见" },
    publishBoundary: "批准或撤回决定只写入审核记录；此操作不会发布或撤回公开文章。",
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
  },
} as const;

const scopes: Scope[] = ["readability", "language_quality", "factual_accuracy", "source_quality"];
const decisions: Decision[] = ["comment", "request_revision", "hold", "approve", "withdraw"];

export function EditorialReviewDesk({ articleId, version }: { articleId: string; version: number }) {
  return (
    <div className={styles.desk}>
      <div className={styles.panels}>
        <LanguagePanel articleId={articleId} version={version} language="en" />
        <LanguagePanel articleId={articleId} version={version} language="zh-CN" />
      </div>
    </div>
  );
}

function LanguagePanel({ articleId, version, language }: { articleId: string; version: number; language: Language }) {
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
  }, [key]);

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

  if (loading) return <section className={styles.panel} aria-live="polite">{c.loading}</section>;
  if (!detail) return <section className={styles.panel} role="alert">{message || c.loadFailed}</section>;

  const article = detail.article;
  const previewPath = `${language === "zh-CN" ? "/zh-CN" : ""}/articles/previews/${articleId}/v${version}`;

  return (
    <section className={styles.panel} lang={language} aria-labelledby={`review-${language}`}>
      <header className={styles.panelHeader}>
        <div>
          <p className={styles.language}>{c.language} · v{article.version}</p>
          <h3 id={`review-${language}`}>{article.title}</h3>
          <p className={styles.summary}>{article.summary}</p>
        </div>
        <span className={styles.state} data-state={article.status}>
          {article.status === "approved" ? c.approvedState : c.previewState}
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
              </details>
            ))}
          </article>
        ))}
      </section>
    </section>
  );
}
