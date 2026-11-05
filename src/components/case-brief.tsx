import type { Language } from "@/lib/i18n";
import { briefCopy, wordingNote, type BriefCase, type CaseBrief } from "@/lib/case-brief";
import c from "./case-brief.module.css";

/**
 * The top of an occupation page for a reader who has not seen the site before:
 * the plain sentence, then the cases that carry it. The full ledger sits below,
 * folded, for whoever wants to check the numbers.
 */
export function Verdict({ brief, language }: { brief: CaseBrief; language: Language }) {
  return (
    <section className={c.verdict}>
      <p className={c.sentence}>{brief.verdict}</p>
      <p className={c.caveat}>{briefCopy[language].caveat}</p>
    </section>
  );
}

export function Cases({ brief, language }: { brief: CaseBrief; language: Language }) {
  const t = briefCopy[language];
  return (
    <>
      {brief.using.length > 0 ? (
        <section className={c.section}>
          <h2 className={c.h2}>{t.useTitle}</h2>
          <p className={c.sub}>{t.useLead}{language === "zh-CN" ? ` ${wordingNote([...brief.using, ...brief.against], language)}` : ""}</p>
          <ul className={c.list}>
            {brief.using.map((row) => (
              <Card key={row.id} row={row} language={language} />
            ))}
          </ul>
        </section>
      ) : null}
      {brief.against.length > 0 ? (
        <section className={c.section}>
          <h2 className={c.h2}>{t.againstTitle}</h2>
          <p className={c.sub}>{t.againstLead}</p>
          <ul className={c.list}>
            {brief.against.map((row) => (
              <Card key={row.id} row={row} language={language} against />
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

function Card({ row, language, against }: { row: BriefCase; language: Language; against?: boolean }) {
  const t = briefCopy[language];
  return (
    <li className={`${c.card} ${against ? c.against : ""}`}>
      <p className={c.who}>
        <b>{row.actor}</b>
        {row.date ? <span>{row.date}</span> : null}
      </p>
      <p className={c.task} lang={row.task.lang}>{row.task.text}</p>
      {row.figures.length > 0 ? (
        <ul className={c.figures}>
          {row.figures.map((f) => (
            <li key={`${f.value}-${f.what.text}`}>
              <b lang={f.what.lang}>{f.value}</b>
              <span lang={f.what.lang}>{f.what.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {row.url ? (
        <p className={c.source}>
          <a href={row.url} rel="nofollow noopener" target="_blank">{t.source} ↗</a>
          {row.quote ? <q lang="en">{row.quote}</q> : null}
        </p>
      ) : null}
    </li>
  );
}
