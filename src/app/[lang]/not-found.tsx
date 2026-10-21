import Link from "next/link";
import { bilingual } from "@/lib/i18n";
import { getLocale } from "@/lib/locale";
import { href } from "@/lib/routes";

const copy = bilingual({
  en: {
    eyebrow: "404 · NO SUCH PAGE",
    title: "Page not found.",
    lead: "There is no page at this address — it may have been renamed, or the link that brought you here may be wrong.",
    home: "Home →",
    occupations: "Occupations →",
  },
  "zh-CN": {
    eyebrow: "404 · 没有这个页面",
    title: "页面不存在。",
    lead: "本站没有这个地址对应的页面：它可能已经改名，也可能是把你带到这里的链接有误。",
    home: "回到首页 →",
    occupations: "职业 →",
  },
});

/**
 * The 404, in both languages. A Server Component so `getLocale()` can read the
 * reader's language the same way every other page does: from the `[lang]` path
 * segment.
 *
 * The root layout still renders around this, so the header, the language switch
 * and the footer stay available: a wrong address should not strand the reader.
 */
export default async function NotFound() {
  const { language } = await getLocale();
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
        <Link className="text-link" href={href(language, "/")}>
          {c.home}
        </Link>
        <Link className="text-link" href={href(language, "/occupations")}>
          {c.occupations}
        </Link>
      </div>
    </section>
  );
}
