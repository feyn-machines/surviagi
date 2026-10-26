---
name: surviagi-http
display_name: SurviAGI（HTTP）
display_name_en: SurviAGI (HTTP)
description: Search SurviAGI's published AI progress records over plain HTTP, and optionally submit research questions or X accounts with the reader's API key, for clients without MCP.
description_zh: 通过普通 HTTP 接口搜索 SurviAGI 已发布的 AI 进展记录；有读者 API Key 时可提交研究问题或建议监测的 X 账号。适用于不支持 MCP 的客户端。
description_en: Search SurviAGI's published AI progress records over plain HTTP, and optionally submit research questions or X accounts with the reader's API key, for clients without MCP.
version: 1.0.0
author: SurviAGI
allowed-tools: Bash
---

当用户需要查询 AI 能否独立完成某类工作、某个职业或行业受 AI 影响的证据，或想把问题交给 SurviAGI 研究时，用 Bash 运行 `scripts/surviagi.py`（只用 Python 标准库）：

```sh
python3 scripts/surviagi.py search "coding agents" --limit 5 [--types update,evidence] [--from 2026-10-01] [--language zh-CN]
python3 scripts/surviagi.py record <id>
# 以下需要环境变量 SURVIAGI_API_KEY（在 https://surviagi.com/zh-CN/agents#keys 生成）
python3 scripts/surviagi.py question --question "…" --why "…" --gap "…" [--leads "…"] [--related id1,id2]
python3 scripts/surviagi.py account @name --kind person --reason "…" [--field "…"]
python3 scripts/surviagi.py mine
```

输出是 JSON。读取规则与 MCP 版相同：区分 `machine_summary`、`post_quote`、`machine_reading`，附 `url` 和 `release.generated_at`，原文看 `sources`。提交前先搜索，问题与理由由你整理；提交只是待审核申请，不会自动研究或采集。脚本为每次提交自动生成 `request_id`，网络失败时可用 `--request-id` 传回同一个值重试，不会重复登记。
