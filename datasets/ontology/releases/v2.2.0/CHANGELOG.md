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
