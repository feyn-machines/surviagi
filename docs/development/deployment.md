# 网站部署手册

2026-10-04 已执行首次发布（先数据，后代码）。本文是操作说明，不记录各次部署的版本号；当前版本用 `pnpm site:status` 和 `pnpm data:releases` 查看。设计依据见[服务器数据库与数据发布设计](../superpowers/specs/2026-10-03-server-database-and-data-releases-design.md)（取代 [SEO、GEO 与部署设计](../superpowers/specs/2026-10-03-seo-geo-deployment-design.md) 中"数据不离开本机、全站预生成"的部分），安全边界见 [SECURITY.md](../../SECURITY.md)。

## 1. 概览

发布分两条独立的线，各有各的命令、版本号和回滚：

| | 发布代码 | 发布数据 |
| --- | --- | --- |
| 发布什么 | 网站程序（不含任何数据） | `datasets/published/latest/` 里处理好的快照，作为数据库中的一个不可变版本 |
| 命令 | `pnpm site:release` → `pnpm site:promote` | `pnpm data:release` → `pnpm data:promote` |
| 回滚 | `pnpm site:rollback` | `pnpm data:rollback` |
| 查看 | `pnpm site:status` | `pnpm data:releases` |
| 版本号 | `<构建时间 UTC，YYYYMMDDTHHMMSSZ>-<git 短哈希>`；跟踪文件有未提交修改时加 `-dirty` | `<快照生成时间 UTC>-<内容哈希前 8 位>` |
| 生效方式 | 候选容器通过检查后切换正式容器 | 写入数据库的生效指针；网站每 30 秒查一次，不需要重新发布代码 |

网站启动时从数据库读取当前生效的数据版本。两个槽位都带 `SITE_REQUIRE_DATABASE=1`：数据库连不上时网站启动即退出；数据库可连但还没有生效的数据版本时网站能启动，但 `/healthz` 返回 503，容器不会变健康，`docker compose up --wait` 最多等 180 秒后失败。所以首次上线必须先发布数据，再发布代码。

### 服务器上有什么、没有什么

- 有：网站的代码发布目录（几十 MB，不含数据）、PostgreSQL 数据库（已发布的数据在 schema `kg`，用户数据在 schema `app`，见第 8 节）、两个环境文件（口令和设置）、用户数据的每日备份目录 `<DEPLOY_ROOT>/backups/`。
- 没有：原始抓取档案、采集程序及其登录/代理状态、重试状态、本机处理过程中的中间数据、本机数据库。采集和处理一直在本机运行；`pnpm data:release` 只把处理好的发布快照写进服务器数据库。
- 用户数据（登录账号、读者提交的账号、订阅、管理员名单）放在单独的 schema `app`，由单独的角色拥有；数据发布永远不读不写它。以后的 API Key、Agent 上报同样放在 `app` 之外的单独 schema，只通过 `kg.entities` 的稳定标识引用知识数据。

### 服务器与槽位

- 服务器：Ubuntu 24.04 x86_64，装有 Docker Compose v2（先用 `docker version` 看 Docker Engine 版本：低于 28 的版本里，发布在 `127.0.0.1` 的端口可能被同一二层网段的主机访问到；数据库仍要求 scram 口令，但建议升级）；防火墙只放行 SSH，80/443 关闭；所有入站流量经现有的 Cloudflare Tunnel（`cloudflared`，令牌方式，路由在 Cloudflare 后台配置）。
- 服务器地址、用户、密钥文件只写在本机被忽略的 `.env.deploy`，不进任何受版本控制的文件。口令不在本机任何位置。
- 服务器上每个代码版本一个目录：`<DEPLOY_ROOT>/releases/<id>/`（默认 `/opt/openaiwill`）。目录旁有状态文件 `current`、`previous`、`candidate`，各存一个版本号。
- 网站容器和数据库容器在同一个 Docker 网络 `openaiwill` 里，网站用名字 `openaiwill-db` 访问数据库。
- 三个 Compose 项目，各自只绑定 `127.0.0.1`：

| 项目 | Compose 项目 | 端口 | `SITE_ENV` | 说明 |
| --- | --- | --- | --- | --- |
| 正式站 | `openaiwill` | 8320 | `production` | Tunnel 指向这里 |
| 候选站 | `openaiwill-next` | 8321 | `preview` | 只能经 SSH 隧道预览，页面带 `X-Robots-Tag: noindex` |
| 数据库 | `openaiwill-db` | 5434 | 无 | 只能经 SSH 转发访问 |

- 正式地址（canonical）是 `https://surviagi.com`，不带 www（2026-10-08 改名，见 `src/lib/site-origin.ts`）。改名前的 `openaiwill.com` 和 `www.openaiwill.com` 保留，由网站自己逐页 308 跳转到新地址。服务器上的内部名字有意不改：`DEPLOY_ROOT` 默认 `/opt/openaiwill`，Compose 项目、容器、镜像、Docker 网络和数据库仍叫 `openaiwill*`。
- 官方账号：X `https://x.com/surviagi`，Discord `https://discord.gg/ArVHw2K9X`，GitHub `https://github.com/feyn-machines/surviagi`。每个页面的页眉页脚和 `llms.txt` 已链接它们。

## 2. 首次准备

### 本机

```bash
cp deploy/deploy.env.example .env.deploy
```

编辑 `.env.deploy`，填 `DEPLOY_HOST`、`DEPLOY_USER`、`DEPLOY_SSH_KEY`（私钥路径，密钥本身留在 `~/.ssh`）、`DEPLOY_ROOT`。预期：`git status` 不列出 `.env.deploy`。本机还需要 `rsync` 和已执行过 `pnpm data:setup`（数据发布用本机的 Python 环境）。

### 服务器要求

- 部署用户能无密码执行 `sudo`（脚本用 `sudo` 调用 Docker）。
- `docker compose` 为 v2，并装有 `curl` 和 `openssl`。
- 端口 8320、8321、5434 空闲。5434 已被占用时 `pnpm db:setup` 在启动数据库一步失败（Docker 报端口已被占用），随后的步骤不会执行，输出里没有 `database ready`；释放端口后重新运行是安全的。
- 磁盘：一个代码版本目录约几十 MB；服务器上最多同时有 7 个版本目录（最新 5 个，加 `current` 和 `previous`），Docker 镜像再占数倍；另有构建缓存，以及失败或未提升的版本目录（`promote` 只清理超出保留数的旧目录，不清理它们）。数据库占用见第 7 节。预留 5 GB。发布前检查：

```bash
ssh -i <密钥> <用户>@<地址> df -h /
```

预期：剩余空间明显大于 5 GB。

只清理 openaiwill 自己的东西：服务器上还有别的项目，不要运行 `docker builder prune` 或 `docker system prune` 这类全局清理（会删掉所有项目的构建缓存和镜像）。旧版本的镜像在 `promote` 时已按保留数自动删除；要查看：

```bash
ssh -i <密钥> <用户>@<地址> 'sudo docker image ls openaiwill-web'
```

没有被提升的版本目录（`release` 失败或候选被放弃）不会自动清理，确认它不是 `current`、`previous`、`candidate` 后手工删除，并删除对应镜像：

```bash
ssh -i <密钥> <用户>@<地址> 'rm -rf <DEPLOY_ROOT>/releases/<id>; sudo docker image rm -f openaiwill-web:<id>'
```

### Cloudflare（需要本人在后台操作，脚本不做）

服务器 80/443 关闭，把域名用 A 记录指向服务器 IP 不会生效。地址必须是 Tunnel 的公开主机名。

1. 确认 `surviagi.com` 和 `openaiwill.com` 的 DNS 都托管在运行这条 Tunnel 的同一个 Cloudflare 账号下；不在则先把域名的 NS 改过去。
2. 在 Tunnel 中添加四个公开主机名 `surviagi.com`、`www.surviagi.com`、`openaiwill.com`、`www.openaiwill.com`，都指向 `http://localhost:8320`。Cloudflare 自动建立 CNAME，不要手工加 A 记录。2026-10-16 查过：`surviagi.com` 和 `www.surviagi.com` 已配好；`openaiwill.com` 和 `www.openaiwill.com` 在 Cloudflare 里没有任何 DNS 记录（NS 在 Cloudflare，`dig` 查不到 A 或 CNAME），旧地址因此打不开，网站自己的跳转用不上——这两个主机名要补上。补好后用 `dig +short openaiwill.com @1.1.1.1` 确认有地址。
3. 跳转由网站自己完成：`www.surviagi.com`、`openaiwill.com`、`www.openaiwill.com` 对任何路径和查询串返回 308，Location 是固定的 `https://surviagi.com` 加原路径，只认这三个主机名（`/api/*` 也一样，`/healthz` 和静态文件除外）。Cloudflare 上的 301 重定向规则因此是可选的：加了也可以，`pnpm site:promote` 的公开检查对 `https://www.surviagi.com/` 接受 301 或 308 指向主域名；www 地址解析不到时该项不算失败。两个旧主机名不在公开检查里，用 `curl -sI https://openaiwill.com/markets` 看一次（预期 `308`，`location: https://surviagi.com/markets`）。
4. 关闭"阻止 AI 爬虫"（Block AI bots）和托管的 `robots.txt`。开着会覆盖站点自己的爬虫规则，GEO 部分的工作等于白做。
5. 不缓存 HTML：不要开启"Cache Everything"。语言跳转依赖源站响应，页面按请求渲染，数据发布后约 30 秒内变化；被边缘缓存的 HTML 无法即时更新。只缓存 `/_next/static/`（默认如此）。

## 3. 首次上线顺序

数据库和数据必须先于网站：候选站启动时就要从数据库读到一个已生效的数据版本。

```bash
pnpm db:setup
```

预期：在服务器上建目录 `<DEPLOY_ROOT>/db` 和 `<DEPLOY_ROOT>/backups`，建 Docker 网络 `openaiwill`，首次生成四个口令并写入两个环境文件（输出 `generated the database passwords on the server` 和 `wrote site.env`，不显示口令），启动数据库和备份容器（等待最多 180 秒），建三个角色、数据库 `openaiwill`、schema `kg` 和 schema `app`，最后在数据库容器自己的网络地址上（该地址上口令校验生效；回环地址和套接字在官方镜像里是免口令的，所以不用它们）用三个角色各自的口令连一次，并确认用错误口令连接 `oaw_site` 会被拒绝（若被接受，脚本以 `password authentication is not being enforced on the container network` 中止），用超级用户直接查权限，确认 `oaw_app` 对 `kg`、`oaw_site` 和 `oaw_kg_writer` 对 `app` 没有 USAGE，`oaw_app` 对 `public` 没有 CREATE（否则以 `isolation broken: <角色> <schema>` 中止），打印 `the three roles authenticate with their passwords over the container network, a wrong password is refused and neither the app role nor the site role reaches the other's schema; releases in kg: 0`，随后 `database ready (...)`，再经 SSH 转发把管理员名单同步进数据库（`administrators on the server: ...`，见第 8 节）。在已经运行过的服务器上再次运行（升级或重复运行），输出里没有 `generated the database passwords` 和 `wrote site.env`，只会出现实际做了的补充：`added the app password to db.env`（旧的 `db.env` 没有 `OAW_APP_PASSWORD`）、`added APP_DATABASE_URL to site.env`、`updated APP_DATABASE_URL in site.env to follow db.env`（`db.env` 里的口令变过）、`added BETTER_AUTH_SECRET to site.env`、`added BETTER_AUTH_URL to site.env`；什么都不缺时一行也没有。追加前脚本会先补上文件末尾缺的换行，不改动已有的行。开头还会校验 `db.env` 里已有的口令（必须是 48 位十六进制）：不合格时一行 `db.env has an unusable <KEY>; nothing was changed`（只给键名）并以状态 1 退出，什么都没改——常见原因是更早的一次手工编辑把两行粘在了一起，修好 `db.env` 再运行。检查之后脚本重启备份容器，使备份在结构建好之后立即做第一份。

**必须看到 `database ready` 这一行才算完成（其后只有管理员名单同步一行）**：只做了一半就中断（例如端口被占）时，随后的 `pnpm data:release` 也许能写入，但网站读不到数据，直到重新运行 `pnpm db:setup`。可重复执行：环境文件已存在时不会重新生成口令。

```bash
pnpm data:publish:snapshot
pnpm data:release
pnpm data:promote
```

预期：`data:release` 打印 `release <id> imported and verified`、与当前生效版本相比各集合的新增/变化/移除行数（首次是 `nothing (no active release)`）和 `not live yet`；`data:promote` 打印 `active release: <id>`，随后因为服务器上还没有网站，打印 `no production site is running yet`。

```bash
pnpm site:release
```

预期：见第 4 节；候选读到刚生效的数据版本并通过检查。构建镜像和启动容器的输出会实时显示在终端里。然后按打印的命令预览（`ssh -N -L 8321:127.0.0.1:8321 ...`，打开 `http://localhost:8321`，英文和中文在桌面和手机宽度下各看一遍），再：

```bash
pnpm site:promote
```

最后做公网检查和通知搜索引擎（第 9 节）。用户功能（Google 登录、提交、订阅）要多做几步，顺序见第 8 节。

## 4. 发布代码

```bash
pnpm site:release
```

预期，依次发生：运行 `pnpm check`（含构建）；组装 `.release/<id>/`（不含数据）；确认发布目录不含 `sharp`/`@img` 和禁止文件；在本机端口 8399 先以 `SITE_ENV=preview` 起服务跑冒烟检查并确认页面带 `X-Robots-Tag: noindex`——本机有快照目录（`datasets/published/latest/`）时服务以文件模式读它（`SNAPSHOT_DIR`，数据留在发布目录之外）并跑完整检查，没有快照时只跑不需要数据的子集（固定页面、跳转、404、`robots.txt`、`llms.txt`）——再以 `SITE_ENV=production` 起一次，确认 `/markets` 返回 200 且没有 `X-Robots-Tag`（上线前就证明正式环境可被索引）；这两次都不带数据库；清除服务器上旧的 `candidate`；rsync 上传（以服务器上的正式版本为参照，没变的文件在服务器上硬链接复用，只传有变化的部分）；以候选槽位启动并等待健康；随后开一条 SSH 本地转发（本机空闲端口 → 服务器 `127.0.0.1:8321`），对候选跑完整冒烟检查，并要求 `/healthz` 报告 `data.source` 为 `database` 且有数据版本号、页面带 `noindex`，通过后写入 `candidate` 文件、关闭转发，打印候选正在使用的数据版本和预览命令。`release` 不碰正式服务。

启动候选时 `docker compose up` 最多等 180 秒（正式切换和恢复同样）。候选没有变健康：脚本显示候选容器日志的最后 40 行和候选 `/healthz` 的内容（含 `candidate /healthz: ...`），并说明候选容器留在服务器上供检查。只有当 `/healthz` 的 `data.source` 是 `database` 且 `data.releaseId` 为空时才提示 `publish data first: pnpm data:release && pnpm data:promote`（先发布数据，再重新运行 `pnpm site:release`）；其他情况（构建失败、端口被占、缺少 `site.env`、缺少网络、容器反复崩溃）只提示 `the candidate did not become healthy; see the output above`，原因看上面的日志。候选冒烟失败时，不写 `candidate`（`promote` 因而拒绝它），候选容器留在服务器上供检查，命令列出失败项。其他常见失败：`pnpm check` 失败、本机冒烟失败、发布目录含禁止文件或原生二进制。

```bash
pnpm site:promote
```

预期：先在服务器上确认数据库可连（以 `oaw_site` 经容器网络地址）且有生效的数据版本，否则一行报错并停止，不动正式服务（`the database does not accept connections as oaw_site; production was not touched` 或 `the database has no active data release (pnpm data:promote); production was not touched`，`pnpm site:rollback` 同样先做这个检查）；校验候选仍健康；把它启动为正式服务并确认健康；成功后记录 `previous` 和 `current`，打印 `production is now <id>`，关闭候选，清理超出保留数的旧版本（保留最新 5 个，`current` 与 `previous` 受保护）；随后对 `https://surviagi.com` 做公开冒烟检查（请求带 `User-Agent: surviagi-release/1.0 (+https://surviagi.com)`；`/healthz` 报告新版本号、语言跳转、客户端导航请求、IndexNow 密钥文件、404、sitemap 中各类页面各一页、正式环境不带 `X-Robots-Tag`，以及 `https://www.surviagi.com/` 跳转到主域名），通过后向 IndexNow 提交 sitemap 中的地址并打印状态码。公开地址解析不到或连不上时，检查结果只列出一行 `<地址> is not reachable: <原因>`。

只想验证构建而不上传：

```bash
pnpm site:build
```

预期：以 `built <id> at .release/<id>` 结束。

```bash
pnpm site:status
```

预期：打印 `current`、`previous`、`candidate`、服务器上的版本目录列表、名称含 `openaiwill` 的容器，以及两行 `production slot (:8320): code <id>, data <数据版本> (database)` 和 `candidate slot (:8321): ...`；槽位没有运行时为 `not running`。

### 发布代码失败时会发生什么

- `release` 从不改动正式服务。
- `promote` 若新版本没有变健康：`current` 不变，并按情况输出：
  - 此前有在线版本：重新启动它并输出 `production restored to <id>`；重启也失败则输出 `RESTORE FAILED: production is down`（此时正式服务已停，需要立即处理）；原版本目录已不存在则输出 `RESTORE FAILED: production is down; <id> is gone`。
  - 要提升的版本就是当前在线版本：输出 `<id> did not become healthy; it is still the current release`，不输出 restored。
  - 首次发布（此前没有在线版本）：先停掉这个不健康的版本占用的正式槽位，再输出 `no earlier release to restore; production slot stopped`，避免它带着 `restart: unless-stopped` 一直占着端口。
- `promote` 已切换但公开检查失败（常见原因：Tunnel 主机名或 DNS 尚未配好）：报错信息以 `production IS switched to <id> and healthy on the server` 开头并列出失败项。纯连通性失败时提示修好 Tunnel/DNS 后运行 `pnpm site:indexnow`，不要回滚；若失败项是页面内容问题，才考虑 `pnpm site:rollback`。IndexNow 在检查失败时不会被调用，修好后单独运行：

```bash
pnpm site:indexnow
```

预期：打印 `IndexNow: <状态码> for <n> addresses`。要再次检查公开地址，可用：

```bash
python3 -c "import sys; sys.path.insert(0,'scripts'); import site_release as r; print(r.smoke(r.SITE_URL, None))"
```

预期：打印 `[]` 表示全部通过，否则列出失败项。

## 5. 发布数据

数据流：本机管线 → `pnpm data:publish:snapshot` → `pnpm data:release` → `pnpm data:promote`。三步都在本机运行；`release` 和 `promote` 经 SSH 转发（本机空闲端口 → 服务器 `127.0.0.1:5434`）连接数据库，转发每次用完关闭。数据库的写入角色口令从服务器的 `<DEPLOY_ROOT>/db/db.env` 读入内存，不显示、不写盘。

```bash
pnpm data:release
```

预期：把 `datasets/published/latest/` 在一个事务里导入为新版本，从数据库重新拼出整份数据并核对内容哈希，通过后标为 `verified`；打印新增文档数、与当前生效版本相比各集合的新增（`+`）、变化（`~`）、移除（`-`）行数，最后打印 `not live yet`。内容相同的快照再次发布是空操作（`already imported; nothing new`）。此时线上不变。

```bash
pnpm data:promote
```

预期：让最新的 `verified` 版本生效，打印 `active release: <id>`；随后通过 SSH 转发访问正式站 `/healthz`，最多等 60 秒，报告 `production site now serves data release <id>`（网站每 30 秒查一次生效指针，所以通常要等十几到三十秒）；超过 60 秒仍是旧版本则打印 `WARNING: ...`（数据库里已经生效，网站仍在重试读取，用 `pnpm site:status` 再看）；服务器上还没有正式站时打印 `no production site is running yet`，命令仍以状态 0 结束。

```bash
pnpm data:releases
```

预期：`active: <id>`，每个版本一行（`*` 标记生效版本、状态、行数、导入时间），并打印正式站当前加载的数据版本。

`pnpm data:local:release` 和 `pnpm data:local:promote` 对本机数据库做同样的事，用于开发和测试。

## 6. 回滚

### 代码

```bash
pnpm site:rollback
```

预期：同样先检查数据库；把 `previous` 记录的版本重新作为正式服务启动，打印 `production is back on <id>`。新版本没有变健康时同样会恢复回滚前的版本。没有 `previous` 时报 `there is no previous release to roll back to`。回滚代码不影响数据版本。

### 数据

```bash
pnpm data:rollback
```

预期：让上一个生效过的数据版本重新生效，打印 `active release: <id>` 并等待正式站报告它；约 30 秒内网站读到。连续运行两次会回到原来的版本。回滚数据不影响代码版本，也不删除任何数据版本。

## 7. 数据库

- **位置**：服务器上的 Compose 项目 `openaiwill-db`，镜像 `postgres:16-alpine`，数据在命名卷里，只绑定服务器的 `127.0.0.1:5434`，加入 Docker 网络 `openaiwill`（容器名 `openaiwill-db`），`restart: unless-stopped`。文件在 `<DEPLOY_ROOT>/db/`（`compose.yml`、`roles.sql`、`001_kg.sql`、`grants.sql`、`001_app.sql`、`db.env`），由 `pnpm db:setup` 从仓库的 `deploy/db/`、`db/published/001_kg.sql` 和 `db/app/` 写入。同一个 Compose 项目里还有备份容器 `openaiwill-db-backup`（第 8 节）。
- **角色**：超级用户（容器默认的 `postgres`）只在 `pnpm db:setup` 里使用；`oaw_kg_writer` 是数据库 `openaiwill` 和 schema `kg` 的所有者，数据发布以它连接；`oaw_site` 在数据库 `openaiwill` 里只有 CONNECT、`kg` 的 USAGE 和 `kg` 内现有及以后新建的表与视图的 SELECT（`public` schema 已对 PUBLIC 收回）。它还保留 PostgreSQL 对 PUBLIC 的默认权限，即能连接内置的 `postgres`、`template1` 数据库，但在那里没有任何对象权限；这里没有收回，以免影响超级用户自己的使用。数据发布只写 `kg`。第三个角色 `oaw_app` 只拥有 schema `app`，见第 8 节。
- **口令在哪**：四个口令（超级用户、`oaw_kg_writer`、`oaw_site`、`oaw_app`）在服务器上生成，存在 `<DEPLOY_ROOT>/db/db.env`（权限 600）；`<DEPLOY_ROOT>/site.env`（权限 600）含 `DATABASE_URL`（`oaw_site`，主机 `openaiwill-db`）和用户功能的设置（第 8 节）。口令不进 Git，不在本机任何文件里，不在脚本输出里。丢失 `db.env`（数据卷还在）时不丢数据、也不需要旧口令：超级用户经容器内的本地套接字连接不需要口令。恢复办法：在服务器上删除 `site.env`（`db.env` 已丢）——注意这会重新生成 `BETTER_AUTH_SECRET`，所有人会因此退出登录，Google 的两个值也要用 `pnpm site:env` 再传一次——然后在本机重新运行 `pnpm db:setup`。脚本会生成四个新口令，写出新的 `db.env` 和 `site.env`（`site.env` 里的 Google 值要再运行一次 `pnpm site:env`），重新创建数据库容器（数据卷不变），并把四个角色（含超级用户）的口令同步成新值；之后检查三个角色的口令。已经运行的网站容器还带着旧的 `site.env`：正式站继续用内存里已加载的数据提供服务，但重启后会因连不上数据库而起不来，所以要尽快重建。办法是 `pnpm site:release`，然后 `pnpm site:promote`：新的候选容器读新的 `site.env`，在动正式服务之前就证明新口令可用，新的版本号会让正式容器被重新创建。不想重新构建时的手动办法（在服务器上，`<current>` 是 `<DEPLOY_ROOT>/current` 文件里的版本号）：`cd <DEPLOY_ROOT>/releases/<current> && sudo RELEASE_ID=<current> HOST_PORT=8320 SITE_ENV=production SITE_ENV_FILE=<DEPLOY_ROOT>/site.env docker compose -p openaiwill up -d --force-recreate --wait --wait-timeout 180`，随后用 `pnpm site:status` 确认正式站在报告数据版本。
`site.env` 在而 `db.env` 丢了时，`pnpm db:setup` 会拒绝执行，提示先删 `site.env`。
- **备份**：知识数据可以从本机重新发布；用户数据有每日自动备份（第 8 节）。整库手动备份（超级用户经容器内的套接字连接，不需要口令；在本机运行，文件落在本机，注意它含全部已发布数据和用户数据，不要提交）：

```bash
ssh -i <密钥> <用户>@<地址> 'sudo docker exec openaiwill-db pg_dump -U postgres -Fc openaiwill' > openaiwill-$(date +%Y%m%d).dump
```

预期：生成一个非空的 `.dump` 文件。恢复到一个已经执行过 `pnpm db:setup` 的数据库：

```bash
ssh -i <密钥> <用户>@<地址> 'sudo docker exec -i openaiwill-db pg_restore -U postgres -d openaiwill --clean --if-exists' < openaiwill-<日期>.dump
```

预期：无错误退出；`pnpm data:releases` 列出备份时的版本。恢复期间网站继续使用内存里已加载的版本。只恢复用户数据用第 8 节的办法。
- **占用**：

```bash
ssh -i <密钥> <用户>@<地址> 'sudo docker exec openaiwill-db psql -U postgres -d openaiwill -tAc "SELECT pg_size_pretty(pg_database_size(current_database()))"'
ssh -i <密钥> <用户>@<地址> 'sudo docker system df'
```

预期：第一条打印数据库大小。各版本共享相同内容的行，所以每次发布只增加新增或变化的行。
- **数据库不可用时**：网站启动时连不上数据库会启动失败，候选检查不通过，不会被切到正式；已经在运行的网站继续使用内存里已加载的版本。`pnpm site:promote` 和 `pnpm site:rollback` 在动正式服务之前先检查数据库，数据库不可用时停下，不动正式服务。
- **销毁服务器上的全部已发布数据**（只在确实要从零开始时）：在服务器上 `cd <DEPLOY_ROOT>/db && sudo docker compose -p openaiwill-db --env-file db.env down -v`，再删除 `db.env` 和 `site.env`，重新 `pnpm db:setup`，然后 `pnpm data:release` 和 `pnpm data:promote`。`down -v` 同时删除用户数据（schema `app`），先按第 8 节备份并拷出；之后要运行 `pnpm db:setup`、`pnpm site:env`，再 `pnpm admins:sync`（`db:setup` 已经会同步一次）。

## 8. 用户数据（`app`）

### 存什么

schema `app`：Better Auth 的 `user`、`session`、`account`、`verification` 四张表（谁用 Google 登录过：姓名、邮箱、头像地址；会话）、`admins`（管理员邮箱名单）、`submissions`（读者提交的想让我们关注的 X 账号，以及管理员的批准或拒绝）、`subscriptions`（更新和每周文章的订阅）。表结构在 `db/app/*.sql`，每条语句都可重复执行。数据发布（schema `kg`）永远不读不写这里；采集到的原始数据不在服务器上。

### 三个角色各能碰什么

| 角色 | `kg` | `app` | 用途 |
| --- | --- | --- | --- |
| `oaw_kg_writer` | 拥有者，读写 | 无任何权限 | `pnpm data:release`、`pnpm data:promote`、`pnpm data:rollback` |
| `oaw_site` | 只读 | 无任何权限 | 网站读取已发布的数据（`DATABASE_URL`） |
| `oaw_app` | 无任何权限 | 拥有者，读写 | 网站的登录、提交、订阅和管理页（`APP_DATABASE_URL`）；`pnpm submissions:pull`、`pnpm admins:sync` |

schema `app` 由超级用户在 `deploy/db/roles.sql` 里创建并交给 `oaw_app`；表由 `oaw_app` 自己建。`oaw_app` 的搜索路径是 `app`。`pnpm db:setup` 每次都会以超级用户查权限：`oaw_app` 对 `kg`、`oaw_site` 和 `oaw_kg_writer` 对 `app` 不得有 USAGE，`oaw_app` 对 `public` 不得有 CREATE，否则中止。

### 口令和设置在哪

- 口令：`oaw_app` 的口令在服务器的 `<DEPLOY_ROOT>/db/db.env`（`OAW_APP_PASSWORD`，权限 600）。`db.env` 已存在但没有这一行时，`pnpm db:setup` 只追加这一行，其余行不动。
- 网站要这五项都有才会显示登录、提交、订阅，并让用户相关的 `/api/*` 工作；缺任何一项，网站照常运行，这些入口不出现：

| 设置 | 谁写入 | 说明 |
| --- | --- | --- |
| `APP_DATABASE_URL` | `pnpm db:setup` | `oaw_app`，主机 `openaiwill-db`；只在缺少时写入，`db.env` 里的口令变了就跟着改写 |
| `BETTER_AUTH_SECRET` | `pnpm db:setup` | 服务器上生成的 64 位十六进制串；只在缺少时写入。改它会让所有人退出登录 |
| `BETTER_AUTH_URL` | `pnpm db:setup` | `https://surviagi.com`；只在缺少时写入，所以改名前写下的旧值不会被改，要在服务器上手工改（2026-10-16 查过，服务器上已是新地址） |
| `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET` | `pnpm site:env` | 从本机被忽略的 `.env`（再看 `.env.local`，后者优先）上传 |

  这些都在 `<DEPLOY_ROOT>/site.env`（权限 600）里，不进 Git、不在脚本输出里、不带 `NEXT_PUBLIC_` 前缀。
- 管理员名单不在 `site.env`：本机 `.env` 里的 `ADMIN_EMAILS`（逗号分隔，不进 Git）被写进表 `app.admins`。网站每次检查都查这张表，所以改名单不需要发布。

### `pnpm db:setup` 对用户数据多做的事

在原有步骤之外：建角色 `oaw_app` 和 schema `app`；以 `oaw_app` 套用 `db/app/*.sql`；在 `site.env` 里补上缺少的设置；建 `<DEPLOY_ROOT>/backups`（权限 700）并启动备份容器；检查 `oaw_app` 的口令和隔离条件，重启备份容器；最后经 SSH 转发以 `oaw_app` 连接，把本机 `ADMIN_EMAILS` 同步进 `app.admins`，只打印个数：`administrators on the server: <n> on the list (+<增>, -<减>)`。本机 `ADMIN_EMAILS` 为空时只打印一行警告并跳过，数据库里的名单不动，命令不算失败。

### `pnpm site:env`

```bash
pnpm site:env
```

预期：打印 `set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET in site.env` 和 `restart the site for this to take effect: pnpm site:release && pnpm site:promote`。只设置这两个键，`site.env` 里的其他行不动，权限保持 600；值经标准输入发送，不出现在命令行或输出里。任一个值在本机缺失，或含空白、引号、`$`、`#`、反斜杠、反引号、换行，命令一行报错并退出，不连服务器。设置只在网站重启后生效，所以接着发布代码。

`pnpm site:release` 的候选检查会读 `site.env` 的键名（不读值）：五项设置都在时，候选的 `/api/me` 必须报告 `enabled: true`，否则候选检查失败，提示 `sign-in is configured but not answering`；设置不齐时不检查（功能本来就关着）。`/healthz` 还带一个 `app` 字段：登录功能未开启时是 `{"enabled": false}`；开启时是 `{"enabled": true, "ok": true|false}`，`ok` 表示用户数据库在 1 秒内答复了 `SELECT 1 FROM app.admins LIMIT 1`（失败原因只写进容器日志，不出现在响应里）。用户数据库不通时 `/healthz` 仍返回 200，公开页面照常服务；但五项设置都在而 `app.ok` 为 false 的候选会被候选检查拒绝，提示 `sign-in is configured but its database is not answering`。

### 修改管理员名单

编辑本机 `.env` 的 `ADMIN_EMAILS`，然后：

```bash
pnpm admins:sync
```

预期：打印 `administrators on the server: <n> on the list (+<增>, -<减>)`，立即生效，不需要发布。名单为空时报错并保持原样（不会清空管理员）。本机数据库用 `data/runtime/venv/bin/python scripts/app-db.py admins --target local`。

### 按邮箱删除一个人的数据

隐私页承诺可以应要求删除。删除 `app."user"` 里的这一行，会按外键级联删除他的会话、登录帐号（含 Google 的登录令牌）、提交和订阅；他审核过别人的提交时，那些行的 `decided_by` 置空，其余不变。用超级用户经容器内的套接字连接（不需要口令），邮箱用 psql 变量传入，不拼进 SQL 文本（它会出现在这条命令的参数里）；`<邮箱>` 换成对方的地址：

```bash
ssh -i <密钥> <用户>@<地址> 'sudo docker exec -i openaiwill-db psql -X -q -U postgres -d openaiwill -v ON_ERROR_STOP=1 -v "email=<邮箱>"' <<'SQL'
DELETE FROM app."user" WHERE lower(email) = lower(:'email') RETURNING id;
SQL
```

预期：打印被删除行的 `id`（一行）；没有输出表示没有这个邮箱。先用同样的方式把 `DELETE` 换成 `SELECT id FROM app."user" WHERE lower(email) = lower(:'email');` 确认是同一个人。数据库里立即消失；已经写入的每日备份里还有，备份在 14 天后自动删除（见下面的"备份"），所以对方的数据最迟在 14 天后从服务器上完全消失。恢复备份时要重新执行这一步，不要把已删除的人带回来。

### 备份

- 备份容器 `openaiwill-db-backup` 启动时先做一份，之后每 24 小时一份：以 `oaw_app`（schema `app` 的拥有者，所以容器里没有超级用户口令，只有 `OAW_APP_PASSWORD`）用 `pg_dump` 导出 schema `app`，压缩后写入 `<DEPLOY_ROOT>/backups/app-<UTC 时间>.sql.gz`。先写成 `.tmp`，导出成功、`gzip -t` 通过且大于 500 字节才改名；否则删除 `.tmp`，在容器日志里写 `app backup failed; retrying in 5 minutes`，5 分钟后重试（成功后才等 24 小时）。每次循环开始先清掉遗留的 `.tmp`。超过 14 天的 `app-*.sql.gz` 在每次成功后自动删除。只备份 `app`：`kg` 里的数据可以重新发布。
- `pnpm db:setup` 的最后一步重启这个容器，所以结构建好后立即会有第一份。确认：

```bash
ssh -i <密钥> <用户>@<地址> 'sudo ls -l <DEPLOY_ROOT>/backups; sudo docker logs --tail 5 openaiwill-db-backup'
```

预期：列出至少一个 `app-<时间>.sql.gz`，体积不是几十字节；日志里没有 `app backup failed`。首次启动时（结构还没建）日志里出现一次 `app backup failed; retrying in 5 minutes` 是正常的，随后重启会补上。之后每天确认最新一份不超过一天。
- 备份文件属于 root、权限 600，读取要用 `sudo`；它含用户邮箱，不要提交、不要发给别人。备份和数据库在同一台服务器上，防不了服务器本身丢失；需要异地副本时定期拷到本机被忽略的位置：

```bash
ssh -i <密钥> <用户>@<地址> 'sudo cat <DEPLOY_ROOT>/backups/app-<时间>.sql.gz' > data/app-backup-<时间>.sql.gz
```

预期：在本机得到一个非空文件，`gzip -t data/app-backup-<时间>.sql.gz` 无输出。

- 恢复（先清空 `app` 再导回；整个过程在一个事务里，导入失败时原来的 `app` 不变；用超级用户，备份里带着 `oaw_app` 作为拥有者，不需要再授权）。从服务器上的备份：

```bash
ssh -i <密钥> <用户>@<地址> 'sudo gunzip -c <DEPLOY_ROOT>/backups/app-<时间>.sql.gz | sudo docker exec -i openaiwill-db psql -X -q -U postgres -d openaiwill -1 -v ON_ERROR_STOP=1 -c "DROP SCHEMA IF EXISTS app CASCADE" -f -'
```

从本机上的副本：

```bash
gunzip -c data/app-backup-<时间>.sql.gz | ssh -i <密钥> <用户>@<地址> 'sudo docker exec -i openaiwill-db psql -X -q -U postgres -d openaiwill -1 -v ON_ERROR_STOP=1 -c "DROP SCHEMA IF EXISTS app CASCADE" -f -'
```

预期：两条都无错误退出。恢复后运行 `pnpm admins:sync`，让管理员名单回到本机 `.env` 的内容；再用 `pnpm db:setup` 的检查或登录一次确认。这个循环（以 `oaw_app` 导出、清理旧文件和遗留 `.tmp`、失败时不留文件并重试、两种形式导回）在本机用一次性的 `postgres:16-alpine` 容器验证过；服务器上的备份容器第一次运行后，用上面的确认命令看一次。

### `pnpm submissions:pull`

```bash
pnpm submissions:pull
```

预期：经 SSH 转发以 `oaw_app` 连接，在一个事务里取出状态为 `approved` 且还没有导入的提交，按（账号名，个人或机构）合并，写入本机 `data/submissions/approved-<UTC 时间>.json`（权限 600；文件在事务提交之前写好，写不成就回滚），再把这些行标为已导入。文件用独占方式创建，同一秒内的两次导出不会互相覆盖（第二个文件名末尾加 `-1`）。文件里每个账号有 `handle`（最早一条请求的大小写形式）、`account_kind`、`requests`（有几位读者提了）、`notes`、`approved_at`；不含任何提交者的姓名或邮箱。打印文件路径和账号数，以及 `add name and role for each person, then import with pnpm data:panel:import`。没有等待的提交时打印 `no approved submissions waiting`，不写文件。如果提交这一步的结果不确定（比如连接在提交时断了），文件会保留，并打印 `commit not confirmed; file kept at <路径>; run pull again - if it reports nothing waiting, this file is the export`：再运行一次 `pnpm submissions:pull`，如果打印 `no approved submissions waiting`，说明提交其实成功了，这个文件就是导出；如果又写出一个新文件，说明上次没有提交，删除旧文件，以新文件为准。已导出的行不会再被导出（数据库触发器也不允许清除 `imported_at`），所以导出的文件留在本机 `data/submissions/`，不要删除，直到已导入。

### Google 控制台（需要本人操作）

1. 在 Google Cloud 控制台的"Google 身份验证平台"里创建 OAuth 客户端，类型"Web 应用"。已获授权的重定向 URI 填两条：`http://localhost:3456/api/auth/callback/google`（本机开发，端口 3456）和 `https://surviagi.com/api/auth/callback/google`。
2. 客户端 ID 和密钥写进本机 `.env` 的 `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`（不进 Git），再 `pnpm site:env` 上传。
3. "品牌塑造"页：发布应用前要填应用首页 `https://surviagi.com`、隐私权政策 `https://surviagi.com/privacy`、服务条款 `https://surviagi.com/terms`，授权网域加 `surviagi.com`。不上传徽标（上传徽标会触发品牌验证）。
4. 数据访问范围只用默认的 `openid`、`email`、`profile`。应用处于"测试中"时只有测试用户能登录，点"发布应用"后任何 Google 账号都能登录。

### 这次上线的顺序

1. `pnpm db:setup`：建 `oaw_app` 和 `app`，补 `site.env` 的三项设置，启动备份，同步管理员名单。
2. `pnpm site:env`：上传 Google 的两个值。
3. `pnpm site:release`，预览，`pnpm site:promote`。
4. 在正式站用 Google 登录一次，确认登录、提交、订阅可用，管理员能打开 `/admin`。
5. 回到 Google 控制台填品牌页的三个链接，发布应用。

## 9. 上线后

以下需要本人的账号。

1. Google Search Console：添加 `surviagi.com` 域名资源，用 DNS TXT 记录验证；在"站点地图"提交 `https://surviagi.com/sitemap.xml`。旧的 `openaiwill.com` 资源保留，用"更改地址"工具指向 `surviagi.com`。
2. Bing Webmaster Tools：同样用 DNS TXT 验证并提交该 sitemap。
3. 确认 AI 爬虫未被 Cloudflare 拦截：

```bash
curl -sI https://surviagi.com/ | grep -i -E '^(HTTP|x-robots-tag)'
curl -sI 'https://surviagi.com/markets?lang=zh-CN' | grep -i '^location'
curl -s -o /dev/null -w '%{http_code}\n' -A GPTBot https://surviagi.com/
curl -s -o /dev/null -w '%{http_code}\n' -A ClaudeBot https://surviagi.com/llms.txt
curl -s https://surviagi.com/robots.txt | head -5
```

预期：依次为 `200` 且没有 `x-robots-tag`；`location: /zh-CN/markets`；`200`；`200`；本站生成的 `robots.txt`（含 `Sitemap:`），不是 Cloudflare 托管的版本。爬虫 UA 返回 403，或 `robots.txt` 不是本站的，说明 Cloudflare 的 AI 爬虫设置仍开着。
4. Google 富媒体结果测试：检查首页和一个更新页（`/updates/<id>`），预期结构化数据无错误。
5. 爬虫抓取量看 Cloudflare 后台的流量与机器人报表，不另外部署统计。

## 10. 每月检查

每月向 ChatGPT、Claude、Perplexity、Gemini 各问下面十个问题，记录 SurviAGI 是否被引用、引用是否准确。这是起始清单，由负责人按需调整。

```
How far has AI come in doing accounting work on its own?
Which kinds of work can AI already complete without a person?
What can AI do today in a software developer's job, task by task?
Is there a site that tracks AI progress by occupation with sources?
What does "L3 conditional automation" mean for a kind of work?
AI 现在能独立完成哪些工作？
AI 对会计这个职业的各项任务做到了什么程度？
有没有按职业和任务追踪 AI 进展并给出来源的网站？
最近哪些 AI 更新改变了某类工作的自动化程度？
SurviAGI 是什么？
```
