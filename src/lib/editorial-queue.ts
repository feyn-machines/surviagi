import type { Language } from "./i18n";

export type EditorialQueueItem = {
  articleId: string;
  version: number;
  title: string;
  chineseTitle: string;
  summary: string;
  chineseSummary: string;
  sourceCutoff: string;
  contentSha256: string;
  chineseHash: string;
  enApproved: boolean;
  chineseApproved: boolean;
  enDecision: string | null;
  chineseDecision: string | null;
  published: boolean;
};
export type QueueView = "pending" | "reviewed" | "published";
export function languageApproved(item: EditorialQueueItem, language: Language) {
  return item.published || (language === "en" ? item.enApproved : item.chineseApproved);
}
export function queueLanguages(items: EditorialQueueItem[], view: QueueView) {
  return items.flatMap((article) => (["en", "zh-CN"] as const)
    .filter((language) => view === "pending" ? !languageApproved(article, language)
      : view === "reviewed" ? !article.published && languageApproved(article, language) : false)
    .map((language) => ({ article, language })));
}
