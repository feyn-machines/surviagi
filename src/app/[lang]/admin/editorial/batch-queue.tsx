"use client";

import { useState } from "react";
import { makeApprovalBatch } from "@/lib/editorial-batch";
import type { Language } from "@/lib/i18n";
import s from "./review.module.css";

type QueueItem = { articleId: string; version: number; title: string; chineseTitle: string; contentSha256: string; chineseHash: string };
type Result = { articleId: string; version: number; contentSha256?: { en: string; "zh-CN": string }; status: string; publicationChanged: boolean };

const labels = {
  en: {
    select: "Select reviewed versions",
    submit: "Approve selected",
    sending: "Processing batch…",
    both: "Each batch action explicitly approves the selected exact versions after independent review of English and Chinese.",
    noSelection: "Select at least one version.",
    failed: "Batch request failed. Refresh the queue before submitting a new batch.",
    approved: "Approved",
    already: "Already approved",
    already_approved: "Already approved",
    conflict: "Version conflict",
    needs_bilingual_approval: "Needs English and Chinese approval records",
    not_found: "No longer public",
    unavailable: "Unavailable",
    batch: "Batch",
    result: "Batch result",
  },
  "zh-CN": {
    select: "选择已完成人工审核的版本",
    submit: "批准所选版本",
    sending: "正在处理批次…",
    both: "本批次会明确批准所选版本；请先分别审核并确认英文与中文版本。",
    noSelection: "请至少选择一个版本。",
    failed: "批次请求失败，请刷新队列后再提交新批次。",
    approved: "已批准",
    already: "此前已批准",
    already_approved: "此前已批准",
    conflict: "版本冲突",
    needs_bilingual_approval: "尚缺中英文批准记录",
    not_found: "已不再公开",
    unavailable: "暂不可用",
    batch: "批次",
    result: "批次结果",
  },
} as const;

export function EditorialBatchQueue({ articles, language, label, onResult }: { articles: QueueItem[]; language: Language; label: string; onResult?: (results: Result[]) => void }) {
  const c = labels[language];
  const [selected, setSelected] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [batchId, setBatchId] = useState("");

  async function submit() {
    const items = selected.map((key) => {
      const [articleId, version] = key.split(":v");
      const article = articles.find((item) => item.articleId === articleId && item.version === Number(version));
      return { articleId, version: Number(version), contentSha256: { en: article!.contentSha256, "zh-CN": article!.chineseHash } };
    });
    if (!items.length) { setMessage(c.noSelection); return; }
    setPending(true);
    setMessage("");
    const batch = makeApprovalBatch(items);
    let parsed: { batchId: string; items: typeof items } | null = null;
    try {
      const prior = localStorage.getItem("editorial-approval-batch");
      parsed = prior ? JSON.parse(prior) as { batchId: string; items: typeof items } : null;
    } catch { parsed = null; }
    const request = parsed && JSON.stringify(parsed.items) === JSON.stringify(items)
      ? parsed : batch;
    try { localStorage.setItem("editorial-approval-batch", JSON.stringify(request)); } catch { /* The batch can still be submitted without browser storage. */ }
    setBatchId(request.batchId);
    try {
      const response = await fetch("/api/admin/editorial/approve-batch", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
      });
      const result = await response.json() as { error?: string; results?: Result[] };
      if (!response.ok || !result.results) { setMessage(result.error ?? c.failed); return; }
      setResults(result.results);
      onResult?.(result.results);
      setSelected([]);
      try { localStorage.removeItem("editorial-approval-batch"); } catch { /* No saved retry state to clear. */ }
    } catch { setMessage(c.failed); }
    finally { setPending(false); }
  }

  return (
    <section className={s.batch} aria-label={label}>
      <p>{c.both}</p>
      <ul>
        {articles.map((article) => {
          const key = `${article.articleId}:v${article.version}`;
          return <li key={key}>
            <label>
              <input type="checkbox" checked={selected.includes(key)} disabled={pending}
                onChange={(event) => setSelected((current) => event.target.checked
                  ? [...current, key] : current.filter((item) => item !== key))} />
              <span>v{article.version} · {article.title} / {article.chineseTitle}</span>
            </label>
          </li>;
        })}
      </ul>
      <button type="button" onClick={() => void submit()} disabled={pending}>{pending ? c.sending : c.submit}</button>
      {message ? <p role="alert">{message}</p> : null}
      {results.length ? <div role="status" aria-live="polite">
        <p>{c.result} {batchId}</p>
        <ul>{results.map((result) => <li key={`${result.articleId}:v${result.version}`}>
          {result.articleId} v{result.version} [{result.contentSha256?.en.slice(0, 10) ?? "—"} / {result.contentSha256?.["zh-CN"].slice(0, 10) ?? "—"}]: {c[result.status as keyof typeof c] ?? result.status}
        </li>)}</ul>
      </div> : null}
    </section>
  );
}
