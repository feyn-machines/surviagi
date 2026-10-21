"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import type { OwnerKind } from "@/lib/handles";
import { bilingual, type Language } from "@/lib/i18n";
import styles from "./admin.module.css";

const copy = bilingual({
  en: { approve: "Approve", reject: "Reject", reason: "Reason", confirm: "Reject", cancel: "Cancel", already: "Already decided", failed: "Try again later" },
  "zh-CN": { approve: "通过", reject: "拒绝", reason: "理由", confirm: "拒绝", cancel: "取消", already: "已被处理", failed: "请稍后再试" },
});

export function Decide({ handle, ownerKind, language }: { handle: string; ownerKind: OwnerKind; language: Language }) {
  const router = useRouter();
  const c = copy[language];
  const reasonId = useId();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState("");

  async function send(decision: "approve" | "reject") {
    setBusy(true);
    setLine("");
    try {
      const response = await fetch("/api/admin/submissions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle, ownerKind, decision, ...(decision === "reject" ? { reason: reason.trim() } : {}) }),
      });
      if (!response.ok) {
        setLine(c.failed);
        return;
      }
      const body = (await response.json()) as { changed?: number };
      if (body.changed === 0) {
        setLine(c.already);
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      router.refresh();
    } catch {
      setLine(c.failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.decide}>
      {rejecting ? (
        <form
          className={styles.reject}
          onSubmit={(event) => {
            event.preventDefault();
            if (reason.trim()) void send("reject");
          }}
        >
          <label className="oaw-sr-only" htmlFor={reasonId}>{c.reason}</label>
          <input id={reasonId} className={styles.reason} value={reason} maxLength={280} required placeholder={c.reason} onChange={(event) => setReason(event.target.value)} />
          <button type="submit" className={styles.button} disabled={busy || reason.trim() === ""}>{c.confirm}</button>
          <button type="button" className={styles.button} disabled={busy} onClick={() => setRejecting(false)}>{c.cancel}</button>
        </form>
      ) : (
        <>
          <button type="button" className={styles.button} disabled={busy} onClick={() => void send("approve")}>{c.approve}</button>
          <button type="button" className={styles.button} disabled={busy} onClick={() => setRejecting(true)}>{c.reject}</button>
        </>
      )}
      {line ? <span className={styles.line} role="status">{line}</span> : null}
    </div>
  );
}
