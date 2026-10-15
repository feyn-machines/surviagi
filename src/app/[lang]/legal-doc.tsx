import { DISCORD_URL, X_HANDLE, X_URL } from "@/lib/seo";
import type { Doc } from "@/lib/legal";
import type { Language } from "@/lib/i18n";
import s from "./legal.module.css";

const UPDATED: Record<Language, string> = { en: "Updated", "zh-CN": "更新于" };

/** A paragraph with `{x}` and `{discord}` replaced by the project's own links. */
function paragraph(text: string, key: string) {
  return text.split(/(\{x\}|\{discord\})/).map((part, i) => {
    if (part === "{x}") {
      return <a key={`${key}-${i}`} href={X_URL} rel="noopener">{X_HANDLE}</a>;
    }
    if (part === "{discord}") {
      return <a key={`${key}-${i}`} href={DISCORD_URL} rel="noopener">Discord</a>;
    }
    return part;
  });
}

export function LegalDoc({ doc, language }: { doc: Doc; language: Language }) {
  return (
    <div className={s.page}>
      <article className={s.doc}>
        <h1 className={s.title}>{doc.title}</h1>
        <p className={s.updated}>{UPDATED[language]} {doc.updated}</p>
        {doc.sections.map((section, i) => (
          <section key={section.heading}>
            <h2 className={s.heading}>{section.heading}</h2>
            {section.body.map((text, j) => (
              <p key={j} className={s.paragraph}>{paragraph(text, `${i}-${j}`)}</p>
            ))}
          </section>
        ))}
      </article>
    </div>
  );
}
