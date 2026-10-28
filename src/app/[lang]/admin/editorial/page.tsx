import type { Metadata } from "next";
import type { Route } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/data-page";
import { appEnabled } from "@/lib/app-config";
import { adminOrNull, appPool } from "@/lib/auth";
import { publicEditorialArticle, publicPreviews, type PublicPreview } from "@/lib/editorial-store";
import { bilingual, localizedPath } from "@/lib/i18n";
import { getLocale } from "@/lib/locale";
import { href as siteHref } from "@/lib/routes";
import { EditorialReviewDesk } from "./review-desk";
import { EditorialBatchQueue } from "./batch-queue";
import s from "./review.module.css";

export const dynamic = "force-dynamic";

const copy = bilingual({
  en: {
    title: "Article review",
    eyebrow: "ADMIN · EDITORIAL",
    back: "← Admin",
    queue: "Preprints awaiting review",
    empty: "Every current article language has been reviewed.",
    noPublic: "There are no public article versions to review.",
    open: "Review both language drafts",
    version: "Version",
    cutoff: "Evidence cutoff",
    noTranslation: "No matching Chinese version",
    batch: "Independent language approvals",
    awaiting: "Awaiting language approvals",
  },
  "zh-CN": {
    title: "文章审核",
    eyebrow: "后台 · 编辑",
    back: "← 后台",
    queue: "待审核的公开预发布稿",
    empty: "当前文章的中英文稿均已完成审批。",
    noPublic: "目前没有可审核的公开文章版本。",
    open: "分别审核中英文稿",
    version: "版本",
    cutoff: "证据截止时间",
    noTranslation: "没有匹配的中文版本",
    batch: "中英文独立审批",
    awaiting: "待审核语言",
  },
});

export async function generateMetadata(): Promise<Metadata> {
  const { language } = await getLocale();
  return { title: copy[language].title, robots: { index: false, follow: false } };
}

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function EditorialAdminPage({ searchParams }: Props) {
  const { language } = await getLocale();
  if (!appEnabled()) notFound();
  if (!(await adminOrNull(new Request("http://internal/", { headers: await headers() })))) notFound();

  const c = copy[language];
  const params = await searchParams;
  const articleId = typeof params.articleId === "string" ? params.articleId : null;
  const versionValue = typeof params.version === "string" ? params.version : "";
  const version = /^v[1-9][0-9]{0,8}$/.test(versionValue) ? Number(versionValue.slice(1)) : null;

  let previews: PublicPreview[] = [];
  try {
    previews = await publicPreviews("en");
  } catch (error) {
    console.error(`[admin editorial] preview queue failed: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  const chinesePreviews = await publicPreviews("zh-CN").catch(() => []);
  const chinese = new Map(chinesePreviews.map((item) => [`${item.articleId}:v${item.version}`, item]));
  const queue: PublicPreview[] = [...previews].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.articleId.localeCompare(b.articleId));
  const draftItems = await Promise.all(queue.map(async (item) => {
    const zh = chinese.get(`${item.articleId}:v${item.version}`);
    const [enArticle, zhArticle] = await Promise.all([
      publicEditorialArticle(item.articleId, item.version, "en"),
      publicEditorialArticle(item.articleId, item.version, "zh-CN"),
    ]);
    return { articleId: item.articleId, version: item.version, title: item.title,
      summary: item.summary, sourceCutoff: item.sourceCutoff,
      chineseTitle: zh?.title ?? c.noTranslation, contentSha256: enArticle?.contentSha256 ?? "",
      chineseHash: zhArticle?.contentSha256 ?? "", enApproved: false, chineseApproved: false };
  }));
  if (draftItems.length) {
    try {
      const db = appPool();
      const reviewState = await db.query<{
        article_id: string; version: number; language: "en" | "zh-CN"; content_sha256: string; decision: string;
      }>(
        `SELECT DISTINCT ON (article_id, version, language)
                article_id, version, language, content_sha256, decision
           FROM app.editorial_reviews
          WHERE actor_kind = 'human' AND article_id = ANY($1::text[])
          ORDER BY article_id, version, language, review_id DESC`,
        [[...new Set(draftItems.map((item) => item.articleId))]],
      );
      const byLanguage = new Map(reviewState.rows.map((row) => [`${row.article_id}:v${row.version}:${row.language}`, row]));
      for (const item of draftItems) {
        const english = byLanguage.get(`${item.articleId}:v${item.version}:en`);
        const chineseReview = byLanguage.get(`${item.articleId}:v${item.version}:zh-CN`);
        item.enApproved = english?.decision === "approve" && english.content_sha256 === item.contentSha256;
        item.chineseApproved = chineseReview?.decision === "approve" && chineseReview.content_sha256 === item.chineseHash;
      }
    } catch (error) {
      console.error(`[admin editorial] approval state failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
  const awaitingItems = draftItems.filter((item) => !item.enApproved || !item.chineseApproved);
  const selected = articleId && version
    ? awaitingItems.some((item) => item.articleId === articleId && item.version === version)
    : false;

  return (
    <div className={s.page}>
      <p className={s.back}><Link href={siteHref(language, "/admin")}>{c.back}</Link></p>
      <PageHeader eyebrow={c.eyebrow} title={c.title} />
      <section aria-labelledby="editorial-queue-heading">
        <h2 className={s.sectionTitle} id="editorial-queue-heading">{c.queue}</h2>
        {awaitingItems.length ? <>
          <h3 className={s.sectionTitle}>{c.awaiting}</h3>
          <EditorialBatchQueue label={c.batch} language={language} articles={awaitingItems} />
        </> : <p className={s.empty}>{queue.length ? c.empty : c.noPublic}</p>}
        {awaitingItems.length === 0 ? null : (
          <ul className={s.queue}>
            {awaitingItems.map((english) => {
              const key = `${english.articleId}:v${english.version}`;
              const zh = chinese.get(key);
              const active = selected && articleId === english.articleId && version === english.version;
              return (
                <li className={s.queueItem} key={key} aria-current={active ? "true" : undefined}>
                  <div className={s.titles}>
                    <div>
                      <p className={s.languageLabel}>EN · {c.version} {english.version}</p>
                      <h3>{english.title}</h3>
                      <p>{english.summary}</p>
                    </div>
                    <div lang="zh-CN">
                      <p className={s.languageLabel}>中文 · {c.version} {english.version}</p>
                      <h3>{zh?.title ?? c.noTranslation}</h3>
                      {zh ? <p>{zh.summary}</p> : null}
                    </div>
                  </div>
                  <p className={s.cutoff}>{c.cutoff}: <time dateTime={english.sourceCutoff}>{english.sourceCutoff.slice(0, 10)}</time></p>
                  <Link
                    className={s.open}
                    href={`${localizedPath(language, "/admin/editorial")}?articleId=${encodeURIComponent(english.articleId)}&version=v${english.version}` as Route}
                    aria-current={active ? "page" : undefined}
                  >
                    {c.open}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {selected && articleId && version ? (
        <>
          <h2 className={s.sectionTitle}>Review version {version}</h2>
          <EditorialReviewDesk key={`${articleId}:v${version}`} articleId={articleId} version={version} language={language} />
        </>
      ) : null}
    </div>
  );
}
