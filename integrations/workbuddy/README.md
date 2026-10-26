# SurviAGI × WorkBuddy

Connector and Skill sources for [WorkBuddy](https://open.workbuddy.cn/docs/connector). Design and reasoning: [docs/superpowers/specs/2026-10-26-agent-access-workbuddy-design.md](../../docs/superpowers/specs/2026-10-26-agent-access-workbuddy-design.md). Human-readable guide: <https://surviagi.com/agents>.

## 内容

| 目录 | 是什么 | 认证 |
| --- | --- | --- |
| `surviagi/` | 连接器「SurviAGI 搜索」，远程 MCP `https://surviagi.com/api/mcp`，工具 `search`、`get_record` | 无 |
| `surviagi-submit/` | 连接器「SurviAGI 搜索与提交」，远程 MCP `https://surviagi.com/api/mcp/submit`，另有 `submit_question`、`suggest_account`、`my_submissions` | `auth_mode: token`，`Authorization: Bearer ${SURVIAGI_API_KEY}` |
| `skill-http/surviagi-http/` | 不用 MCP 的 Skill：`scripts/surviagi.py` 调用 HTTP 接口（只用 Python 标准库） | 提交时读环境变量 `SURVIAGI_API_KEY` |

WorkBuddy 的认证按整个连接器生效，所以免 Key 读取和带 Key 提交是两个连接器。

## 打包

源文件用 `mcp-server.json` 和 `skill/` 命名，因为仓库的公开文件闸门不允许 `mcp.json`、`skills/` 进入 Git。打包脚本组装成平台要求的结构：

```sh
node scripts/pack-workbuddy.mjs   # 写入被忽略的 out/workbuddy/
cd out/workbuddy && for d in surviagi surviagi-submit surviagi-http; do (cd "$d" && zip -qr "../$d.zip" .); done
```

## 用户怎样用

1. 只想查：安装「SurviAGI 搜索」，无需任何账号。
2. 想提交：在 <https://surviagi.com/zh-CN/agents#keys> 用 Google 登录生成 Key（`sag_…`，只显示一次），安装「SurviAGI 搜索与提交」并填入 Key。可随时在同一页面撤销。

## 实测记录

| 项目 | 结果 |
| --- | --- |
| 本地构建的服务器：MCP `initialize` / `tools/list` / `tools/call`，HTTP 接口，Key 缺失/无效/撤销，额度与重试 | 通过（`pnpm check` 中的 `site:test`，见设计文档） |
| WorkBuddy 客户端安装、连接、能力发现、搜索、详情、填 Key 提交 | **未测**：需要部署到 surviagi.com 并在 WorkBuddy 开放平台提交或开发安装 |
| `connector-meta.json` 名称/描述/示例字段名 | 待按平台模板核对 |
