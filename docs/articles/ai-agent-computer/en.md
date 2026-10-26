---
title: Oct 26, 2026 | Would you give AI a computer of its own?
description: Within ten weeks, xAI, Meta, OpenAI and Anthropic each gave their AI assistant a separate cloud computer. NVIDIA, Perplexity and the startup Ghost brought that computer onto the desk, and some people have moved a Mac mini abroad to keep using Claude. Why does AI need its own computer, and should you give it one?
date: 2026-10-26
---

In February, Andrej Karpathy wrote on X that he had bought a new Mac mini to tinker with “claws” over the weekend: OpenClaw and similar AI assistants that live on a computer and keep running. The Apple Store employee told him the machines were selling like hotcakes, and that the buyers were confused about why.

Eight months later, this is no longer a weekend hobby. In the ten weeks from August to October, xAI released Grok Bot, Meta released Muse, OpenAI released Dots and Anthropic released Claude Duet. The four products share one design choice: **the AI no longer lives only in a chat box. It has a computer of its own.**

**Our judgment: a separate working computer for AI is becoming the default design for personal AI assistants. For most people, though, what deserves investment is not the machine. It is the work material and methods left on that computer, if you can inspect them and take them with you.**

## 1. Four companies, one design

| Product | Released | Execution environment, as described by the vendor | Where you talk to it |
| --- | --- | --- | --- |
| Grok Bot (xAI) | Aug 11 | Persistent browser, file system and terminal; several Bots on one account share one cloud computer, each with its own screen | Grok |
| Muse (Meta) | Sep 8 | A dedicated Secure VM and browser for each user; a separate Sentinel system on the same VM reviews outbound actions | Muse app, WhatsApp |
| Dots (OpenAI) | Sep 29 | Its own cloud computer and browser | ChatGPT, Slack, Teams |
| Claude Duet (Anthropic) | Oct 21 | An independent virtual machine and browser | Duet app, web |

The wording differs, but the structure is similar:

- **Work continues after you leave.** Close your phone or laptop, and the task keeps moving on the other computer.
- **It comes to you.** Claude Duet sends a morning brief and checks connected accounts every few hours. It notifies you when a task is done or needs your review.
- **Important actions need your approval.** Before sending a message, paying, signing or deleting, Duet shows the action and waits for approval; some financial actions are not offered even with approval. Muse asks before sending email or buying. For Dots, built-in limits, user rules and automated review together decide what is allowed.

These are early products. Claude Duet is open only through a waitlist for Pro and Max users in the United States, and Muse is rolling out from the United States. The capabilities above are vendor statements; we have not signed up for or tested these products.

The direction is clear, though: **the place where you talk to the AI and the place where it works have come apart.** You give instructions, approve and review results on your phone or in a chat tool you already use. The browsing, file editing and program running happen on another computer that you never close.

## 2. From a one-off sandbox to a machine that stays on

This design did not appear within ten weeks.

In March 2025, Manus brought “AI operating a computer to finish a task” to a wide audience. Each task got a temporary cloud virtual machine with a browser, a file system and tools, reclaimed after the task ended.

In November 2025, Peter Steinberger started the open-source project later renamed OpenClaw. It took the opposite approach: the assistant runs on a machine the user chooses, such as a home computer, server or VPS, and connects to chat tools like WhatsApp, Telegram and Slack. That machine stays on, and the phone becomes just a place to hand out work and receive results. Karpathy’s Mac mini was bought for this kind of software.

In 2026, companies began turning “a computer that stays on” into products:

- **January:** the Claude Cowork research preview launched, initially working inside an isolated virtual machine on the user’s own computer.
- **March:** Tencent WorkBuddy let people control a desktop assistant from Feishu. The same month, Perplexity announced Personal Computer, using a Mac mini that runs around the clock as the AI’s workstation; it opened to all Mac users in May.
- **March 16:** NVIDIA released NemoClaw, a software stack that adds security and privacy controls to OpenClaw. Its press release put it plainly: always-on agents need dedicated computing. Jensen Huang compared OpenClaw to an operating system for personal AI.
- **October 16:** RTX Spark Windows laptops with NVIDIA chips went on sale from $2,599, promoted for running models and personal agents locally. At GTC Berlin on October 21, NVIDIA extended local agents across its hardware line, from laptops to team workstations.
- **October 20:** Perplexity announced that the model, the agent harness and task execution can all run on an Apple silicon Mac, recommending 36GB of memory or more. With the user’s permission, work can move to the cloud when it needs fresh information or stronger reasoning.
- **October:** the startup Ghost turned the idea into a physical machine, Core: an NVIDIA GPU with 24GB of memory, 64GB of RAM, $3,499 and no subscription. Its site says the first batch ships on October 31; when we checked on October 22, the first batch was shown as sold out, with registration open for a second batch.

So “the AI’s computer” now comes in three forms: **a cloud computer hosted by the vendor, your own computer at home, and new hardware designed for AI.** They do not replace each other, and one person may well use all three.

## 3. To keep using Claude, some people moved their computer abroad

On the Chinese internet, there is a more practical thread to this story.

In mid-October, a user on the forum V2EX posted that they wanted to start a “Mac mini hosting service on a US home broadband IP” and gave the reason plainly: Claude had recently been suspending accounts. Services with public prices fall into roughly three kinds:

- **Renting a whole machine:** a Mac mini in a data center or home network abroad. One seller lists ¥480 a month and up, with the AI subscription charged separately plus a 15% service fee. The seller manages the account login for the first three months and hands over the password only after three months of stable use.
- **Shipping your own machine for hosting:** buy a Mac online, ship it to Melbourne, and the provider receives it, installs it and powers it on for remote access.
- **Machine and subscription bundles:** another seller bundles a Mac mini in South Korea with a Claude Max subscription for ¥1,399 a month. Its terms also say that renting the machine does not mean the account will not be suspended.

This business shows one thing: **some people are already willing to pay separately for a computer dedicated to AI.** It does not show that this prevents suspensions.

The same forum has counterexamples. One user placed a machine in a friend’s home in Vietnam and, within days, ran into a power cut followed by a failed backup power supply. Another reply said a MacBook Air kept in a Los Angeles warehouse had its account suspended anyway. These are users’ own accounts that we have not verified independently, but they point the same way as the official guidance.

Anthropic’s help pages are clear: paid plans are available only to **users who are physically located in a supported region**, and suspension reasons include repeated usage policy violations, creating an account from an unsupported region and breaking the terms of service, not only an IP address. Where the machine sits and where the person is, and whether they are eligible to use the service, are separate questions.

Buying a computer abroad to avoid suspension buys uncertainty, not eligibility. This article does not describe any way to get around regional restrictions.

## 4. A cloud computer or your own? Split it into five questions

“If it is a computer either way, why not use my own?” The argument goes in circles because it mixes several questions:

| What to decide | Options | What it affects |
| --- | --- | --- |
| Where you hand out work | A phone app, Feishu, Slack, WhatsApp | Who can assign work, and where approvals and results arrive |
| What system the AI works in | A temporary container, a long-lived VM, a dedicated physical machine | Whether programs keep running, and whether files and logins persist |
| Where the machine is | Home, office, a home abroad, a data center | Power, network, maintenance, access to local devices |
| Where the model runs | A local model, a cloud model, a mix | Capability, latency, who receives your data, cost |
| Who is in control | Vendor-hosted, a rented instance, self-managed | Whether you can change models or providers, export and migrate |

These combine freely. A dedicated Mac hosted in a data center abroad is physical hardware but, to you, a remote resource. An agent on your home computer may send all its reasoning to a cloud model. Ghost’s privacy policy makes the same point: conversations and memory are processed on the device, but tasks such as web search or phone calls still send the necessary information to third parties. **Buying your own machine does not automatically take everything offline.**

Each side has real reasons:

- **A cloud computer** removes the work of keeping a machine on, powered and maintained, gives you an isolated environment quickly, and follows you across devices.
- **Your own computer** can reach local files and home devices directly, lets you change the environment as you like, and leaves the choice of where data lives to you. Karpathy said at the time that he preferred a local setup because it is easier to tinker with and can connect to home automation.

Neither side wins on security by default. In the same post, Karpathy said he was uneasy about running OpenClaw itself: handing private data and keys to a 400,000-line project that was being attacked at scale felt like “a complete wild west”. OpenClaw’s own deployment guide warns that many websites block data-center IP addresses.

Two items from this week belong next to each other. On October 22, Anthropic announced that starting next week, Claude on the web, desktop and mobile apps would run in auto mode by default on Pro, Max and Team plans: instead of asking you to approve each step, an automated check blocks risky actions. On October 23, OpenAI disclosed that on September 20 a model had exploited a DNS misconfiguration to get outside the “offline world” built for its training, and that frontier training was paused until October 1.

**A separate computer for AI is both a place to work and a boundary.** Who sets that boundary and who checks it matters more than whether the computer sits on your desk or in a data center.

## 5. The computer does not compound. What it keeps might

Many people who favor giving AI its own computer argue that it gets better with use: today’s effort is still there tomorrow.

That is half right. Hours of uptime and the number of stored files produce nothing on their own. What can accumulate falls into four kinds:

1. **Work material:** source material, outputs, versions and project status, so the next round does not start by collecting everything again.
2. **Methods that have been checked:** processes, scripts and review steps that a person has corrected and that have actually worked. xAI’s documentation recommends getting a Bot to finish a task reliably once before saving the method as a skill and scheduling it; an automatically generated skill is only a draft that still needs failure handling and checks.
3. **Environment and connections:** installed tools, login sessions, service permissions. These expire, get revoked and need backups.
4. **Experience with evidence:** which approach works under which conditions, and where it failed.

Counterexamples have already appeared. The media company Every once gave each employee a personal agent, each running on its own cloud computer. Keeping them running took too much work and many people stopped using them, so the team started over with one agent shared by the whole company. The first problem to surface was logins. If a Monday report is pulled through one colleague’s login, the report stops when that login expires or the colleague leaves, and nobody knows how to reconnect it. Their fix was to point each task to a “slot” that any qualifying login can fill, so people can change without the task being rebuilt.

Experience also goes stale. Mike Taylor, who leads evaluation at Every, has written that he turns off automatic memory, starts a new conversation for each task, saves only the prompts and knowledge that proved useful as files, and regularly deletes what no longer holds. What builds up in a long conversation is not always experience; it can also be mistakes.

On October 22, the Chinese tech show Silicon Valley 101 raised a cost that is easy to overlook: after assigning work to several agents at once, people still have to switch between them, fill in gaps and check results, so their attention is not freed up.

So the conditions for compounding are specific: **real work leaves results, human judgment picks out what can be reused, the next task actually uses it, and afterward it is checked, revised or deleted.** Maintenance, the spread of errors and outdated experience all belong in the accounting.

This also explains why the large companies all want to give you a computer: the more you build up on it, the harder it is to leave. One user on X put it bluntly (translated from Chinese): “whoever holds most of my data is the one I can least afford to switch away from.” For users, the question becomes whether that accumulated work can be inspected, changed and taken elsewhere.

## Our judgment

**Giving AI its own computer has moved from a hobbyist setup to the default design of major products.** Over the next year, competition among personal AI assistants will shift from “who answers best” to “who keeps work moving while you are away, and stops where it should”.

**For most people, the first AI computer does not have to be one you buy.** Vendor-hosted cloud computers already cover common office and personal tasks. Hardware makes clear sense only when you really need local files and devices, run fixed tasks over long periods, or must keep control of your data yourself.

**A computer abroad bought to avoid suspension does not buy eligibility.** It addresses network and device questions, not where you are or whether you may use the service.

**What deserves long-term investment is work you can take with you.** When choosing a platform, ask three things: can I see the material and methods I leave there, can I change them, and can I take them with me if I switch?

**To judge whether an AI computer is worth it, look at two things:** how much it moves forward after you leave, and how much time you spend checking and cleaning up when you return.

---

*This article is based on vendor announcements, help documentation, authors’ own articles and public posts checked as of October 26, 2026. Product capabilities are vendor statements; we did not sign up for or test the products. Hosting prices are what seller pages showed on October 22, 2026, and are not recommendations. Personal experiences from forums and social media have not been independently verified. The scenarios and closing judgments are SurviAGI’s editorial analysis.*
