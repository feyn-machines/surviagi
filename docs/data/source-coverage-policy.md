# 来源覆盖规则 / Source coverage policy

2026-11-05 · #22 · [方法 / Method](evidence-ledger-method.md)

## 中文

本规则落实已确认的[证据账本设计](../superpowers/specs/2026-11-02-evidence-ledger-redesign.md)。名单回答“我们在看谁、为什么”，不是可信度排行榜。下列分层是证据用途，不是新的能力等级，也不是已经发布的数据库枚举。账号可以提供多种用途；每条观察仍须单独判断主体身份、依据、条件和利益关系。

| 证据用途 | 纳入条件与身份证据 | 排除与解释边界 |
| --- | --- | --- |
| 第一方发布 | 模型、Agent/应用、云与芯片组织的正式账号；组织官网明确链接账号，或可核对的组织关联证据 | 员工个人账号不自动算官方；发布、演示与客户宣传不能直接证明独立测评或生产效果 |
| 独立测评与基准 | 具名测评机构、研究团队或个人；身份有一手关联，公开方法、测试对象/版本、条件与结果 | 转述排行榜、无方法的推荐不算测评；受雇、赞助、投资与被测产品关系须记录，存在利益关系时不能仅凭名单标签声称独立 |
| 具名采用方 | 企业、公共机构或行业从业者；能核对组织/职业关联，直接描述自己在具体任务中的使用 | 匿名客户、厂商单方面客户名单不算采用方自己确认；试用、个人使用与生产部署分开，不能外推行业普及率 |
| 市场与就业测量 | 发布调查、经济指数或就业研究的机构；核对发布主体，并保留样本、时间窗、地域、分母与方法 | 产品使用指数不自动代表就业替代；招聘、使用量、支出与工作结果不可互换；有商业关系须披露 |
| 观点与预测 | 可核对身份和相关经历的研究者、从业者或负责人；保留原话、时间及观点归属 | 预测、感想、转述与社交热度不能当成已经发生的采用或能力证据 |

身份核对独立于观点真假：认证徽章、粉丝数、账号自述、单向链接到官网均不足以单独确认归属。保存一手身份证据 URL、核对日期、数字账号 ID 与适用身份；无法确认则保持候选。身份证据的公开描述不能包装成已实现的新“身份等级”字段，字段变更必须服从本体与契约。

### 覆盖顺序与候选流程

优先补具名采用方、独立测评与研究、市场/就业测量；厂商账号保留并有选择地补齐。官方范围包括主要 Agent/编程产品、模型、云与芯片公司；已确认的研究方向包括 Cursor、Cognition、Replit、Mistral、Perplexity、Amazon、NVIDIA。这些名称是覆盖目标，不表示当前缺口、具体 X 账号已核实或已启用。Baidu/ERNIE 继续排除。

采用方与从业者先检查会计、客服、软件开发、法律（含律师助理）、设计，之后按 Search Console 真实查询调整。对每一职业分别找采用方自己的陈述与独立检验；保留失败、撤回、人工接管和成本上升等反方向证据，不按产品赞扬程度选来源。

每批先对照当日启用名单去重，再形成私有差距清单：证据用途、职业/公司、当前覆盖、候选主体、发现来源、一手身份链接、数字 ID 核对状态、利益关系、纳入理由、尚缺证据。没有核对过的当前数量写“未核对”，不沿用旧快照数字。差距清单经负责人确认后，才按现有候选→身份核对→启用流程分批导入；发现来源或列入研究目标都不等于启用。该规则不要求为每个已确认范围再次审批。

### 后续公开验收

账号公开说明须包含用途、角色、身份证据及核对时间、纳入理由和必要的利益关系限制；不公开抓取重试、代理、审核备注等内部运行信息。账号用途只帮助理解覆盖，不能替代逐条观察的证据类型。

分层统计须给出统计时点、近 30 天窗口与时区、启用账号数、发帖账号数、来源帖子数和去重观察数，以及公司/职业分布。多用途账号分别计入相应用途，合计必须去重；同一观察多来源也不能重复计为多个事实。采集失败、未覆盖与观察为零分别列明，不能都显示为零。不要把来源数当作市场份额或代表性抽样。

本次文档交付不声称已完成账号字段、统计接口、双语站内展示或候选导入；这些仍是 #22 的验收项。名单维护交给 #23，非 X 来源接入交给 #24，逐条准确率评估交给 #26。

## English

This policy implements the confirmed [evidence-ledger design](../superpowers/specs/2026-11-02-evidence-ledger-redesign.md). The watchlist explains whom we follow and why. Its layers describe evidence uses, not credibility rankings, capability levels or already published database enums. An account can serve several uses; each observation still requires its own attribution, basis, conditions and conflict assessment.

| Evidence use | Inclusion and identity evidence | Exclusions and limits |
| --- | --- | --- |
| First-party announcements | Formal accounts of model, Agent/application, cloud and chip organizations; explicit links from the organization’s website or verifiable organizational affiliation | Employees are not automatically official spokespeople. Releases, demonstrations and customer marketing do not establish independent testing or production outcomes |
| Independent tests and benchmarks | Named evaluators, research teams or individuals with primary identity evidence and disclosed methods, tested versions, conditions and results | Reposted rankings and recommendations without methods are not tests. Employment, sponsorship and investment relationships must be recorded; a watchlist label alone cannot establish independence |
| Named adopters | Companies, public institutions and practitioners with verifiable organizational or occupational affiliation describing their own use in a specific task | Anonymous customers and vendor-only customer lists are not adopter confirmation. Trials, personal use and production deployment remain distinct and do not establish industry prevalence |
| Market and employment measurement | Identifiable publishers of surveys, economic indices or employment research, retaining sample, period, geography, denominator and method | Product usage indices do not automatically measure job displacement. Hiring, usage, spending and work outcomes are different measures; commercial relationships must be disclosed |
| Views and predictions | Researchers, practitioners and leaders with verifiable identity and relevant experience; retain attribution, original wording and date | Predictions, impressions, relays and social popularity are not evidence of completed adoption or demonstrated capability |

Identity verification is separate from claim verification. Badges, follower counts, self-descriptions and one-way links to an organization’s website are insufficient on their own. Retain primary identity URLs, check dates, numeric account IDs and the applicable affiliation; unresolved identities remain candidates. Public identity descriptions must not imply that a new identity-grade field already exists: schema changes remain governed by the ontology and contract.

### Priorities and candidate lifecycle

Prioritize named adopters, independent evaluators and researchers, then market/employment measurement. Retain vendor accounts and expand selectively across major Agent/coding products, model companies, cloud and chips. Confirmed research targets include Cursor, Cognition, Replit, Mistral, Perplexity, Amazon and NVIDIA. These are coverage targets, not verified current gaps, confirmed X identities or enabled accounts. Baidu/ERNIE remains excluded.

Start with accounting, customer service, software development, law (including paralegals) and design; adjust using actual Search Console queries. Seek both adopters’ own statements and independent checks for each occupation. Include failures, withdrawals, human intervention and rising costs; positive product sentiment is not a selection criterion.

Before each batch, deduplicate against the current enabled list. Keep a private gap register containing evidence use, occupation/company, current coverage, candidate, discovery source, primary identity links, numeric-ID verification status, conflicts, inclusion rationale and missing evidence. Mark unchecked current counts as unchecked rather than reusing historical snapshots. After the owner confirms the gap list, import in batches through the existing candidate → identity verification → enabled lifecycle. Discovery and research targets do not imply activation. This does not require renewed approval of already confirmed scope.

### Remaining public acceptance

Public account descriptions must include uses, role, identity evidence and check date, inclusion rationale and relevant conflict limitations. Keep collection retries, proxies and internal review notes private. Account uses explain coverage; they do not replace an observation’s evidence type.

Layer statistics must identify the as-of date, 30-day window and timezone, enabled accounts, posting accounts, source posts, deduplicated observations and company/occupation distributions. Multi-use accounts count in each applicable layer but totals must deduplicate them; multiple sources for one observation do not create multiple facts. Distinguish collection failure, missing coverage and observed zero. Source counts are not market shares or representative sampling.

This documentation delivery does not claim completed account fields, statistics APIs, bilingual website presentation or candidate imports. They remain acceptance items for #22. Ongoing watchlist maintenance belongs to #23, non-X ingestion to #24 and observation accuracy evaluation to #26.
