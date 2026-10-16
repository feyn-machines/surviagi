# 一期本地入库与计算

本地处理文件 → PostgreSQL → 指标 → 实验进度 → 回查，已实现并在 PostgreSQL 18.6 上运行验证。已支持合成材料回归与本地真实采集档案；真实材料使用独立的证据审阅试算方法，正式能力估计仍未校准。网页尚未连接此数据库。

## 运行

需要 Docker Engine/Desktop、Docker Compose、Python 3.12+、Node.js 22+ 和仓库 pnpm 依赖。

```sh
pnpm install --frozen-lockfile
pnpm data:setup
pnpm data:test
```

`data:setup` 在根目录 `data/runtime/venv` 创建 Python 环境，安装固定版本 psycopg，启动专用 Compose 项目 `openaiwill-data-local` 并应用迁移。数据库只监听 `127.0.0.1:7543`，库名 `openaiwill_local`；用户名 `openaiwill` 是本地数据库连接账号，不是网站用户。

密码首次生成到 `data/postgres/password`，文件权限 0600；不会写入命令参数、公开环境文件或 Git。数据位于专用 Docker volume。固定镜像 digest 的运行版本已核对为 PostgreSQL 18.6。PG 18 镜像挂载位置采用 `/var/lib/postgresql`，与[官方镜像说明](https://hub.docker.com/_/postgres)一致；Python 驱动采用 [Psycopg 3 binary 安装方式](https://www.psycopg.org/psycopg3/docs/basic/install.html)。

```sh
pnpm data:status
pnpm data:down    # 停止此项目，保留数据库卷
pnpm data:up
pnpm data:migrate
```

`data:up` 启动已有环境；首次使用应运行 `data:setup`。不提供清空历史或删除卷命令。数据库连接程序固定使用上述本地地址；迁移工具不接受远程生产连接串。

## 输入和版本

- [合成输入](../../datasets/simulation/local-v1/baseline.json)包含人物、机构、产品/版本、账号、来源、采集版本、事件、声明、采用、标签、关联及覆盖记录。
- [独立配置](../../datasets/simulation/local-v1/config.json)固定本体、赛道/工作范围、来源平台/账号集合、标签、四种指标规则、实验方法和关系权重。
- [正式迁移](../../db/migrations/001_business_schema.sql)建立 34 张业务表；[封存保护迁移](../../db/migrations/002_immutable_imports.sql)补充 `sealed_at` 和保护触发器；[采用阶段迁移](../../db/migrations/003_integrated_adoption_stage.sql)增加 `integrated`（已接入），与 `integrating`（接入中）、`production`（明确生产使用）区分。阶段本身不决定分值。[语义判断层迁移](../../db/migrations/006_semantic_judgment_layer.sql)建立能力、闸门、判断运行、类型边与实例层证据/状态表，其中所有枚举 CHECK 由语义层生成；[判断者词表迁移](../../db/migrations/007_semantic_judge_vocabulary.sql)把 `judge` 与 `task` 两列也纳入受控词表；[判断项迁移](../../db/migrations/008_judgment_items.sql)保留每一次判断——包括否定与未决，否则两个判断者的对照只看得见一致，看不见分歧的形状；[空值修复迁移](../../db/migrations/009_kind_check_null_repair.sql)修正 006 生成的 CHECK 中`NULL IN (...)` 为 NULL 而非 false 导致约束从未生效的问题；[自主度观测迁移](../../db/migrations/010_observed_autonomy.sql)把「所描述的用法里人还做多少」与「是哪类证据」「来源多可信」分开记录；[闸门状态任务迁移](../../db/migrations/011_gate_state_task.sql)把 `gate_state` 加进判断运行的任务词表，此前闸门状态运行借用 `demonstrates`，导致证据查询把它选中、快照发布出 0 条证据；[能力覆盖面迁移](../../db/migrations/012_capability_breadth.sql)在能力状态上记录 `work_nodes_requiring` 与 `work_nodes_judged` 两个整数——不存比值，比值会和它的来源对不上。另有 `schema_migrations` 记录迁移哈希。
- 本体导入先调用现有封存包语义校验器，再验证实际读入字节哈希；导入完整 20,796 个概念和 20,733 条关系，保留既有 ID。外部参考目录仍由原封存包及其哈希追溯。

导入其他符合当前合同的本地合成处理包：

```sh
pnpm data:import --input=data/my-simulation/input.json --config=data/my-simulation/config.json
```

`local-input-1` 且 `synthetic=true` 保留原合成回归及哈希；真实材料使用 `real-local-input-1`、`synthetic=false` 以及单独的 `real-local-pipeline-1` 引擎版本。两种输入与方法不能混用。真实入口校验已保存的标准化采集档案，并接受明确编写的事件/声明及 AI 判断；尚未实现自动阅读全文提取事件或自动生成能力估计。

输入顶层字段、允许表和方法操作受程序约束；表字段通过正式迁移的列及约束校验。`batch_id`、本体/配置版本、记录哈希由导入器赋值；输入不能直接写入指标和进度表。时间必须带时区，统一为 UTC；相同身份的完全相同记录合并，内容冲突拒绝。关系权重须可精确存为 10 位小数，三情景值须可精确存为 3 位小数，避免数据库隐式舍入改变分母或汇总。来源自然键和采集时点冲突同样拒绝。

来源范围在配置中明确指定平台和账号；合成合同的覆盖记录必须与它们、工作/标签和统计窗口一致。真实合同保留多个原始查询及其窗口，不将部分来源查询重写为完整工作覆盖。缺失覆盖保留 unknown；部分覆盖的正计数是已观察到的部分数量。空输入只有在完整覆盖下才得到零，查询失败或覆盖缺失不生成零。覆盖记录不能宣称已完整查询其检查时间之后的窗口。

## 本体 schema 与判断流

[本体 schema](../../datasets/ontology/schema/schema.json)是唯一的类型定义：
SQL 的枚举 CHECK、抽取 prompt、判断 rubric 与站点标签全部由它生成。
`pnpm ontology:projections` 产出投影，`pnpm ontology:check` 校验 schema 本身，
并逐列比对 `db/migrations` 里实际生效的 CHECK 值表与词表是否逐字相等——
它的作用不是发现打字错误，而是保证不存在第二份真相。

```sh
pnpm data:discover:capabilities -- --output data/discovery/caps.json   # 从任务原文推导能力
pnpm data:classify:capabilities -- --input caps.json --output classified.json
pnpm data:seed:ontology                              # 能力、闸门、组织注册表与候选边落库
pnpm data:judge:requires -- --judge typesafe --occupation oaw:occupation:31-9094.00
pnpm data:judge:blocked -- --resume                  # 哪些闸门挡住哪些工作
pnpm data:judge:compare -- --run-a <run> --run-b <run>
pnpm data:judge:demonstrates -- --vocabulary event_kind-2.0.0
pnpm data:gate:state                                 # 有没有立场声明移动了闸门
pnpm data:capability:state                           # 证据 → 自主阶段
pnpm data:review:pending / pnpm data:review:record    # 人工评审
pnpm data:publish:snapshot                           # 网站读取的已发布快照
```

把快照作为版本化数据发布到服务器数据库（`pnpm data:release`、`pnpm data:promote`、`pnpm data:rollback`；`--target local` 对本机库做同样的事）见[网站部署手册](deployment.md)的“发布数据”一节。

能力集从工作本身推导，不从厂商发布推导：按职业大类分层抽样任务原文，
让模型说出每条任务需要什么能力，**先按跨大类广度筛掉只出现在一个大类的名称**
（那是任务改写不是能力），再合并同义项。分类是独立的一遍——提议阶段问
「这项工作需要什么能力」，模型就会把闸门也说成能力：physical-presence 曾以
14 个职业大类成为覆盖面最广的一条「能力」，而它是最典型的闸门。

判断者可以换：`--judge typesafe` 或 `--judge deepseek`，每条边都记下是谁判的。
两者在 8,857 对重叠判断上一致率 93.8%，但分歧单向——一方比另一方严得多，
所以边不是判断者中立的，快照里按 `judge` 字段区分。

判断者额度会在跑到一半时用尽，这不是假设：一次全量扫描中途返回 HTTP 402，
后续 16,814 次「判断」其实是从未发生的请求。**这类行会被删除而不是记成未决**——
把「请求被拒绝」记成「判断者看过但决定不了」是两回事，后者会污染覆盖率统计。
三个判断运行器都带熔断：连续 3 个批次没有任何一条被判定就中止，而不是继续磨。运行中途失败时，该次运行标记为 `failed` 并在 `params` 里写明原因与被删除的行数；
它在失败前写入的边是有效的，保留。`--resume` 按 `judgment_items` 里已有的记录跳过，
而不是按运行状态，所以崩溃过的运行做过的事仍然算数。

`requires` 边是判断不是匹配：对 18,838 条任务原文做关键词匹配找「软件相关」命中 999 条，
抽样核对其中一个职业的 14 条命中全部是假阳性。因此每条边都带 `method` 与 `status`，
`ai_proposed` 在数据库层被强制只能是 `candidate` 或 `rejected`，且必须指向一次判断运行。

自主阶段由三道互相独立的封顶取最小值：证据的种类（基准证明不了自主性）、
来源的层级（厂商自证最多到 2）、以及所描述用法里人还做多少。
`capability_states.limiting_factor` 记录是哪一道在起作用，
读者因此能分清「能力弱」「证据弱」与「工具够强但人还在盯」。
没有证据的能力不给数字：`insufficient_evidence` 与阶段 0 是两种不同的陈述。

## 真实档案入口

新的官方 X 账号采集入口及覆盖语义见[官方 X 账号采集](official-x-monitoring.md)。它按注册账号读取原生时间线并逐页保存原始响应；当前输出尚未自动接入以下真实档案转换和计算入口。

在现有采集文件基础上执行：

```sh
pnpm data:setup
pnpm data:real --archive=data/collection/2026-09-12-two-weeks/normalized --review=data/real-calculation/2026-09-12/review.json --output=data/real-calculation/2026-09-12/run-v1
```

上述文件是本机已有档案，普通 Git clone 不包含这些原始材料。`--archive` 指向含顶层与日期窗口清单的标准化目录；转换器核对原始文件、JSONL 的哈希/数量、身份引用、发布时间、采集时点、全文与互动快照的一致性，保留原始来源和采集 ID。多个查询覆盖记录分别保留；不将 X 分组搜索变成逐账号完整覆盖，也不把 Reddit 社区写成帖子作者。

`--review` 明确提供批次 ID、生成时间、配置、语义记录及每个工作的三情景判断。判断带事件、当前采集 ID、内容哈希、判断者和理由；不能通过该入口覆盖采集器拥有的来源、采集、身份或覆盖记录。真实入口拒绝宣称已完整取尽这份部分档案。

`--output` 使用与归档分开的根目录 `data/` 子目录，保留规范化输入、原判断、配置、档案清单哈希和数据库查询结果。相同内容可以重放，已有的不同内容文件不能被覆盖。原始归档不改写。首次新口径判断是初始化，不回填过去的能力值。

本次实际结果见[真实数据计算记录](../data/real-data-calculation-2026-09-12.md)；方法及限制见[真实证据试算方法 v1](../data/real-evidence-estimation-pilot-v1.md)。

## 话题与搜索索引（2026-10-09）

用户 2026-10-09 的决定：话题是挂在一个职业或一类生意上的封闭问题，带两到四个互斥的答案（“AI 会取代大多数会计吗？”）；帖子里的主张能关联就关联到已有话题，不能就提出新话题；话题按自然季度看变化，**不判定结果**；话题反过来给搜索提供查询词。定义在本体 2.3.0（`Topic`、`TopicOption`，关系 `about`、`has_option`、`argues`、`merged_into`，六条规则），表在迁移 039。话题还没有上站，也没有投票。

```sh
pnpm data:models                                  # 下载向量模型（一次，310 MB，核对校验值）
pnpm data:up                                      # 启动 PostgreSQL、向量服务和 Meilisearch
pnpm data:mine:topics -- --window-start 2026-10-08T00:00:00+00:00 --window-end 2026-10-09T00:00:00+00:00 \
  --output data/topics/topics-2026-10-08.json     # 读帖子、取主张、归到话题，写入数据库
pnpm data:search:index                            # 把话题、更新、目录写进搜索索引
pnpm data:search -- "会计" --index topics          # 关键词加向量的混合搜索
```

- **两遍**：先逐条读个人和第三方机构的原创帖，取出“对象、问题类型（替代 / 赛道）、主张、原文引用”，引用在帖子正文里找得到才保留；再按发帖时间逐条处理主张：归到已有话题的某个选项下、提出新话题、或带原因放弃。公司官方账号的帖子不读。
- **归并是判断，不是键**：本机向量（EmbeddingGemma 2，llama.cpp 容器提供）只负责挑出最相近的几个已有话题和目录条目给模型看，相似度本身不做决定。话题的身份是“问题类型 + 对象”，数据库用唯一索引保证同一身份只有一个未并入、未关闭的话题；模型写出一个已存在的话题时，会带着那个话题再问一次。
- **存放**：`topics`、`topic_options`、`topic_claims`、`topic_queries`、`topic_mining_runs`。每次运行另存一份不可覆盖的记录到 `data/topics/`，文件名就是运行编号；`--claims-from` 复用其中的主张重新归并，`--no-store` 只写记录不写库。
- **读数**：两个以上选项各有账号主张为 `open`；只有一边有人主张为 `one_sided`，没人主张的选项也写出来，并带针对它的搜索词。选项下的账号数是“采到的帖子里谁这么主张”，不是“多少人这么认为”。按季度的账号数在 `by_quarter` 里。
- **实测（2026-09-29 至 10-08，3,392 条帖子）**：约 2% 的帖子有这样的主张（64 条）；归成 32 个话题，11 条主张归到已有话题，21 条放弃；2 个话题两边都有人主张；29 个对上了目录。同一批帖子多次运行，主张数在 45 到 73 之间波动，归并结果也随提示词变化，尚不稳定。
- **搜索索引**：Meilisearch 里有 `topics`、`updates`、`catalog` 三个索引，是数据库的副本，可随时重建。Meilisearch 自己调用向量服务，所以一次请求同时按词和按意思匹配，中英文互通。

### 搜索回流（2026-10-09 跑通一轮）

```sh
pnpm data:topics:queries -- --limit 30 --per-topic 2 --output data/topics/queries-<日期>.txt   # 最需要另一边声音的话题的搜索词
pnpm crawl search --queries-file data/topics/queries-<日期>.txt --start … --end … --max-pages 1 \
  --output data/collection/search/search-topics-<日期>.json
pnpm data:topics:searched data/collection/search/search-topics-<日期>.json                     # 记下为哪些话题搜过
pnpm data:mine:topics -- --collection-run search-topics-<日期> --window-start … --window-end … \
  --output data/topics/topics-search-<日期>.json                                              # 把搜到的主张归回话题
```

- 排序：只有一边的话题在前，没搜过的在前，再按主张的浏览量。没搜成的查询不记为搜过，下一轮仍排在前面。
- 第一轮：60 个查询完成 29 个（其余当时记为搜索限流，实际是请求签名被拒，2026-10-11 已修，见 [x-crawler](x-crawler.md)），采到 475 个账号的 516 条帖子；其中约 12% 带主张（名单帖子约 2%）；22 条归到已有话题、20 条开了新话题；两边都有人主张的话题从 2 个到 6 个。
- 第二轮（2026-10-11，修正签名重试后）：60 个查询全部完成，856 个账号的 964 条帖子；读 740 条得到 96 条主张，58 条归到已有话题、21 条开了新话题；话题从 62 个到 83 个，两边都有人主张的从 8 个到 17 个。
- 搜到的作者大多不在名单里，没有做过身份核对。主张只记录“这个账号这么说了”；上站时要与名单账号的主张分开显示。

### 第三方机构账号（2026-10-09）

用户 2026-10-09：a16z 这类账号属于第三方机构，是核心要关注的。名单角色增加 `market_researcher`（市场与行业研究）：投资机构、咨询公司、数据公司、公共机构、智库及其成员。草稿在 `datasets/third-party-institutions.draft-2026-10-09.json`（49 个），按既有流程导入并查询资料；45 个由账号自己的资料确认身份并启用（41 个机构、4 个人），3 个仍是候选。

- 已采 2026-09-29 以来的 1,204 条帖子。**现在的抽取读不出它们的价值**：734 条候选只产生 1 条更新。a16z 的“98% 的美国家庭还没有为 AI 付费”（590 万浏览）、“前 1% 的 AI 付费用户月均花 903 美元，中位数 25 美元”这类帖子被判为“市场评论，不是 AI 更新”而丢弃，因为更新类型里没有“市场测量”。这是下一步要定的。
- 投资机构对它投资的公司不独立。持股没有记录；在记录之前，它们谈被投公司的话不能当作第三方的说法。
- 查询时发现一条旧问题：候选账号 @MSFTCopilot 解析到的平台账号与已登记的 @Microsoft365 相同，会让整批查询结果入库失败；这次只入库了本批账号的结果。

### 市场测量（2026-10-09，用户同意按提议做）

事件类型词表升到 2.2.0，增加 `market_measurement`：第三方对 AI 的采用、花费、排名，或与 AI 相关的某个具名职业、行业的就业所做的一次量化读数，必须带数字。它挂在市场或职业上（关系 `measures`，表 `event_measures`），**不对应到工作，不影响任何等级**（`rule:market-measurement-moves-no-level`，路由按这条规则跳过它）。

```sh
pnpm data:extract:events -- --collection-run <采集批次> --output data/extraction/<名称>.json   # 新类型随抽取产生
pnpm data:measure:markets                                                                    # 说明每条测量量的是哪个市场或职业
```

- `measure:markets`：本机向量挑出 12 个最相近的目录条目，模型从中选最多 2 个或一个都不选；选出的标为机器提出的候选。看过的测量记在 `event_measure_checked`，“目录里没有对应条目”不会被反复询问。
- 实测：同一批 1,204 条机构帖子，加类型前产生 1 条更新；加类型后第一遍 67 条，其中混有与 AI 无关的统计（总体就业、宗教调查、股价）；把定义收紧为“必须与 AI 有关”后重读得到 21 条，7 条挂上了目录。两遍之间 a16z 的测量从 15 条变成 9 条，说明收紧后也丢了一些该留的；同一个数字的两种说法还会成为两条（“4.5% 的美国消费者付费”与“不到 5%”）。
- 多数测量说的是整个消费市场或所有企业（“98% 的美国家庭还没有为 AI 付费”），目录里没有对应条目，所以不挂。这是如实的结果，不是遗漏。
- 这类更新的行动者是第三方机构，不是注册的 AI 公司，所以按现有规则不进入路由，也还不进入公开的更新列表；怎么上站待定。

### 更新到话题的选项（2026-10-09，本体 2.4.0）

第一版只按目录推导（视图 `topic_events`）：同一市场组里的更新全部列到话题下，17 个话题共 2,547 条，同组话题列出的更新完全相同，替代类话题一条都没有。用户 2026-10-09 的决定：这样不行，必须收窄；向量只做初筛，由 Jev 判断，并且要判断到选项，否则没有意义。该视图已由迁移 043 删除，规则 `rule:updates-reach-topics-by-the-catalog` 标了 `until`。

```sh
pnpm data:topics:evidence -- --since 2026-09-25     # 向量挑话题，Jev 逐个选项判断
```

- 每条更新：本机向量挑出最相近的最多 3 个话题（相似度低于 0.80 的不要；相似度不做决定），再问 Jev，对这些话题的每个选项分别问两次——“这条更新是否支持这个答案”“是否反驳这个答案”——高于 0.6 的写入 `topic_option_evidence`（关系 `weighs_on`，方向 `supports` / `contradicts`），标为机器提出的候选。问题里写明“处于同一领域、同一产品或同一家公司不算证据”。问反驳是因为实测往往只否定一个答案而不证明另一个：“模型胜过 12 位持证会计”反驳“AI 做不了会计工作”，本身不等于“需要的会计变少”。
- 判断过的（更新，话题）记在 `topic_evidence_checked`，不重复问；新开的话题会被之前的更新补问。方法版本变了（现在是 `topic-evidence-2`）就全部重问。
- **只认 Jev**：分类器在 Jev 失败时会退到对照模型，这一步不接受那样的结果——该更新留作未判断，下一轮再问；开头连续 3 条都失败就整轮停止。试跑时对照模型把“Claude Haiku 5.5 在 GitHub Copilot 可用”判成了某个答案的证据。2026-10-09 有一段时间 Jev 从本机返回 HTTP 451（所在地区不可用），之后恢复。
- 记录的是“更新偏向某个答案的哪一边”，不判定哪个答案是对的（`rule:topic-carries-no-answer` 不变），也不读、不动任何工作等级。
- **量**：418 条更新、58 个话题，235 条进入判断，235×2 次请求、3,412 个判断，约 5 分钟。每天把更新对应到工作的那一步是每条更新 614 个判断。

**选项的写法决定证据挂不挂得上。** 第一遍（选项是“AI 处理常规工作，但大多数人转向更复杂的工作，职位得以保留”这种先让步再下结论的句子）1,706 个判断只通过 7 个，其中 3 个落在同一个写得太宽的选项上，相似度最高的 Mercor 会计实测没有挂到任何选项。于是 `rule:topic-is-a-closed-question` 补了一条：每个选项是对现状的一句短陈述（英文不超过 10 个词），证据能表明它成立或不成立。

```sh
pnpm data:topics:reword -- --reason "…"     # 把超长的选项改写成短陈述；编号和顺序不变，旧文字进 topic_option_revisions
```

58 个话题的 177 个选项全部改写后重跑：通过 10 个（6 个支持、4 个反驳），来自 5 条更新。Mercor 实测以 0.91 反驳“AI 无法可靠完成会计工作”，以 0.65 支持“会计师需求大幅减少”。仍有判错的（ILO 的一项通用研究被判为反驳“一名画师用 AI 取代整个团队”）。命中稀少本身是如实的：公司的产品更新很少回答这类问题，能回答的主要是个人的实测和第三方机构的测量。

### 话题上站与投票（2026-10-09）

- **发布**：数据发布多了一个集合 `topics`（实体编号 `topic_id`）。每个话题带选项、各选项下的主张（帖子原文、作者、是否名单内）、Jev 判出的正反证据、按季度的主张账号数，以及它所在的领域（职业大类或市场组）。没过标准、已并入或关闭的话题不发布；没有任何字段说明哪个答案是对的。
- **页面**：`/topics`（概览数字、两边都有人说的话题、按领域、带筛选排序分页的全部列表；每个视图都是链接）和 `/topics/<slug>`（每个选项下列证据和主张）。
- **投票**：登录的读者对一个话题的一个选项投票，每人每话题每季度一票；本季度内可改、可撤回，季度结束后封存，下一季度重新投。表 `app.topic_votes` 在用户数据一侧，数据发布不碰它；票数由浏览器读取，页面本身对所有人相同。投票是读者的看法，与证据分栏显示，不判定任何结果，也不写成概率。
- **拉票数、决定先研究什么**：

```sh
pnpm votes:pull                       # 从服务器取票数到 data/votes/votes-<时间>.json，只有计数，没有读者
pnpm data:topics:queries -- --output data/topics/queries-<日期>.txt   # 默认读最新的票数文件
```

  搜索计划的排序：本季度读者投票多的在前，其次是只有一边的话题，再是没搜过的，再按主张的浏览量。投票只决定研究什么，不影响找到什么。

- **发布顺序**（三步都会动服务器，等用户明确要求时才执行）：先 `pnpm db:setup`（建投票表，可重复执行）；再发布代码（`pnpm site:release`、`pnpm site:promote`）；最后发布数据（`pnpm data:release`、`pnpm data:promote`）。现在线上的网站不认识 `topics` 这个集合，先发数据会让它拒绝加载整个版本；新代码读到没有话题的旧数据则显示“暂无话题”。

未做：市场测量单独的页面；读者提交新话题；服务器上的搜索服务和站内搜索；投资机构与被投公司的关系。

## 每日更新（`pnpm data:daily`，2026-10-16）

网站的数据只有在有人跑完“采集 → 处理 → 快照 → 发布”这一串之后才会变。`pnpm data:daily` 把这一串做成一条命令，供定时任务每天调用；它会花 X 账号额度、调用 DeepSeek 和 TypeSafe，并写服务器数据库，所以只在负责人要求或负责人建的定时任务里运行。

```sh
pnpm data:daily --plan       # 只打印窗口和每一步的命令，什么都不执行
pnpm data:daily              # 采集和处理下一个窗口，然后 data:release（已校验，未生效）
pnpm data:daily --promote    # ……没有需要人看的问题时再 data:promote，网站随即更新
```

- **窗口**：从上一个完成的窗口结束处开始（`data/daily/state.json`；第一次运行取最新一次官方账号采集的结束时间），到当前的最后一个整点为止；不足 6 小时的窗口留到下次。
- **顺序**（2026-10-16 手动跑通的一轮）：官方账号采集、名单账号采集（分开两次）、`data:extract:events`、`data:verify`、`data:identify:models`、`data:route:events`、`data:measure:markets`、`data:gate:state`、`data:mine:topics`、`data:topics:evidence`、`data:post-events`、`data:activity:state`、`data:publish:snapshot`。一轮大约 1 小时 15 分。
- **断点续跑**：每个窗口一个目录 `data/daily/<窗口>/`，每步一个日志，`record.json` 记下做完的步骤。中途停下的窗口下次从停下的那一步接着跑，已采集的帖子不重采、已发给模型的不再发。抽取结果文件已写出但没入库时改为 `data:ingest:events`。快照写好之后游标才前进。
- **停下（退出码 1，保留位置）**：某一步失败；采集被拒（退出码 1）；第一次调用判断模型之前 TypeSafe 从本机连不上或回 451（地区封锁，要在代理里把 `typesafe.ai` 走美国出口）；`data:release` 连续 3 次失败（它在一个事务里，断线不留半个版本）。
- **发布但不生效（退出码 2）**：采集结束但需要注意（退出码 2）；任何一步报告失败或改用备用模型的批次（`failed`、`failed_batches`、`batches_failed`、`fallback_batches`）或没处理完的更新。版本仍导入并校验，报告列出原因，人看过后用 `pnpm data:promote` 生效。
- **不拦的**：新话题。它们列在 `mine-topics` 的结果里，值得人看一眼（2026-10-16 见过 `decisions-api` 与 `openai-decisions-api` 这样的重复），但不阻止发布。
- 采集有上限，一次没采到不等于那段时间没有更新。

## 指标和实验进度

| 指标 | 当前口径 |
| --- | --- |
| `comments` | 每次采集的评论字段；缺失为 NULL，明确返回零为 0 |
| `event_count` | 接受关联且携带目标标签、已发生、发生时间在 `[start,end)` 的去重事件；截止前至少存在一条可用来源 |
| `post_count` | 对每个来源选择截止前最新采集，按帖子原发布时间落入窗口、来源标签和工作关联计数；不继承事件发生时间窗口 |
| `comment_sum` | 对上述选中帖子汇总评论；任一字段缺失时总值 NULL，同时保留已知小计和缺失来源数 |
| `archive_post_count` | 真实档案按平台/原帖发布时间窗口统计去重来源，选截止前最新可用采集；属于观察样本数 |
| `archive_comment_sum` | 对同一真实样本汇总最新回复/评论字段，保存缺失数、已知小计、输入与原查询覆盖；不视为历史窗口末的互动值 |

SQL 在数据库中选择事件/来源并聚合观测。计数保存定义、平台/账号集合、标签、窗口、截止时间、输入哈希和行级输入。原始发布时间、采集时间和平台指标更新时间分别记录；未知平台更新时间保持 NULL。

合成实验方法只接受带采用方角色、有效关联、当前可访问来源及合成核验状态的证据，事件计数仅作为覆盖与存在性门槛。示例试点阶段映射 `[10,20,30]`，生产阶段映射 `[60,70,80]`；这是为了检验程序的**任意测试值**，不主张采用阶段能测出独立完成能力。更多同阶段采用或评论上涨不会加分。

当前来源及支持材料均按截止前最新采集检查；新批次发现材料被删除时，不再用其旧可用状态作当前实验依据。旧批次和已保存的历史计算仍保留。对同一工作选合格阶段中央值最大的三情景；全部子工作有值才按关系权重汇总。缺失子项保留未知份额，赛道三值为空，不删除子项后重新归一化。没有世界总分。

真实方法 `reviewed_evidence_scenarios` 保存 AI 对三个工作节点的明确判断，再按固定关系权重加权。证据相关性、身份与事实核验分别保留；评论、事件数、采用阶段均不自动增加分数。未提供判断的子项保持未知，父级不删项重算。判断本身是冻结输入，因此程序复算可复现，重新让 AI 判断不保证得到同一组数字。

## 事务、重放和回查

导入器以事务级 advisory lock 串行化导入；配置、输入、计算和封存一次提交。处理中的 loading 批次仅在本事务内用于计算，全部成功后才成为可查询的 ready 批次。任一步失败整笔回滚，不留下可用的半批结果。

同一批次 ID 与规范化输入/配置/引擎版本哈希相同则复用结果；相同 ID 不同哈希拒绝。更正需要新批次 ID，引用旧批次；旧批次必须已封存且更早。每种方法的 ID + 方法版本不能换算法内容；范围、权重、方法修订分别记录原因，一次只更改一个口径维度。

数据库触发器拒绝已封存批次的追加、改写、删除和 TRUNCATE，也拒绝已封存目录的追加/改写。父记录锁使封存与并发写入相互排斥。本地开发连接是数据库所有者；这些保护防止正常 SQL 误改，不防所有者主动禁用触发器或删除表。未实现生产连接权限部署。

```sh
pnpm data:report sim:new-evidence
pnpm data:psql -- -c "SELECT id, status, config_version FROM data_batches ORDER BY generated_at;"
pnpm data:psql -- -c "SELECT batch_id, concept_id, central, change_cause, previous_batch_id FROM progress_values ORDER BY estimated_at, concept_id;"
```

此前合成模拟的每次运行保存在独立的 `data/simulation/runs/<UTC时间>/`，内含五批规范化输入、配置、JSON 查询结果和中文 Markdown 报告；当前 `package.json` 没有运行它的脚本，全部运行产物保留本地，不进入 Git。

`pnpm data:test` 在独立临时数据库运行真实 PG 回归，测试后只删除本次生成的测试库；`pnpm check` 保留无需 Docker 的网站和静态数据检查，并包含输入单元测试。仓库不使用托管 CI：完整验收在本机运行 `pnpm check:full`，它先执行 `pnpm check`，再执行 `pnpm data:test`（需要本地数据库已由 `pnpm data:setup` 建好并在运行）。

## 人工评审

机器提议的边不经人确认不得进入任何结论。评审通道：

```sh
pnpm data:review:pending -- --capability cap:asr-longform --limit 20
pnpm data:review:record -- --file review.json --reviewer "姓名"
```

`review-pending` 按**距离确定性的远近**排序而不是按置信度：判断者最没把握的那些，
才是人的时间最值钱的地方。`review.json` 的形状：

```json
{"decisions": [
  {"edge_kind": "requires", "from": "oaw:task:9413", "to": "cap:asr-longform",
   "decision": "reviewed", "note": "任务原文就是长语音转写"},
  {"edge_kind": "requires", "from": "oaw:task:11275", "to": "cap:domain-text-editing",
   "decision": "rejected", "note": "查的是格式与排版错误，不是术语准确性"}
]}
```

被否决的边保留为 `status='rejected'` 而不是删除，下一轮判断因此不会把同一条边
当作没人看过再提一遍。`decision='rejected'` 不改 `method`——人没有提出这条边，
只是否决了它；只有确认才会把边变成 `method='reviewed'` 的断言。
已决定的边不会被重放的文件悄悄改写，重复评审会被报告而不是覆盖。
