const ARTICLE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HASH = /^[0-9a-f]{64}$/;
const MAX_BATCH_ITEMS = 50;

export type ApprovalItem = {
  articleId: string;
  version: number;
  language: "en" | "zh-CN";
  contentSha256: { en: string; "zh-CN": string };
};

export type ApprovalQueueArticle = { articleId: string; version: number; contentSha256: string; chineseHash: string };

export function approvalSelectionKey(article: { articleId: string; version: number }, language: "en" | "zh-CN") {
  return `${article.articleId}:v${article.version}:${language}`;
}

export function selectedApprovalItems(selected: string[], queue: ApprovalQueueArticle[]): ApprovalItem[] {
  return queue.flatMap((article) => (["en", "zh-CN"] as const)
    .filter((language) => selected.includes(approvalSelectionKey(article, language)))
    .map((language) => ({ articleId: article.articleId, version: article.version, language,
      contentSha256: { en: article.contentSha256, "zh-CN": article.chineseHash } })));
}

export function makeApprovalBatch(items: ApprovalItem[]): { batchId: string; items: ApprovalItem[] } {
  return { batchId: crypto.randomUUID(), items };
}

export function parseApprovalBatch(value: unknown): { batchId: string; items: ApprovalItem[] } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (typeof body.batchId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.batchId)
      || !Array.isArray(body.items) || body.items.length < 1 || body.items.length > MAX_BATCH_ITEMS) return null;
  const items: ApprovalItem[] = [];
  const seen = new Set<string>();
  for (const value of body.items) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    const hashes = item.contentSha256;
    if (typeof item.articleId !== "string" || !ARTICLE_ID.test(item.articleId)
        || !Number.isSafeInteger(item.version) || (item.version as number) < 1
        || !hashes || typeof hashes !== "object" || Array.isArray(hashes)) return null;
    const record = hashes as Record<string, unknown>;
    if (typeof record.en !== "string" || !HASH.test(record.en)
        || typeof record["zh-CN"] !== "string" || !HASH.test(record["zh-CN"])) return null;
    if (item.language !== "en" && item.language !== "zh-CN") return null;
    const key = `${item.articleId}:v${item.version}:${item.language}`;
    if (seen.has(key)) return null;
    seen.add(key);
    items.push({ articleId: item.articleId, version: item.version as number, language: item.language, contentSha256: { en: record.en, "zh-CN": record["zh-CN"] } });
  }
  return { batchId: body.batchId, items };
}
