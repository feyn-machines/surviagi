/** Source chronology, never collection time. An announcement is not an occurrence. */
export type UpdateDates = { occurred_at: string | null; announced_at?: string | null };

export function updateTimestamp(update: UpdateDates): string | null {
  return update.occurred_at ?? update.announced_at ?? null;
}

export function dateLabel(date: string | null | undefined, announced: boolean | undefined, language: "en" | "zh-CN"): string | null {
  if (!date) return null;
  const day = date.slice(0, 10);
  return announced ? (language === "zh-CN" ? `${day} 宣布` : `Announced ${day}`) : day;
}

export function updateDateLabel(update: UpdateDates, language: "en" | "zh-CN"): string | null {
  return dateLabel(updateTimestamp(update), !update.occurred_at, language);
}
