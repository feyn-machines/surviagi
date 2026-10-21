"use client";

import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { bilingual, type Language } from "@/lib/i18n";
import styles from "./account.module.css";
import { refreshMe, useMe } from "./me";
import { startSignIn } from "./session";

const copy = bilingual({
  en: {
    subscribe: "Subscribe",
    subscribed: "Subscribed",
    updates: "Site updates",
    weekly: "Weekly report",
    save: "Save",
    saved: "Saved",
    cancel: "Cancel",
    failed: "Try again later",
  },
  "zh-CN": {
    subscribe: "订阅",
    subscribed: "已订阅",
    updates: "网站更新",
    weekly: "周报",
    save: "保存",
    saved: "已保存",
    cancel: "取消",
    failed: "请稍后再试",
  },
});

/**
 * The subscribe control. `footer` renders a plain button, `menu` a menu item; both open the same
 * dialog. Renders nothing when sign-in is off or until /api/me has answered.
 */
export function Subscribe({
  language,
  enabled,
  variant = "footer",
  onOpen,
}: {
  language: Language;
  enabled: boolean;
  variant?: "footer" | "menu";
  onOpen?: () => void;
}) {
  const { state, me } = useMe(enabled);
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [updates, setUpdates] = useState(false);
  const [weekly, setWeekly] = useState(false);
  const [line, setLine] = useState("");
  const [busy, setBusy] = useState(false);
  const [signInLine, setSignInLine] = useState("");
  const c = copy[language];

  if (!enabled || state === "loading" || !me.enabled) return null;

  const known = me.subscriptions;
  const active = known !== null && (known.updates || known.weekly);

  function open() {
    if (!me.user) {
      setSignInLine("");
      startSignIn(`${window.location.pathname}${window.location.search}`).catch(() => setSignInLine(c.failed));
      return;
    }
    onOpen?.();
    setUpdates(known?.updates ?? false);
    setWeekly(known?.weekly ?? false);
    setLine(known ? "" : c.failed);
    dialog.current?.showModal();
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setLine("");
    try {
      const response = await fetch("/api/subscriptions", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ updates, weekly, language }),
      });
      if (response.ok) {
        setLine(c.saved);
        await refreshMe();
      } else {
        setLine(c.failed);
        if (response.status === 401) await refreshMe();
      }
    } catch {
      setLine(c.failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button ref={opener} type="button" className={variant === "menu" ? styles.item : styles.footerButton} onClick={open}>
        {active ? c.subscribed : c.subscribe}
      </button>
      {signInLine ? <span className={styles.note} role="status">{signInLine}</span> : null}
      {createPortal(
        <dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId} onClose={() => (variant === "menu" ? document.querySelector<HTMLElement>("[data-account-menu] summary") : opener.current)?.focus()}>
          <form className={styles.form} onSubmit={save}>
            <h3 id={titleId} className={styles.dialogTitle}>{c.subscribe}</h3>
            {known ? (<>
            <label className={styles.check}>
              <input type="checkbox" checked={updates} onChange={(event) => { setUpdates(event.target.checked); setLine(""); }} />
              <span>{c.updates}</span>
            </label>
            <label className={styles.check}>
              <input type="checkbox" checked={weekly} onChange={(event) => { setWeekly(event.target.checked); setLine(""); }} />
              <span>{c.weekly}</span>
            </label>
            </>) : null}
            <p className={styles.line} role="status" aria-live="polite">{line}</p>
            <div className={styles.actions}>
              <button type="button" className={styles.submitButton} onClick={() => dialog.current?.close()}>{c.cancel}</button>
              {known ? <button type="submit" className={`${styles.submitButton} ${styles.primary}`} disabled={busy}>{c.save}</button> : null}
            </div>
          </form>
        </dialog>,
        document.body,
      )}
    </>
  );
}
