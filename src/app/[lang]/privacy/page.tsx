import type { Metadata } from "next";
import { bilingual } from "@/lib/i18n";
import { legalCopy } from "@/lib/legal";
import { getLocale } from "@/lib/locale";
import { pageMetadata } from "@/lib/seo";
import { LegalDoc } from "../legal-doc";

/** Nothing is read here, but the layout shows the sign-in menu only when the settings are present: render per request so a build without them cannot bake that in. */
export const dynamic = "force-dynamic";

const meta = bilingual({
  en: { description: "What SurviAGI stores about people who sign in, submit an account or subscribe, and how to have it deleted." },
  "zh-CN": { description: "SurviAGI 对登录、提交帐号或订阅的人存储哪些信息，以及如何删除。" },
});

export async function generateMetadata(): Promise<Metadata> {
  const { language } = await getLocale();
  return pageMetadata({
    language,
    path: "/privacy",
    title: legalCopy[language].privacy.title,
    description: meta[language].description,
  });
}

export default async function PrivacyPage() {
  const { language } = await getLocale();
  return <LegalDoc doc={legalCopy[language].privacy} language={language} />;
}
