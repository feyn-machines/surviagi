"use client";

import type { OwnerKind } from "@/lib/handles";
import { bilingual, type Language } from "@/lib/i18n";
import styles from "./account.module.css";
import { useMe } from "./me";
import { statusCopy } from "./submit-account";
import { useSubmissions } from "./submissions";

/** UTC date, `2026-09-21`. Local copy: data-page pulls in server-only data code. */
const isoDate = (value: string) => value.slice(0, 10);

const copy = bilingual({
  en: { title: "My submissions", person: "Person", organization: "Company" },
  "zh-CN": { title: "我的提交", person: "人物", organization: "公司" },
});

export function MySubmissions({ language, enabled }: { language: Language; enabled: boolean }) {
  const { state, me } = useMe(enabled);
  const { list } = useSubmissions(enabled && state === "ready" && me.enabled && me.user !== null);
  const c = copy[language];
  if (!enabled || list.length === 0) return null;
  return (
    <section className={styles.mine} aria-label={c.title}>
      <h2 className={styles.mineTitle}>{c.title}</h2>
      <ul className={styles.mineList}>
        {list.map((item) => (
          <li key={item.id} className={styles.mineRow}>
            <a href={`https://x.com/${item.handle}`} target="_blank" rel="noreferrer" className={styles.mineHandle}>@{item.handle}</a>
            <span className={styles.mineMeta}>{c[item.ownerKind as OwnerKind]}</span>
            <span className={styles.mineStatus} data-status={item.status}>{statusCopy[language][item.status]}</span>
            <span className={styles.mineMeta}>{isoDate(item.createdAt)}</span>
            {item.status === "rejected" && item.reason ? <span className={styles.mineReason}>{item.reason}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
