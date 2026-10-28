import type { Metadata } from "next";
import type { Route } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/data-page";
import { appEnabled } from "@/lib/app-config";
import { adminOrNull } from "@/lib/auth";
import { approvedEditorialArticles, publicEditorialArticle, publicPreviews, type ApprovedEditorialSummary, type PublicPreview } from "@/lib/editorial-store";
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
    queue: "Public article versions",
    empty: "There are no public article versions to review.",
    open: "Review both languages",
    version: "Version",
    cutoff: "Evidence cutoff",
    noTranslation: "No matching Chinese version",
    batch: "Batch approval",
  },
  "zh-CN": {
    title: "文章审核",
    eyebrow: "后台 · 编辑",
    back: "← 后台",
    queue: "公开文章版本",
    empty: "目前没有可审核的公开文章版本。",
    open: "审核中英文版本",
    version: "版本",
    cutoff: "证据截止时间",
    noTranslation: "没有匹配的中文版本",
    batch: "批量批准",
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
  let approved: ApprovedEditorialSummary[] = [];
  try {
    [previews, approved] = await Promise.all([publicPreviews("en"), approvedEditorialArticles("en")]);
  } catch (error) {
    console.error(`[admin editorial] preview queue failed: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  const [chinesePreviews, chineseApproved] = await Promise.all([
    publicPreviews("zh-CN").catch(() => []),
    approvedEditorialArticles("zh-CN").catch(() => []),
  ]);
  const chinese = new Map([...chineseApproved, ...chinesePreviews].map((item) => [`${item.articleId}:v${item.version}`, item]));
  const versions = new Map<string, (PublicPreview | ApprovedEditorialSummary)>(
    approved.map((item) => [`${item.articleId}:v${item.version}`, item]),
  );
  for (const preview of previews) versions.set(`${preview.articleId}:v${preview.version}`, preview);
  const queue = [...versions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.articleId.localeCompare(b.articleId));
  const selected = articleId && version ? queue.some((item) => item.articleId === articleId && item.version === version) : false;

  return (
    <div className={s.page}>
      <p className={s.back}><Link href={siteHref(language, "/admin")}>{c.back}</Link></p>
      <PageHeader eyebrow={c.eyebrow} title={c.title} />
      <section aria-labelledby="editorial-queue-heading">
        <h2 className={s.sectionTitle} id="editorial-queue-heading">{c.queue}</h2>
        {queue.length ? <EditorialBatchQueue label={c.batch} language={language} articles={await Promise.all(queue.map(async (item) => {
          const zh = chinese.get(`${item.articleId}:v${item.version}`);
          const [enArticle, zhArticle] = await Promise.all([
            publicEditorialArticle(item.articleId, item.version, "en"),
            publicEditorialArticle(item.articleId, item.version, "zh-CN"),
          ]);
          return { articleId: item.articleId, version: item.version, title: item.title,
            chineseTitle: zh?.title ?? c.noTranslation, contentSha256: enArticle?.contentSha256 ?? "",
            chineseHash: zhArticle?.contentSha256 ?? "" };
        }))} /> : null}
        {queue.length === 0 ? <p className={s.empty}>{c.empty}</p> : (
          <ul className={s.queue}>
            {queue.map((english) => {
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
