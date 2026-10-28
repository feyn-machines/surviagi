import type { Metadata, Route } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { appEnabled } from "@/lib/app-config";
import { adminOrNull, appPool } from "@/lib/auth";
import { approvedEditorialArticles, publicEditorialArticle, publicPreviews } from "@/lib/editorial-store";
import { localizedPath } from "@/lib/i18n";
import { getLocale } from "@/lib/locale";
import type { EditorialQueueItem, QueueView } from "@/lib/editorial-queue";
import { EditorialBody } from "@/components/editorial-body";
import { EditorialReviewDesk } from "./review-desk";
import { EditorialBatchQueue } from "./batch-queue";
import s from "./review.module.css";

export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  const { language } = await getLocale();
  return { title: language === "en" ? "Editorial workspace" : "文章审核工作台", robots: { index: false, follow: false } };
}
type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
export default async function EditorialAdminPage({ searchParams }: Props) {
  const { language } = await getLocale();
  if (!appEnabled() || !(await adminOrNull(new Request("http://internal/", { headers: await headers() })))) notFound();
  const zh = language === "zh-CN";
  const params = await searchParams;
  const articleId = typeof params.articleId === "string" ? params.articleId : null;
  const versionValue = typeof params.version === "string" ? params.version : "";
  const version = /^v[1-9][0-9]{0,8}$/.test(versionValue) ? Number(versionValue.slice(1)) : null;
  const view: QueueView = params.view === "reviewed" || params.view === "published" ? params.view : "pending";
  let articles: EditorialQueueItem[] = [];
  let failed = false;
  try {
    const [previews, approved] = await Promise.all([publicPreviews("en"), approvedEditorialArticles("en")]);
    const published = new Set(approved.map((item) => `${item.articleId}:v${item.version}`));
    const summaries = [...new Map([...previews, ...approved].map((item) => [`${item.articleId}:v${item.version}`, item])).values()];
    articles = await Promise.all(summaries.map(async (item) => {
      const [en, cn] = await Promise.all([publicEditorialArticle(item.articleId, item.version, "en"), publicEditorialArticle(item.articleId, item.version, "zh-CN")]);
      if (!en || !cn) throw new Error("Bilingual version unavailable");
      return { articleId: item.articleId, version: item.version, title: en.title, chineseTitle: cn.title,
        summary: en.summary, chineseSummary: cn.summary, sourceCutoff: item.sourceCutoff,
        contentSha256: en.contentSha256, chineseHash: cn.contentSha256, enApproved: false, chineseApproved: false,
        enDecision: null, chineseDecision: null, published: published.has(`${item.articleId}:v${item.version}`) };
    }));
    if (articles.length) {
      const { rows } = await appPool().query<{ article_id: string; version: number; language: "en" | "zh-CN"; content_sha256: string; decision: string }>(
        `SELECT DISTINCT ON (article_id, version, language) article_id, version, language, content_sha256, decision
         FROM app.editorial_reviews WHERE actor_kind = 'human' AND article_id = ANY($1::text[])
         ORDER BY article_id, version, language, review_id DESC`, [[...new Set(articles.map((item) => item.articleId))]]);
      for (const item of articles) {
        for (const row of rows.filter((row) => row.article_id === item.articleId && row.version === item.version)) {
          if (row.language === "en" && row.content_sha256 === item.contentSha256) { item.enDecision = row.decision; item.enApproved = row.decision === "approve"; }
          if (row.language === "zh-CN" && row.content_sha256 === item.chineseHash) { item.chineseDecision = row.decision; item.chineseApproved = row.decision === "approve"; }
        }
      }
    }
  } catch (error) {
    console.error(`[admin editorial] workspace failed: ${error instanceof Error ? error.message : "unknown error"}`);
    failed = true;
  }
  const selected = articles.find((item) => item.articleId === articleId && item.version === version);
  const reviewLanguage = params.reviewLanguage === "en" || params.reviewLanguage === "zh-CN" ? params.reviewLanguage
    : selected && !selected.published && selected.enApproved && !selected.chineseApproved ? "zh-CN"
    : selected && !selected.published && selected.chineseApproved && !selected.enApproved ? "en" : language;
  const reading = selected ? await publicEditorialArticle(selected.articleId, selected.version, reviewLanguage) : null;
  return <div className={s.page}>
    <p className={s.back}><Link href={localizedPath(language, "/admin") as Route}>{zh ? "← 后台" : "← Admin"}</Link></p>
    <header className={s.workspaceHeader}>
      <p className={s.languageLabel}>{zh ? "编辑工作台" : "EDITORIAL WORKSPACE"}</p>
      <h1>{zh ? "文章审核" : "Article review"}</h1>
      <p>{zh ? "分别阅读并批准中英文稿。批准后移出待审核；两种语言都通过，自动进入正式文章栏目。" : "Read and approve each language. Approved drafts leave your queue; both approvals automatically publish the article."}</p>
    </header>
    {failed ? <div className={s.empty} role="alert"><h2>{zh ? "审核状态暂时无法加载" : "Review status could not be loaded"}</h2><p>{zh ? "请重试，避免依据旧状态操作。" : "Reload before making a decision."}</p><a className={s.open} href={localizedPath(language, "/admin/editorial")}>{zh ? "重新加载" : "Reload workspace"}</a></div>
      : selected ? <EditorialReviewDesk key={`${selected.articleId}:v${selected.version}:${reviewLanguage}`} articleId={selected.articleId} version={selected.version} language={language} reviewLanguage={reviewLanguage} queueItem={selected} returnView={view} reader={reading ? <EditorialBody markdown={reading.markdown} language={reviewLanguage} /> : null} />
      : <>
        {articleId ? <p role="status" className={s.notice}>{zh ? "该版本已不在当前工作台中。请从下方选择最新版本。" : "That version is no longer in this workspace. Choose a current version below."}</p> : null}
        <EditorialBatchQueue articles={articles} language={language} view={view} notice={typeof params.notice === "string" ? params.notice : ""} />
      </>}
  </div>;
}
