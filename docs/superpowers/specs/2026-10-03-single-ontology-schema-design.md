# 一个本体：schema 与数据

日期：2026-10-03 · 状态：待用户审阅

## 1. 用户的决定

以下是用户在 2026-10-03 对话里的原话，本设计以它们为准：

- 「只应该存在一套本体」「必须合并 只有一个 ontology」
- 「不应该叫 schema 吗？本体的规范看起来完全没遵守」
- 规范做到哪一层：选 1 ——「用规范的结构和术语，源文件仍是 JSON，再自动导出一份标准格式」
- 模型的元数据增加了，属性要定义清楚；目录来源的模型和供应商「不要那么多」

其余都是为落实这些决定提出的设计，标了「提议」的部分可以改。

## 2. 现状

类型定义现在有三处，其中五种概念定义了两遍：

| 位置 | 内容 | 谁在读 |
|---|---|---|
| `datasets/ontology/releases/v1.0.0/model.json` | 5 种概念、4 种关系 | 本体自己的构建与检查、数据库导入 |
| `datasets/ontology/releases/v1.0.0/schema.json` | 数据文件每一行的格式（JSON Schema），不是本体 schema | 同上 |
| `datasets/semantic/semantic-model.v2.json`（2.1.0） | 10 种节点、11 种关系、24 个词表、29 条规则、设计札记 | 整条数据流程、网站标签 |
| `db/migrations/*.sql` | 表、列、约束 | PostgreSQL |

对照本体的通行做法，缺的是：

1. schema 和数据没有分开命名，真正的 schema 叫 `model.json`，叫 `schema.json` 的是文件格式。
2. 类和属性没有命名空间与全局标识。
3. 属性没有声明：除「模型」外，各类的属性只存在于文件格式和 SQL 里。
4. 关系没有基数；两份文件写法不同（父/子类型，from/to）。
5. 人物、账号、帖子、事件在数据库里是实体，在类型定义里不是类。`extracted_event` 作为关系端点被特殊放行。
6. 词表、类型、规则、设计札记混在一个文件的同一层。
7. 规则是自然语言，自身不可校验。
8. 没有标准格式的导出。
9. 已移除的「能力」节点还留在定义里。

## 3. 目标结构

只留 `datasets/ontology/`。一个本体分两部分：

```
datasets/ontology/
  schema/
    schema.json            唯一的类型定义：类、属性、关系、词表、约束
    CHANGELOG.md
  data/
    gates.json             闸门实例（原 semantic/gates.v1.json）
    organizations.json     公司名单（原 semantic/organizations.json）
    model-catalog-map.json 目录归属方、供应商对照（原 datasets/ 根目录）
  releases/
    v1.0.0/                保留，同一个本体的上一版
    v2.0.0/                本次封存：schema + 概念实例 + 导出
  README.md  VERSIONING.md
```

- `datasets/semantic/` 删除，「语义层」「语义模型」这两个名字停用。
- `datasets/platform/` 是 v1.0.0 的前身，保留为历史，不再称为本体。
- 设计札记（观察到的问题、为什么这样设计）移到 `docs/data/semantic-layer-journal.md`，该文件改名为 `ontology-journal.md`。schema 里只留定义。

## 4. schema 的写法

源文件是 JSON，结构和术语按 RDFS/OWL、SKOS、SHACL 的概念来，一一对应，可以无损导出。

```json
{
  "ontology": "openaiwill",
  "version": "2.0.0",
  "namespace": "https://openaiwill.com/ontology#",
  "prefix": "oaw",
  "classes": {
    "Model": {
      "label": {"en": "Model", "zh-CN": "模型"},
      "definition": {"en": "...", "zh-CN": "..."},
      "identifier": "model_id",
      "storage": "pg:models",
      "sealed": false
    }
  },
  "properties": {
    "Model.level": {
      "domain": "Model", "range": "vocabulary:model_level",
      "min": 1, "max": 1,
      "definition": {"en": "Family or release.", "zh-CN": "系列还是具体版本。"},
      "source": "derived", "column": "models.level"
    }
  },
  "relations": {
    "makes": {
      "domain": "Organization", "range": "Model",
      "domain_cardinality": "0..1", "range_cardinality": "0..*",
      "storage": "pg:models.org_id", "sealed": false
    }
  },
  "vocabularies": { "model_level": { "version": "1.0.0", "closed": true, "terms": {} } },
  "constraints": [
    {"id": "constraint:family-has-no-version", "applies_to": "Model",
     "when": {"level": "family"}, "require": {"version": null, "variant": null},
     "statement": {"en": "...", "zh-CN": "..."}, "enforced_by": ["sql_check:models_family_has_no_version"]}
  ]
}
```

规定：

- **类**用大驼峰单数；每个类声明标识属性、存放位置、是否进封存包。
- **属性**键为「类.属性」，必须声明定义域、值域（数据类型、词表或另一个类）、最少和最多个数、含义、来源。`column` 指向它在数据库里的列，检查脚本据此核对列存在且可空性一致。
- **关系**声明定义域、值域、两端基数；带属性的关系（例如判定出的边，带证据等级、理由、方法）声明自己的属性。
- **词表**各自带版本。事件类型词表的版本继续写在每条事件的标记里并进入判定哈希；本体版本变化不影响它。
- **约束**分两种：有 `when`/`require` 的可以直接校验；只有 `statement` 的必须列出 `enforced_by`，指向执行它的 SQL 约束或代码，检查脚本核对被指向的对象存在。
- 类型一律是定义，不带「新增」「已存在」之类的过程标记。

## 5. 类

共 13 个。前 6 个的实例进封存包，其余在数据库。

| 类 | 含义 | 存放 | 封存 |
|---|---|---|---|
| MarketGroup | 归拢相关赛道的编辑领域 | 概念实例 | 是 |
| Market | 一个赛道或服务领域 | 概念实例 | 是 |
| Work | 一项工作：编辑的工作条目，或来源职业的任务 | 概念实例 | 是 |
| OccupationGroup | O*NET 职业大类 | 概念实例 | 是 |
| Occupation | O*NET 职业 | 概念实例 | 是 |
| Gate | 能力齐备后仍阻止自主完成的条件 | `data/gates.json` → `gates` | 是 |
| Organization | 我们跟踪的公司或机构 | `data/organizations.json` → `org_registry` | 是 |
| Person | 一个人，带身份出处 | `people` | 否 |
| SourceAccount | 一个被采集的社交账号，属于一个人或一个机构 | `source_accounts` | 否 |
| Post | 一条帖子的身份；每次采集的快照是它的观测 | `collected_sources` | 否 |
| Event | 一条去重后的更新 | `extracted_events` | 否 |
| Model | 厂商以某个名字发布的模型或模型系列 | `models` | 否 |
| Provider | 提供模型访问的平台 | `model_providers` | 否 |

不是本体类的：采集运行、抽取运行、判定运行、检查点、导入记录、迁移记录、帖子快照。它们是过程记录，说明某个事实怎么来的，继续只由数据库表定义，schema 里列一张「过程记录」清单注明不在范围内。

「能力」不再是类。

## 6. 属性

每个类的属性在 schema 里逐个声明。这里列出名单，定义文字在实现时照现有文件格式、SQL 注释和提示词写入，不新造含义。

**五种概念类共用**（MarketGroup、Market、Work、OccupationGroup、Occupation）：`id`、`label_en`、`label_zh_cn`（可空）、`origin`（词表）、`translation_status`（词表）、`scope_status`（词表）、`scope_note`（可空）、`definition`（可空：文本、语言、依据）。

**Gate**：`gate_id`、`gate_type`（词表）、`label_en`、`label_zh_cn`、`definition_en`、`definition_zh_cn`、`lifecycle`（词表）、`replaced_by`（可空）、`obsolescence_reason`（可空）。

**Organization**：`org_id`、`canonical_name_en`、`canonical_name_zh_cn`（可空）、`aliases`（多值）。

**Person**：`person_id`、`name`、`aliases`（多值）、`identity_url`（可空）。

**SourceAccount**：`account_key`、`platform`、`handle`、`platform_account_id`（可空）、`owner_kind`、`panel_role`（词表）、`panel_state`（词表）、`identity_grade`（词表）、`identity_url`（可空）、`language`（可空）、`focus`（可空）、`excluded`、`added_from`、`state_changed_at`。

**Post**：`source_id`、`platform`、`canonical_url`、`kind`、`published_at`、`is_reply`、`is_repost`、`conversation_id`（可空）。

**Event**：`event_id`、`kind`（词表）、`kind_vocabulary`、`subject_key`（可空）、`title`、`summary`、`announced_at`（可空）、`occurred_at`（可空）、`scheduled_for`（可空）、`occurrence_status`、`confidence`（可空）、`identity_confidence`（可空）。

**Model**（15 个，已在 2.1.0 写明）：`model_id`、`org_id`（可空）、`owner_name`（可空）、`level`、`parent_model_id`（可空）、`name`、`version`（可空）、`variant`（可空）、`status`、`released_at`（可空）、`first_seen_event_id`（可空）、`catalog_id`（可空）、`catalog_released_on`（可空）、`open_weights`（可空）、`output_modalities`（多值，可空）。

**Provider**：`provider_id`、`name`、`kind`（词表）。

这一步会新增四个现在只写在文件格式里的词表：`concept_origin`、`translation_status`、`scope_status`、`definition_basis`，以及外部映射用的 `mapping_relation`。取值照搬 v1.0.0，不改。

## 7. 关系

| 关系 | 定义域 → 值域 | 基数 | 存放 | 带属性 |
|---|---|---|---|---|
| has_market | MarketGroup → Market | 1..* 对 0..* | 封存关系 | 顺序 |
| has_work | Market → Work | 0..* 对 0..* | 封存关系 | 顺序 |
| has_occupation | OccupationGroup → Occupation | 1 对 0..* | 封存关系 | 顺序 |
| has_task | Occupation → Work | 0..* 对 0..* | 封存关系 | 顺序 |
| performed_by（提议的名字） | Work → Work（赛道工作 → 职业任务） | 0..* 对 0..* | `activity_task_edges` | 判官、方法、状态、置信度、理由 |
| blocked_by | Work → Gate | 0..* 对 0..* | `activity_gate_edges` | 同上 |
| employs（提议的名字） | Market → Occupation | 0..* 对 0..* | `market_occupation_edges` | 同上 |
| evidences（提议的名字） | Event → Work | 0..* 对 0..* | `activity_evidence` | 证据等级、方向、观察到的级别、理由 |
| verifies（提议的名字） | Post → Event × Work | 0..* | `verification_evidence` | 帖子性质、级别、是否独立 |
| links_to | Post → Event | 0..* 对 0..* | `event_posts` | 关联方式（词表）、深度 |
| extracted_from | Event → Post | 1..* 对 0..* | `extracted_event_sources` | 来源角色 |
| announced_by | Event → Organization | 0..1 对 0..* | `extracted_events.primary_org_id` | — |
| names_model | Event → Model | 0..* 对 0..* | `event_models` | 角色（词表）、原文、置信度 |
| makes | Organization → Model | 0..1 对 0..* | `models.org_id` | — |
| has_release | Model → Model | 0..1 对 0..* | `models.parent_model_id` | — |
| offers | Provider → Model | 0..* 对 0..* | `model_offerings` | 上架日期 |
| operated_by | Provider → Organization | 0..1 对 0..* | `model_providers.org_id` | — |
| owned_by | SourceAccount → Person 或 Organization | 恰好 1 | `source_accounts.person_id` / `org_id` | — |
| affiliated_with | Person → Organization | 0..* 对 0..* | `person_affiliations` | 关系（词表）、职务、起止、出处 |
| authored_by | Post → SourceAccount | 0..1 | `collected_sources.account_external_id` | — |
| replies_to / quotes / reposts | Post → Post | 0..1 | `collected_sources` 的三列 | — |

标了「提议的名字」的五个关系现在只有表名、没有关系名，名字需要用户确认或改。

已经没有数据支撑的 `requires`、`demonstrates`（指向已移除的能力）从 schema 删除。

## 8. 词表与约束

- 现有 24 个词表全部并入，取值不变。`autonomy_stage`（已退役的 0–4 刻度）和 `org_affiliation_role`、`person_event_role` 在迁入时逐个核对是否还有列在用；没有的移到 `retired_vocabularies`，保留定义、不再生成约束。
- 现有 29 条规则改写为约束。能写成 `when`/`require` 的改写；其余保留语句并补全 `enforced_by`。指向能力层的规则（例如 `rule:tier-caps-stage`）按同样办法核对后退役。
- 规则里的阈值（例如连续两次复核失败即退役、提及窗口 7 天）继续放在约束的 `expression` 里，代码继续从这里读，不在代码里重写。

## 9. 从 schema 生成的东西

| 产物 | 现在 | 之后 |
|---|---|---|
| 封存数据的文件格式（JSON Schema） | 由 `ontology-schema.mjs` 里手写的结构生成 | 由 schema 的类和属性生成，文件改名 `data-format.json` |
| SQL 约束 | 由语义模型生成，或手写后由检查脚本比对 | 由 schema 生成或比对，覆盖全部词表列 |
| 网站中英文标签 | `src/content/semantic-labels.json` | 改名 `ontology-labels.json`，内容来源不变 |
| 抽取与判定的提示词、判定标准 | 从语义模型读取 | 从 schema 读取，文字不变 |
| 标准格式导出 | 没有 | `releases/v2.0.0/ontology.ttl`：类与属性用 RDFS/OWL，词表用 SKOS，可校验的约束用 SHACL |

导出只进封存包，流程里没有任何东西读它。它的作用是证明 schema 可以无损转成标准格式；检查脚本校验导出文件能被解析，且类、属性、词条数量与 schema 一致。

## 10. 版本

- 本体 2.0.0：类型定义的范围和结构变了，按 `VERSIONING.md` 属于大版本。
- 概念和关系的 ID 全部沿用 v1.0.0，构建时逐个核对：v1.0.0 的 20,796 个概念、20,733 条关系、19,924 条外部映射在 2.0.0 里一个不少，内容哈希相同。
- 事件类型词表保持 2.0.0，`event_kind-2.0.0` 标记不变。
- 判定标准哈希、抽取提示词哈希、模型识别提示词哈希在迁移前后必须相同。这是每一步的验收条件。
- 数据库里的 `ontology_version` 列现在都是 `1.0.0`。提议：2.0.0 封存后新增一条本体发布记录，已有行不改写；新判定写 `2.0.0`。因为概念 ID 没变，两个版本的行可以直接连接。

## 11. 不变的

- 所有概念、关系、事件、模型的 ID。
- 数据库里的数据和已应用的迁移文件。
- 提示词文字和判定结果。
- 网站页面的内容；只有读取标签的文件路径变。

## 12. 实施顺序

每一步结束都跑 `pnpm check` 和 `pnpm data:test`，并核对第 10 节的三个哈希。

1. **写出 schema**：`datasets/ontology/schema/schema.json`，包含 13 个类、全部属性、关系、词表、约束。此时旧文件还在，新增一个测试核对两边的词表取值完全相同。
2. **读取方改指向 schema**：Python 的 `semantic.py` 改为 `ontology_schema.py`，Node 的 `semantic-model.mjs` 并入 `ontology-schema.mjs`，逐个模块切换。
3. **搬实例文件并删除旧文件**：闸门、公司名单、目录对照搬到 `datasets/ontology/data/`；删除 `datasets/semantic/`；`semantic:build`、`semantic:check` 并入 `ontology:build`、`ontology:check`。
4. **检查脚本补全**：属性对列、约束对执行者、词表对 SQL 约束。
5. **封存 2.0.0**：构建、ID 继承核对、标准格式导出。
6. **文档**：`CLAUDE.md`、`datasets/ontology/README.md`、`VERSIONING.md`、札记改名与迁入设计说明。

## 13. 这次不做

- 不把源文件换成 OWL/Turtle（用户选了方案 1）。
- 不给每个类补新的属性；只把已经存在的属性声明出来。
- 不重跑抽取或判定。
- 不处理目录里混入的非模型条目和没挂上系列的 12 个模型；它们是数据问题，另行处理。
- 不删除 `datasets/platform/` 和 `releases/v1.0.0/`。

## 14. 待用户确认

1. 第 5 节的范围：人物、账号、帖子、事件是否都算本体的类。提议是算，因为词表和关系已经在引用它们。
2. 第 7 节五个提议的关系名。
3. 第 10 节数据库里旧行的 `ontology_version` 不改写。
