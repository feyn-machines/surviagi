import articleIndex from "./articles.json";
import type { Language } from "@/lib/i18n";

type EditorialCopy = {
  label: string;
  updated: string;
  title: string;
  description: string;
  summary: string;
  points: { title: string; text: string; source: string; url: string }[];
  next: string;
  article: string;
};

/** Site-owned commentary, separate from the published topic's claims and evidence. */
const saas: Record<Language, EditorialCopy> = {
  en: {
    label: "Editorial analysis",
    updated: "Sources reviewed",
    title: "What would an agent have to replace?",
    description: "Will AI replace SaaS? Compare bespoke agents, workflow knowledge and the cost of reliable delivery, with original sources and dated editorial analysis.",
    summary: "Similar features alone do not establish a replacement for paid software. Our current judgment is to test the recurring workflow, integrations and total running cost. The sources below offer different views; none establishes industry-wide replacement.",
    points: [
      { title: "The part you actually use", text: "Could a bespoke agent handle a narrow, recurring job? DHH's 5% example is a prediction, not measured software usage or a completed replacement.", source: "DHH · prediction", url: "https://x.com/dhh/status/2108643095768101111" },
      { title: "The workflow beneath the interface", text: "Diogo Almeida argues that established SaaS companies understand customer workflows. His view appears in an a16z interview, not a study of revenue or renewals.", source: "a16z interview · vendor's view", url: "https://x.com/a16z/status/2108622406428619002" },
      { title: "What buyers still value", text: "Ian Nuttall reports difficulty selling side projects. Selling a project differs from selling a subscription; this personal account does not establish a market-wide trend.", source: "Ian Nuttall · personal experience", url: "https://x.com/iannuttall/status/2108528886724411880" },
    ],
    next: "Evidence to look for: a specific software replacement, repeated results, setup and maintenance costs, failures, and whether the customer cancelled or restored the subscription.",
    article: "Read the full SaaS analysis →",
  },
  "zh-CN": {
    label: "编辑分析",
    updated: "来源核对于",
    title: "Agent 要替代的，到底是什么？",
    description: "AI 会取代 SaaS 吗？结合原始来源，分析按需定制的 Agent、客户工作流程和可靠交付的总成本，区分预测、个人经历与编辑判断。",
    summary: "做出相似功能，还不足以证明付费软件已经被替代。我们的当前判断是检验反复发生的工作、系统集成和持续运行的总成本。下列来源提出不同看法，都不足以证明整个行业正在被替代。",
    points: [
      { title: "你真正用得上的那部分", text: "定制 Agent 能否完成一件范围小、反复发生的工作？DHH 的“5%”是假设例子，不是使用比例统计，也不是已经完成的替代。", source: "DHH · 预测", url: "https://x.com/dhh/status/2108643095768101111" },
      { title: "界面下面的工作流程", text: "Diogo Almeida 认为老牌 SaaS 公司理解客户的流程。这是 a16z 采访中的厂商观点，不是收入或续费率研究。", source: "a16z 采访 · 厂商观点", url: "https://x.com/a16z/status/2108622406428619002" },
      { title: "买家还在购买什么", text: "Ian Nuttall 自述副业项目越来越难出售。出售项目与出售订阅是不同交易，个人经历还不足以说明整个市场的变化。", source: "Ian Nuttall · 个人经历", url: "https://x.com/iannuttall/status/2108528886724411880" },
    ],
    next: "接下来要找的证据：具体替代哪个软件、能否反复交付、搭建与维护成本、失败记录，以及客户最后取消还是恢复了订阅。",
    article: "阅读完整 SaaS 分析 →",
  },
};

export function topicEditorial(slug: string, language: Language) {
  const articleSlug = "will-ai-replace-saas";
  if (slug !== "viability-saas-app-5c83f1cb" || !articleIndex.some((article) => article.slug === articleSlug)) return null;
  return { ...saas[language], date: "2026-10-10", articlePath: `/articles/${articleSlug}` };
}
