"use client";

import { useSyncExternalStore } from "react";
import { DEFAULT_LANGUAGE, bilingual, normalizeLanguage, type Language } from "@/lib/i18n";
import styles from "./error.module.css";

const copy = bilingual({
  en: {
    eyebrow: "ERROR · PAGE NOT RENDERED",
    title: "Something went wrong.",
    lead: "This page failed while it was being built, so nothing on it can be trusted to be complete — the details stay in the server log rather than on the page.",
    retry: "Try again",
    referenceCode: "Reference code",
  },
  "zh-CN": {
    eyebrow: "出错 · 页面未能渲染",
    title: "出了点问题。",
    lead: "这个页面在生成过程中失败了，因此页面上的内容不能当作完整的结果——具体信息留在服务器日志里，不显示在这里。",
    retry: "重试",
    referenceCode: "参考编号",
  },
});

/**
 * `<html lang>` is written once by the root layout and only changes on a full
 * page load, so there is nothing to subscribe to; the unsubscribe is a no-op.
 */
const subscribe = () => () => {};

/** The language the layout resolved, read back off the document. */
const documentLanguage = (): Language =>
  normalizeLanguage(document.documentElement.lang) ?? DEFAULT_LANGUAGE;

/** No document during a server render: English, the documented default. */
const serverLanguage = (): Language => DEFAULT_LANGUAGE;

/**
 * The route error boundary, in both languages.
 *
 * An error boundary must be a Client Component, so the async `getLocale()` —
 * which reads the `[lang]` segment on the server — cannot be called here. The
 * root layout sits outside this boundary and still renders, so the language it
 * resolved is already on `<html lang>` and is read back from there.
 * Where that is not readable — the server render — English is used, which is
 * the site's default when nobody has chosen a language. `useSyncExternalStore`
 * rather than an effect: reading a value React does not own is what it is for,
 * and setting state from an effect is a lint error in this project.
 *
 * The reader is never shown `error.message`: a message forwarded from a Server
 * Component can carry internals. Only `error.digest`, the hash that matches the
 * server log, is printed, and only when one exists.
 */
export default function Error({
  error,
  reset,
  retry,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  /**
   * Next 16 passes both. `reset()` only clears the boundary's state, which
   * re-renders the same failed server output; `retry()` refreshes the route
   * first, so it is the one the button uses when it is available.
   */
  retry?: () => void;
}) {
  const language = useSyncExternalStore(subscribe, documentLanguage, serverLanguage);
  const c = copy[language];

  return (
    <section className="inner-page">
      <p className="eyebrow">
        <span className="dot" />
        {c.eyebrow}
      </p>
      <h1>{c.title}</h1>
      <p className="lead">
        {c.lead}
      </p>
      <div className="actions">
        <button className={styles.retry} type="button" onClick={() => (retry ?? reset)()}>
          {c.retry}
        </button>
      </div>
      {error.digest ? (
        <p className={styles.digest}>
          {c.referenceCode}
          <span className={styles.digestCode}>{error.digest}</span>
        </p>
      ) : null}
    </section>
  );
}
