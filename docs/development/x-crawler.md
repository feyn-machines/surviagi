# X 采集爬虫运行手册

项目唯一的采集组件，位于 `local/x-crawler/crawler/`（2026-10-03 起只在本地维护，不进 Git；同目录还有测试 `tests/` 和 X 登录模块 `login/`），统一入口 `pnpm crawl <timeline|lookup|doctor>`（`crawl:x`、`crawl:lookup` 是前两者的别名）。Agent 通过 `crawler` 技能调度它；技能不含采集代码，新能力一律加进本组件。原技能 `social-qingguo-collector` 与单账号入口 `collect-official-x.py` 已于 2026-09-27 删除（技能归档在忽略的 `data/archive/skills/`）。设计见 [爬虫子系统设计](../superpowers/specs/2026-09-14-crawler-subsystem-design.md)。

数据流分三段独立：**采集**(本手册,`local/x-crawler/crawler`)→ **入库到采集库**(`data:ingest:x`,见下)→ **市场范围计算批次**(现有 `run_batch`,单独一步,本手册不含)。采集只产运行归档、不知道市场/指标;入库把归档幂等落进独立的采集库(不带市场/权重/指标/进度);计算阶段再从采集库按范围选证据。**不做**官网发布记录对账、事件抽取或估计。

## 组件结构

```
local/x-crawler/crawler/
  cli.py          pnpm crawl 的子命令
  core/           与数据源无关的机制
    scheduler     唯一的调度器：并发 worker、按失败类型换号/冷却/重试/停批
    accounts      账号池：租借（同一账号不会同时借给两个 worker）、冷却、失效，即时落盘
    errors        失败分类：RateLimited / AuthFailed / TransportError / SchemaChanged
    archive       不可覆盖的运行文件与原始响应、实现哈希
    proxy         青果代理配置（只读项目根 .env）与 TLS
    progress      进度显示
  x/              X 数据源
    client        twikit 会话（唯一联网模块），记录 x-rate-limit-* 响应头
    compat        twikit 2.3.3 补丁
    parse         纯解析与任务规划
    timeline      时间线任务
    lookup        handle → user id / 公开资料任务
```

每类任务只提供"怎么做一个任务"，账号策略全部在 `core/scheduler`。新增数据源（如 Reddit）作为与 `x/` 平级的包加入，复用调度、存档与入库衔接。

## 采集哪些账号

账号都在数据库 `public.source_accounts`，爬虫直接读表，不再经中间文件：

- 官方号：`panel_role='official'`，由 `pnpm data:official:import` 从 `datasets/official-x-accounts.json`（经核验的公开名单，仍是官方号的来源与证据）幂等导入，归属机构记在 `org_id`。已确认、有数字 user id 的账号会启用；其余作为候选，不采集。名单更新后重跑导入即可。
- 名单账号：其余角色，由 `pnpm data:panel:import` 导入研究草稿。
- 账号状态只由检查记录推导（`rule:panel-lifecycle`）。机构自己的账号对本机构不独立（`rule:panel-independence`），在验证中不算第三方。

`--targets official|panel|all` 选采哪一类，默认 `official`。官方号和名单账号默认分开跑，让一次运行只含一类来源（事件抽取把运行里的原创帖都当候选）。`--registry <file>` 可改为读指定名单文件（离线或排查用）。运行文件记录 `targets`（来源与类别）和所用账号列表的哈希 `registry_sha256`。

## 前置

- 代理：`X_PROXY`（或 `QINGGUO_PROXY_URL` / `SOCIAL_PROXY_URL`）在 `.env`，青果隧道入口。代理是基础设施凭据，留在 env。入口同一端口同时接受 http 与 https；入口证书 2026-09-27 过期后，自 2026-09-29 起按用户决定改用 `http://`：代理账号密码明文传输，x.com 流量仍在 CONNECT 隧道内端到端 TLS。运行文件记录 `proxy_transport`。青果必须经本机 VPN（Shadowrocket）出去，不能 DIRECT；但 VPN 会把按域名发出的明文代理连接送错地方（表现为 Cloudflare 400），按 IP 则正常，所以 `X_PROXY` 用入口 IP（2026-09-29：`overseas.tunnel.qg.net` → `overseas-us.tunnel.qg.net` → `23.236.65.26`）。青果换 IP 时 `pnpm crawl doctor` 会报错，届时用公共 DNS 重新解析。
- 账号池：`data/secrets/x-accounts/pool.json`（gitignore、0600）。字段 `username,password,totp_secret,email,email_password,auth_token,ct0,status,cooldown_until,last_used_at,label`。仅 token（有 `auth_token`、`ct0` 为 null）的账号可用——引擎会合成 32 位 ct0（cookie 与 `x-csrf-token` 同值，X 读接口接受），已于 2026-09-14 实机验证。
- venv：`data/runtime/crawler-venv`。首次或依赖变更后 `pnpm crawl:setup`（装 `local/x-crawler/requirements.txt`：twikit 2.3.3、httpx 0.28.1、psycopg 3.3.5）。
- 本地 PostgreSQL 已 `pnpm data:up`：读账号与自动入库都经 `core/store.py` 借用 `data_pipeline` 的连接。
- 自检：`pnpm crawl doctor` 检查代理配置、账号池（数量、健康态、0600 权限）、本地数据库中可采集的官方号/名单账号数与 twikit，不访问 X、不打印凭据。

## 运行

```sh
# 只看计划、不访问 X
pnpm crawl:x -- --start 2026-08-24T00:00:00Z --end 2026-09-14T00:00:00Z \
  --plan-only --output data/collection/official-x/plan.json

# 三周基准（默认并发 5）
pnpm crawl:x -- --start 2026-08-24T00:00:00Z --end 2026-09-14T00:00:00Z \
  --concurrency 5 --output data/collection/official-x/three-week-baseline.json

# 定向账号 + 已知公告验收
pnpm crawl:x -- --start ... --end ... --handles OpenAI \
  --expect-post <postid> --output data/collection/official-x/openai.json
```

账号查询（名单解析 handle → user id 与公开资料；worker 在成功后保留账号与连接给下一个 handle，因为每次只是一个请求）：

```sh
# 默认查库里还没有 user id 的账号；--all 刷新全部在册账号的资料
pnpm crawl lookup --output data/collection/lookups/<new-run>.json
```

查完自动写成账号检查记录并重新推导状态（`--no-ingest` 跳过；之后可用 `pnpm data:panel:lookup-import <run>.json` 补录）。`--handles` / `--handles-file` 可指定 handle。

退出码：0 完成，2 完成但需处理，1 启动被拒绝。

窗口用 `[start, end)`，需带时区。输出必须是 `data/` 下尚不存在的 `.json`（运行不可覆盖）；原始页写入同名 `.pages/<jobid>/` 目录，逐页 SHA-256。参数：`--concurrency`、`--count`（每页请求数，默认 40）、`--max-pages`、`--max-requests`、`--timeout`、`--pace`（≥3s）。账号自动按健康态从池中挑选，无需指定。

## 进度

运行时向 stderr 打印进度。TTY 下是原地刷新的多行块（总体 + 每个活跃 worker `@handle 第N页 (账号label)` + 账号池 usable/cooldown/dead）；重定向到日志时是节流的单行汇总加 failover 里程碑行。收尾打印一行总结：完成/incomplete 数、总帖数、请求数、用时、账号冷却/失效数、reconciliation 状态。

## 入库到采集库（data:ingest:x）

时间线运行结束后**自动入库**（`--no-ingest` 跳过）。入库失败不影响运行文件，退出码为 2，之后可手动补：

把一次爬虫运行归档幂等地落进 Postgres 里独立的采集库（migration `004_collection_store.sql`：`collection_runs / collected_sources / collected_captures / collection_gaps`）。这层不带市场范围、权重、指标或进度——那属于后续的计算批次。

```sh
pnpm data:ingest:x -- data/collection/official-x/<run>.json
```

`run_id` 取运行文件名(stem)。同一 `run_id` 内容相同再 ingest 是空操作(`reused:true`);同 `run_id` 内容不同会被拒绝。同一帖跨多次运行出现 = 多条 capture(按时间的观测),查询时按 `(platform, source_id)` 去重。凭据不入库,只存被监控账号的公开身份;原始页留磁盘,采集库按 SHA-256 在 `collection_runs.raw_pages` 引用。走 `data/runtime/venv`(psycopg),需本地 PG 已 `pnpm data:up`。

真实验证(2026-09-14):把 `smoke-2handle` 运行入库,得 22 sources / 22 captures / 2 gaps(OpenAI 17、AnthropicAI 5,均 complete),互动指标(含 null)如实保留,采集库无任何凭据列,重放 `reused:true`。

## 并发与代理模型

青果隧道**每条新连接换一个出口 IP，连接内 IP 稳定**。因此一个账号绑一条独占连接（`max_connections=1`）= 一个稳定 IP 覆盖其整个抓取；账号之间并发即天然把足迹摊到不同 IP。约 1/5–1/6 的连接会 `ConnectError`（坏出口 IP），按 transport 错误在新连接上重试，不判账号失效。青果套餐并发上限未知（3 路已验证干净），并发度从保守值起步、可配。

## 失效转移

限流后换号是已确认的项目规则（2026-09-27）。

- 限流（429 / X 错误码 88、130）：账号冷却到 X 给出的重置时间（`x-rate-limit-reset` + 5 秒；没有或超过 1 小时则用固定 900 秒），该 job 换别的账号重试（计入 `--max-attempts`，默认 4）。
- 预判限流：每页记录 `x-rate-limit-remaining`。额度用尽而窗口未翻完时，任务主动按限流处理并换号，不等 X 回 429；任务结束时额度已用尽的账号也先冷却。
- 认证失败（401/403 / 码 32、89、215、353 / 账号锁定/封禁）：账号标 `dead`，job 换账号重试。
- 传输错误（`ConnectError`、超时等）：不判账号问题，同账号换新连接（新 IP）重试，另计 `max_transient`（默认 8）。
- 结构变化（接口 404，或响应结构解析器不认识）：`SchemaChanged`，**整批停止**，不重试、不换号（换哪个账号都是同样结果），不判账号失效。运行文件 `schema_change` 记下出错任务与原因，原始页留在 `.pages/`，据此修 `x/parse.py` 或 `x/compat.py`。
- 单条记录无法解析（如不可用的帖子）：该 job 记 `parse_error:*`，不重试，其余 job 继续。
- 不算解析失败的三种情况（2026-10-05）：时间线数据旁带着字段级 `errors`（如长文字段的 214）时照常读已返回的帖子；订阅者专属帖（`TweetPreviewDisplay`）跳过；没有帖子的页面即时间线到头（`empty_page`），不论是否带 cursor，因为 X 在最后一条之后仍会给 cursor。
- twikit 自身读不懂某次响应（`KeyError` 等）按传输错误处理，换新连接重试。
- 账号换遍仍不成 → 该 job `incomplete` 并记原因，不阻塞其余 job。单账号错误被转移消化后不影响整次 `ok`。

## 成败判据

`ok=True` 要求：所有 job 达到 `search_ended`（翻过窗口起点）、无缺失的 `--expect-post`。否则 `needs_attention`。`coverage_status=provider_timelines` 只表示 X 返回的时间线翻过了起点，**不代表重大发布已收齐**——官网对账仍需另行实现。

## 凭据安全

账号密码、2FA、auth_token、ct0、邮箱密码、代理凭据**绝不**进 Git、运行输出、日志或进度；对外只用 `label`。原始页只存响应体，不含请求头/cookie/代理。池与输出在忽略的 `data/` 下。

## 验证

- 离线单测：`pnpm crawl:test:unit`（解析、账号池冷却/失效/LRU/租借互斥、引擎窗口/身份/cursor/限流、按重置时间冷却与预判限流、结构变化停批、单条解析失败、并发调度、失效转移、传输重试、账号查询、CLI、进度渲染、输出组装、凭据不外泄），已并入 `pnpm check`。
- 实机烟囱（2026-09-14）：`@OpenAI`+`@AnthropicAI` 三天窗、并发 2，两账号并行、各自合成 ct0，均 `search_ended`，reconciliation 命中三条 OpenAI 金融服务公告 ID（旧采集遗漏的那批）。

## 尚未完成

官网发布记录自动对账；回复/评论**正文**抓取（现仅采 `replies` 计数）；链接与媒体字段解析；定时/增量重跑调度；事件抽取与定向 Reddit/X 深挖；**段 3**（采集库→市场范围计算批次的投影与估计，走现有 `run_batch`）。采集(段1)与入库到采集库(段2)已实现。旧手册 [official-x-monitoring](official-x-monitoring.md) 描述的是已删除的单账号入口。

**基准已建立(2026-09-14)**:全 51 账号、窗口 `[2026-08-24, 2026-09-14)`、并发 5、每账号 20 页，一次跑完 51/51 complete、0 incomplete、1625 帖(原创~880/转推435/回复310)、164 请求、3分06秒、0 冷却/失效、6 次传输重试自愈。已 `data:ingest:x` 入库为 `run_id=baseline-3wk`(1625 sources/captures、51 gap 全 complete)。早先 calib-3day(115)与 smoke-2handle(22)的帖被完整覆盖并再次观测,证明同一帖跨运行的多 capture 观测序列成立。运行文件 `data/collection/official-x/baseline-3wk.json`(gitignore 的 `data/` 下)。

## 相关

- 与外部实现 `x-account-client` 的对比及借鉴建议，见 [X 采集实现对比 spec](../superpowers/specs/2026-09-23-x-account-client-crawler-comparison.md)。

## 按搜索采集（2026-10-07）

时间线采集只读名单里的账号。搜索读的是任何人就某个对象发的帖子，所以能触及名单之外的账号。

```sh
pnpm crawl search --query "Qwen3.8-Flash-Next" --query "Strata Qwen3.8-Flash-Next" \
  --start 2026-09-29T00:00:00+00:00 --end 2026-10-07T00:00:00+00:00 \
  --output data/collection/search/<run>.json
```

- 每个 `--query` 是一个任务；`--queries-file` 每行一个查询。时间窗口以 X 自己的 `since:`/`until:` 写进查询，并按帖子时间再过滤一次；回复不取，转发不留。
- `--product Top`（默认）取 X 排序后的结果，`Latest` 取最新的。`--max-pages` 默认 3，搜索到这里就结束，运行文件里记为 `search_ended / page_budget`。
- 运行文件和时间线的格式相同，照常入库；`coverage_status=provider_search`。**搜索给的是样本，不是全量**，不能据此说“共有多少人在说”。
- **搜索的 404 是请求签名被拒，不是账号或额度问题（2026-10-11 实测，更正此前的结论）**：X 对搜索接口校验 `X-Client-Transaction-Id`（时间线接口不校验），不接受时在约 10 毫秒内返回空的 404。新建的签名约四成被拒；成败跟签名走，不跟账号走（被拒的签名换到别的账号同样被拒，被接受的签名换到别的账号同样可用）。每个账号的真实额度是每 15 分钟 50 次搜索，几乎用不到。处理：被拒时在同一账号上换一份签名重试，最多 `SIGNATURE_ATTEMPTS`（4）次；被接受的签名留给后面的会话用，失效就丢掉；连续被拒才让该账号休息 120 秒、任务换号。签名为什么有四成算错没有定位（算法来自 twikit 和 `x/compat.py` 的补丁）。
- 此前记录的“约一半账号搜索会 404”（10-07）和“一轮约 30 个查询、14 个账号全部被搜索限流”（10-09，60 个查询完成 29 个）都是这个原因：当时每次被拒都记成限流并换号。修正后同样 60 个查询 5 分 49 秒全部完成（2026-10-11，`search-topics-2026-10-11`），仍有 9 次连续 4 份签名被拒后换号。不需要为搜索扩充账号。
- 搜到的作者不在名单里。它的帖子在提取时产生了更新，才登记为候选账号（`rule:search-finds-candidates`）：归属未知、角色未分类、身份依据为“搜索发现”。候选账号不按时间线采集、不会被启用、不进入路由和公开的声音名单。
- 提取搜索到的帖子：`pnpm data:extract:events --targets search --window-start … --window-end … --output data/extraction/<run>.json`。

