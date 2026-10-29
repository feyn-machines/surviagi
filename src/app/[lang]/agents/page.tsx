import type { Metadata } from "next";
import { ApiKeys } from "@/components/account/api-keys";
import { appEnabled } from "@/lib/app-config";
import { getLocale } from "@/lib/locale";
import { pageMetadata } from "@/lib/seo";
import legal from "../legal.module.css";
import { agentsCopy, installCopy } from "./copy";
import s from "./agents.module.css";

// Package downloads are language-neutral API responses, not localized pages.
const downloads = {
  skill: "/api/agent/packages/surviagi-http.zip",
  search: "/api/agent/packages/surviagi.zip",
  submit: "/api/agent/packages/surviagi-submit.zip",
};

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
  const install = installCopy[language];
  return (
    <div className={legal.page}>
      <article className={legal.doc}>
        <h1 className={legal.title}>{copy.title}</h1>
        <p className={s.lead}>{copy.lead}</p>
        <section id="install" className={s.install}>
          <h2 className={legal.heading}>{install.heading}</h2>
          <p className={legal.paragraph}>{install.intro}</p>
          <div className={s.actions}>
            <a className={s.download} href={downloads.skill} download>{install.download}</a>
            <a href="https://github.com/feyn-machines/surviagi/tree/main/integrations/workbuddy/skill-http/surviagi-http">{install.source}</a>
          </div>
          <ol className={s.steps}>{install.steps.map((step) => <li key={step}>{step}</li>)}</ol>
          <p className={legal.paragraph}>{install.promptLabel}</p>
          <pre className={`${s.code} ${s.prompt}`}><code>{install.prompt}</code></pre>
          <p className={legal.paragraph}>{install.keys}</p>
          <details>
            <summary>{install.workbuddy}</summary>
            <p className={legal.paragraph}>{install.workbuddyBody}</p>
            <div className={s.actions}>
              <a href={downloads.search} download>{install.readConnector}</a>
              <a href={downloads.submit} download>{install.submitConnector}</a>
            </div>
          </details>
        </section>
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
