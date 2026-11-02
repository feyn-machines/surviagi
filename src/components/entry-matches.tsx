import type { Route } from "next";
import Link from "next/link";
import type { EntryMatch } from "@/lib/entry-search";
import { bilingual, localizedPath, type Language } from "@/lib/i18n";
import { plural } from "@/lib/plural";
import m from "./entry-matches.module.css";

const copy = bilingual({
  en: {
    title: "Closest to “{q}”",
    leadOccupations: "Found by each occupation's name and the other names it goes by. Open one for what the evidence says about it.",
    leadMarkets: "Found by each market's name and the kinds of work in it. Open one for what the evidence says about it.",
    via: "also called “{v}”",
    observations: "{n} {n|observation|observations}",
    noObservation: "no observation yet",
  },
  "zh-CN": {
    title: "与“{q}”最接近的",
    leadOccupations: "按职业的名称和它的其他叫法找到。打开一个，看证据怎么说。",
    leadMarkets: "按赛道的名称和其中各项工作找到。打开一个，看证据怎么说。",
    via: "也叫“{v}”",
    observations: "{n} 条观察",
    noObservation: "还没有观察",
  },
});

const fill = (text: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce((out, [key, value]) => out.replaceAll(`{${key}}`, String(value)), plural(text, values));

/**
 * The occupations or markets a query from the home page names (Issue #32), each linked to its evidence, above
 * the list the reader arrived at. Nothing when nothing matched: the list then keeps the query as its filter and says so.
 */
export function EntryMatches({ query, matches, kind, language }: { query: string; matches: EntryMatch[]; kind: "occupations" | "markets"; language: Language }) {
  const q = query.trim();
  if (!q || matches.length === 0) return null;
  const c = copy[language];
  return (
    <section className={m.matches} aria-labelledby="entry-matches">
      <h2 id="entry-matches" className={m.title}>{fill(c.title, { q })}</h2>
      <p className={m.lead}>{kind === "occupations" ? c.leadOccupations : c.leadMarkets}</p>
      <ul className={m.list}>
        {matches.map((match) => {
          const name = (language === "zh-CN" ? match.zh : match.en) ?? match.en;
          const path = `/${kind}/${match.slug}${match.observations ? "#evidence" : ""}`;
          return (
            <li key={match.id} className={m.item}>
              <span>
                <Link className={m.name} href={localizedPath(language, path) as Route}>{name}</Link>
                {match.via ? <span className={m.other}>{fill(c.via, { v: match.via })}</span> : null}
              </span>
              {match.observations !== null ? (
                <span className={m.count}>{match.observations ? fill(c.observations, { n: match.observations }) : c.noObservation}</span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
