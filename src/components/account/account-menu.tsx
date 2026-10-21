"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { bilingual, type Language } from "@/lib/i18n";
import { href } from "@/lib/routes";
import styles from "./account.module.css";
import { useMe } from "./me";
import { signOut, startSignIn, takeSignInFailure } from "./session";
import { Subscribe } from "./subscribe";

const copy = bilingual({
  en: { signIn: "Sign in", signOut: "Sign out", account: "Account", admin: "Admin", failed: "Sign-in failed", retry: "Try again later" },
  "zh-CN": { signIn: "登录", signOut: "退出", account: "账号", admin: "后台", failed: "登录失败", retry: "请稍后再试" },
});

function initials(name: string) {
  return (name.trim().slice(0, 1) || "?").toUpperCase();
}

export function AccountMenu({ language, enabled }: { language: Language; enabled: boolean }) {
  const { state, me } = useMe(enabled);
  const menu = useRef<HTMLDetailsElement>(null);
  const [note, setNote] = useState("");
  const c = copy[language];

  // A failed Google sign-in comes back as ?signin=failed: say so once and take the marker out of the address.
  useEffect(() => {
    // Not cleaned up on purpose: a development double-run of this effect must not lose the marker it already took.
    if (enabled && takeSignInFailure()) window.setTimeout(() => setNote(copy[language].failed), 0);
  }, [enabled, language]);

  useEffect(() => {
    const close = () => menu.current?.removeAttribute("open");
    const onPointer = (event: PointerEvent) => {
      if (menu.current && !menu.current.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  if (!enabled) return null;
  if (state === "loading") return <div className={styles.root} data-account-menu aria-hidden="true"><span className={styles.placeholder} /></div>;
  if (!me.enabled) return null;

  if (!me.user) {
    return (
      <div className={styles.root} data-account-menu>
        {note ? <span className={styles.note} role="status">{note}</span> : null}
        <button
          type="button"
          className={styles.signIn}
          onClick={() => {
            setNote("");
            startSignIn(window.location.pathname + window.location.search).catch(() => setNote(c.retry));
          }}
        >
          {c.signIn}
        </button>
      </div>
    );
  }

  const { user } = me;
  return (
    <div className={styles.root} data-account-menu>
      <details ref={menu} className={styles.details}>
        <summary className={styles.summary} aria-label={`${c.account}: ${user.name}`}>
          {user.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className={styles.avatar} src={user.image} alt={user.name} width={28} height={28} referrerPolicy="no-referrer" />
          ) : (
            <span className={styles.avatar} aria-hidden="true">{initials(user.name)}</span>
          )}
        </summary>
        <div className={styles.panel}>
          <p className={styles.name}>{user.name}</p>
          <Subscribe language={language} enabled={enabled} variant="menu" onOpen={() => menu.current?.removeAttribute("open")} />
          {me.admin ? (
            <Link className={styles.item} href={href(language, "/admin")} onClick={() => menu.current?.removeAttribute("open")}>
              {c.admin}
            </Link>
          ) : null}
          <button
            type="button"
            className={styles.item}
            onClick={() => void signOut()}
          >
            {c.signOut}
          </button>
        </div>
      </details>
    </div>
  );
}
