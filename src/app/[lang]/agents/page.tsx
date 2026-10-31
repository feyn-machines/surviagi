import type { Metadata } from "next";
import { ApiKeys } from "@/components/account/api-keys";
import { appEnabled } from "@/lib/app-config";
import { getLocale } from "@/lib/locale";
import { pageMetadata } from "@/lib/seo";
import { agentsCopy, agentsUi, installCopy } from "./copy";
import { AgentsToc } from "./agents-toc";
import { CodeBlock } from "./code-block";
import s from "./agents.module.css";

// Package downloads are language-neutral API responses, not localized pages.
const downloads = {
  skill: "/api/agent/packages/surviagi-http.zip",
  search: "/api/agent/packages/surviagi.zip",
  submit: "/api/agent/packages/surviagi-submit.zip",
};

const SOURCE = "https://github.com/feyn-machines/surviagi/tree/main/integrations/workbuddy/skill-http/surviagi-http";

/** The key list is fetched by the browser; the page itself is the same for every visitor. Per request, like the legal pages, for the sign-in settings. */
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const { language } = await getLocale();
  const copy = agentsCopy[language];
  return pageMetadata({ language, path: "/agents", title: copy.title, description: copy.description });
}

function SectionHead({ n, title }: { n: string; title: string }) {
  return (
    <header className={s.sectionHead}>
      <span className={s.sectionNumber} aria-hidden="true">{n}</span>
      <h2 className={s.h2}>{title}</h2>
    </header>
  );
}

export default async function AgentsPage() {
  const { language } = await getLocale();
  const copy = agentsCopy[language];
  const install = installCopy[language];
  const ui = agentsUi[language];
  const enabled = appEnabled();

  // The public title is also the heading, and this site writes it as
  // "proposition | MCP, API and Skill". Splitting it keeps the keywords in the
  // h1 while the promise, not the list of protocols, carries the display size.
  const [titleMain, titleTail] = copy.title.split(/\s*[｜|]\s*/, 2);
  const sections = copy.sections.map((section, i) => ({ ...section, id: section.id ?? `section-${i + 1}` }));
  const toc = [
    { id: "install", label: install.heading },
    ...sections.map((section) => ({ id: section.id, label: section.heading })),
    { id: "keys", label: ui.tocKeys },
  ];

  return (
    <div className={s.page}>
      <header className={s.hero}>
        <div className={s.heroCopy}>
          <p className={s.eyebrow}>{ui.eyebrow}</p>
          <h1 className={s.title}>
            <span className={s.titleMain}>{titleMain}</span>{" "}
            {titleTail ? <span className={s.titleTail}>{titleTail}</span> : null}
          </h1>
          <p className={s.lead}>{copy.lead}</p>
          <div className={s.heroActions}>
            <a className={s.primary} href={downloads.skill} download>
              {install.download}
              <span className={s.buttonMark} aria-hidden="true">↓</span>
            </a>
            <a className={s.quietLink} href="#endpoints">
              {ui.endpointsLink}
              <span className={s.linkMark} aria-hidden="true">→</span>
            </a>
            <a className={s.quietLink} href={SOURCE} rel="noopener">
              {install.source}
              <span className={s.linkMark} aria-hidden="true">↗</span>
            </a>
          </div>
        </div>
        <aside className={s.panel} aria-label={ui.panelAria}>
          <p className={s.status}>
            <span className={s.statusDot} aria-hidden="true" />
            {ui.freeRead}
          </p>
          <div className={s.panelBlock}>
            <p className={s.panelLabel}>MCP · Streamable HTTP</p>
            <p className={s.endpoint}>https://surviagi.com/api/mcp</p>
          </div>
          <dl className={s.panelList}>
            <div>
              <dt>{ui.readLabel}</dt>
              <dd>{ui.readValue}</dd>
            </div>
            <div>
              <dt>{ui.writeLabel}</dt>
              <dd>{ui.writeValue}</dd>
            </div>
          </dl>
          <p className={s.panelNote}>{ui.writeNote}</p>
        </aside>
      </header>

      <div className={s.layout}>
        <AgentsToc label={ui.tocLabel} items={toc} />
        <article className={s.doc}>
          <section id="install" className={s.section}>
            <SectionHead n="01" title={install.heading} />
            <p className={s.paragraph}>{install.intro}</p>
            <div className={s.installBar}>
              <div className={s.installActions}>
                <a className={s.primary} href={downloads.skill} download>
                  {install.download}
                  <span className={s.buttonMark} aria-hidden="true">↓</span>
                </a>
                <a className={s.quietLink} href={SOURCE} rel="noopener">
                  {install.source}
                  <span className={s.linkMark} aria-hidden="true">↗</span>
                </a>
              </div>
              <p className={s.installMeta}>Python 3 · SKILL.md · scripts/surviagi.py</p>
            </div>
            <ol className={s.steps}>
              {install.steps.map((step) => <li key={step}>{step}</li>)}
            </ol>
            <p className={s.paragraph}>{install.promptLabel}</p>
            <CodeBlock language={language} label={ui.promptCodeLabel} text={install.prompt} wrap />
            <p className={s.note}>{install.keys}</p>
            <details className={s.disclosure}>
              <summary>{install.workbuddy}</summary>
              <div className={s.disclosureBody}>
                <p className={s.paragraph}>{install.workbuddyBody}</p>
                <div className={s.installActions}>
                  <a className={s.secondary} href={downloads.search} download>{install.readConnector}</a>
                  <a className={s.secondary} href={downloads.submit} download>{install.submitConnector}</a>
                </div>
              </div>
            </details>
          </section>

          {sections.map((section, i) => (
            <section key={section.id} id={section.id} className={s.section}>
              <SectionHead n={String(i + 2).padStart(2, "0")} title={section.heading} />
              {section.body.map((text, j) => <p key={j} className={s.paragraph}>{text}</p>)}
              {section.code ? (
                <CodeBlock
                  language={language}
                  label={section.id === "endpoints" ? ui.endpointsCodeLabel : ui.configCodeLabel}
                  text={section.code.join("\n")}
                />
              ) : null}
            </section>
          ))}

          <div className={s.keysPanel}>
            <span className={s.keysNumber} aria-hidden="true">09</span>
            <ApiKeys language={language} enabled={enabled} />
          </div>
        </article>
      </div>
    </div>
  );
}
