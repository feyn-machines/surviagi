"use client";

import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { bilingual, type Language } from "@/lib/i18n";
import styles from "./account.module.css";
import { useMe } from "./me";
import { startSignIn } from "./session";

const copy = bilingual({
  en: {
    title: "Your API keys",
    off: "API keys are not available on this server.",
    signedOut: "Sign in with Google to make a key for your agent. Reading needs no key.",
    signIn: "Sign in",
    name: "Key name",
    placeholder: "WorkBuddy",
    create: "Make a key",
    once: "Copy this key now. It is shown only once; we keep only a hash of it.",
    copy: "Copy",
    copied: "Copied",
    none: "No keys yet.",
    active: "Active",
    revoked: "Revoked",
    made: "made",
    used: "last used",
    never: "never used",
    requests: "{q} questions · {a} accounts",
    revoke: "Revoke",
    confirm: "Revoke this key? Agents using it stop at once.",
    usage: "Today (UTC): questions {qt}/{qd}, pending {qp}/{qpl} · accounts {at}/{ad}, pending {ap}/{apl}",
    limit: "You have {n} active keys, the most allowed. Revoke one first.",
    failed: "Try again later",
  },
  "zh-CN": {
    title: "我的 API Key",
    off: "此服务器未开放 API Key。",
    signedOut: "用 Google 登录后即可为助手生成 Key。读取不需要 Key。",
    signIn: "登录",
    name: "Key 名称",
    placeholder: "WorkBuddy",
    create: "生成 Key",
    once: "请立即复制这个 Key。它只显示这一次，我们只保存它的哈希值。",
    copy: "复制",
    copied: "已复制",
    none: "还没有 Key。",
    active: "有效",
    revoked: "已撤销",
    made: "创建于",
    used: "最近使用",
    never: "尚未使用",
    requests: "问题 {q} 个 · 账号 {a} 个",
    revoke: "撤销",
    confirm: "确定撤销这个 Key？使用它的助手会立即停止。",
    usage: "今日（UTC）：问题 {qt}/{qd}，待审核 {qp}/{qpl} · 账号 {at}/{ad}，待审核 {ap}/{apl}",
    limit: "已有 {n} 个有效 Key，达到上限。请先撤销一个。",
    failed: "请稍后再试",
  },
});

type Key = { id: string; name: string; prefix: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null; questions: number; accounts: number };
type Quota = { pending: number; pendingLimit: number; today: number; dailyLimit: number };
type List = { keys: Key[]; usage: { questions: Quota; accounts: Quota; resetsAt: string }; maxActive: number };

const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));
const day = (value: string | null) => (value ? value.slice(0, 10) : "");

async function fetchKeys(): Promise<List | null> {
  try {
    const response = await fetch("/api/keys", { cache: "no-store" });
    return response.ok ? ((await response.json()) as List) : null;
  } catch {
    return null;
  }
}

/** Make, list and revoke the signed-in reader's API keys. Fetched by the browser, so the page is the same for everyone. */
export function ApiKeys({ language, enabled }: { language: Language; enabled: boolean }) {
  const { state, me } = useMe(enabled);
  const c = copy[language];
  const nameId = useId();
  const [list, setList] = useState<List | null>(null);
  const [name, setName] = useState("");
  const [secret, setSecret] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState("");
  const signedIn = enabled && state === "ready" && me.enabled && me.user !== null;

  const load = useCallback(async () => {
    const next = await fetchKeys();
    if (next) setList(next);
    else setLine(copy[language].failed);
  }, [language]);

  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    fetchKeys().then((next) => {
      if (!live) return;
      if (next) setList(next);
      else setLine(copy[language].failed);
    });
    return () => {
      live = false;
    };
  }, [signedIn, language]);

  async function create() {
    setBusy(true);
    setLine("");
    setSecret("");
    setCopied(false);
    try {
      const response = await fetch("/api/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim() || c.placeholder }),
      });
      const body = (await response.json().catch(() => ({}))) as { result?: string; secret?: string; limit?: number };
      if (response.ok && body.result === "created" && body.secret) {
        setSecret(body.secret);
        setName("");
        await load();
      } else if (response.ok && body.result === "limit") {
        setLine(fill(c.limit, { n: body.limit ?? "" }));
      } else {
        setLine(c.failed);
      }
    } catch {
      setLine(c.failed);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    if (!window.confirm(c.confirm)) return;
    setBusy(true);
    setLine("");
    try {
      const response = await fetch("/api/keys/revoke", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
      if (!response.ok) setLine(c.failed);
      await load();
    } catch {
      setLine(c.failed);
    } finally {
      setBusy(false);
    }
  }

  let body: ReactNode;
  if (!enabled) body = <p className={styles.line}>{c.off}</p>;
  else if (state === "loading") body = null;
  else if (!me.enabled) body = <p className={styles.line}>{c.off}</p>;
  else if (!me.user) {
    body = (
      <>
        <p className={styles.line}>{c.signedOut}</p>
        <button type="button" className={styles.submitButton} onClick={() => startSignIn(`${window.location.pathname}#keys`).catch(() => setLine(c.failed))}>
          {c.signIn}
        </button>
      </>
    );
  } else {
    const u = list?.usage;
    body = (
      <>
        <form
          className={styles.keyForm}
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <label className={styles.field} htmlFor={nameId}>
            {c.name}
            <input id={nameId} className={styles.input} value={name} maxLength={60} placeholder={c.placeholder} onChange={(event) => setName(event.target.value)} />
          </label>
          <button type="submit" className={`${styles.submitButton} ${styles.primary}`} disabled={busy}>{c.create}</button>
        </form>
        {secret ? (
          <div className={styles.secret} role="status">
            <p className={styles.line}>{c.once}</p>
            <code className={styles.secretValue}>{secret}</code>
            <button
              type="button"
              className={styles.submitButton}
              onClick={() => navigator.clipboard?.writeText(secret).then(() => setCopied(true), () => undefined)}
            >
              {copied ? c.copied : c.copy}
            </button>
          </div>
        ) : null}
        {u ? (
          <p className={styles.mineMeta}>
            {fill(c.usage, {
              qt: u.questions.today, qd: u.questions.dailyLimit, qp: u.questions.pending, qpl: u.questions.pendingLimit,
              at: u.accounts.today, ad: u.accounts.dailyLimit, ap: u.accounts.pending, apl: u.accounts.pendingLimit,
            })}
          </p>
        ) : null}
        {list && list.keys.length === 0 ? <p className={styles.line}>{c.none}</p> : null}
        {list && list.keys.length > 0 ? (
          <ul className={styles.mineList}>
            {list.keys.map((key) => (
              <li key={key.id} className={styles.mineRow}>
                <span className={styles.mineHandle}>{key.name}</span>
                <code className={styles.mineMeta}>{key.prefix}…</code>
                <span className={styles.mineStatus} data-status={key.revokedAt ? "rejected" : "approved"}>{key.revokedAt ? c.revoked : c.active}</span>
                <span className={styles.mineMeta}>{c.made} {day(key.createdAt)}</span>
                <span className={styles.mineMeta}>{key.lastUsedAt ? `${c.used} ${day(key.lastUsedAt)}` : c.never}</span>
                <span className={styles.mineMeta}>{fill(c.requests, { q: key.questions, a: key.accounts })}</span>
                {key.revokedAt ? null : (
                  <button type="button" className={styles.submitButton} disabled={busy} onClick={() => void revoke(key.id)}>{c.revoke}</button>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </>
    );
  }

  return (
    <section id="keys" className={styles.mine} aria-label={c.title}>
      <h2 className={styles.mineTitle}>{c.title}</h2>
      {body}
      {line ? <p className={styles.line} role="status">{line}</p> : null}
    </section>
  );
}
