---
title: Oct 26, 2026 | AI is starting to operate software for you. What goes next, the UI or the software?
description: Agents are operating browsers, changing files and continuing work while users are away. Product announcements and Anthropic’s internal research suggest software value is shifting toward permissions, shared state and reviewing results.
date: 2026-10-26
---

Imagine handing AI a task: read the material in your email, update a spreadsheet, then deliver the result to a colleague.

Previously, it would explain the steps. Now it is starting to open pages, find files and make changes. You may do less copying and pasting, while answering a different set of questions: Is this the latest version? Can this information be shared? Is it ready to submit?

**As of October 2026, agents are beginning to work across browsers, files and applications on users’ behalf. Our judgment is that the need for people to perform every step will weaken first. Software value will become more concentrated in data, permissions, shared state and recovery when something goes wrong.**

Interfaces will still matter. Screens that teach people how to operate software may increasingly give way to screens that show progress, surface exceptions and let people review results.

## 1. Which part of the interface is being bypassed?

Our [previous software article](/articles/ai-uses-software-for-you) examined ChatGPT operating a browser and Copilot editing Office files. The common change was handing the work of finding controls and following steps to an agent.

October’s newer material takes this further: the place where a person requests work can be separate from the place where the agent executes it.

Anthropic’s October 21 [Claude Duet announcement](https://claude.com/resources/articles/claude-duet) describes a virtual machine and browser that keep working while the user is away, returning with results or requests for review. Initial access is a research-preview waitlist for US Pro and Max users. Anthropic also warns that it can misread information and misjudge urgency.

The useful distinction is that a message on your phone can initiate work somewhere else. The phone need not be the machine performing it.

**The conversation, the execution environment and the business record can become three separate things.**

## 2. Does giving AI a computer make software disappear?

Several products in the source material implement this separation, with different boundaries.

[OpenAI’s Dots](https://openai.com/index/introducing-dots/) have a cloud computer and browser, with conversations continuing across ChatGPT, Slack and Teams. Proactive background research is restricted to read-only tools; actions that change or send information follow separate permission and approval rules. Being online continuously does not mean unrestricted access to every application.

[Meta’s Muse](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/) uses a dedicated virtual machine, with its app or WhatsApp as a communication channel. Meta describes work continuing after the app closes, with approval requested before sending email or making purchases.

[Grok Bot’s documentation](https://docs.x.ai/grok-bot/overview) emphasizes persistent browser, file and terminal state. Multiple Bots belonging to one account share a cloud computer, including files and browser sessions. They should not be treated as separate, fully isolated machines.

These are first-party descriptions of product capabilities. They do not establish how much time ordinary users reliably save.

They do make one point concrete: **agents still depend on software to store files, retrieve records and execute transactions. Users may simply stop entering every application themselves.**

Giving an agent a computer need not mean buying physical hardware. The environment might be a cloud virtual machine or another authorized host. Continuity, clear permissions and retrievable results matter more to the work than the shape of the machine.

## 3. Why are people still busy when there are fewer buttons to press?

Delegating operation can turn the user into a supervisor.

[Anthropic’s internal employment study](https://www.anthropic.com/research/employment-at-anthropic) offers an instructive example. By August 2026, interactive agent work hours were roughly six times employee hours. Yet approximately 80% of elapsed interactive Claude session time was spent waiting for human input. Meta-work, including managing and monitoring agents, grew from about 10% of interactive sessions in fall 2025 to about 22% in spring 2026.

Six times the hours does not mean six times the useful output. Nor does the waiting figure mean employees were idle for 80% of their workday. These measures describe different aspects of agent activity inside one unusually AI-intensive company.

The implication for interfaces is that human attention can become scarce as more tasks run together.

People need not watch every click. They do need to know what is happening, where work is stuck, which data was used and what the next approval would do.

Task lists, change comparisons, permission boundaries, failure alerts and undo controls may become more valuable than another feature buried in a menu.

**Less manual operation still leaves someone responsible for understanding and accepting the result.**

## 4. What can software still charge for?

Consider a tool whose main job is moving email attachments into a spreadsheet and formatting them. If a general assistant performs those steps, the user has a reason to reconsider the subscription.

Now consider a company’s order system. An agent might enter an order, while the system still has to synchronize inventory, maintain a shared record, enforce authority to change prices and recover from failures.

These are hypothetical comparisons, not measured replacement cases. They illustrate why copying an interface is insufficient to establish that a product can be replaced.

The more useful questions concern:

- **Data:** Are its records trustworthy and kept current?
- **Permissions:** Can access and changes be constrained in practice?
- **Collaboration:** Do people and agents see consistent state?
- **History and recovery:** Can errors be detected, traced and reversed?
- **Delivery:** Who accepts the result, and who handles failure?

This follows our [earlier analysis of SaaS subscriptions](/articles/will-ai-replace-saas): reproducing features addresses only part of replacement. Customers also buy the ability to deliver a job repeatedly.

Supporting agent access could make an existing product easier to include in workflows while reducing users’ direct contact with its brand. Whether revenue survives depends on the responsibility it carries in delivering the result.

## Our judgment

**Interfaces will lose some of their role as the everyday operating entrance, while retaining roles in observation, authorization, collaboration and review.** A good interface should help people understand ongoing work with less attention.

**Whether software is displaced depends on what it provides beyond its interface.** Tools that package simple sequences may face replacement pressure earlier. Systems that maintain shared records, enforce permissions and handle recovery still need to be compared on reliability and total cost.

**For users, begin by delegating a bounded task.** Organizing material or producing a checkable spreadsheet draft is a useful example. Count the time spent briefing, reviewing and correcting before expanding the delegation.

The next round of software competition will increasingly ask: when users no longer perform the clicks, can you still reliably deliver the work?

---

*This article draws on first-party announcements and research checked through October 26, 2026. Product capabilities are vendor descriptions; we have not performed hands-on acceptance testing of these products. Scenarios and concluding judgments are SurviAGI’s editorial analysis.*
