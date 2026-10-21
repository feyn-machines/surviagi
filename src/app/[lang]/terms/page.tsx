import type { Metadata } from "next";
import { bilingual } from "@/lib/i18n";
import { legalCopy } from "@/lib/legal";
import { getLocale } from "@/lib/locale";
import { pageMetadata } from "@/lib/seo";
import { LegalDoc } from "../legal-doc";

/** Nothing is read here, but the layout shows the sign-in menu only when the settings are present: render per request so a build without them cannot bake that in. */
export const dynamic = "force-dynamic";

const meta = bilingual({
  en: { description: "The terms for using SurviAGI: the data is machine-proposed and unreviewed, and what to submit." },
  "zh-CN": { description: "使用 SurviAGI 的条款：数据由机器提出、未经审核，以及可以提交什么。" },
});

export async function generateMetadata(): Promise<Metadata> {
  const { language } = await getLocale();
  return pageMetadata({
    language,
    path: "/terms",
    title: legalCopy[language].terms.title,
    description: meta[language].description,
  });
}

export default async function TermsPage() {
  const { language } = await getLocale();
  return <LegalDoc doc={legalCopy[language].terms} language={language} />;
}
