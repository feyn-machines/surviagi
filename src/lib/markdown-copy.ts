import { bilingual, type Language } from "@/lib/i18n";
import { absoluteUrl } from "@/lib/seo";
import { manifest } from "@/lib/snapshot";

/**
 * The Markdown copy of a data page (`<page>/raw.md`), for readers that are programs.
 *
 * It says what the page says, from the same release and the same copy, without
 * the layout: an engine that quotes it quotes the page. Each copy names its page
 * as canonical in a `Link` header, so a search engine keeps the page and not the
 * copy in its index, and a page that asks to stay out of the index asks the same
 * for its copy.
 */
const copy = bilingual({
  en: {
    page: "Page",
    generated: "Data generated {at}; method {method}; ontology {schema}.",
    status: "Machine-proposed: no person has reviewed these readings, and the method is not calibrated.",
    cite: "Cite the page address together with the generation time.",
    none: "No data release is loaded.",
  },
  "zh-CN": {
    page: "页面",
    generated: "数据生成于 {at}；方法 {method}；本体 {schema}。",
    status: "由机器提出：这些读数未经人工审核，方法也未经校准。",
    cite: "引用时请写页面地址和数据生成时间。",
    none: "当前没有加载数据版本。",
  },
});

/** The colon between a name and what is said of it, as each language writes it. */
export const colon = (language: Language) => (language === "zh-CN" ? "：" : ": ");

/** A link written for a program: the whole address, never one relative to the site. */
export function link(language: Language, text: string, path: string): string {
  return `[${text.replace(/([[\]])/g, "\\$1")}](${absoluteUrl(language, path)})`;
}

/** The answer to a request for `<path>/raw.md`: a title, the page's own lines, and where they came from. */
export function markdownResponse(
  language: Language,
  path: string,
  title: string,
  body: string[],
  options: { index?: boolean; canonical?: Language } = {},
): Response {
  const c = copy[language];
  const data = manifest();
  const page = absoluteUrl(language, path);
  // A page whose other-language address points at one version (an update) names that version, not itself.
  const canonical = absoluteUrl(options.canonical ?? language, path);
  const text = [
    `# ${title}`,
    "",
    ...body,
    "",
    "---",
    "",
    `${c.page}${colon(language)}${page}`,
    "",
    data
      ? c.generated
          .replace("{at}", data.generated_at)
          .replace("{method}", data.method_version)
          .replace("{schema}", data.schema_version)
      : c.none,
    c.status,
    c.cite,
    "",
  ].join("\n");
  const headers = new Headers({
    "Content-Type": "text/markdown; charset=utf-8",
    Link: `<${canonical}>; rel="canonical"`,
  });
  if (options.index === false) headers.set("X-Robots-Tag", "noindex");
  return new Response(text, { headers });
}
