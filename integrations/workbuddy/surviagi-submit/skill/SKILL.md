---
name: surviagi-submit
display_name: SurviAGI 搜索与提交
display_name_en: SurviAGI Search & Submit
description: Search SurviAGI's published AI progress records, and with the reader's API key submit research questions and X accounts to monitor as requests for review.
description_zh: 搜索 SurviAGI 已发布的 AI 进展记录，并用读者的 API Key 提交研究问题和建议监测的 X 账号（待审核申请）。
description_en: Search SurviAGI's published AI progress records, and with the reader's API key submit research questions and X accounts to monitor as requests for review.
version: 1.0.0
author: SurviAGI
examples_zh:
  - 帮我查一下 AI 法律助手的进展；如果没有相关研究，就把这个问题提交给 SurviAGI
  - 把 @某个账号 推荐给 SurviAGI 监测
examples_en:
  - Look up progress on AI legal assistants; if nothing covers it, submit the question to SurviAGI
  - Suggest @someone to SurviAGI for monitoring
---

## 搜索与读取

与「SurviAGI 搜索」相同：先 `search`，再对相关结果 `get_record`；区分 `machine_summary`（摘要）、`post_quote`（原话摘录）和 `machine_reading`（机器等级），附上记录 `url` 和数据版本 `generated_at`，原文请给出 `sources` 链接。所有内容均为机器提出、未经审核。

## 提交研究问题（submit_question）

只在用户明确同意提交时调用。提交前必须：

1. 先用 `search`（必要时 `types: ["question"]`）确认没有已发布的同类问题；有就读取并告诉用户，不要提交。
2. 由你根据对话整理：
   - `question`：一句话、具体，关于 AI 完成真实工作（某个职业、某类业务或某项能力），8–300 字符；
   - `why_it_matters`：答案为什么重要、对谁重要，20–1000 字符，不能重复问题本身；
   - `evidence_gap`：你搜索过的记录缺什么，10–1000 字符；
   - `leads`（可选）：来源、账号、日期、链接；
   - `related_record_ids`（可选）：搜索中看到的相关记录 ID，最多 10 个；
   - `request_id`：为这次提交生成一个唯一 ID（如 UUID）。重试时使用同一个 `request_id`，不会重复登记，也不会多占额度。
3. 把结果告诉用户：`result` 为 `created` 时给出申请编号 `id` 和状态 `pending`；`duplicate` 表示用户之前提交过；`published` 表示已有公开话题，给出链接；`quota` 错误时说明是待审核数量还是今日新增达到上限。

提交的问题只有用户本人和审核人可见，不会按原文公开；是否研究由审核人决定，不会自动启动研究。

## 推荐监测账号（suggest_account）

参数：`account`（@name、name 或 https://x.com/name）、`kind`（`person` 或 `organization`）、`reason`（推荐理由，最多 280 字符）、`field`（相关领域，可选）、`request_id`。`monitored` 表示已在监测；`duplicate` 表示用户推荐过。提交申请、审核通过、身份确认、启用监测是不同阶段，推荐本身不会启动采集，也不代表身份已确认。

## 查看状态（my_submissions）

返回用户最近的问题与账号推荐及审核状态，以及今日剩余额度（按 UTC 日计算；所有 Key 和网站表单共用）。

## Key 出错时

`missing_key` 或 `invalid_key`：请用户到 https://surviagi.com/zh-CN/agents#keys 检查或重新生成 Key，并在连接器设置中更新。搜索与读取不受 Key 影响。
