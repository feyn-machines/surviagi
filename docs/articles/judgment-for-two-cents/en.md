---
title: Sep 29–Oct 7, 2026 | Judgment now costs two cents
description: Five threads from nine days. Decision models became a category and started a price war. Evaluations moved from answering questions to doing long jobs. People handed whole chores to agents. Large models ran on personal machines. Open-weight releases came in a cluster.
date: 2026-10-07
---

Between September 29 and October 7, 2026 we read just over 3,400 posts and kept about 240 things that actually happened. Eleven companies announced 68 of them; the rest came from evaluation groups and individuals. Each is a news item on its own. Together they make five threads.

## 1. Decision models became a category in one week

- On September 29 OpenAI introduced the [Decisions API](https://x.com/OpenAIDevs/status/2105003318917697873) ([the work it bears on](/updates/ev-636f6ab7bc2ba7679f77ff0c65c48d2d8175a6bb)) in limited preview, with a plain purpose: real-time classification, routing, and choosing an agent's next action.
- On October 1 Perplexity [open-sourced its own decision model and opened an API](https://x.com/AravSrinivas/status/2105774153903268288) at 4 cents per million input tokens, with output tokens free.
- The same day @svpino [described Nace AI's Drex 1.5](https://x.com/svpino/status/2105682903640514931): by his account a 128k context window, also at 4 cents.
- Inception's Mercury Decide [went live on OpenRouter](https://x.com/OpenRouter/status/2105374270243426760), free for early access.
- Ollama [announced support for running decision models locally](https://x.com/ollama/status/2105152056382345544).
- On October 6 OpenAI [opened the Decisions API to all developers](https://x.com/OpenAIDevs/status/2107573382229188645). The same day Perplexity [halved its price to 2 cents](https://x.com/AravSrinivas/status/2107573198145663233).

Perplexity also posted a bill: its model [cleared the Elite Four and the Champion in Pokémon FireRed](https://x.com/AravSrinivas/status/2106688463542333795) in 137 API calls for 2.8 cents.

**Eight days, four vendors: one open-sourced, one cut in half, one free, and now one you can run locally. A new category went straight into a price war.**

## 2. Evaluation moved from answering questions to doing a long job

- Vals AI had [Gemini 4 Argon](/updates/ev-c76a0b6a437c2eba2940269e6190de8b80211ef4) [play Kerbal Space Program](https://x.com/ValsAI/status/2105774260182765768), from orbit to landing on several bodies and returning. It succeeded.
- Vals AI had ten Claude Sonnet 5.5 agents [prove a mathematical result](https://x.com/ValsAI/status/2104757086462914888): the lowest-energy arrangement of seven electrons on a sphere. Within 15 hours they produced a formal proof 17,895 lines long.
- Perplexity had its agent [build a browser-based open-world game from scratch](https://x.com/AravSrinivas/status/2104941391272956125). It did, spending about 2,000 dollars in credits.
- Asked to [run a vending machine business](https://x.com/lukaspet/status/2105392413032497380), Gemini 4 Argon partly succeeded.
- @johnowhitaker asked [GPT-6.1 Sol](/updates/ev-95f69611945819306ce39c6e131a37dc9eb624d3) to [design a simple motor mount in CAD](https://x.com/johnowhitaker/status/2105481516902187282). That partly succeeded as well.

**A model can write a 17,000-line proof and still not keep a vending machine in business. Whether a long job can be handed over depends on whether anyone catches it when it goes wrong.**

## 3. People started handing whole chores to agents

- @doodlestein handed over the entire job of [selling old GPUs on eBay](https://x.com/doodlestein/status/2106952610393526565): researching recent sale prices, writing the listings, posting them and tracking the sales. Twelve items sold.
- @svpino had an agent [check in for flights, move a PayPal balance, sort a spreadsheet and summarize email](https://x.com/svpino/status/2105367390930301364).
- @sayashk spent [several days](https://x.com/sayashk/status/2105472435390906634) using a high-speed tier for filling out forms and simple coding, and used up a week's allowance in about two hours.

The supporting pieces appeared the same week:

- Stripe, with Meta, Shopify, Walmart and others, launched the [Personal Agent Protocol](https://x.com/stripe/status/2107533255646089319), a standard for how personal agents deal with businesses.
- On October 7 Alibaba Cloud and Sui announced [a collaboration on agent payments](https://x.com/alibaba_cloud/status/2107758047808692297).
- Every launched [an "agentic coworker" in Slack](https://x.com/danshipper/status/2107501521885594101) at 30 dollars a month.
- Nativ 0.4 added [on-device web browsing and computer operation](https://x.com/Prince_Canuma/status/2107232089246753037).

**What gets handed over first is not the job but the chores. And payment companies and retailers have started building roads for agents.**

## 4. Large models running on your own machine

The biggest thing on this thread did not come from a company. Strata, an open-source inference engine written by one developer, put Qwen3.8-Flash-Next, a model of more than a hundred billion parameters, onto ordinary gaming PCs.

- Its author @coldniko [wrote](https://x.com/coldniko/status/2105657680303948063) that a cheap old DDR3 machine with 64 or 128 GB of memory and a GPU of 8 GB or more runs it at over 70 tokens per second. A day later he [raised output speed](https://x.com/coldniko/status/2106063046728957957) from 64.5 to 76.4 tokens per second.
- @Yacamochi_db [measured](https://x.com/Yacamochi_db/status/2105489201382965522) the 87 GB model at 120 to 150 tokens per second on a single RTX 5090.
- @rS_alonewolf [measured](https://x.com/rS_alonewolf/status/2104930917689045489) 100 to 140 on an RTX 5090 and 50 to 70 on an RTX 5070 Ti.
- @daluoseo [measured](https://x.com/daluoseo/status/2106318517738127514) 96 tokens per second with 12 GB of GPU memory.
- @chikitleung [reached 38](https://x.com/chikitleung/status/2106727691982647389) on an 8 GB RTX 4060 Ti.

Among the posts our search returned, 39 accounts published results from their own machines, most of them writing in Japanese or Chinese.

Apple silicon moved too:

- @hxiao [ran the same model locally on an M3 Ultra](https://x.com/hxiao/status/2107139756094300518) at about 75 tokens per second, up from 20 to 25 in July.
- @ivanfioravanti [tested nine local deployment setups](https://x.com/ivanfioravanti/status/2106790178954395782) on 92 agent scenarios. The best scored 92. Seven of the nine leaked another tenant's data.
- llama.cpp released [version 0.6.0](https://x.com/ggerganov/status/2107190267887632462), and Artificial Analysis open-sourced [a benchmark for running agents on local hardware](https://x.com/ArtificialAnlys/status/2105133181536243942).

Not everything worked: @Gimenorum asked a more heavily compressed version to fix the same problem [five times in a row](https://x.com/Gimenorum/status/2107749144219803855), and it did not.

**In one week dozens of people ran the same large model on their own old graphics cards. The bar dropped from a server to a gaming PC. But seven of nine setups leaking data says that running and being safe to rely on are still two different things.**

## 5. Open-weight models arrived in a cluster

- Mistral released a [preview of Mistral Large 4](https://x.com/GuillaumeLample/status/2107461898127954001): one trillion parameters, 49 billion active at a time, weights due at the end of October. It is [listed on OpenRouter](https://x.com/OpenRouter/status/2107477859317297600) at 68 cents per million input tokens.
- Google released [EmbeddingGemma 2](https://x.com/GoogleDeepMind/status/2107502286758895878) ([the work it bears on](/updates/ev-243c2855bd6d22bc4accb339cb0fe745d422546f)), a 740-million-parameter model for on-device use.
- Cristóbal Valenzuela announced [Praxis-1](https://x.com/c_valenzuelab/status/2105370660059164913), an open-weight action model for robots.
- Perplexity's decision model is open source as well.
- A new non-profit, [Trillium Labs](https://x.com/natolambert/status/2106060179985019085), launched to build open training recipes for frontier models.

**In one week, from a trillion-parameter model down to an embedding model for phones, each came in a version you can download.**

## You

What follows is this issue's judgment and guesswork, not data.

**One: if your product sells "helping people choose", this week it stopped being a product.** Routing, triage, first-pass screening, recommendation, review: at two cents these are a feature. The question is no longer whether your judgment is accurate. It is what you hold besides judgment: the data, the channel, or the liability when it goes wrong.

**Two: the hours you spend on chores each week will disappear before your actual job does.** Not because the models suddenly got smarter, but because someone has started building roads for agents. Check-ins, expenses, second-hand listings, forms: what they share is that a mistake can be undone.

**Three: do not hand over a whole long job yet.** This week's best model only partly managed to run a vending machine. What you can hand over safely is work where a mistake is visible and fixable. The test is simple: if it gets this wrong, how long before you notice?

**A guess: voice is the next thing to fall to a few cents.** Microsoft's [voice models](https://x.com/MicrosoftAI/status/2105693024013467905) appeared on several platforms within days of release, which is usually how a price war starts. If your business assumes speech transcription is expensive, redo the arithmetic now.

---

*Data through 10:32 UTC on October 7, 2026. Every figure is as stated by the account that posted it; follow the links to the original posts. For the work each update bears on and the level it reached, see [all updates](/updates) and [occupations](/occupations).*
