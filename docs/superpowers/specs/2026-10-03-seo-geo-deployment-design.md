# openaiwill.com 的 SEO、GEO 与部署设计

日期：2026-10-03。状态：设计稿，待用户审阅；尚未实现，尚未部署。

## 目标与边界

让 openaiwill.com 上线，并能被搜索引擎和 AI 引擎找到、读懂、引用。

用户在 2026-10-03 的对话中确定了四件事：

1. **受众**：全球优先。主攻 Google、Bing 和 ChatGPT、Claude、Perplexity、Gemini。不为大陆访问速度做专门安排，不备案。
2. **数据上线方式**：数据留在本地，本地构建，通过 SSH 部署到用户已有的新加坡服务器。
3. **语言地址**：中文版改为路径前缀 `/zh-CN/…`，英文保持无前缀。
4. **AI 爬虫**：检索引用类和训练类全部允许。

用户同日还确认了项目的官方账号：X 是 `https://x.com/openaiwill`，Discord 是 `https://discord.gg/ArVHw2K9X`，GitHub 是 `https://github.com/feyn-machines/openaiwill`（公开仓库）。三者写入组织的结构化数据（`sameAs`）和 `llms.txt`，并在每页的页头和页脚都显示为链接；X 账号另外写入分享卡片的 `twitter:site`。

其余内容是本文提出的设计，不是用户原话。

不在本次范围内：定时自动部署、公开数据下载接口、页面的 Markdown 副本、按页生成的分享图、第三方访问统计、登录和 API Key、大陆镜像。

## 现状（2026-10-03 核对）

网站：

- 没有 `robots`、`sitemap`、canonical、`hreflang`、Open Graph、结构化数据、`llms.txt`；`public/` 为空。
- `src/app/layout.tsx` 的默认标题是 "Will AI Kill Your Idea?"，描述是旧的创业想法检查文案。DESIGN.md 在 2026-09-22 已把它降为副标题。
- 语言由 `?lang=` 和 cookie 决定（`src/proxy.ts`、`src/lib/i18n.ts`）。`getLocale()` 读取 cookie 和请求头，被 17 个文件使用，因此全站每次请求实时渲染。
- 页面从 `datasets/published/latest/` 读盘（5.4 MB，已被 Git 忽略）。五个动态路由已有 `generateStaticParams`。
- 没有任何部署配置，只有 `.github/workflows/ci.yml`。

服务器（只读核对）。服务器地址、登录用户和密钥路径记录在本地被忽略的 `.env.deploy` 中，不写入任何受版本管理的文件：

- Ubuntu 24.04，x86_64，2 核，7.4 GB 内存（约 5 GB 可用），磁盘剩余 29 GB。
- 已装 Docker 29.6；没有装 Node、Caddy、Nginx。
- 防火墙只开放 SSH。80 和 443 没有任何进程监听。
- 对外流量全部经 `cloudflared`（Cloudflare Tunnel，令牌方式运行，路由规则在 Cloudflare 后台配置，服务器上没有配置文件）。
- 现有三个项目的做法一致：代码放在 `/opt/<项目>/releases/<版本>/`，用 Docker Compose 运行，只绑定 `127.0.0.1:<端口>`。本项目使用 8320、8321；其他本地端口已被现有项目占用。
- 本地开发机是 arm64，服务器是 x86_64。

## 一、部署

### 运行形态

沿用服务器上已有的做法，不引入新的组件：

- Next.js 用 `output: "standalone"` 构建成自带依赖的 Node 服务。
- 在服务器上以一个 Docker Compose 项目 `openaiwill` 运行，基础镜像 `node:22-alpine`（与本地构建和 CI 使用的 Node 22 一致），只绑定 `127.0.0.1:8320`。
- 由现有的 Cloudflare Tunnel 把 `openaiwill.com` 转到 `http://localhost:8320`。HTTPS、压缩、静态资源缓存由 Cloudflare 提供；服务器不开放 80 和 443。

镜像在服务器上构建，内容只是把已构建好的文件复制进基础镜像。这样避开了 arm64 到 x86_64 的跨架构镜像构建。standalone 产物是纯 JavaScript；实现时要核对其中没有平台相关的二进制依赖（例如 `sharp`），有则在镜像构建时安装对应版本。

### 数据不离开本机

所有页面在本地构建时预先生成，快照只在构建时被读取。上传的是渲染好的页面和脚本，不上传 `datasets/published/latest/` 的原始 JSON，也不上传 `data/`、`local/`、`.env*`。

为此所有动态路由设 `dynamicParams = false`：快照里没有的地址返回 404，线上服务不需要读快照。

风险：两种语言合计的页面数可能达到数千到上万。实现第一步要报告实际页面数和构建时间；如果构建时间不可接受，再回到本文重新决定，不默认改成线上读快照。

### 发布命令

发布分两条命令，都在本地运行，任一步失败即停止，不改动线上。`pnpm site:release` 执行第 1 至 7 步，`pnpm site:promote` 执行第 8、9 步：

1. 校验快照：`manifest.json` 存在，`content_sha256` 和 `counts` 与文件一致（2026-10-03 已核对：两者都能从已写出的文件重新算出）。
2. 运行 `pnpm check`（其中包含构建）。
3. 组装发布目录：standalone 产物、`.next/static`、`public/`、`Dockerfile`、`compose.yml`、一份 `release.json`（快照版本、Git 提交、构建时间）。
4. 对发布目录运行禁止路径和凭据扫描；发布目录是白名单组装的，扫描是第二道检查。
5. `rsync` 到 `/opt/openaiwill/releases/<快照生成时间>-<Git 提交>/`，例如 `20261003T102912Z-e2d4005`。快照的 `snapshot_version` 是固定值，不能区分版本，所以用生成时间；工作区有未提交改动时追加 `-dirty`。
6. 在服务器上以候选项目名 `openaiwill-next` 启动，绑定 `127.0.0.1:8321`，等待健康检查通过。
7. 在候选版本上运行冒烟检查，打印预览方法（SSH 隧道把 8321 映射到本地）。
8. 操作者确认后运行 `pnpm site:promote`：用候选版本重启正式项目 `openaiwill`（8320），健康检查通过后停掉候选项目。
9. 向 IndexNow 提交站点地图中的全部地址（约四千条，在单次提交上限之内）。

版本号与现有项目的目录命名方式一致。保留最近 5 个版本目录和镜像，更早的删除。

回滚：`pnpm site:rollback` 用上一个版本目录重启正式项目。

候选版本和任何非正式环境的页面响应都带 `X-Robots-Tag: noindex`，由运行时环境变量 `SITE_ENV` 控制；只有正式项目设为 `production`。候选版本只绑定本机端口，Tunnel 不指向它。

健康检查：`/healthz` 返回构建时写入的版本号，发布脚本据此确认线上跑的是刚上传的版本。

### 配置与凭据

- 服务器地址、用户、密钥路径放在本地被忽略的 `.env.deploy`，不进 Git。仓库里提供不含真实值的 `.env.deploy.example`。
- 站点地址 `SITE_URL=https://openaiwill.com` 是公开值，写在代码配置里。
- 线上服务不需要任何密钥。

### 一次性的人工步骤

这些步骤需要用户在 Cloudflare 后台操作，脚本不做：

用户于 2026-10-03 确认由本人完成域名指向。

注意：这台服务器不开放 80 和 443，把域名用 A 记录直接指向服务器公网地址不会生效。指向必须经过 Tunnel：

1. 确认 `openaiwill.com` 的 DNS 托管在运行这条 Tunnel 的同一个 Cloudflare 账号下；不在的话先把域名的 NS 改过去。
2. 在 Tunnel 里添加公开主机名 `openaiwill.com` → `http://localhost:8320`，以及 `www.openaiwill.com`。Cloudflare 会自动建立对应的 CNAME 记录，不需要手工添加 A 记录。
3. 加一条重定向规则：`www` 永久跳转到主域名。
4. **关闭 Cloudflare 的"阻止 AI 爬虫"和"托管 robots.txt"**。新域名上这两项可能默认开启，开着会直接抵消 GEO 部分的全部工作。
5. 确认 Cloudflare 对 HTML 不做缓存（默认如此），只缓存 `/_next/static/`。语言跳转依赖源站逻辑。

## 二、SEO

### 路径前缀与预生成

- 页面移入 `src/app/[lang]/`。`lang` 只接受 `en` 和 `zh-CN`。
- 对外地址：英文无前缀（`/markets`），中文带前缀（`/zh-CN/markets`）。
- `src/proxy.ts` 的规则，按顺序：
  1. 地址带 `?lang=<语言>`：保存 cookie，临时跳转（307）到该语言的路径地址（去掉参数）。用临时跳转是因为浏览器会缓存永久跳转，缓存后再次点击就不会到达服务器，语言选择也就不会被保存。旧的分享链接因此继续有效，语言切换也复用这条规则。
  2. 地址以 `/en/` 开头：永久跳转到无前缀地址，避免重复内容。
  3. 地址以 `/zh-CN` 开头：直接放行。
  4. 无前缀地址，读者保存过中文选择，且是页面导航：临时跳转到 `/zh-CN/…`。
  5. 其余无前缀地址：内部改写到 `/en/…`。
- 爬虫不带 cookie，所以无前缀地址对爬虫永远是英文。浏览器语言仍然不参与判断，符合项目的语言规则。
- 页面改为从路由参数取得语言（`next/root-params`），不再读 cookie 和请求头。语言切换链接用相对地址 `?lang=<语言>`，由规则 1 处理，不需要脚本。
- 找不到的地址：详情路由只接受预生成的参数；全站 404 用 `global-not-found`（本版本 Next.js 的实验特性，根布局在动态段下时需要它）。
- 站内链接统一经一个函数生成带语言前缀的地址，保留 `typedRoutes` 的检查。

### 每页的元信息

- 根布局设 `metadataBase`。
- 每页输出 canonical 和 `hreflang`：`en`、`zh-CN`、`x-default`（指向英文）。
- 每页有自己的标题和描述，由页面数据生成。标题只描述页面实际包含的内容（任务、证据条数、L0–L5 等级），不写替代百分比、失败概率或任何未经校准的分数。
- Open Graph 和 Twitter 卡片：第一版全站共用一张品牌图，按语言各一张。
- 全站默认标题和描述改用 DESIGN.md 中 2026-09-22 已确认的文字，**提议如下，待用户确认**：

| | 英文 | 中文 |
| --- | --- | --- |
| 默认标题 | How far AI has taken over the world | AI 接管世界的进度 |
| 标题后缀 | `%s \| openaiwill` | `%s \| openaiwill` |
| 默认描述 | Will AI kill your idea? Replace what you do? Every AI update could change your answer. | AI 会杀死你的想法？取代你的工作能力？每一次 AI 更新，都可能会挑战你的答案。 |

各板块页面标题的具体措辞在实现时列成一张双语表，一并交用户审阅。

### 站点地图和爬虫规则

- 一个 `sitemap.xml`，每条带两种语言的对应地址。当前约四千条，远低于单文件五万条的上限，超过再拆分。站点地图和各详情页的预生成列表取自同一处，保证不列出不存在的页面。
- 更新时间：数据页取快照的 `generated_at`，动态页取事件的发布时间，白皮书取文件的最后提交时间。
- `robots.txt` 允许全部，指向站点地图。

### 结构化数据

| 页面 | 类型 | 要点 |
| --- | --- | --- |
| 首页 | `Organization`、`WebSite` | 名称 openaiwill，两种语言；`sameAs` 指向官方 X、Discord 和 GitHub |
| 白皮书 | `Article` | 版本、日期 |
| 市场、职业、任务详情 | `BreadcrumbList` | 层级路径 |
| 市场和职业总览 | `Dataset` | 快照版本、生成时间、本体版本、数据状态 |
| 动态详情 | `Article` | `isBasedOn` 指向原始帖子；原文保持原语言，翻译单独标注 |

不使用 `ClaimReview`、`Rating` 或任何暗示已审核结论的类型。

### 流量入口

主要自然流量来自职业页和市场页，对应"AI 能做某职业的哪些工作"这类搜索。O*NET 职业页即使暂时没有证据也保留收录，因为它列出了该职业的任务构成；页面如实显示"尚无更新提到"。

## 三、GEO

- **爬虫规则**：`robots.txt` 明确列出并允许 GPTBot、OAI-SearchBot、ChatGPT-User、ClaudeBot、Claude-SearchBot、Claude-User、PerplexityBot、Perplexity-User、Google-Extended、Applebot-Extended、CCBot、Bytespider。
- **`/llms.txt`**：说明 openaiwill 是什么（用白皮书的倡议定位，不称平台）、各板块地址、快照版本和生成时间、L0–L5 的含义、引用方式、中文版入口。由导航配置、等级名称和快照清单在构建时生成，不手写。
- **内容可被直接读到**：关键数字和结论出现在服务端输出的 HTML 文字中。首页的 three.js 场景和动画只是表现层，同样的数字要有文字版本。实现时用不执行脚本的抓取（`curl`）逐个板块核对。
- **可引用**：详情页地址和锚点保持稳定；数字旁带截止日期；每个证据条目链接到原始来源。
- **数据状态写给机器看**：快照里的每条边、关卡和等级都是机器提出、未经审核。这个状态写入 `Dataset` 结构化数据和 `llms.txt`，界面文案不增加说明文字。AI 引用时因此带着状态。
- **不夸大**：结构化数据和 `llms.txt` 不出现"已验证""已审核""替代率"之类的说法，与页面保持一致。

### 上线后的登记与观察

- 登记 Google Search Console 和 Bing Webmaster Tools，提交站点地图。Bing 的索引是 ChatGPT 搜索和 Copilot 的来源。
- 每次发布后自动通知 IndexNow。
- 爬虫抓取量：从 Cloudflare 后台的流量与机器人报表查看，不额外部署统计。
- 每月用约 10 个固定问题（中英文各半）手动询问各 AI 引擎，记录是否引用本站及引用是否准确。问题清单在上线时确定。

## 验证

- `pnpm check` 全部通过；`typedRoutes` 保证没有失效的站内链接。
- 新增单元测试：`proxy` 的五条规则；每个路由两种语言的 canonical 和 `hreflang` 成对且互相指向；站点地图中的每个地址都对应一个预生成的页面；`llms.txt` 中的地址都存在。
- 发布目录扫描：不含快照 JSON、`.env*`、`data/`、`local/`。
- 候选版本上逐项核对：`?lang=zh-CN` 跳转、`/en/…` 跳转、`noindex` 头存在；正式版本上 `noindex` 头不存在。
- 桌面和手机各看一遍两种语言。
- 上线后用 Google 富媒体结果测试检查结构化数据，用 `curl -A GPTBot` 确认 Cloudflare 没有拦截。

## 实施顺序

1. 路径前缀和全站预生成；报告页面数和构建时间。
2. 元信息、站点地图、爬虫规则、结构化数据。
3. `llms.txt`，以及关键数字的文字版本核对。
4. `standalone` 构建、`Dockerfile`、`compose.yml`、`/healthz`、发布与回滚脚本。
5. 用户完成 Cloudflare 的人工步骤；首次发布；登记站长工具。

第 1 至 4 步只改本地代码，不触碰服务器。第 5 步的首次发布需要用户明确下令。

## 待用户确认

1. 默认标题和描述是否采用上表的提议。未另行指示时按提议实现，文案集中在一处，便于之后修改。
2. 本地端口 8320（正式）和 8321（候选）是否可用于本项目。未另行指示时使用这两个端口。
