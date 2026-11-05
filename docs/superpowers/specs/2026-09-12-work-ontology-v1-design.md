# openaiwill 工作本体 v1 设计

> **历史设计，2026-11-02 起被取代（标记于 2026-11-05）。** 本文的等级、闸门和接管进度计算不再作为现行方法；原文保留用于追溯，不代表当前实现或上线状态。现行方向见[证据账本方法](../../data/evidence-ledger-method.md)。目录 ID、来源与历史数据保留，退役代码仍按 #35 分步迁移。

> 历史草案：2026-09-12 后续讨论已采用 [平台元数据 v0.0.1](2026-09-12-platform-metadata-v0.0.1-design.md)。原文保留用于比较；单一 DWA 分母、职业单入口及仅就业统计权重的假设已被替代。当前版本与数据见 [平台数据入口](../../../datasets/platform/README.md)。

日期：2026-09-12。状态：设计稿，等待评审。本文定义 openaiwill 的工作本体、发布格式与权重推导规则，**不包含任何能力分数**。

本设计填补[整体功能框架](2026-09-12-functional-framework-design.md) §13 留空的一项：「九行业之外的世界范围怎样定义」。它不替换[模拟合同 v0.3](../../../datasets/takeover-simulation.v0.3.json)，而是为其提供此前缺失的世界范围、权重来源与计分骨架。

## 1. 目的与边界

**目的**：建立一套可版本发布、可外部复算的工作本体，使「AI 独立完成主要生产与服务工作的进度」这一估计具备可追溯的分母与骨架。

**核心决定**：

| 决定 | 内容 |
| --- | --- |
| 计分单位 | **工作项**（O*NET 详细工作活动），2,087 个 |
| 展示维度 | **职业树**，23 个职业大类 → 1,016 个职业 |
| 切片维度 | 行业（ISIC / a16z）与地区（Region） |
| 唯一估计对象 | 工作项的三情景完成度 `c` |
| 其余全部数值 | 来自公开来源，带 URL、版本与哈希 |

**明确不做**（本版）：

- 不建交付场景层。工作项即最细粒度，不把「准备合同或其他交易文件」再切成「合同审查 / 租约审查」。
- 不使用 RDF、OWL、推理机或图数据库。本体是建模方法，实现用 PostgreSQL 与 JSONL。
- 不重构[现有证据层](../../data/collection-and-simulation-pilot-2026-09-12.md)。事件、采用记录、社交信号保持现有 schema，本版只增加一条 `Event → WorkItem` 关系。
- 不产生任何能力分数。本版交付骨架、维度、关系与权重；`c` 的估计是下一个设计。

## 2. 本体分层

六层，加一个贯穿的元层。每一层的存在理由是它在计分链上的位置。

```
层 0  溯源与发布  Provenance
      Release · SourceDocument · 全实体携带 release_id

层 1  工作骨架  Work
      WorkItem 2,087   ★ 唯一计分单位
      Group 332 · Domain 41            工作项的上级分组
      Occupation 1,016 · Task 18,838   实体定义在此层，不承载估计

层 2  维度  Dimension
      OccupationTree  23 → 1,016       ★ 主展示维度
      Industry        ISIC 830 / a16z 9
      Region          us / global / cn

层 3  度量  Measure
      EmploymentStatistic → WeightSet → Weight

层 4  能力  Capability
      CapabilityEstimate · EstimateRevision    ★ 唯一估计的地方

层 5  证据  Evidence（本版不动）
      Actor · Source · Event · Claim · Availability · AdoptionRecord · MetricSnapshot

层 6  记账  Ledger
      EstimateUpdate · MethodRevision · SimulationSnapshot
```

**`Occupation` 出现在两层，不是重复。** 实体本身定义在层 1（它有 ID、名称、任务列表）；层 2 的 `OccupationTree` 是由 `family_id` 与 SOC 编码派生的**聚合轴**，不单独建表。同一实体既是计分链上的中继站，也是读者的浏览维度。

两条贯穿主链：

```
Event ──triggers──▶ EstimateUpdate ──changes──▶ CapabilityEstimate ──on──▶ WorkItem
WorkItem ──Weight[Region]──▶ 沿 OccupationTree 聚合 ──▶ SimulationSnapshot
```

**准入规则**：每个类必须能说明它在计分链上的位置——骨架、维度、权重、估计、证据或账本。说明不了的本版不进。据此 `Milestone`、`WeeklyEdition`、`CommunityContribution`、人物讲话本版均不进入本体。

## 3. 层 1 · 工作骨架

### 3.1 命名

O*NET 的缩写不进入本项目的模型与界面。原始 ID 与原文保留在溯源字段中。

| O*NET 原名 | 数量 | 本项目名称 | 英文 |
| --- | ---: | --- | --- |
| Generalized Work Activity | 41 | 活动域 | `Domain` |
| Intermediate Work Activity | 332 | 活动组 | `Group` |
| **Detailed Work Activity** | **2,087** | **工作项** | **`WorkItem`** |
| Occupation | 1,016 | 职业 | `Occupation` |
| Task | 18,838 | 任务 | `Task` |

三层示例，均为原始数据：

```
记录与归档信息
  └ 准备合同、申请或许可类文件
      └ 准备合同或其他交易文件        ← 工作项，打分在这一层

监控与调配资源
  └ 开具医疗处置或器械
      └ 开药
```

### 3.2 WorkItem

```
WorkItem
  id                 oaw:wi:<序号>          本项目稳定 ID
  source_scheme      onet-31.0
  source_id          4.A.3.b.6.m.2          O*NET 原始 ID
  label_en           Prepare contracts or other transaction documents.
  label_zh_cn        准备合同或其他交易文件          openaiwill 翻译
  group_id           唯一父级（Group）
  institution_binding  null | {type, note}   见 §3.5
  release_id
```

`label_zh_cn` 是本项目添加的修改，须按 CC BY 4.0 标注，不得表述为 O*NET 官方译名。

### 3.3 Occupation 与 Task

两者**不直接承载分数**，但都是计分链的必经节点，且 Occupation 是主展示维度。

```
Occupation
  id / source_code 15-1252.00 / label_en / label_zh_cn
  family_id        23 个职业大类之一
  soc_minor_group  从编码派生（15-12xx 计算机类 / 15-20xx 数学类）

Task
  id / source_task_id 20877 / occupation_id / statement_en / statement_zh_cn
  task_type        Core | Supplemental | null
  importance       IM，1–5，可空
  relevance        RT，执行该任务的在职者百分比，可空
  frequency        FT，1–7 类别分布，可空
```

**本版必须补的提取**：现有 `normalized/tasks.json` 只保留了 `task_type` 与 `incumbents_responding`。后者是**样本量**（律师全部任务均为 71/72），不是权重，不得用于加权。`IM`/`RT`/`FT` 在 `onet_31_0_csv.zip` 的 `task_ratings.csv` 中，本版必须提取入库。

### 3.4 覆盖缺口（实测）

| 项目 | 数量 | 处理 |
| --- | ---: | --- |
| 职业总数 | 1,016 | — |
| 有任务记录的职业 | 923 | 进入权重链 |
| **无任务记录的职业** | **93** | 其就业量计入 `uncovered_no_activity_points`，见 §5.3 |
| 任务总数 | 18,838 | — |
| **缺 IM / RT 的任务** | **418** | 见下 |
| 任务→工作项关系 | 24,087 | 全部 18,838 条任务均有映射 |

418 条缺 `RT` 的任务无法参与 §5.1 的工作量分配。本版处理：**在其所属职业内按该职业已有 RT 的均值补足，并在 `WeightSet` 中单独记录受影响的职业与就业量**。不静默丢弃，也不当作 0。

**2026-09-12 提取后实测确认**：这 418 条与「`task_type` 为空」的 418 条**完全重合**，即它们是 O*NET 尚未完成评级的同一批任务，而非随机缺失。均值补足因此是对同一类对象的统一处理，不是对异质缺失的掩盖。

**另有 155 条任务被 O*NET 标记 `Recommend Suppress = Y`**（`IM` 或 `RT` 至少其一）。O*NET 建议不发布这些具体数值。本版处理：`suppress` 标志随值一并保存；**这些值可参与内部权重计算，但不在公开发布物中显示具体数值**，展示时标为「来源建议不公开」。

### 3.5 制度依赖

工作项和任务在不同地区的可移植性不同。两种后果性质不同，分开存储：

| 类型 | 含义 | 后果 |
| --- | --- | --- |
| `existence` | 该工作在其他地区**不存在** | 换 Region 时从分母剔除 |
| `form` | 存在但形态/难度不同 | 影响 `c`，不影响分母 |

实测规模：全库 18,838 条任务中，显式点名美国制度的（federal / jury / probate / Medicare / Medicaid / OSHA / county / municipal 等关键词）共 **87 条，占 0.5%**。其中 federal 61、jury+jurors 11、municipal+county 12、medicare+medicaid 6、probate 1。

**本版处理**：字段建好，值留空。第一版 Region 为单一口径时不需要填。增加第二个 Region 时，先人工过这 87 条。关键词扫描会漏掉隐式依赖，但隐式依赖几乎全属 `form` 类，不影响分母。

## 4. 层 2 · 维度

维度不被打分，只用于切片与聚合。

```
Region
  id        us | global | cn
  kind      country | aggregate        （global 不是地理区域，用 kind 区分）
  label_zh_cn / label_en

Industry
  id / scheme  isic-rev5 | a16z-industry-v1 | naics-2022
  source_id / label / parent_id / level

OccupationTree
  由 Occupation.family_id 与 SOC 编码派生，不单独建表
```

`Region` 的命名保留一处已知不足：`global` 严格说不是 region，未来若需要非地理口径（如「仅正规就业」），通过 `kind` 字段扩展，不改字段名。

## 5. 层 3 · 度量：权重推导

目标：给每个工作项一个权重点，全部权重点之和等于 `covered_points`（见 §5.3）。

### 5.1 四步链

```
① 职业就业        E(o)                     BLS 行业—职业矩阵
② 职业内分到任务  share(t|o) = RT(t) / Σ RT(t')
③ 任务分到工作项  share(w|t) = crosswalk.share，默认 1/|WorkItem(t)|
④ 汇总            W(w) = Σ_o Σ_t E(o)·share(t|o)·share(w|t)
```

**② 为什么用 RT 不用 IM**：`RT` 是执行该任务的在职者比例，是工作量的代理；`IM` 是重要性，用它加权会放大「重要但耗时少」的工作。理想变量是工时占比，O*NET 未提供。`FT`（频率）留作 v2 改进项——`RT × FT` 更接近工时，但需要先定义 1–7 类别到数值的映射，那是额外构造，本版不引入。

**③ 为什么默认等分**：平均每条任务关联 1.28 个工作项（24,087 / 18,838），绝大多数为一对一，等分误差小。一对多的情形用 `crosswalk_relation.share` 人工调整。

### 5.2 必须断言的约束

```
Σ_t share(t|o) = 1          每个职业的工作量完整分配
Σ_w share(w|t) = 1          每条任务的工作量完整分配
Σ_w W(w)      = Σ_o E(o)    ★ 恒等式：总量必须等于总就业人数
```

第三条是发布前的硬校验，与 SHA 校验并列。对不上即说明推导链有遗漏或重复计数，不得发布。

### 5.3 未覆盖份额

不使用特殊 `WorkItem` 节点表示未覆盖工作，那会污染骨架。放在 `WeightSet` 上，四项加总恒等于 100：

```
WeightSet
  region_id / release_id
  employment_source            来源、年份、口径、URL、哈希
  covered_points                          例 92.4   可打分部分
  uncovered_no_activity_points            例  3.1   93 个无任务职业，精确可算
  uncovered_out_of_statistics_points      例  4.5   无偿家务与照护、未统计的非正规就业
  uncovered_unknown_points                例  0.0
  affected_by_missing_ratings             418 条任务影响的职业与就业量
```

三类性质不同：

| 类别 | 获得方式 |
| --- | --- |
| 无活动描述 | **精确计算**——93 个职业的就业人数 ÷ 总就业。不是估计 |
| 统计之外 | **估计，但须有来源**。ILO 时间使用调查的无偿照护劳动数据为候选，**待核实** |
| 未知 | 声明为未知，不填 0 |

**由此产生一条必须在界面执行的规则**：

> 总分 `P = Σ(w × c)` 的理论上限是 `covered_points`，不是 100。

展示形态：

```
当前估计   —          情景区间 —
本口径可评估上限   92.4
无法评估           7.6
   3.1  有职业但无活动描述
   4.5  在就业统计之外
```

本设计不产生上述示例中的任何具体数值；92.4 / 3.1 / 4.5 为格式示意。

## 6. 层 4 · 能力（本版只定义，不填值）

```
CapabilityEstimate
  work_item_id
  region_id              可空。空 = 全球默认值
  conservative / central / optimistic     0 ≤ 保守 ≤ 中性 ≤ 积极 ≤ 1
  basis                  使用了哪些材料、哪些部分为先验
  assumptions            关键假设与信息缺口
  raise_conditions / lower_conditions     什么新证据会上调或下调
  estimator_model / prompt_version / input_versions / estimated_at
  release_id
```

`region_id` 可空是为了实现「`c` 默认一套全球值，允许按口径覆盖」。覆盖必须填写理由，默认不填。语言与法律密集的工作项是预期的覆盖对象。

`EstimateRevision` 记录旧值、新值、时间、理由与触发者，上调与下调同等支持。

## 7. 层 6 · 记账

```
EstimateUpdate      触发事件 · 工作项 · 旧三情景 · 新三情景 · 理由 · 证据版本
MethodRevision      口径 / 权重 / 词表 / 估计模型的变更，与能力变化分账
SimulationSnapshot  region · release · 总分 · 区间 · covered_points · 输入 SHA-256
```

`MethodRevision` 与 `EstimateUpdate` 必须分账。首次建立基线、修订权重、改变范围、更换估计模型、修正数据各自记账；它们可能改变今天看到的估计，但不得表述为 AI 在本周获得了能力。

## 8. 关系表

所有跨实体、跨体系的映射走同一张表。

```
crosswalk_relation
  from_scheme       oaw-workitem | oaw-occupation | oaw-task
  from_id
  to_scheme         isic-rev5 | a16z-industry-v1 | naics-2022
                    | onet-occupation | onet-task | gdpval
  to_id
  predicate         exact | close | broad | narrow | related     （SKOS 语义）
  method            source_provided | manual | llm_proposed
  status            candidate | partial | reviewed | rejected
  confidence        0..1，可空
  share             0..1        ★ 多对多时的份额分配
  is_scoring_path   bool        ★ 是否参与加总
  evidence_url / evidence_version
  reviewed_by / reviewed_at / note
  release_id
```

借用 SKOS 的谓词词汇以便外部理解，不引入 RDF 技术栈。

两个关键字段：

- **`share`**：同一 `(from_id, to_scheme)` 下所有 `share` 之和必须为 1，或显式声明未分配部分。缺此字段会重复计数。
- **`is_scoring_path`**：同一对实体可以有多条关系，但只有一条参与计分，其余仅供检索。这实现了既有原则「评分树中有主要归属，交叉标签只帮助检索」。

```sql
create unique index on crosswalk_relation (from_id, to_scheme, release_id)
  where is_scoring_path;
```

**不使用图数据库。** 2,460 个概念、约 3 万条关系，PostgreSQL 足够；本项目需要的是可审计的行（每条关系带方法、状态、复核人），不是图遍历性能。

## 9. 发布格式与版本

### 9.1 两层职责

| 层 | 角色 |
| --- | --- |
| PostgreSQL | 运行时真相 |
| 发布物 | 从 PG 导出的**不可变快照**，是外部下载、引用、复算的对象 |

### 9.2 格式

**JSONL + JSON Schema 2020-12。** 每行一个实体，git diff 可见单行变化。

不使用 XML：工具链、可读性与 diff 均不如 JSON，且与既有 `datasets/*.json` 不一致。SKOS / Turtle 可作为额外导出供外部引用，属派生物，不是真相。

### 9.3 发布物

四条**独立的发布线**，各有自己的 semver 与 manifest。本版只产出前三条。

```
releases/
  vocabulary/v1.0.0/          词表线
    vocabulary.jsonl          2,460 节点：工作项 / 活动组 / 活动域
    occupations.jsonl         1,016
    tasks.jsonl               18,838（含 IM / RT / FT）
    dimensions.jsonl          Region · Industry
    schema/*.json · manifest.json

  crosswalk/v1.0.0/           关系线，依赖某个 vocabulary 版本
    crosswalk.jsonl
    schema/*.json · manifest.json

  weights/v1.0.0/             权重线，依赖某个 vocabulary + crosswalk 版本
    weights.<region>.jsonl
    schema/*.json · manifest.json

  estimates/…                 估计线，本版不产出
```

每条线的 `manifest.json` 记录：本线 semver、所依赖的其他线的**精确版本与根哈希**、本线各文件 SHA-256、changelog。依赖写成具体版本号，不写范围。

校验链：每文件一个 SHA-256 → `manifest.json` 汇总 → manifest 自身一个哈希 = **单一根哈希**。引用某版本只需引这一个值。

### 9.4 版本规则

| 变更 | 版本影响 |
| --- | --- |
| 词表节点增删、父级变更 | major |
| 关系或权重修订 | minor |
| 翻译、说明文字修正 | patch |
| 能力估计更新 | 不动本发布，进入 `estimates` 的独立版本与更新账本 |

**四条发布线各自独立版本化**（见 §9.3）。换 ISIC 版本只发新的 crosswalk；改权重口径只发新的 weights；新证据只发新的 estimates。每条线声明它依赖的上游精确版本，因此任何一个分数都能回溯到一组确定的上游哈希。

这样「分数变了」永远能回答「是世界变了还是我们改了口径」——上游版本没变而分数变了，就是证据驱动；上游版本变了，就是口径修订，进 `MethodRevision`。

**旧版本永久可访问**：已发布的分数与周报引用的是当时那一版，不得改写。

### 9.5 署名

职业、任务与工作活动数据来自 **O*NET® 31.0 Database, USDOL/ETA**，依 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 使用。O*NET® 是 USDOL/ETA 的商标。openaiwill 添加了 ID 命名空间、中文翻译与关系字段；这些修改未经 USDOL/ETA 批准、背书或测试。

BLS 就业数据与 O*NET OnLine 行业索引属外部数据，不适用 O*NET 数据库许可，单独标注。ISIC 完整内容的对外再分发许可状态**未确认**，本版仅作本地参考，不进入公开发布物。

## 10. 发布前校验清单

1. 词表：2,460 节点，41 + 332 + 2,087；每个非根节点有且仅有一个父级；无环。
2. ID：全局唯一；O*NET 原始 ID 与本项目 ID 一一对应。
3. 关系：`Σ share = 1`（按 `from_id` × `to_scheme` 分组）；每组 `is_scoring_path` 唯一。
4. 权重：`Σ_w W(w) = Σ_o E(o)`；四项 points 之和 = 100。
5. 未覆盖：93 个无任务职业的就业量已计入；418 条缺 RT 任务的影响已记录。
6. 许可：每个外部来源有 URL、版本、访问日期与许可状态；状态未确认的不进公开发布物。
7. 哈希：每文件 SHA-256 与 manifest 一致；manifest 根哈希写入 changelog。
8. 空值：未采集显示为 `null` 并说明原因，实测零显示 `0`，二者不混用。

## 11. 已知缺口

| 缺口 | 状态 | 阻塞什么 |
| --- | --- | --- |
| **BLS 行业—职业矩阵** | 三个官方 XLSX 返回 **403**。2026-09-12 复测：`server: AkamaiGHost`，Access Denied 页面 —— 是 **Akamai 的 bot 拦截**，非 User-Agent 问题。**不绕过 WAF**；需人工用浏览器下载后放入 `raw/` | 阻塞 §5.1 第 ① 步，即全部权重 |
| Region 的就业数据源 | ILOSTAT 可用层级**待核实**；中国国家统计局分行业就业**待核实** | 阻塞 us 以外的 Region |
| 无偿劳动份额来源 | ILO 时间使用调查为候选，**待核实** | 阻塞 `uncovered_out_of_statistics_points` |
| ~~`task_ratings.csv` 未提取~~ | **2026-09-12 已完成**。`IM` / `RT` / `FT` 已进 `normalized/tasks.json`，新增 10 项断言，`collect-work-reference.py --offline` 通过 5,839 项校验 | 已解除 |
| 现有行业索引 | 1,902 条关系带 10% 收录门槛，**无人数** | 不能替代 BLS 矩阵 |

现有 `industry-occupation-links.json` 只说明「哪些职业出现在哪个行业」，其百分比的分母是该职业从业者而非行业总人数，**不可用于权重推导**。

## 12. 并行切分

多个 agent 并行的前提是**先冻结 schema 与 ID**，否则产出无法合并。切分建议：

**可并行**

| 工作 | 切分方式 | 合并方式 |
| --- | --- | --- |
| 中文翻译（2,460 + 1,016 + 18,838） | 按 41 个活动域 / 23 个职业大类分片 | 按 ID 合并，术语表统一后复核 |
| crosswalk：工作项 → ISIC | 按活动域分片 | 按 `from_id` 合并；冲突进 `status=candidate` 待人工裁决 |
| crosswalk：职业 → a16z 九行业 | 按职业大类分片 | 同上 |
| 制度依赖标注（87 条） | 不必并行，量太小 | — |

**不可并行**

| 工作 | 原因 |
| --- | --- |
| 权重推导 | 一次全局计算，且有跨分片的恒等式校验 |
| schema 与发布 | 单点，且必须先于一切并行工作完成 |
| `share` 与 `is_scoring_path` 的裁决 | 需要全局视角，分片会产生重复计分 |

**执行顺序**：冻结 schema → 提取 `task_ratings` → 并行翻译与 crosswalk → 合并复核 → 补 BLS → 一次性推导权重 → 校验 → 发布 v1.0.0。

## 13. 本版不做

- 能力估计 `c` 的生成（下一个设计）
- 交付场景层
- 证据层重构
- 页面与可视化
- 中国与全球 Region 的权重（先出单一 Region 跑通全链）
- 周报生成（由人撰写，不作为功能）
