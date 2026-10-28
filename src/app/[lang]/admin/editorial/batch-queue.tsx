"use client";

import { useState } from "react";
import { makeApprovalBatch } from "@/lib/editorial-batch";
import type { Language } from "@/lib/i18n";
import s from "./review.module.css";

type QueueItem = {
  articleId: string;
  version: number;
  title: string;
  chineseTitle: string;
  contentSha256: string;
  chineseHash: string;
  enApproved: boolean;
  chineseApproved: boolean;
};
type Result = {
  articleId: string;
  version: number;
  language: Language;
  status: string;
  publicationChanged: boolean;
};

const labels = {
  en: {
    submit: "Approve selected language(s)",
    sending: "Recording approvals…",
    both: "Review English and Chinese independently. Each checked language gets its own private approval record. The article enters Articles only after both are approved.",
    noSelection: "Select at least one language you have reviewed.",
    failed: "Approval request failed. Refresh the queue before retrying.",
    english: "English",
    chinese: "Chinese",
    pending: "Awaiting approval",
    languageApproved: "Approved; waiting for the other language",
    approved: "Both languages approved; now in Articles",
    already_approved: "Already approved",
    already_language_approved: "This language was already approved",
    language_approved: "This language is approved; the other language is still pending",
    conflict: "Version changed; reload and review the current text",
    not_found: "No longer public",
    unavailable: "Temporarily unavailable",
    batch: "Batch",
    result: "Approval result",
  },
  "zh-CN": {
    submit: "批准所选语言",
    sending: "正在分别记录批准…",
    both: "请分别阅读中英文稿。每个勾选的语言都会单独保存批准记录；只有两种语言都批准后，文章才进入正式文章栏目。",
    noSelection: "请至少选择一种已审核的语言。",
    failed: "批准请求失败，请刷新队列后重试。",
    english: "英文",
    chinese: "中文",
    pending: "等待此语言审核",
    languageApproved: "此语言已批准，等待另一种语言",
    approved: "中英文均已批准，文章已进入正式栏目",
    already_approved: "整篇双语文章此前已批准",
    already_language_approved: "此语言此前已批准",
    language_approved: "此语言已批准，另一种语言仍待审核",
    conflict: "版本已变化，请刷新并重新审核当前文本",
    not_found: "此版本已不再公开",
    unavailable: "暂时无法处理",
    batch: "分语言批量审核",
    result: "批准结果",
  },
} as const;

function selectionKey(article: QueueItem, language: Language) {
  return `${article.articleId}:v${article.version}:${language}`;
}

export function EditorialBatchQueue({ articles, language, label }: { articles: QueueItem[]; language: Language; label: string }) {
  const c = labels[language];
  const [queue, setQueue] = useState(articles);
  const [selected, setSelected] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [publishedArticles, setPublishedArticles] = useState<string[]>([]);
  const [batchId, setBatchId] = useState("");

  async function submit() {
    const items = selected.flatMap((key) => {
      const [articleId, versionText, itemLanguage] = key.split(":");
      const article = queue.find((item) => item.articleId === articleId && item.version === Number(versionText));
      if (!article || (itemLanguage !== "en" && itemLanguage !== "zh-CN")) return [];
      return [{ articleId, version: Number(versionText), language: itemLanguage as Language,
        contentSha256: { en: article.contentSha256, "zh-CN": article.chineseHash } }];
    });
    if (!items.length) { setMessage(c.noSelection); return; }
    setPending(true);
    setMessage("");
    const batch = makeApprovalBatch(items);
    let prior: { batchId: string; items: typeof items } | null = null;
    try {
      const value = localStorage.getItem("editorial-language-approval-batch");
      prior = value ? JSON.parse(value) as { batchId: string; items: typeof items } : null;
    } catch { prior = null; }
    const request = prior && JSON.stringify(prior.items) === JSON.stringify(items) ? prior : batch;
    try { localStorage.setItem("editorial-language-approval-batch", JSON.stringify(request)); } catch { /* Browser storage is only for safe retry. */ }
    setBatchId(request.batchId);
    try {
      const response = await fetch("/api/admin/editorial/approve-batch", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
      });
      const result = await response.json() as { error?: string; results?: Result[] };
      if (!response.ok || !result.results) { setMessage(result.error ?? c.failed); return; }
      setResults(result.results);
      const publishedInBatch = new Set(result.results.filter((item) => item.publicationChanged)
        .map((item) => `${item.articleId}:v${item.version}`));
      setPublishedArticles([...publishedInBatch]);
      setQueue((current) => current.flatMap((article) => {
        let enApproved = article.enApproved;
        let chineseApproved = article.chineseApproved;
        for (const item of result.results ?? []) {
          if (item.articleId !== article.articleId || item.version !== article.version) continue;
          if (["approved", "already_approved"].includes(item.status)) { enApproved = true; chineseApproved = true; }
          if (["language_approved", "already_language_approved"].includes(item.status)) {
            if (item.language === "en") enApproved = true;
            if (item.language === "zh-CN") chineseApproved = true;
          }
        }
        return enApproved && chineseApproved ? [] : [{ ...article, enApproved, chineseApproved }];
      }));
      setSelected([]);
      try { localStorage.removeItem("editorial-language-approval-batch"); } catch { /* No retry state remains. */ }
    } catch { setMessage(c.failed); }
    finally { setPending(false); }
  }

  return (
    <section className={s.batch} aria-label={label}>
      <p>{c.both}</p>
      <ul>
        {queue.map((article) => {
          const version = `v${article.version}`;
          return <li key={`${article.articleId}:${version}`}>
            <strong>{version} · {article.title} / {article.chineseTitle}</strong>
            <div className={s.languageApprovals}>
              {(["en", "zh-CN"] as const).map((itemLanguage) => {
                const isEnglish = itemLanguage === "en";
                const approved = isEnglish ? article.enApproved : article.chineseApproved;
                const key = selectionKey(article, itemLanguage);
                return <label className={s.languageApproval} key={itemLanguage}>
                  <input type="checkbox" checked={selected.includes(key)} disabled={pending || approved}
                    onChange={(event) => setSelected((current) => event.target.checked
                      ? [...current, key] : current.filter((item) => item !== key))} />
                  <span><b>{isEnglish ? c.english : c.chinese}</b> · {approved ? c.languageApproved : c.pending}</span>
                </label>;
              })}
            </div>
          </li>;
        })}
      </ul>
      {queue.length ? <button type="button" onClick={() => void submit()} disabled={pending || selected.length === 0}>
        {pending ? c.sending : c.submit}
      </button> : null}
      {message ? <p role="alert">{message}</p> : null}
      {results.length ? <div role="status" aria-live="polite">
        <p>{c.result} · {c.batch} {batchId}</p>
        <ul>{results.map((result, index) => {
          const key = `${result.articleId}:v${result.version}`;
          const status = publishedArticles.includes(key) && ["language_approved", "already_language_approved"].includes(result.status)
            ? "approved" : result.status;
          return <li key={`${key}:${result.language}:${index}`}>
            {result.articleId} v{result.version} · {result.language === "en" ? c.english : c.chinese}: {c[status as keyof typeof c] ?? status}
          </li>;
        })}</ul>
      </div> : null}
    </section>
  );
}
