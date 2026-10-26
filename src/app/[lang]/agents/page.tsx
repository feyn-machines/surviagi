import type { Metadata } from "next";
import { ApiKeys } from "@/components/account/api-keys";
import { appEnabled } from "@/lib/app-config";
import { getLocale } from "@/lib/locale";
import { pageMetadata } from "@/lib/seo";
import legal from "../legal.module.css";
import { agentsCopy } from "./copy";
import s from "./agents.module.css";

/** The key list is fetched by the browser; the page itself is the same for every visitor. Per request, like the legal pages, for the sign-in settings. */
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const { language } = await getLocale();
  const copy = agentsCopy[language];
  return pageMetadata({ language, path: "/agents", title: copy.title, description: copy.description });
}

export default async function AgentsPage() {
  const { language } = await getLocale();
  const copy = agentsCopy[language];
  return (
    <div className={legal.page}>
      <article className={legal.doc}>
        <h1 className={legal.title}>{copy.title}</h1>
        <p className={s.lead}>{copy.lead}</p>
        {copy.sections.map((section) => (
          <section key={section.heading} id={section.id}>
            <h2 className={legal.heading}>{section.heading}</h2>
            {section.body.map((text, i) => (
              <p key={i} className={legal.paragraph}>{text}</p>
            ))}
            {section.code ? (
              <pre className={s.code}><code>{section.code.join("\n")}</code></pre>
            ) : null}
          </section>
        ))}
        <ApiKeys language={language} enabled={appEnabled()} />
      </article>
    </div>
  );
}
