"use client";

import { useEffect, useState } from "react";
import { useMe } from "@/components/account/me";
import { startSignIn } from "@/components/account/session";
import { bilingual, type Language } from "@/lib/i18n";
import s from "../topics.module.css";

/**
 * Readers' votes on one topic, by quarter. Kept apart from the evidence on the page: a vote is a
 * reader's view and decides nothing. The page itself is the same for everyone; the counts and the
 * reader's own vote are fetched here. Renders nothing when sign-in is off.
 */
const copy = bilingual({
  en: {
    title: "Reader vote",
    vote: "Vote",
    yours: "Your vote",
    withdraw: "Withdraw",
    votes: "votes",
    none: "No votes yet this quarter.",
    earlier: "Earlier quarters",
    failed: "Try again later",
  },
  "zh-CN": {
    title: "读者投票",
    vote: "投票",
    yours: "已投",
    withdraw: "撤回",
    votes: "票",
    none: "本季度还没有人投票。",
    earlier: "往季",
    failed: "请稍后再试",
  },
});

type Answer = { quarter: string; counts: Record<string, Record<string, number>>; mine: string | null };
type Option = { option_id: string; text: string };

export function TopicVote({ language, enabled, topicId, options }: { language: Language; enabled: boolean; topicId: string; options: Option[] }) {
  const { me } = useMe(enabled);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState("");
  const c = copy[language];
  const signedIn = Boolean(me.user);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    fetch(`/api/topics/votes?topic=${encodeURIComponent(topicId)}`, { cache: "no-store" })
      .then((response) => (response.ok ? (response.json() as Promise<Answer>) : null))
      .then((body) => { if (live && body) setAnswer(body); })
      .catch(() => undefined);
    return () => { live = false; };
    // Asked again when the reader signs in or out, so "your vote" follows the session.
  }, [enabled, topicId, signedIn]);

  if (!enabled || !answer) return null;

  async function choose(option: string | null) {
    if (busy) return;
    if (!signedIn) {
      startSignIn(`${window.location.pathname}${window.location.search}`).catch(() => setLine(c.failed));
      return;
    }
    setBusy(true);
    setLine("");
    try {
      const response = await fetch("/api/topics/votes", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic: topicId, option }),
      });
      if (response.ok) setAnswer((await response.json()) as Answer);
      else setLine(c.failed);
    } catch {
      setLine(c.failed);
    } finally {
      setBusy(false);
    }
  }

  const now = answer.counts[answer.quarter] ?? {};
  const total = Object.values(now).reduce((sum, n) => sum + n, 0);
  const most = Math.max(1, ...options.map((o) => now[o.option_id] ?? 0));
  const earlier = Object.keys(answer.counts).filter((quarter) => quarter !== answer.quarter).sort().reverse();

  return (
    <section className={s.vote} aria-label={c.title}>
      <div className={s.voteHead}>
        <h2 className={s.voteTitle}>{c.title}</h2>
        <span className={s.voteQuarter}>{answer.quarter} · {total} {c.votes}</span>
      </div>
      <ul className={s.voteList}>
        {options.map((option) => {
          const count = now[option.option_id] ?? 0;
          const mine = answer.mine === option.option_id;
          return (
            <li key={option.option_id} className={`${s.voteRow} ${mine ? s.mine : ""}`}>
              <button type="button" className={s.voteButton} disabled={busy} aria-pressed={mine}
                onClick={() => choose(mine ? null : option.option_id)}>
                {mine ? c.yours : c.vote}
              </button>
              <span className={s.voteText}>{option.text}</span>
              <span className={s.voteCount}>{count}</span>
              <span className={s.voteTrack}><i className={s.voteFill} style={{ width: `${(count / most) * 100}%` }} /></span>
            </li>
          );
        })}
      </ul>
      {total === 0 ? <p className={s.voteNote}>{c.none}</p> : null}
      {answer.mine ? <p className={s.voteNote}><button type="button" className={s.voteWithdraw} disabled={busy} onClick={() => choose(null)}>{c.withdraw}</button></p> : null}
      <p className={s.voteNote} role="status" aria-live="polite">{line}</p>
      {earlier.length > 0 ? (
        <table className={s.quarters}>
          <thead><tr><th>{c.earlier}</th>{options.map((o) => <th key={o.option_id}>{o.text}</th>)}</tr></thead>
          <tbody>
            {earlier.map((quarter) => (
              <tr key={quarter}>
                <td className={s.n}>{quarter}</td>
                {options.map((o) => <td key={o.option_id} className={s.n}>{answer.counts[quarter][o.option_id] ?? 0}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
