---
title: 2026 年 9 月 29 日至 10 月 7 日｜“做判断”只值两美分了
description: 九天里的五条线：决策模型一周内变成品类并开始价格战；评测从答题变成让模型干一件长事；有人把杂事整件交给 agent；大模型跑进了自己的机器；开放权重模型密集发布。
date: 2026-10-07
---

9 月 29 日到 10 月 7 日这九天，我们读了 3400 多条帖子，留下约 240 件真正发生的事：11 家公司自己宣布了 68 件，其余来自测评机构和个人。单看每一件都是新闻，放在一起是五条线。

## 一、“决策模型”在一周内变成了一个品类

- 9 月 29 日，OpenAI 推出 [Decisions API](https://x.com/OpenAIDevs/status/2105003318917697873)（[它涉及的工作](/updates/ev-636f6ab7bc2ba7679f77ff0c65c48d2d8175a6bb)），限量预览，用途写得很直白：实时分类、路由、替 agent 选下一步动作。
- 10 月 1 日，Perplexity [开源了自己的决策模型并上线 API](https://x.com/AravSrinivas/status/2105774153903268288)，每百万输入词元 4 美分，输出免费。
- 同一天，@svpino [介绍了 Nace AI 的 Drex 1.5](https://x.com/svpino/status/2105682903640514931)，按他的说法是 128k 上下文、同样 4 美分。
- Inception 的 Mercury Decide [上了 OpenRouter](https://x.com/OpenRouter/status/2105374270243426760)，早期免费。
- Ollama [宣布支持在本地运行决策模型](https://x.com/ollama/status/2105152056382345544)。
- 10 月 6 日，OpenAI [向所有开发者开放](https://x.com/OpenAIDevs/status/2107573382229188645)。同一天 Perplexity [把价格砍到 2 美分](https://x.com/AravSrinivas/status/2107573198145663233)。

Perplexity 还晒了一张账单：让模型[打通宝可梦火红的四天王和冠军](https://x.com/AravSrinivas/status/2106688463542333795)，全程 137 次调用，花了 2.8 美分。

**八天，四家，有开源、有降价、有免费，还能在本地跑。一个新品类刚出现就开始了价格战。**

## 二、评测从“答题”变成“让它干一件长事”

- Vals AI 让 [Gemini 4 Argon](/updates/ev-c76a0b6a437c2eba2940269e6190de8b80211ef4) [玩坎巴拉太空计划](https://x.com/ValsAI/status/2105774260182765768)，从入轨到登陆多个天体再返回。成了。
- Vals AI 让十个 Claude Sonnet 5.5 agent [证明一道数学题](https://x.com/ValsAI/status/2104757086462914888)：球面上七个电子的最低能量排布。15 小时内交出一份 17,895 行的形式化证明。
- Perplexity 让自家的 agent [从头做一个浏览器里的开放世界游戏](https://x.com/AravSrinivas/status/2104941391272956125)，做出来了，花掉约 2000 美元的额度。
- 让 Gemini 4 Argon [经营一台自动售货机](https://x.com/lukaspet/status/2105392413032497380)，只成了一部分。
- @johnowhitaker 让 [GPT-6.1 Sol](/updates/ev-95f69611945819306ce39c6e131a37dc9eb624d3) [用 CAD 画一个简单的电机支架](https://x.com/johnowhitaker/status/2105481516902187282)，也只成了一部分。

**能写出一万七千行证明，却管不好一台售货机。长活能不能交出去，取决于这件事错了有没有人兜着。**

## 三、有人开始把日常杂事整件交给 agent

- @doodlestein 把[卖二手显卡](https://x.com/doodlestein/status/2106952610393526565)整件交了出去：查近期成交价、写商品描述、上架、跟踪，卖掉了 12 件。
- @svpino 让 agent [办了值机、转了 PayPal 余额、整理了表格、汇总了邮件](https://x.com/svpino/status/2105367390930301364)。
- @sayashk [连续几天](https://x.com/sayashk/status/2105472435390906634)用高速档填表和做简单编码，一周的额度两个小时左右就用完了。

配套的东西在同一周出现：

- Stripe 拉上 Meta、Shopify、沃尔玛等几家，推出[个人 agent 协议](https://x.com/stripe/status/2107533255646089319)，定的是 agent 怎么和商家打交道。
- 10 月 7 日，阿里云和 Sui [合作做 agent 支付](https://x.com/alibaba_cloud/status/2107758047808692297)。
- Every 在 Slack 里上线了[“agent 同事”](https://x.com/danshipper/status/2107501521885594101)，每月 30 美元。
- Nativ 0.4 加入了[在本机上浏览网页和操作电脑](https://x.com/Prince_Canuma/status/2107232089246753037)。

**先交出去的不是工作，是杂事。而支付公司和零售商已经开始为 agent 修路了。**

## 四、在自己的机器上跑大模型

这条线上最大的一件事不是哪家公司发的。一位开发者做的开源推理引擎 Strata，把一千多亿参数的 Qwen3.8-Flash-Next 跑进了普通的游戏电脑。

- 作者 @coldniko 的[原帖](https://x.com/coldniko/status/2105657680303948063)说：一台便宜的旧 DDR3 机器，64GB 或 128GB 内存，接一块 8GB 以上的显卡，每秒能出 70 个以上的词元。第二天他[又把输出速度](https://x.com/coldniko/status/2106063046728957957)从每秒 64.5 提到了 76.4。
- @Yacamochi_db [实测](https://x.com/Yacamochi_db/status/2105489201382965522)：87GB 的模型，单张 RTX 5090 每秒 120 到 150 个词元。
- @rS_alonewolf [实测](https://x.com/rS_alonewolf/status/2104930917689045489)：RTX 5090 每秒 100 到 140，RTX 5070 Ti 每秒 50 到 70。
- @daluoseo [实测](https://x.com/daluoseo/status/2106318517738127514)：12GB 显存，每秒 96 个词元。
- @chikitleung 在一块 8GB 的 RTX 4060 Ti 上[跑到了每秒 38 个](https://x.com/chikitleung/status/2106727691982647389)。

我们搜到的帖子里，有 39 个账号各自贴出了自己机器上的实测结果，主要来自日文和中文圈。

苹果芯片这边同样在动：

- @hxiao 在一台 M3 Ultra 上[本地跑同一个模型](https://x.com/hxiao/status/2107139756094300518)，每秒约 75 个词元，而七月还只有 20 到 25。
- @ivanfioravanti 用 92 个 agent 场景[测了 9 种本地部署方案](https://x.com/ivanfioravanti/status/2106790178954395782)，最高分 92。同时发现其中 7 种会泄露别的租户的数据。
- llama.cpp 发布了 [0.6.0](https://x.com/ggerganov/status/2107190267887632462)；Artificial Analysis 开源了一套[专测本地机器跑 agent 的基准](https://x.com/ArtificialAnlys/status/2105133181536243942)。

也有没做成的：@Gimenorum [连续五次](https://x.com/Gimenorum/status/2107749144219803855)让一个压缩得更小的版本修同一个问题，没有修好。

**一周之内，几十个人在各自的旧显卡上把同一个大模型跑了起来。门槛从服务器降到了游戏电脑。但九种部署方案里七种会漏数据，说明跑得起来和用得放心还是两回事。**

## 五、开放权重模型密集发布

- Mistral 放出 [Mistral Large 4 预览版](https://x.com/GuillaumeLample/status/2107461898127954001)：总参数一万亿，每次激活 490 亿，权重月底开放。OpenRouter 上的[价格](https://x.com/OpenRouter/status/2107477859317297600)是每百万输入词元 0.68 美元。
- Google 发布 [EmbeddingGemma 2](https://x.com/GoogleDeepMind/status/2107502286758895878)（[它涉及的工作](/updates/ev-243c2855bd6d22bc4accb339cb0fe745d422546f)），7.4 亿参数，面向端侧。
- Cristóbal Valenzuela 宣布了 [Praxis-1](https://x.com/c_valenzuelab/status/2105370660059164913)，一个开放权重的机器人动作模型。
- Perplexity 的决策模型也是开源的。
- 新的非营利机构 [Trillium Labs](https://x.com/natolambert/status/2106060179985019085) 成立，做开放的前沿模型训练方法。

**一周之内，从万亿参数的大模型到手机上的嵌入模型，都有了能下载的版本。**

## 你

以下是本期的判断和猜测，不是数据。

**一，如果你的产品卖的是“帮人做选择”，这周它不再是产品了。** 路由、分流、初筛、推荐、审核，这些在两美分面前都只是一个功能。你该问的不是“我的判断准不准”，而是“除了判断，我还握着什么”：数据、渠道，还是出了错由你负责。

**二，你每周花在杂事上的那几个小时，会比你的本职工作先消失。** 不是因为模型突然变聪明了，而是因为有人开始为 agent 修路。值机、报销、挂二手、填表，这些事的共同点是做错了能撤回。

**三，别急着把整件长活交出去。** 这周最好的模型经营一台售货机都只能算部分成功。现在能放心交的是“错了看得见、看见了能改”的事。判断标准很简单：如果它搞砸了，你多久能发现？

**猜测：下一个被打到几美分的是语音。** Microsoft 的[语音模型](https://x.com/MicrosoftAI/status/2105693024013467905)这周发布后很快出现在多个平台上，这通常是价格战的前奏。如果你的生意建立在“语音转写很贵”这个前提上，现在就该重算一遍。

---

*数据截至 2026 年 10 月 7 日 10:32（UTC）。文中数字均出自发帖方本人的陈述，点击链接可看原帖。每条更新涉及哪些工作、到了哪一级，见[全部更新](/updates)和[职业](/occupations)。*
