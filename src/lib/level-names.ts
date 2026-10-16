/** Level ruler v4. The one place the level names are written; pages and the snapshot reader both take them from here. */
export const LEVEL_NAMES = {
  en: ["Manual", "Assisted", "Partial automation", "Conditional automation", "High automation", "Full automation"],
  "zh-CN": ["人工", "辅助", "部分自动化", "有条件自动化", "高度自动化", "完全自动化"],
} as const;

/** The line the scale draws: who is still doing the work below L3 and above it. */
export const LEVEL_LINE = {
  en: "At L0–L2, a person is still doing the work. From L3, a person is no longer doing it.",
  "zh-CN": "L0–L2，人仍在干这件活；L3 起，人不再干这件活。",
} as const;

/** What each level means, L0 first: who does the work, and the evidence a level needs before it is accepted. */
export const LEVEL_MEANINGS = {
  en: [
    { roles: "A person carries out, reviews and handles exceptions.", evidence: "—" },
    { roles: "AI takes some steps. A person carries out, reviews and handles exceptions.", evidence: "Product launch" },
    { roles: "AI carries out every step. A person reviews each item and handles exceptions.", evidence: "Product launch" },
    { roles: "AI carries out and checks its own work. A person samples and takes over on exceptions. Limited scope.", evidence: "Confirmed by several sources" },
    { roles: "AI carries out, reviews and handles exceptions. Limited scope.", evidence: "Production use by a named company" },
    { roles: "AI carries out, reviews and handles exceptions. Unlimited scope.", evidence: "Independent measurement" },
  ],
  "zh-CN": [
    { roles: "人执行、审核并处理例外。", evidence: "—" },
    { roles: "AI 承担部分步骤，人执行、审核并处理例外。", evidence: "产品发布" },
    { roles: "AI 执行全部步骤，人逐件审核并处理例外。", evidence: "产品发布" },
    { roles: "AI 执行并自检，人抽检，例外时由人接手。范围限定。", evidence: "多方印证" },
    { roles: "AI 执行、审核并处理例外。范围限定。", evidence: "具名企业生产使用" },
    { roles: "AI 执行、审核并处理例外。范围不限。", evidence: "独立测量" },
  ],
} as const;
