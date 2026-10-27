import { ACCOUNT_DAILY_LIMIT, MAX_ACTIVE_KEYS, PENDING_LIMIT, QUESTION_DAILY_LIMIT, QUESTION_PENDING_LIMIT } from "@/lib/app-store";
import { READ_LIMIT_PER_MINUTE } from "@/lib/agent-api";
import type { Language } from "@/lib/i18n";

/**
 * The agents page, one document per language. A plain Record like the legal pages: sections hold lists.
 * Numbers come from the code that enforces them, so the page cannot promise another limit.
 */
type Block = { heading: string; id?: string; body: string[]; code?: string[] };

export const agentsCopy: Record<Language, { title: string; description: string; lead: string; sections: Block[] }> = {
  en: {
    title: "Connect an AI agent",
    description:
      "Let an AI agent search SurviAGI's published updates, questions, evidence and bilingual editorial articles over MCP or HTTP without a key, and submit research questions or accounts to monitor with a reader's API key.",
    lead:
      "An agent such as WorkBuddy, Claude or ChatGPT can search what SurviAGI has published and read each record with its sources. Reading needs no account and no key. A signed-in reader can also give an agent a key to submit research questions and accounts worth monitoring, as requests for review.",
    sections: [
      {
        heading: "What an agent can do",
        body: [
          "search: find published updates, questions, evidence readings and public bilingual articles. For articles, use types=[article] and optionally status=approved or preview. A preview is public but not approved; each result includes its exact revision, sources, evidence cutoff and language-specific link.",
          "get_record: read an article revision's complete Markdown and publication status by its article:<slug>:v<version> id, or read an update/question/evidence record in full. Private drafts, reviewer identities and review notes are never returned.",
          "With a key: submit_question registers a research question for review, suggest_account registers an X account to monitor, and my_submissions shows their status and the quota left.",
          "The site finds and registers; it does not answer. The agent does the analysis. No query, empty search or submission starts a model, a research run or a collection here.",
        ],
      },
      {
        heading: "Endpoints",
        body: [
          "MCP over Streamable HTTP (JSON responses, no session). Use the first endpoint with no key; use the second, with the key in an Authorization header, to submit as well. Reading works on both, and a wrong or revoked key never blocks it.",
          "The same tools as plain HTTP, for a script or a Skill that does not speak MCP:",
        ],
        code: [
          "https://surviagi.com/api/mcp                 search, get_record — no key",
          "https://surviagi.com/api/mcp/submit          + submit_question, suggest_account, my_submissions",
          "                                             header  Authorization: Bearer sag_…",
          "",
          "GET  https://surviagi.com/api/agent/search?query=coding+agents&limit=5&types=update,evidence,article&status=preview",
          "GET  https://surviagi.com/api/agent/record?id=ev-…",
          "POST https://surviagi.com/api/agent/questions     (key)  {question, why_it_matters, evidence_gap, leads?, related_record_ids?, request_id?}",
          "POST https://surviagi.com/api/agent/accounts      (key)  {account, kind, reason, field?, request_id?}",
          "GET  https://surviagi.com/api/agent/submissions   (key)",
        ],
      },
      {
        heading: "WorkBuddy and other clients",
        body: [
          "WorkBuddy applies a connector's sign-in to every call, so SurviAGI comes as two connectors: one for searching with no key, and one that asks for your key once and can also submit. Other MCP clients take the address directly, for example:",
        ],
        code: [
          '{ "mcpServers": { "surviagi": { "type": "streamableHttp", "url": "https://surviagi.com/api/mcp" } } }',
        ],
      },
      {
        heading: "What reading gives you",
        body: [
          "Only what the site has published: the same updates, questions and readings its pages show, from the data release named in every answer. Nobody's submissions, no raw collection and no internal state are reachable.",
          "Every summary and level is proposed by machine and has not been reviewed; each text says whether it is our summary, a reading, or a quote of the source. The full text of source posts is not published: open the source links. X Articles, linked pages and PDFs are not collected.",
          "Cite the record's page address together with the release's generation time.",
        ],
      },
      {
        heading: "A question worth submitting",
        body: [
          "Search first; a question already published is read, not submitted. A good question is specific and about AI doing real work: a job, a kind of business or a capability. Say why the answer matters and to whom (at least 20 characters), what the published records do not answer (at least 10), and give leads: sources, accounts or dates.",
          "A submitted question stays private to you and the reviewers, and is never published as written. A reviewer decides whether it is researched. An account suggestion follows the same path as the site's own form: submitted, approved, identity confirmed, monitoring enabled are separate steps, and none happens by itself.",
        ],
      },
      {
        heading: "Limits",
        body: [
          `Reading: at most ${READ_LIMIT_PER_MINUTE} requests a minute from one address, up to 20 results a search.`,
          `Submitting, per reader (all your keys and the site's own forms together, so a new key does not reset them): ${QUESTION_DAILY_LIMIT} new questions a day and ${QUESTION_PENDING_LIMIT} waiting for review; ${ACCOUNT_DAILY_LIMIT} new account suggestions a day and ${PENDING_LIMIT} waiting. Days are UTC. A duplicate, a refused request or a retry with the same request_id uses nothing.`,
          `Keys: up to ${MAX_ACTIVE_KEYS} at once. Revoking one stops it at once; the requests made with it stay.`,
        ],
      },
    ],
  },
  "zh-CN": {
    title: "接入 AI 助手",
    description:
      "让 WorkBuddy 等 AI 助手通过 MCP 或 HTTP 免 Key 搜索 SurviAGI 已发布的更新、问题、证据与双语文章；读者可用自己的 API Key 提交研究问题或建议监测的账号。",
    lead:
      "WorkBuddy、Claude、ChatGPT 等 AI 助手可以搜索 SurviAGI 已发布的内容，并连同来源读取每条记录。读取无需账号、无需 Key。登录的读者还可以给助手一个 Key，用来提交研究问题和值得监测的账号；提交只是待审核的申请。",
    sections: [
      {
        heading: "助手能做什么",
        body: [
          "search：搜索已发布的更新、问题、证据读数和公开双语文章。检索文章时传 types=[article]，可用 status=approved 或 preview 筛选。预发布稿公开可读但尚未批准；每条结果都带精确版本、来源、证据截止时间和对应语言的链接。",
          "get_record：传 article:<文章 ID>:v<版本> 可读取该版文章全文和真实发布状态；也可读取更新、问题或证据详情。私有草稿、审核人身份和审核意见不会返回。",
          "有 Key 时：submit_question 登记待审核的研究问题，suggest_account 登记建议监测的 X 账号，my_submissions 查看审核状态和剩余额度。",
          "本站只负责检索和登记，不负责回答，分析由助手完成。任何查询、无结果的搜索或提交都不会在本站启动模型、研究或采集。",
        ],
      },
      {
        heading: "接入地址",
        body: [
          "MCP，Streamable HTTP（JSON 响应，无会话）。不带 Key 用第一个地址；要提交时用第二个地址，并在 Authorization 头里放 Key。两个地址都能读取，错误或已撤销的 Key 不会挡住读取。",
          "同样的能力也有普通 HTTP 接口，给不支持 MCP 的脚本或 Skill 使用：",
        ],
        code: [
          "https://surviagi.com/api/mcp                 search, get_record — 免 Key",
          "https://surviagi.com/api/mcp/submit          + submit_question, suggest_account, my_submissions",
          "                                             请求头  Authorization: Bearer sag_…",
          "",
          "GET  https://surviagi.com/api/agent/search?query=coding+agents&limit=5&types=update,evidence,article&status=preview",
          "GET  https://surviagi.com/api/agent/record?id=ev-…",
          "POST https://surviagi.com/api/agent/questions     (Key)  {question, why_it_matters, evidence_gap, leads?, related_record_ids?, request_id?}",
          "POST https://surviagi.com/api/agent/accounts      (Key)  {account, kind, reason, field?, request_id?}",
          "GET  https://surviagi.com/api/agent/submissions   (Key)",
        ],
      },
      {
        heading: "WorkBuddy 与其他客户端",
        body: [
          "WorkBuddy 的连接器认证对整个连接器生效，所以 SurviAGI 提供两个连接器：一个免 Key，只能搜索和读取；另一个只在安装时填一次 Key，同时可以提交。其他 MCP 客户端直接填写地址即可，例如：",
        ],
        code: [
          '{ "mcpServers": { "surviagi": { "type": "streamableHttp", "url": "https://surviagi.com/api/mcp" } } }',
        ],
      },
      {
        heading: "能读到什么",
        body: [
          "只有本站已公开的内容：与页面展示相同的更新、问题、读数以及文章的当前公开批准版或预发布版。文章批准状态按中英两个版本的发布范围如实提供。读不到任何人的提交、原始采集数据或内部审核状态。",
          "所有摘要和等级都由机器提出、未经人工审核；每段文字都标明是我们的摘要、读数，还是来源原话的摘录。来源帖子的全文未发布，请打开来源链接查看；X Article、外链文章和 PDF 未采集。",
          "引用时请写记录的页面地址和数据版本的生成时间。",
        ],
      },
      {
        heading: "什么样的问题值得提交",
        body: [
          "先搜索；已发布的问题直接读取，不要重复提交。好问题要具体，关于 AI 完成真实工作：某个职业、某类业务或某项能力。写清答案为什么重要、对谁重要（至少 20 字），已发布记录缺什么（至少 10 字），并给出线索：来源、账号或日期。",
          "提交的问题只有你和审核人可见，不会按原文公开。是否纳入研究由审核人决定。账号推荐与网站上的表单走同一流程：提交申请、审核通过、身份确认、启用监测是不同阶段，任何一步都不会自动发生。",
        ],
      },
      {
        heading: "限制",
        body: [
          `读取：同一地址每分钟最多 ${READ_LIMIT_PER_MINUTE} 次请求，每次搜索最多 20 条结果。`,
          `提交按读者计算（你的所有 Key 与网站表单共用，重建 Key 不会重置）：问题每天新增 ${QUESTION_DAILY_LIMIT} 个、待审核最多 ${QUESTION_PENDING_LIMIT} 个；账号推荐每天新增 ${ACCOUNT_DAILY_LIMIT} 个、待审核最多 ${PENDING_LIMIT} 个。按 UTC 日计算。重复提交、被拒绝的请求和使用相同 request_id 的重试都不占额度。`,
          `Key：同时最多 ${MAX_ACTIVE_KEYS} 个。撤销立即生效；用它提交过的申请保留。`,
        ],
      },
    ],
  },
};
