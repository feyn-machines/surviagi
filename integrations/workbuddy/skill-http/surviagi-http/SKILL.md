---
name: surviagi-http
display_name: SurviAGI（HTTP）
display_name_en: SurviAGI (HTTP)
description: Search SurviAGI's published AI progress records and bilingual editorial articles over plain HTTP, and optionally submit research questions or X accounts with the reader's API key, for clients without MCP.
description_zh: 通过普通 HTTP 接口搜索 SurviAGI 已发布的进展记录和双语文章；有读者 API Key 时可提交研究问题或建议监测的 X 账号。适用于不支持 MCP 的客户端。
description_en: Search SurviAGI's published AI progress records and bilingual editorial articles over plain HTTP, and optionally submit research questions or X accounts with the reader's API key, for clients without MCP.
version: 1.2.0
author: SurviAGI
allowed-tools: Bash
---

当用户需要查询 AI 能否独立完成某类工作、某个职业或行业受 AI 影响的证据，或想把问题交给 SurviAGI 研究时，用 Bash 运行 `scripts/surviagi.py`（只用 Python 标准库）：

```sh
python3 scripts/surviagi.py search "coding agents" --limit 5 [--types update,evidence,article] [--status preview|approved] [--from 2026-10-01] [--language zh-CN]
python3 scripts/surviagi.py record <id>
# 某个职业或赛道的证据统计（与页面数字一致），可传 ID 或中英文名称
python3 scripts/surviagi.py summary --occupation "会计师与审计师" [--language zh-CN]
python3 scripts/surviagi.py summary --market accounting-audit-assurance
# 观察列表：按职业/赛道、组织、产品、证据类型、方向、日期过滤，--cursor 翻页
python3 scripts/surviagi.py observations --occupation 13-2011.00 [--evidence-types production_use,measurement] [--directions human_still_needed] [--from 2026-10-01] [--order newest] [--limit 10] [--cursor …]
# 以下需要环境变量 SURVIAGI_API_KEY（在 https://surviagi.com/zh-CN/agents#keys 生成）
python3 scripts/surviagi.py question --question "…" --why "…" --gap "…" [--leads "…"] [--related id1,id2]
python3 scripts/surviagi.py account @name --kind person --reason "…" [--field "…"]
python3 scripts/surviagi.py mine
```

输出是 JSON。文章结果会标明精确 `revision_id` 和 `status`：`preview` 是公开预发布、尚未批准；`approved` 是双语当前批准版本。用 `record` 可读取全文、来源和证据截止时间。私有草稿及审核意见不会被返回。问职业或生意时先用 `summary`，计数截至 `counts.as_of`，是机器从采集帖子里读出的观察数，不是被替代的比例；观察的 `task` 是概括，数字请引用 `facts[].quote` 原文。数据记录仍需区分 `machine_summary`、`post_quote`、`machine_reading`，附 `url` 和 `release.generated_at`，原文看 `sources`。提交前先搜索，问题与理由由你整理；提交只是待审核申请，不会自动研究或采集。脚本为每次提交自动生成 `request_id`，网络失败时可用 `--request-id` 传回同一个值重试，不会重复登记。
