# 语义层方法札记 / Semantic layer method journal

这份文件记录**方法上的修正、已知缺口和判断者对照**——它们是写给人看的项目笔记，
不是数据契约。之前它们躺在 `datasets/ontology/schema/schema.json` 的 
`derived_content` 里，而那个文件自己的 `rule:type-layer-has-no-state` 写着
「类型层节点不得携带状态、时间或置信度字段」。带日期的札记放在可封存的类型层里，
是同一个错误的另一种形态，所以搬到这里。

- 类型与受控词表 → `datasets/ontology/schema/schema.json`
- 能力与闸门定义 → `capabilities.seed-v1.json`、`capabilities.discovered-v1.json`
- 状态、边、测量值 → PostgreSQL，发布时由 `publish-snapshot` 现算
- 方法札记 → 本文件

## 方法修正（17 条）

每一条都是先做错、被测量结果推翻、然后改方法的记录。留着是因为一条被改掉的判据，
比一个正确的结论更能说明这套数字该信到什么程度。

### correction:production-use-needs-no-metric

*2026-09-22*

证据判据原先写成「关于这个能力工作得有多好的可核验陈述」，判断者据此要求必须有测量数据，于是把每一条生产采用都判成了非证据（Venice AI 用 Wan 3.0 得 0.33，Fortal Studio 得 0.40，都低于阈值）。这会系统性丢掉唯一能到阶段 3/4 的证据类型。改判据明确：具名组织在真实业务中运行，无需任何数字即构成证据。改后视频能力的证据从 8 条增至 20 条。修判据而不是调阈值。

### correction:production-use-is-not-autonomy

*2026-09-22*

方法原先把 production_adoption 平映射到阶段 4，随即产出了一个站不住的阶段 4：证据是「Venice AI 用 Wan 3.0，从 360p 到 1080p 迭代打样」——迭代打样是人在环里，那是阶段 2。生产使用只证明「已部署」，不证明「人做得少」。增加第三道封顶：在所描述的用法里人还做多少，单独判定（判断者给 1.90）。三道封顶取最小值，并记录是哪一道在起作用。修正后该能力回到阶段 2，封顶因素 observed_autonomy。

### correction:missing-autonomy-is-not-permission

*2026-09-22*

自主度评分缺失时原先不施加封顶，等于把「不知道」当成「很自主」。阶段 3 与 4 的定义就是人做得少，没有这个读数就不能断言。缺失一律按 2 封顶。

### correction:state-must-use-one-run

*2026-09-22*

状态计算原先把所有历史判断运行的证据加在一起，导致被改进判据取代掉的旧结论仍在撑着一个阶段 4。改为只取最近一次完成的 demonstrates 运行；历史行保留作溯源，不参与当前结论。

### correction:sql-null-check-hole

*2026-09-22*

006 生成的 CHECK 踩了 SQL 三值逻辑：kind 为 NULL 时 kind IN (...) 返回 NULL，NULL OR FALSE 仍是 NULL，PostgreSQL 放行。那条「判不出必须写理由」的约束从未拒绝过任何东西。由集成测试发现，009 用显式 IS NULL / IS NOT NULL 修复，并已验证两种违规写入都被拒绝。

### correction:one-org-registry

*2026-09-22*

组织别名表存在两份（event_extraction.py 的字典与 organizations.json），且已经分叉：一份认识 Qwen 不认识 Google AI，另一份相反，只被其中一份认识的别名会让事件被静默丢弃。合并为一份，抽取层改为读取该文件，并在 ontology:check 里加了「不得出现第二份」的扫描。

### correction:gate-must-govern-the-output

*2026-09-22*

blocked_by 判据原先只问「完美的软件能否越过这个条件」，判断者据此把医疗转录员 15 条任务里的 14 条都连到医师签字闸门上——包括「速记打字」(0.63) 与「处理收发邮件」(0.66)。医师签字管不到收发邮件：与受管活动同处一个场所不等于被管。判据补上「条件必须管住这项工作本身的产出，而不是它所处的场所」。同一批复测：速记打字与处理邮件转为 False，「交付报告供医师签字」仍为 True 0.91。

### correction:identity-is-not-word-overlap

*2026-09-22*

requires 判据里那句「缺了它就不可能自主完成」写成了逻辑必然性，加上防关键词假阳性的警告，造成了反向错误：判断者把「能力名称与工作近乎同义」当成词面重合而否掉。诊断证据是同一条回答自相矛盾——「讲授科目并开展课堂练习 → 教学交付」noul 给 0.28（不需要），同一次回答的 centrality 却给 2.11（覆盖这项工作的核心）。两个判断者在 8,857 对重叠判断上一致率 93.8%，但分歧是单向的：DeepSeek 多判 473 条、TypeSafe 多判 74 条，6.4 倍不对称；抽查这 473 条，是 TypeSafe 判得过严而不是 DeepSeek 过宽。判据改为：测试是实际需要而非逻辑必然；能力本身就是这项工作时，那是最清楚的正判，不是可疑的词面重合；真正不算证据的是「有共同词但背后没有要求」。复测同一条：True 0.95，centrality 4.0。

### correction:adopter-publishing-is-t1-not-t3

*2026-09-22*

T1 与 T3 的措辞在「发布方自己就是采用方」时同时字面命中，因此两条定义都补上互指：采用方说自己在用他人产品是 T1，厂商说自己产品好是 T3。层级不是小事——T3 封顶阶段 2、T1 封顶阶段 4，而生产采用是通往阶段 3/4 的唯一路径。

### correction:irrelevant-is-a-decision

*2026-09-22*

证据判据把 demonstrates 的取值写成「true、false，或真的判不出时为 null」，模型据此把「这条更新根本没提到这个能力」判成了 null。26,726 次判断里 20,927 条未决（78%），其中最常见的理由就是「更新里没有相关内容」——那是一个清楚的否定，不是判不出来。把做出过的判断记成没做出的空缺，会让覆盖率看起来比实际差得多。判据补上：不相关即 false；null 只留给「更新确实触及该能力，但看不出它是成还是败」。

### correction:confidence-is-not-comparable-across-judges

*2026-09-22*

两个判断者的置信度不是同一种测量，实测分布：TypeSafe 众数 0.7、1.0 仅 4 条（它报的是 noul 概率的换算值）；DeepSeek 众数 0.9 有 12,520 条、0.6 只有 411 条（它报的是模型自述的确信程度，系统性虚高）。于是 DeepSeek 的 0.8 是家常便饭，TypeSafe 的 0.8 是高分。这会打坏两处：评审队列按 |conf-0.5| 排序会把一方的常规边排在另一方真正的两可边前面；快照里高置信(≥0.8)/低置信(<0.7)的分档跨判断者失去意义。改为在各自判断者的分布内取百分位排名，原始值仍照常显示；快照发布每个判断者的分位数轮廓，让页面能说清一个数在它自己的尺子上意味着什么。

### correction:a-failed-request-is-not-an-undecided-judgment

*2026-09-22*

同一种错误犯了两次，来源不同：一次是 TypeSafe 额度耗尽（HTTP 402），一次是持续数分钟的网络故障（SSL UNEXPECTED_EOF）。两次都是请求从未到达服务，而运行器把它们记成了「判断者无法决定」——第一次 16,814 条，第二次 604,486 条。这会让覆盖率凭空多出几十万个并不存在的空缺，而且没有任何东西会报错。

**改法：** 三条：(1) 这类行一律删除而不是记成未决，被删数量写进运行记录；(2) 重试退避从 2/4 秒改为 3/6/12 秒——三次六秒的重试在一场几分钟的故障面前形同虚设；(3) 三个运行器都加熔断：连续 3 个批次没有任何一条被判定就中止运行、标记 failed 并写明原因。一个安静地把覆盖率填满虚假空缺的运行，比一个停下来说明原因的运行更糟。

### correction:two-decimal-places-a-judge-never-had

*2026-09-22*

置信度一直按 numeric(4,3) 存、按两位小数显示，默认它是连续量。全量扫描后一数：DeepSeek 只用了 14 个取值，97.5% 落在六个整数档上。它报的是档位，不是概率；显示成 0.82 这种数，是在给一个六级刻度补上两位它没有的精度。TypeSafe 用了 41 个取值，前六个只占 12%——同一个字段，两种量纲。

**改法：** 不改存储（原始值必须保留），改的是自述：judge_confidence_profile 增加 distinct_values 与 top_six_share，快照 caveat 不写死具体百分比而是指向这两个字段——写死的数字下一轮扫描就会和它旁边的数据打架。

### correction:a-malformed-probe-almost-became-a-finding

*2026-09-22*

为了检验判断者，我手写了一个 12 条明确样例的探针，结果 TypeSafe 全判「否」、DeepSeek 全部未决——看上去像是两个判断者在最显然的例子上同时崩了。真实原因是我把 judge_with_retry(judge, work_text, items) 的第二个参数传成了字符串 'requires'：每一条都在拿「requires」这个词当工作描述去判，而且 12 条不同的工作被塞进了同一次调用。

**改法：** 按运行器的真实调用形状重写探针——一次调用对应一个工作节点，work_text 是它自己的文本。重跑后两个判断者都是 12/12。教训不在这个 bug 本身，而在于：一个「两个模型同时失败」的结果，先验概率远低于「我的测试写错了」，应该先怀疑测试。差一点就把它记成方法学发现。

### correction:a-capability-that-reaches-everything-explains-nothing

*2026-09-22*

首轮全量 requires 扫描跑完后，cap:attention-to-detail 落在 19,452 个已判断工作节点里的 17,022 个上——87.5%。次高的 cap:equipment-operation 只有 28.7%，中间是一道 0.588 的断崖。判断者没有判错：绝大多数工作确实需要细致。问题是这条结论没有信息量，而且按边数它会压过每一个职业页面上其余四十五项能力。这类节点是能力发现步骤从任务文本里抽出来的「工作特质」，不是能被某次官方发布推动的能力。

**改法：** 不删边——判断者回答的是它被问到的问题，删掉它的回答是把发现藏起来而不是记录下来。改为测量并公开：capability_states 存 work_nodes_requiring 与 work_nodes_judged 两个整数（不存比值，比值会和它的来源对不上），阈值只写在语义层的 rule:breadth-limits-discrimination 里；超过阈值的能力退出职业层结论与影响力排序，并在自己的页面上带着 87.5% 这个数一起显示。附带说明阈值为什么不吃重：实测分布只有一个离群值，0.3 到 0.87 之间任何一条线结论相同。

### correction:evidence-is-judged-under-two-standards

*2026-09-22*

判断 prompt 里，能力可以带一段 `what_counts_as_evidence`（本项算什么、不算什么）。最初那
5 个能力有，能力发现步骤产出的 41 个一条都没有——缺失时该字段直接不出现在 prompt 里，
判断者只拿到能力定义加全局的证据层级与自主度量表。结果是：当前发布的 158 条证据里，
**63 条按带判据的标准判，95 条按不带判据的标准判**，而这两套标准的松紧并不相同。

用 DeepSeek 做了两次 A/B。第一次挑证据最少的三个能力（document-review、record-keeping、
data-entry），25 个事件 × 3 项，75 次判断**零翻转**——但那一轮总共只产出 1 个正判，
几乎没有可移动的信号，这个"没变化"说明不了什么。第二次换成正判最多的三个
（video-editing、information-synthesis、realtime-voice-agent），40 个事件 × 3 项：
正判 8 → 5，**3 次翻转全部是 True → False**。

逐条看，收紧的方向是对的：「Grok Imagine 鼓励创作电影场景」是演示不是产出物，
「Google Labs Dreambeans 转为 GA」是可用性变化不是综合结果，「Hailuo 新增快速分镜功能」
是功能公告不是可测产出。判据把这三条挡掉了。

**改法：** 暂不批量补写 41 段判据。理由有两条，而且都来自已有记录：一是
[[correction:production-use-needs-no-metric]] 证明过判据写错会系统性地丢掉正确证据，
把我没有领域依据的措辞乘以 41 倍，风险大于收益；二是本次样本只有 3 次翻转，不足以支撑
重写整个证据层并重跑全量扫描。先做的是把这个不一致公开——快照与页面写明证据由两套
标准判出，以及各有多少条。判据要补，应当一次补一个、每补一个测一次翻转，而不是一次写 41 段。

**附带结论：** 缺判据不会让证据变少，只会让它变松。当前的 158 条是偏宽的读数，
和整张图谱是偏宽读数（DeepSeek 相对 TypeSafe 约 5:1 的单方面正判）方向一致。

### correction:silence-leaves-no-trace-to-resume-from

*2026-09-22*

四个 pass 都靠「这个主体有没有边」判断它跑过没有。这个测试只在每个主体都留下点什么时
才等于「它被判断过」，而实际分布是反过来的：**581 个事件里 325 个不指向任何活动
（56%）**，614 个活动里 329 个不被任何闸门约束（54%），265 个赛道里 8 个没匹配到职业。
按边数续跑，这些主体每次都会被重新问一遍——路由一轮 356,734 次提问，其中
199,550 次问的是已经问过并且答案是「没有」的事件。

沉默是一个答案，它需要一个能落脚的地方。

**改法：** 新增 `judgment_checkpoints`（迁移 018/019），主键是
`(method_version, subject_id)`，而不是 `run_id`——续跑真正要问的是「这个主体在我要用的
方法下判过没有」。方法一改 `method_version` 就变，所有主体自动重新到期，不需要手工清缓存。
表里存 `kept`，**0 是这张表存在的理由**：它把「问过、没留下东西」和「从没问过」分开，
而边表做不到这件事。

两条安全规则：断点在主体判完之后写，不在之前；批次失败的主体不写断点。后者是关键——
要避免的不是多打一次判官，是在半个答案上把主体标成已完成，之后再没有任何东西会回头看它。
事件路由还多一条：层级读取失败时证据行的 `observed_level` 是空的，对聚合毫无贡献，
这种半判定同样不写断点。

**已付过的钱补记进去了。** 四轮建库运行（164,332 + 356,734 次提问）都是 failed_batches=0
完成的，主体列表是确定的，因此可以逐条回填——`questions_asked` 留 NULL 而不是 0，
因为当时只记了每轮总数没记每个主体，写 0 等于声称「什么都没问」，那恰恰是它没做的事。
回填时第一版把 598 个活动标成判过，和运行记录的 614−23=591 对不上：我的判据比 pass 自己
的宽，漏了 `status='candidate'` 和「职业得真的带任务」两个条件。按 pass 的原判据重算后
删掉多出的 7 条。

**代价变化：** 四个 pass 现在续跑都返回 `run_id=None`、零次判官调用。每天新增的
事件按 19 条算，一天的增量是 19 × 614 ≈ 11,666 次提问，而不是 356,734 次。

## 尚未填的缺口（6 条）

- **hole:domain-text-editing-no-evidence** — cap:domain-text-editing 仍然没有任何证据边。581 个新事件、2905 次判断里，没有一条关于专业文本校订的可核验结果。这不是判断者的问题，是这三周的官方发布里确实没有这类证据——不能用相邻能力顶替。该能力的 stage_status 因此是 insufficient_evidence，不给数字。
- **hole:all-edges-unreviewed** — 所有 requires 边与 blocked_by 边都是 ai_proposed + candidate，没有一条经人确认。数据库层的 CHECK 强制 ai_proposed 只能是 candidate 或 rejected，发布快照把 candidate 与 reviewed 分开导出，页面必须分开显示，但这改变不了一个事实：现在图上每一条边都还没人看过。
- **hole:discovered-set-unreviewed** — 41 个新能力与 9 个新闸门全部是 ai_proposed + candidate，且其中 16 条的分类置信度低于 0.6——判断者自己也没把握它是能力还是闸门（如 regulatory-compliance 0.25、networking 0.46）。能力与闸门混淆会把「制度没变」算成「AI 没进步」，这 16 条必须先人工定性。中文为机器翻译，未经校订。
- **hole:capability-set-from-a-sample** — 能力集来自 658 条任务的抽样（每个职业大类 30 条，全库 18,838 条的 3.5%），且有一批次因 SSL 中断丢了约 20 条。抽样之外的工作可能需要还没被提出的能力，因此「某条任务没有匹配能力」目前不能读作「AI 与它无关」。
- **hole:twenty-one-capabilities-no-evidence** — 46 个能力中 21 个在这三周的官方发布里没有任何可核验证据（例如动物处置、表面清洁、现场勘验这类需要实体的工作）。它们的 stage_status 是 insufficient_evidence，不给数字。这不是判断失败，是证据确实不存在：采集范围是 13 家 AI 公司的官方账号，而这些能力的进展不会出现在那里。要覆盖它们需要扩大采集范围，不是改判据。
- **hole:one-judge-one-sweep** — 首轮全量 requires 扫描（19,452 个工作节点 × 46 个能力）全部由 DeepSeek 一个判断者完成。TypeSafe 在中途额度耗尽，只覆盖了很小一部分，两者的 A/B 对照因此只建立在 75 次判断上，而不是全量。更麻烦的是两者的置信度刻度类型不同（一个是十几个取值的梯子，一个是连续的），所以即使都跑了，也不能把分数直接放在一起比。现在的全量图谱是「一个判断者说的」，不是「两个判断者都同意的」。

## 已关闭的缺口（8 条）

- **hole:production-adoption-never-identified**（2026-09-22）— 原缺口：755 个事件里 production_adoption 一条都没识别出来——自主阶段 3/4 唯一的硬证据类型缺席，因为词表里根本没这个词。补入定义与判别依据后重抽，581 个事件中识别出 28 条具名生产采用（Klarna 式的具名采用方 + 真实业务场景），占 4.8%。
- **hole:other-bucket-hides-23-percent**（2026-09-22）— 原缺口：other 桶占 23.7%（179/755），问题被藏起来。取消 other，改为判不出即 kind=null 并必须写 unresolved_reason。新口径下判不出为 6.4%（37/581），且每条都写明卡在哪（「是活动公告但没有明确活动名」「是用户自述不是厂商发布」），可诊断可改进。
- **hole:dedup-by-title**（2026-09-22）— 原缺口：身份用 slug(组织+标题)，措辞不同即拆成多个事件。改为三元组 (组织ID, 类型, 对象键)。实测：CodeArena WebDev 从 4 条合并为 1 条，Apsara Conference 从 15 条合并为 1 条；候选从 775 增至 1128 的同时事件数从 755 降至 581。
- **hole:org-as-free-text**（2026-09-22）— 原缺口：primary_org 是自由文本，xAI 被拆成「xAI」9 条 + 「xAI / SpaceXAI」14 条，所有按公司的聚合都是错的。改为引用 org_registry 的 ID。新口径 581 条事件全部有组织 ID，0 条缺失，13 家公司。
- **hole:five-capabilities-only**（2026-09-22）— 原缺口：只有 5 个能力，全部来自证据评审，19,452 个工作节点的正判率仅 0.23%。改为从工作本身推导：22 个职业大类分层抽样 658 条任务原文 → 1,162 条原始提议 → 按跨大类广度筛掉 896 个单大类名称（那是任务改写不是能力）→ 合并为 51 条 → 独立分类为 41 个能力 + 9 个闸门 + 1 个未分类。合并后正判率 7.5%。分类必须是独立的一遍：提议阶段问「这项工作需要什么能力」，模型就会把闸门也说成能力——physical-presence 以 14 个职业大类成为覆盖面最广的一条「能力」，而它是最典型的闸门。
- **hole:occurrence-window-not-enforced**（2026-09-22）— 原缺口：14 天窗口只在 prompt 里，无代码强制。现已实现 occurrence_suffix()，由调用方传入已记录的发生时间（保持 assemble_extraction 为纯函数），同一三元组超过 14 天再次出现即追加年份。6 个测试覆盖边界两侧的对称性。
- **hole:gate-states-empty**（2026-09-22）— 原缺口：gate_states 一行没有，闸门是静态的。现已按 12 条 policy_statement 事件 × 11 个闸门判断 132 次，结果是 0 个闸门被移动、11 个仍关闭——而且是带日期的结论，rationale 写明「闸门要等制度改规则才会松，这是预期结果不是缺口」。空表与「查过、没动」是两回事，现在能分辨。
- **hole:evidence-covers-five-of-46**（2026-09-22）— 原缺口：证据边只覆盖最初 5 个能力，其余 41 个说不出 AI 做到了什么程度。现已对全部 46 个能力跑完证据判断（581 事件 × 46 能力 = 26,726 次判断，未决 0.9%），25 个能力得到基于证据的阶段：阶段 1 十个、阶段 2 八个、阶段 3 七个；封顶因素分别是证据种类 13 个、所述用法的自主度 10 个、来源层级 2 个。其余 21 个仍无证据，按规则不给数字。

## 判断者对照

> 这一节的数字是**某一时刻的测量结果**，会随扫描重跑而变。发布快照里的 
> `judge_agreement` 由 `publish-snapshot` 从数据库现算，那个才是权威值；
> 这里保留的是当时的读法和结论。

同一批 75 次判断（医疗转录员 15 条任务 × 5 个能力），TypeSafe Jev 与 DeepSeek 对照：

**before_definition_fix** — `agreement_rate=0.92`, `disagreements=4`

4 处分歧全部落在 cap:domain-text-editing 一个能力上，其余 4 个能力零分歧。一方按「凡涉及医学术语的文本工作」读宽，另一方按「校订既有稿件」读窄。


**after_definition_fix** — `agreement_rate=0.947`, `disagreements=2`

按来源原文取窄读并补上 boundary 后重跑，一致率 0.92→0.947，分歧 4→2，残余分歧仍在同一能力上。


**conclusion**

分歧集中在单一能力而非均匀分布，说明问题在定义不在判断者。改定义能测量到一致率变化——这是语义层驱动质量的可验证证据，不是主观判断。


**confidence_scales** — `on=2026-09-22`, `measured_over=93,475 requires edges from the first full sweep`

两个判断者的置信度此前只知道「不可比」——一个是换算过的概率，一个是自报确信度，后者系统性偏高。全量扫描跑完后能看到第二层差别：刻度的类型不同。DeepSeek 只用了 14 个不同取值，其中 97.5% 压在六个整数档上（0.70/0.75/0.80/0.85/0.90/0.95），它报的实际是一把六级梯子；TypeSafe 用了 41 个取值，前六个只占 12%，是连续的。把两者都按两位小数显示，会给其中一个凭空加上它从未具备的精度。

- *consequence*：快照的 judge_confidence_profile 现在带 distinct_values 与 top_six_share，页面据此决定怎么显示一个分数。评审队列按判断者内部百分位排序本来就是对的，这条发现又多了一个理由：在梯子上，绝对值的并列极多，跨判断者比大小毫无意义。

**full_scale_2026_09_22** — `on=2026-09-22`, `overlapping_pairs=180554`, `both_decided=177771`, `agreement_rate=0.975`, `deepseek_only_positive=3732`, `typesafe_only_positive=715`

此前的对照只有 75 次判断。TypeSafe 额度恢复后，用固定种子随机抽取 200 个工作节点重跑了一遍（9,200 次判断，67 秒），连同此前的部分扫描，两个判断者在 177,771 对上都做出了决定，一致率 0.975。关键不是这个数字高，而是分歧不对称：DeepSeek 单方面判为「是」的有 3,732 条，TypeSafe 单方面判为「是」的只有 715 条——大约 5:1。全量扫描是 DeepSeek 做的，所以发布出去的图谱是两种读法里偏宽的那一个。

- *reading*：分歧分散在多个能力上（attention-to-detail 37、visual-inspection 29、information-synthesis 23……），不像上一轮那样集中在单一能力。按本项目自己的判据，集中说明定义有问题，分散说明是 rubric 的松紧不同——也就是说，这不是某条定义写错了，而是两个判断者对「实际需要」这个门槛的高低理解不同。
- *consequence*：快照的 coverage.judge_agreement 现在发布这组数（含两个方向各自的条数），caveat 明说发布的边数是偏高的那一个而不是共识。这不消除偏差，但让读者能按比例折算。

## 开放问题

- 关系与映射 ID 现在把子节点 ID 嵌进自己的身份（relation:occupations:oaw:occupation:31-9094.00:oaw:task:9413）。概念一旦拆分即自相矛盾。建议改为不透明 ID，parent/child 只留字段；概念 ID 一个不动。这是 major，待定。
- relations.order 是展示顺序，现在封在合同里，纯排序调整会逼出新封存版本。是否移出类型层。
- adoption_stage 七值与 autonomy_stage 五值并存，映射关系待确认。草案按「证据属性 vs 能力结论」分开处理。

## 从类型定义迁出的设计说明（2026-10-03）

本体 2.0.0 把类型定义合并为 `datasets/ontology/schema/schema.json`，schema 里只留定义。下面这些「观察到的问题」「为什么这样设计」原来夹在语义模型里，原文照录：

- **vocabulary event_kind**（replaces）：scripts/data_pipeline/deepseek.py:33 里的无定义词串
- **vocabulary event_kind**（observed_problem）：两次独立抽取（旧 461 条 / 新 294 条，共 755 条）的实测，结论一致且可复算：
- **vocabulary event_kind**（version_note）：事件类型词表自己的版本。写在每条事件的 kind_vocabulary 标记里（event_kind-2.0.0），并进入判定 rubric 的哈希。只有词条或边界变了才升；语义层加了与事件分类无关的类型（如 2.1.0 的模型、供应商）不动它，否则新旧抽取会被误判为不可比。
- **vocabulary evidence_tier**（moved_from）：datasets/scoring/method.v0.json
- **vocabulary activity_level**（replaces）：autonomy_stage
- **vocabulary activity_level**（why）：autonomy_stage 是能力层的结论刻度（0-4，允许半步），判断对象是一个能力。活动层级判断的是一条活动，取值是整数 0-5，并且 5 是常设且预期为空的一档——画出一个没人占的最高档，本身就是结论。两把尺子不能互换，也不能合并。
- **vocabulary autonomy_stage**（moved_from）：datasets/scoring/method.v0.json
- **vocabulary autonomy_stage**（why_retired）：随能力层一起退役。它的 CHECK (0..4) 已写进已应用的迁移 006 并参与哈希校验，因此原样保留：改它会让 db.migrate 判定已应用的迁移被改过。
- **vocabulary person_event_role**（replaces）：public.event_people.role（现为无 CHECK 的自由文本）
- **vocabulary person_event_role**（why）：决定证据层级：同一句话，厂商高管宣布是 T3，采用方工程负责人确认是 T1/T2，匿名社区自述是 T4。没有这个词表，T1–T4 只能人肉判。
- **vocabulary org_affiliation_role**（replaces）：public.person_affiliations.role_name（现为无 CHECK 的自由文本）
- **vocabulary relation_status.rejected**（why）：被你划掉的边要留痕，否则下一轮 AI 会再提一遍。
- **vocabulary lifecycle**（why）：当前本体合同在格式上无法表达「这个概念退休了、由谁接替」。schema.json 全层 additionalProperties:false，今天连加这个字段的口子都没有。
- **vocabulary judge**（why）：每条 ai_proposed 边都必须能追到是谁提的。006 里把 judge 写死成 deepseek/typesafe，漏了一种真实存在的来源：评审对话中由模型提出的边——本体现有的 5 个能力、2 个闸门、6 条边全部由此而来。漏掉它只会逼人把它伪装成别的来源，那比多一个词更糟。
- **vocabulary judgment_task.gate_state**（why）：原先借用 demonstrates 记录闸门状态运行，结果证据查询按 task='demonstrates' 取最近一次完成的运行时选中了它，整份快照的证据变成 0 条。借用一个词表项的代价不是不整洁，是下游会按它的本义去用。
- **class gate**（why_separate_from_capability）：混在一起会把「法律没变」误算成「AI 没进步」。O*NET 全库有 716 条任务原文涉及法规合规、涉及 364 个职业，量级足以扭曲整条进度曲线。
- **class model**（why_separate_from_product）：事件的 subject_key 是为去重写的自由文本，同一个模型在几乎每条事件里写法都不同。模型单独成节点，才能回答「这条更新说的是哪个模型」。产品不进这张表。
- **class model**（not_recorded）：目录里还有输入模态、上下文长度、价格、知识截止日期、是否支持推理与工具调用。输入模态在同一模型的不同供应商条目间不一致（152 个里 98 个），其余与「AI 能独立完成哪些工作」无直接关系，均不入库。
- **relation requires**（why_method_required）：这条边是判断不是匹配。实测：对 18838 条任务原文做关键词匹配找「软件相关」，命中 999 条 / 362 个职业，但抽样核对 oaw:occupation:11-9032.00（中小学教育管理者）的 14 条命中全部是假阳性——program 指课程、code 指法规条文。没有 method/status，我提议的边和你审过的边混在一起，整张图不可信。
- **rule:tier-caps-stage**（currently_lives_in）：datasets/scoring/method.v0.json 的 stage_caps
- **rule:ai-proposed-cannot-assert-equivalence**（currently_lives_in）：scripts/lib/ontology-data.mjs（硬编码在校验器里）
- **rule:definition-must-equal-source**（currently_lives_in）：scripts/lib/ontology-data.mjs（硬编码在校验器里）
- **rule:blocked-by-needs-source-task**（why_retired）：闸门现在直接挂在活动上（activity_gate_edges），不再需要经由某条任务来取得来源。
- **rule:breadth-limits-discrimination**（threshold_is_not_load_bearing）：首轮全量 requires 扫描测得的分布只有一个离群值：cap:attention-to-detail 0.875，次高 cap:equipment-operation 0.287，其余全部更低。0.3 到 0.87 之间任何一条线都会得到同一个结论，所以这个阈值放在哪里不影响结果。若将来有能力落到 0.4–0.6 之间，这条规则必须重新论证，而不是照用。
- **rule:breadth-limits-discrimination**（why_retired）：它是给能力设的护栏：一条能力覆盖面过宽就不再有区分力。活动层不靠覆盖面筛选——一条活动能否被判定，取决于有没有证据打到它，而不是它有多宽。
- **rule:tier-caps-level**（replaces）：rule:tier-caps-stage
- **rule:task-level-is-the-minimum**（observed_problem）：取最高一度把行李搬运工判到 59%：迎接客人匹配上了，搬行李没有。
- **rule:attention-baseline**（why_not_views）：按浏览量相对账号基线排名时，前十被付费推广帖占满：浏览量是账号平时的数千倍，点赞却极少。互动需要真人操作，推广买来的主要是浏览。
- **rule:attention-baseline**（why_two_captures）：X 帖子的互动大多发生在前一两天，第 7 天基本定型；第 7 天同时是第三方验证的查找窗口终点，定稿热度、收齐回复、触发验证可以在同一次完成。每天回看、重复采集同一帖子，只增加请求，不增加信息。
- **rule:gate-caps-level**（replaces）：原规则把有障碍的环节直接记为 L0。L0 的意思是 AI 不参与，而一条 AI 更新不可能证明 AI 不参与；这把「有障碍」和「AI 没参与」混成了一件事，把 250 项任务压到了 L0。
- **rule:verification-tier**（replaces）：原规则按账号角色（评测者、实测者……）决定层级，并按「用途」对账号分组、按连续无产出降级。首次试跑中，降级规则把 139 个验证账号降为印证：一个账号没谈某个产品是常态，不说明它不可靠。
- **rule:nature-caps-level**（observed_problem）：首次验证试跑中，判官把一段无人机演示判为 L4；若不设限，演示会产生全站第一个 L4。
- **organizations_are_ids_not_names**（observed_problem）：461 条事件的 primary_org 是自由文本，同一家公司出现两个值：「xAI / SpaceXAI」7 条、「xAI」6 条。所有按公司的聚合因此都是错的，而且没人会注意到。
