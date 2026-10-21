# v2.3.0

话题（Topic）：帖子在争论的封闭问题。

- 新增类 `Topic`：关于一个职业或一类生意的封闭问题，带两到四个互斥的答案；身份是“问题类型 + 对象”。新增类 `TopicOption`：话题的一个可选答案。两者都是数据库里的记录，不随包封存。
- 新增关系 `about`（话题到职业、市场或市场组，可为空，机器提出的保持候选）、`has_option`、`argues`（帖子主张某个选项，带转述和原文引用）、`merged_into`（话题并入另一个话题，保留编号）。
- 新增词表 `topic_question_type`（替代、赛道）、`topic_state`（提议中、研究中、休眠、已并入、关闭）、`topic_origin`（从帖子挖出、读者提出、编辑指定）。
- 新增规则 `rule:topic-is-a-closed-question`、`rule:one-topic-per-object-and-question`、`rule:claim-outcome`、`rule:topic-carries-no-answer`、`rule:topics-are-read-by-quarter`、`rule:topic-ids-are-stable`。话题按自然季度读数，不判定结果。
- 词表 `panel_role` 增加 `market_researcher`（市场与行业研究）：投资机构、咨询公司、数据公司、公共机构、智库及其成员，发布自己对市场、采用情况或工作的测量。
- 过程记录新增表 `topic_mining_runs`、`topic_queries`、`topic_searches`、`event_measure_runs`。
- 事件类型词表升到 2.2.0，增加 `market_measurement`（市场测量）：第三方对某个市场或职业的采用、花费、排名或就业的一次量化读数。新写入的行标记为 `event_kind-2.2.0`；已有的行保留原标记和原值。
- 新增关系 `measures`（市场测量到市场、市场组或职业）；新增规则 `rule:market-measurement-moves-no-level`（市场测量不对应到工作，不影响任何等级）和 `rule:updates-reach-topics-by-the-catalog`（更新经目录列到话题下，不归到选项）。
- 已有的类、属性、关系和规则不变。
- 全部数据文件逐字节继承 2.2.0，所有概念、关系、外部映射的 ID 不变。

# v2.2.0

更新（Event）的表达，以及定义从某一版起向前生效的规则。

- 更新新增可选属性：`actor_account_key`（行动者账号，由程序填写）、`subject`、`basis`、`task`、`result`、`quote`、`schema_version`。`task` 和 `result` 只用于使用实录、独立测评、失败报告和生产采用。
- 新增类 `EventFact`：帖子给出的一个数字、价格、限制、成绩、日期或适用范围，连同原文引用。
- 新增关系 `acted_by`（更新到来源账号）和 `attached_to`（帖子挂靠到已存在的更新）。
- 新增词表 `event_basis`、`event_result`；`post_link` 增加 `attached`。
- 事件类型词表升到 2.1.0，增加 `usage_report`、`independent_evaluation`、`failure_report`。新写入的行标记为 `event_kind-2.1.0`，判定哈希随之改变；已有的行保留 `event_kind-2.0.0` 和原值。
- 新增规则 `rule:definitions-take-effect-forward`：类、属性、关系、词表项可以写 `since` 和 `until`；新增不补旧，失效不删除，默认不重抽。
- 新增规则 `rule:relays-are-not-a-source`、`rule:post-outcome`。
- 全部数据文件逐字节继承 2.1.0，所有概念、关系、外部映射的 ID 不变。

# v2.1.0

- 来源账号新增可选属性 `avatar_url`：账号查询时平台返回的头像地址。只用于显示，不是身份证据。
- 其余类型、词表、约束和全部数据文件不变；事件类型词表保持 2.0.0。

# v2.0.0

一个本体，一份类型定义。

- 类型定义合并为 `schema.json`：原 1.0.0 的 `model.json`（5 种概念、4 种关系）与语义模型 2.1.0（词表、规则、模型与供应商）合成一份，每个类型只定义一次。
- 写法改为类、属性、关系、词表、约束；属性声明定义域、值域、个数和对应的数据库列；关系声明两端基数。
- 人物、来源账号、帖子、更新成为类。它们原来只是数据库表。
- 「能力」不再是类；指向它的 `requires`、`demonstrates` 两种关系删除。
- 数据文件格式由 schema 生成，改名 `data-format.json`；新增标准格式导出 `ontology.ttl`。
- 闸门、公司名单随包封存。
- 1.0.0 的全部数据文件逐字节继承，所有概念、关系、外部映射的 ID 不变。
- 事件类型词表保持 2.0.0，`event_kind-2.0.0` 标记和判定哈希不变。

# v1.0.0

从 platform/v0.0.1 拆出独立本体合同；保留全部概念/关系 ID，新增关系类型及来源定义，排除运行模型、权重和来源统计值。
