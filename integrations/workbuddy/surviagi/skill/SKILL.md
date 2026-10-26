---
name: surviagi-search
display_name: SurviAGI 搜索
display_name_en: SurviAGI Search
description: Search and cite SurviAGI's published records of AI progress (updates, questions, evidence) through the SurviAGI MCP tools.
description_zh: 通过 SurviAGI 的 MCP 工具搜索并引用已发布的 AI 进展记录（更新、问题、证据）。
description_en: Search and cite SurviAGI's published records of AI progress (updates, questions, evidence) through the SurviAGI MCP tools.
version: 1.0.0
author: SurviAGI
examples_zh:
  - AI 编程助手最近有哪些官方更新？
  - AI 会取代会计吗？SurviAGI 有哪些证据？
examples_en:
  - What have AI companies shipped for coding agents recently?
  - Will AI replace accountants? What evidence does SurviAGI have?
---

当用户问到 AI 能否独立完成某类工作、某个职业或行业是否会被 AI 取代、某家 AI 公司最近发布了什么，按以下步骤使用 SurviAGI：

1. 调用 `search`，`query` 用用户问题里的关键词（公司、模型、工作类型、职业；中英文都可以）。需要时用 `types`（`update`、`question`、`evidence`）和 `from`/`to`（YYYY-MM-DD）缩小范围，`limit` 默认 8、最多 20。用户用中文时传 `language: "zh-CN"`，链接会指向中文页面。
2. 对最相关的 2–5 条结果调用 `get_record`（传结果里的 `id`），读取详情、来源和读数。
3. 回答时：
   - 区分文字的性质：`machine_summary` 是 SurviAGI 根据来源写的摘要，不是原话；`post_quote` 是帖子原话摘录；`machine_reading` 是机器给出的等级。所有内容都是 `machine_proposed_unreviewed`（机器提出、未经人工审核）。
   - 等级看 `level`（证据层级允许的等级），`claimed_level` 是封顶前的判断，二者不同时要说明。
   - 每条结论附上记录的 `url`，并注明数据版本的 `generated_at`；需要原文时给出 `sources` 中的原始链接。来源帖子全文不在 SurviAGI 中（`original_text.available` 为 false），不要把摘要说成原文。
   - 说清楚记录没有覆盖什么。搜索无结果不代表没有进展，只代表 SurviAGI 尚未收录。
4. 本连接器只读，不能提交。用户想把问题交给 SurviAGI 研究或推荐账号时，告诉用户安装「SurviAGI 搜索与提交」连接器并在 https://surviagi.com/zh-CN/agents#keys 生成 API Key。

SurviAGI 只负责检索；分析和结论由你完成，并应保持审慎。
