# AI 助手接入（WorkBuddy）：公开搜索与受控提交

日期：2026-10-26。状态：按 [Issue #5](https://github.com/feyn-machines/surviagi/issues/5) 的需求实现于分支 `feat/agent-access`，合并到本地 `main`；**未部署、未在 WorkBuddy 客户端实测**。额度数值是本文提出的默认值，待所有者确定。

## 需求边界（来自 Issue #5）

- 公开读取（`search`、`get_record`）免登录、免 Key；外部提交（`submit_question`、`suggest_account`）必须使用本站用户的 API Key，并受额度限制。
- 只读已发布内容；不含用户私有提交、原始档案或内部运行数据。本站只检索和登记，分析由调用方 AI 完成；不开放生成模型、判断模型、任意 prompt、研究执行或采集执行接口，查询无结果或提交都不触发这些能力。
- 提交进入审核；账号推荐保持“提交申请、审核通过、身份确认、启用监测”的阶段区分。
- Key 通过现有 Google 登录领取、查看、撤销；额度按用户计算，多 Key、网页与 WorkBuddy 共用，重建 Key 不重置；并发、重试、重复和失败请求不重复消耗额度。

## 路线评估

WorkBuddy 的[连接器文档](https://open.workbuddy.cn/docs/connector)和 [Skill 文档](https://open.workbuddy.cn/docs/skill)（2026-10-26 查阅）给出的事实：

- 连接器是“MCP + Skill”（推荐）或“CLI + Skill”。远程 MCP 必须是 HTTPS，传输为 SSE 或 streamableHttp；每个连接器只配置一个 MCP Server。
- **认证按连接器整体生效**，由 `connector-meta.json` 的 `auth_mode` 决定：省略时走标准 MCP（服务器要求时用 OAuth 2.1 + PKCE、动态注册）；`token` 时用户在表单里填 Key，以 `${VAR}` 注入请求头；同一服务要同时提供两种方式，需提交两个不同 `source` 的连接器。凭据只存在用户本机 `~/.workbuddy`。
- Skill 是一个带 frontmatter 的 `SKILL.md`，可附 `scripts/` 由 AI 通过 Bash 执行；文档没有说明 Skill 如何获得密钥、网络权限和大小限制。

| | 远程 MCP | Skill 调用 HTTP API | MCP 配套 Skill |
| --- | --- | --- | --- |
| 能做什么 | 结构化工具（JSON Schema 输入、`structuredContent` 输出），客户端自动发现 | AI 读说明后用 Bash 跑脚本、解析 JSON | MCP 提供工具，Skill 教 AI 何时用、怎样引用、提交前先搜索 |
| 接入成本（本站） | 一个无状态 JSON-RPC 端点 | 同一套 HTTP 接口 + 一个脚本 | 两者之和，工具逻辑共用 |
| 接入成本（用户） | 市场点“连接”；提交版填一次 Key | 安装 Skill；Key 放环境变量（WorkBuddy 未说明怎样提供） | 同远程 MCP |
| 对公开数据的影响 | 只读内存中已加载的数据版本，与页面同源 | 同左 | 同左 |
| 认证 | 连接器级：免 Key 与带 Key 需两个连接器 | 脚本自带，按调用区分 | 同远程 MCP |
| 依赖客户端能力 | 只需标准 MCP | 依赖 Bash 与出站网络 | 同远程 MCP |

**结论：首版采用“远程 MCP + 配套 Skill”，并提供同一能力的 HTTP 接口作为 Skill-only 备选。** 理由：它是 WorkBuddy 推荐的接入形式，工具与结构化结果由协议保证；Skill-only 依赖 Bash 和未说明的密钥机制，不适合作为首选，但 Issue 要求 Skill 方案也有真实接口，所以 HTTP 接口和脚本一并交付。

针对“公开读取免 Key，仅提交时配置 Key”：因为认证按连接器生效，**单个连接器做不到**——`token` 模式会在连接时就要求填写 Key。所以设计为两个独立入口、两个连接器：

| 连接器 `source` | 端点 | 认证 | 工具 |
| --- | --- | --- | --- |
| `surviagi` | `https://surviagi.com/api/mcp` | 无 | `search`、`get_record` |
| `surviagi-submit` | `https://surviagi.com/api/mcp/submit` | `token`：`Authorization: Bearer ${SURVIAGI_API_KEY}` | 以上两个 + `submit_question`、`suggest_account`、`my_submissions` |

读取工具在两个端点上都**从不检查 Key**：缺失、错误、已撤销的 Key 不影响搜索和详情读取。提交工具只在 `/api/mcp/submit` 上提供；公开端点调用它们返回“未知工具”并指出提交端点。

未采用 OAuth：要实现授权服务器（发现文档、动态注册、令牌刷新），而本站已有 Google 登录 + 自管 Key 就能满足“可撤销、可审计、绑定用户”，成本低得多。以后如需要，可另提交一个 OAuth 连接器（不同 `source`）。

## 实现

### MCP 端点（`src/lib/mcp.ts`）

Streamable HTTP 的无状态用法：每个 POST 一条 JSON-RPC 消息、一个 JSON 响应；无会话、无 SSE 流，GET 返回 405。支持 `initialize`、`ping`、`tools/list`、`tools/call`；通知返回 202；批量请求、非 JSON、超过 64 KB、未知 `MCP-Protocol-Version`、带外站 `Origin` 的请求被拒绝（后者按传输规范防 DNS 重绑定）。工具结果同时给 `structuredContent` 和同内容的文本；参数错误、未找到、未认证、超额以 `isError: true` 返回，便于调用方 AI 读懂。

### 搜索与详情（`src/lib/agent-search.ts`）

- 范围：当前已加载数据版本中有页面的更新（`chain.events`）、话题（问题）和证据读数。与页面同一份内存数据，**不连数据库、不碰本机采集库或索引**；数据版本切换后自动重建。Embedding/Meilisearch 等本机检索组件不对外。
- 匹配：英文按词、中日韩文按二字组；按字段加权（标题 > 机构/类别 > 摘要），整句命中加分；一两个词的查询要求全部命中，更长的要求至少一半。筛选：`types`、`from`/`to`（记录自身日期）、`language`（链接与标签语言）。每次最多 20 条，摘要截断到 280 字。
- 返回：稳定 ID（`ev-…`、`topic:…`、`evidence:<更新ID>:<工作slug>`）、标题、摘要、站内链接与 Markdown 副本链接、原始来源链接、日期、机构、数据版本（`release.id`、`generated_at`）。每段文字标明性质：`machine_summary`（本站摘要）、`post_quote`（帖子原话摘录）、`machine_reading`（机器等级）；全部标为 `machine_proposed_unreviewed`。
- 原文缺口如实说明：发布层不含 X 帖子全文（话题的摘录除外），X Article、外链文章和 PDF 未采集，详情一律返回 `original_text.available: false` 和说明，不把摘要标成原文。

### 提交与审核（`src/lib/agent-api.ts`、`src/lib/app-store.ts`、`db/app/002_agent_access.sql`）

- **问题价值要求（服务端确定性校验，不调用任何模型）**：`question` 8–300 字、不能只是链接；`why_it_matters` 20–1000 字且不能重复问题；`evidence_gap` 10–1000 字；`leads` 可选；`related_record_ids` 最多 10 个合法记录 ID。与已发布话题相同的问题返回 `published` 并给出链接，不登记。是否“与研究范围相关”由审核人判断。
- **登记**：`app.questions`，状态 `pending → accepted | rejected`，拒绝须写理由，决定后不可改（触发器）。问题私有，不进入任何公开结果。管理员在 `/admin?view=questions` 审核。
- **账号推荐**：复用 `app.submissions` 与网站表单同一函数，新增 `via`（web/api）、`api_key_id`、`request_id`、`field`（相关领域）列；已监测返回 `monitored`，重复返回原记录与状态；返回的 `lifecycle` 说明各阶段相互独立，提交和通过都不启动采集、不代表身份确认。
- **去重与重试**：同一读者的同一问题（NFKC、小写、去标点后比较）或同一账号返回 `duplicate`；同一 `request_id` 返回第一次的结果（`replayed`）。

### Key 与额度

- Key 形如 `sag_` + 32 位 base64url（24 字节随机数）。只存 SHA-256；明文只在生成时返回一次。每人最多 5 个有效 Key；撤销立即生效且不可恢复，用它提交的记录保留（`api_key_id` 可追溯）。`/agents#keys` 提供生成、查看（前缀、创建/最近使用时间、各类提交数、今日额度）和撤销；页面 HTML 对所有人相同，Key 列表由浏览器取得。
- 额度**按读者**、直接数该读者在表里的行：待审核数和当日（UTC）新增数，在锁住用户行的同一事务里检查后插入。因此：多个 Key 与网页共用；重建 Key 不重置；并发不会超额；重复、重放、被拒、失败的请求不产生行，也就不占额度。
- 默认值（待所有者确定）：问题每天 5 个、待审核上限 20；账号推荐每天 20 个、待审核上限 10（沿用网站原上限）。
- 限流：匿名读取每个客户端地址（Cloudflare 的 `cf-connecting-ip`）每分钟 60 次，MCP 与 HTTP 共用；每个 Key 每小时最多 60 次提交类调用。限流计数在进程内存中，服务重启即清零。

### HTTP 接口（Skill 备选）

`GET /api/agent/search`、`GET /api/agent/record`（公开，`Cache-Control: public, max-age=60`）；`POST /api/agent/questions`、`POST /api/agent/accounts`、`GET /api/agent/submissions`（Bearer Key，先验 Key 再读请求体，`no-store`）。字段与 MCP 工具一致。

### 接入包

`integrations/workbuddy/` 存两个连接器和一个 HTTP Skill 的源文件；`node scripts/pack-workbuddy.mjs` 在被忽略的 `out/workbuddy/` 组装成 WorkBuddy 要求的目录（`connector-meta.json`、`mcp.json`、`token-schema.json`、`icon.svg`、`skills/<名>/SKILL.md`）。源文件不叫 `mcp.json`、`skills/`，因为公开文件闸门禁止这两个名字进入 Git（防止私有代理配置外泄），本次没有放宽该闸门。

## 安全边界小结

- 公开读取只能看到已发布数据版本；不能读到任何提交、`app` 模式、原始采集或内部状态。
- 提交只写待审核行；没有任何代码路径从提交触发模型、研究或采集。
- Key 只存哈希，绑定用户，可撤销；所有提交行记录来源（web/api）和所用 Key。
- 错误信息不含内部细节；数据库不可达时读取照常，提交返回 503。

## 剩余事项

1. **WorkBuddy 客户端实测未做**：两个连接器需要在 WorkBuddy 开放平台提交上架或以开发方式安装，实测连接、能力发现、搜索、详情、填 Key 后提交。`connector-meta.json` 中名称/描述/示例的确切字段名需按平台模板核对。验收第 1、6 条在实测前不能算通过。
2. 额度数值待定；限流在单进程内存中，多实例部署时需要共享存储。
3. 部署需要：服务器执行 `pnpm db:setup`（应用 `002_agent_access.sql`）和代码发布。
4. 问题审核后的去向（导出到本机、转为话题）尚未实现；目前只在后台记录决定。
5. 原文贯通发布层（X 帖子正文、X Article、外链、PDF）属于 #4 及后续评估，不在本次范围。
