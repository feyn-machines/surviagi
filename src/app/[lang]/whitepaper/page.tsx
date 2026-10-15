import type { Metadata } from "next";
import { bilingual } from "@/lib/i18n";
import { getLocale } from "@/lib/locale";
import { articleLd, pageMetadata } from "@/lib/seo";
import { JsonLd } from "@/components/json-ld";
import { whitepaperBlocks, whitepaperExists, type Block, type Inline } from "@/lib/whitepaper";
import { Head, blueprint as b } from "@/components/blueprint";
import { WhitepaperToc } from "./whitepaper-toc";
import s from "./whitepaper.module.css";

/**
 * The page frame only: the document itself is published in both languages.
 *
 * `/about` was deleted and the method explanation moved here, so this is now the
 * only route that says how the numbers are made. It has to carry that: a ruled
 * canvas, the design system's type scale, a measure a person can actually read
 * a page of, and an index that says where in the document the reader is.
 *
 * docs/whitepaper.md is not edited from here. Nothing below changes a word of
 * it; the section ids are derived from the order of its own headings.
 */
/**
 * The whitepaper reads no data release. It is built from docs/whitepaper.md, which
 * the server does not carry, so it is the one page rendered at build time. That
 * bakes the layout's sign-in menu in as well: `site_release.py` checks after the
 * build that the static HTML has it (the build machine needs the five sign-in
 * settings). Every other page under `[lang]` sets `dynamic = "force-dynamic"`
 * itself, because a layout's setting would override these.
 */
export const dynamic = "force-static";

const copy = bilingual({
  en: {
    metaTitle: "Whitepaper",
    metaDescription:
      "SurviAGI is an initiative to make progress toward AI independently completing major work more transparent and credible.",
    missing: "The whitepaper file is not present in this build.",
    eyebrow: "PUBLIC WHITEPAPER",
    contents: "Contents",
    sections: "{n} sections",
  },
  "zh-CN": {
    metaTitle: "白皮书",
    metaDescription: "SurviAGI 是一项倡议，让 AI 独立完成主要工作的进展变得更透明、更可信。",
    missing: "本次构建中没有白皮书文件。",
    eyebrow: "公开白皮书",
    contents: "目录",
    sections: "{n} 节",
  },
});

export async function generateMetadata(): Promise<Metadata> {
  const { language } = await getLocale();
  const c = copy[language];
  return pageMetadata({ language, path: "/whitepaper", title: c.metaTitle, description: c.metaDescription });
}

function renderInline(inline: Inline[], keyPrefix: string) {
  return inline.map((part, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (part.kind) {
      case "strong":
        return <strong key={key}>{part.text}</strong>;
      case "em":
        return <em key={key}>{part.text}</em>;
      case "break":
        return <br key={key} />;
      case "link":
        return (
          <a
            key={key}
            href={part.href}
            {...(part.href.startsWith("http")
              ? { target: "_blank", rel: "noreferrer noopener" }
              : {})}
          >
            {part.text}
          </a>
        );
      default:
        return <span key={key}>{part.text}</span>;
    }
  });
}

/** The plain text of a heading, for the index. */
function headingText(inline: Inline[]): string {
  return inline.map((part) => ("text" in part ? part.text : "")).join("");
}

function renderBlock(block: Block, i: number, sectionId: string | undefined) {
  const key = `b${i}`;
  switch (block.kind) {
    case "rule":
      return <hr key={key} className={s.rule} />;
    // The whitepaper is parsed without figures; the case only closes the type.
    case "image":
      return null;
    // The whitepaper is parsed without bullet lists; the case only closes the type.
    case "bullets":
    case "list":
      return (
        <ol key={key} className={s.list}>
          {block.items.map((item, j) => (
            <li key={`${key}-${j}`}>{renderInline(item, `${key}-${j}`)}</li>
          ))}
        </ol>
      );
    case "heading": {
      // A bare anchor keeps its id so the document's own footnote links resolve.
      if (block.id && !block.inline.length) return <span key={key} id={block.id} />;
      const Tag = (["h1", "h2", "h3"] as const)[block.level - 1];
      return (
        <Tag key={key} id={sectionId ?? block.id} className={s[`h${block.level}`]}>
          {renderInline(block.inline, key)}
        </Tag>
      );
    }
    default:
      return (
        <p key={key} className={s.paragraph}>
          {renderInline(block.inline, key)}
        </p>
      );
  }
}

export default async function Whitepaper() {
  const { language } = await getLocale();
  const c = copy[language];
  const blocks = whitepaperBlocks(language);

  if (!whitepaperExists || !blocks.length) {
    return (
      <div className={s.page}>
        <p className={s.missing}>{c.missing}</p>
      </div>
    );
  }

  // The document's sections are its level-3 headings. They carry no anchor of
  // their own in the Markdown, so the id is their position: stable as long as
  // the order is, and derived rather than written into the document.
  const sectionIds = new Map<number, string>();
  const contents: { id: string; text: string }[] = [];
  blocks.forEach((block, i) => {
    if (block.kind !== "heading" || block.level !== 3 || !block.inline.length) return;
    const id = `section-${contents.length + 1}`;
    sectionIds.set(i, id);
    contents.push({ id, text: headingText(block.inline) });
  });

  return (
    <div className={s.page}>
      <JsonLd data={articleLd(language, { headline: c.metaTitle, description: c.metaDescription, path: "/whitepaper" })} />
      <header className={`${s.masthead} ${b.canvas}`}>
        <Head
          label={c.eyebrow}
          tag={c.sections.replace("{n}", String(contents.length))}
          tone="signal"
        />
      </header>

      <div className={s.layout}>
        <WhitepaperToc label={c.contents} items={contents} />
        {/* The document carries its own headings and version line; the page
            frames it rather than restating it. SurviAGI is an initiative, not
            a platform, and this page must not describe it as one. */}
        <article className={s.doc}>
          {blocks.map((block, i) => renderBlock(block, i, sectionIds.get(i)))}
        </article>
      </div>
    </div>
  );
}
