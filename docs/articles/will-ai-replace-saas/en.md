---
title: Oct 10, 2026 | Will AI replace SaaS? What are users still paying for?
description: Bespoke agents, established workflows and harder-to-sell side projects point to different questions. A source-linked analysis of what it would take to replace paid software.
date: 2026-10-10
---

**Our current judgment: building similar features does not, by itself, let a customer cancel a software subscription. An alternative has to handle the customer's actual workflow at an acceptable cost, including the work of keeping it running.**

Three recent posts make this question more concrete. DHH predicts small pieces of bespoke software. Diogo Almeida argues that established SaaS companies understand the workflows to automate. Ian Nuttall describes difficulty selling the side projects he builds. These are a prediction, a software vendor's view and a personal business experience. They do not establish an industry-wide replacement trend.

Follow the competing claims on our [SaaS topic page](/topics/viability-saas-app-5c83f1cb). This article adds our interpretation and the questions we would use to test it.

## 1. What if an agent builds only the part you use?

[DHH's post](https://x.com/dhh/status/2108643095768101111) imagines asking an agent to build the small fraction of Microsoft Office or Adobe Creative Suite that you actually need. His “5%” is a hypothetical example, not a measured average of software usage. The post predicts bespoke software; it does not document a completed replacement.

The useful question is narrower than whether an agent can recreate a whole suite: can it reliably do one recurring job?

For example, a replacement for an invoice tool might only need to import a file, validate fields and export a report. A convincing demonstration would use real input files and test corrections, duplicate records and the next month's run. The example is ours, not a reported deployment.

**A small feature set can be enough. The test is whether it completes the job repeatedly.**

## 2. What do established SaaS companies know that a clone does not?

In an [interview excerpt published by a16z](https://x.com/a16z/status/2108622406428619002), TypeSafe AI's Diogo Almeida separates cheaper software from easy replication. He argues that established SaaS companies know their customers' workflows and needs, and could benefit substantially from AI. That is his view, not a finding about SaaS revenue, renewals or market performance.

Our interpretation is that the visible interface is only part of what a replacement must cover. A buyer may also need:

- **Integrations:** the right records arrive from other systems and updates reach the right destination.
- **Shared data:** colleagues can work on the same records without losing changes.
- **Permissions and history:** access rules hold, and someone can reconstruct what happened.
- **Recovery and support:** a failed run can be repaired, with someone responsible for fixing it.

These are evaluation criteria, not proof that existing vendors will keep their customers. An incumbent still has to show that its service earns the price.

**Knowing the workflow matters only if it results in better delivery.**

## 3. Easier to build does not necessarily mean easier to sell

[Ian Nuttall reports](https://x.com/iannuttall/status/2108528886724411880) that his business of building profitable side projects and selling them has become much harder, even though he can still build them.

That distinction matters: selling a finished project or business is different from selling a subscription to an end user. His account does not show that customers stopped paying for SaaS, and the post's text supplies no transaction series from which to estimate a market-wide change.

For a founder, it raises a useful test: if another developer could recreate your features, what else would a buyer acquire? Paying customers, a distribution channel, useful proprietary data and a workflow people already depend on are candidates to investigate. They are not automatic protections against competition.

**Treat this as a question about business value, not a verdict on every software subscription.**

## 4. Did replacing the subscription actually save money?

This is where the discussion needs operating evidence. We would compare a subscription with an agent-built alternative doing the same recurring job, over a stated period.

- **Define the job:** inputs, expected output, frequency and who accepts the result.
- **Count the whole cost:** model calls, hosting, setup, human review, repairs and maintenance. Record time separately from cash, or state the hourly rate used to convert it.
- **Record failures:** what broke, whether it was detected and how long recovery took.
- **Check the decision:** was the subscription cancelled, retained or restored, and why?

A screenshot of a working clone cannot answer those questions. Neither can a count of people arguing for one side of the debate. The relevant observation is a customer getting the needed result repeatedly, at a cost they are willing to bear.

## You

The following is our judgment and a hypothesis to track, not a measured market result.

If you are building SaaS, describe the recurring job you complete and the failures you absorb. Then test whether an agent-built alternative can do it under the same conditions. The answer may differ between a personal tool and a shared business system.

If you are considering cancelling software, start with one bounded workflow. Measure its output, running cost and repair time before expanding the replacement.

**Our hypothesis: pressure will show up first in workflows that are narrow, easy to check and cheap to repair. Broader replacement will require evidence about integration, reliability and total cost.**

The next useful contribution to our [SaaS topic](/topics/viability-saas-app-5c83f1cb) is a specific replacement attempt: which software, which job, what cost, what failed, and whether the customer kept paying.

---

*Sources reviewed on October 10, 2026. Source summaries use the published text of the three posts. Predictions and personal accounts are attributed to their authors; the evaluation framework and conclusions are SurviAGI's editorial analysis.*
