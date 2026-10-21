"use client";

import { useEffect, useRef, useState } from "react";
import type { Submission } from "@/lib/app-store";
import { normalizeHandle, type OwnerKind } from "@/lib/handles";
import { bilingual, type Language } from "@/lib/i18n";
import styles from "./account.module.css";
import { useMe } from "./me";
import { startSignIn } from "./session";
import { refreshSubmissions } from "./submissions";

export const statusCopy = bilingual({
  en: { pending: "Pending", approved: "Approved", rejected: "Rejected" },
  "zh-CN": { pending: "待审核", approved: "已通过", rejected: "已拒绝" },
});

const copy = bilingual({
  en: {
    open: "Submit an account",
    title: "Submit an account",
    handle: "X account",
    placeholder: "@name",
    why: "Why",
    submit: "Submit",
    cancel: "Cancel",
    created: "Submitted",
    monitored: "Already monitored",
    limit: "10 pending. Wait for review.",
    rate: "Too many attempts",
    invalid: "Not an X account",
    failed: "Try again later",
  },
  "zh-CN": {
    open: "提交帐号",
    title: "提交帐号",
    handle: "X 帐号",
    placeholder: "@name",
    why: "理由",
    submit: "提交",
    cancel: "取消",
    created: "已提交",
    monitored: "已在监控",
    limit: "已有 10 条待审核",
    rate: "操作太频繁",
    invalid: "不是有效的 X 帐号",
    failed: "请稍后再试",
  },
});

type Answer =
  | { result: "created" | "duplicate"; submission: Submission }
  | { result: "monitored"; handle: string }
  | { result: "limit"; limit: number };

export function SubmitAccount({ language, ownerKind, enabled, anchor }: { language: Language; ownerKind: OwnerKind; enabled: boolean; anchor: "people" | "companies" }) {
  const { state, me } = useMe(enabled);
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [handle, setHandle] = useState("");
  const [note, setNote] = useState("");
  const [line, setLine] = useState("");
  const [bad, setBad] = useState(false);
  const [busy, setBusy] = useState(false);
  const [signInLine, setSignInLine] = useState("");
  const c = copy[language];

  useEffect(() => () => clearTimeout(timer.current), []);

  if (!enabled || state === "loading" || !me.enabled) return null;

  function close() {
    clearTimeout(timer.current);
    dialog.current?.close();
  }

  function open() {
    if (!me.user) {
      setSignInLine("");
      startSignIn(`${window.location.pathname}${window.location.search}#${anchor}`).catch(() => setSignInLine(c.failed));
      return;
    }
    setHandle("");
    setNote("");
    setLine("");
    setBad(false);
    dialog.current?.showModal();
  }

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!normalizeHandle(handle)) {
      setBad(true);
      setLine(c.invalid);
      return;
    }
    setBad(false);
    setBusy(true);
    setLine("");
    try {
      const response = await fetch("/api/submissions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle, ownerKind, note }),
      });
      const body = (await response.json().catch(() => ({}))) as Partial<Answer> & { error?: string };
      if (response.ok && body.result) {
        const answer = body as Answer;
        if (answer.result === "created") {
          setLine(c.created);
          await refreshSubmissions();
          timer.current = setTimeout(close, 1200);
        } else if (answer.result === "duplicate") {
          setLine(statusCopy[language][answer.submission.status]);
        } else if (answer.result === "monitored") {
          setLine(c.monitored);
        } else {
          setLine(c.limit);
        }
      } else if (response.status === 429) {
        setLine(c.rate);
      } else if (response.status === 400 && body.error === "invalid_handle") {
        setBad(true);
        setLine(c.invalid);
      } else {
        setLine(c.failed);
      }
    } catch {
      setLine(c.failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button ref={opener} type="button" className={styles.submitButton} onClick={open}>
        {c.open}
      </button>
      {signInLine ? <span className={styles.note} role="status">{signInLine}</span> : null}
      <dialog
        ref={dialog}
        className={styles.dialog}
        aria-labelledby={`submit-${anchor}-title`}
        onClose={() => opener.current?.focus()}
      >
        <form className={styles.form} onSubmit={send} noValidate>
          <h3 id={`submit-${anchor}-title`} className={styles.dialogTitle}>{c.title}</h3>
          <label className={styles.field}>
            <span>{c.handle}</span>
            <input
              className={styles.input}
              value={handle}
              onChange={(event) => setHandle(event.target.value)}
              placeholder={c.placeholder}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-invalid={bad}
              aria-describedby={`submit-${anchor}-line`}
              autoFocus
            />
          </label>
          <label className={styles.field}>
            <span>{c.why}</span>
            <textarea className={styles.input} value={note} onChange={(event) => setNote([...event.target.value].slice(0, 280).join(""))} rows={3} />
            <span className={styles.count}>{[...note].length}/280</span>
          </label>
          <p id={`submit-${anchor}-line`} className={styles.line} role="status" aria-live="polite">{line}</p>
          <div className={styles.actions}>
            <button type="button" className={styles.submitButton} onClick={close}>{c.cancel}</button>
            <button type="submit" className={`${styles.submitButton} ${styles.primary}`} disabled={busy}>{c.submit}</button>
          </div>
        </form>
      </dialog>
    </>
  );
}
