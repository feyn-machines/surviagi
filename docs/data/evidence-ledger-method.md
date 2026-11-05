# Evidence-ledger method

Updated: 2026-11-05. Implements the direction confirmed in the [2026-11-02 design](../superpowers/specs/2026-11-02-evidence-ledger-redesign.md); retirement is tracked in [Issue #35](https://github.com/feyn-machines/surviagi/issues/35). This document describes the method and its limits, not a completed production rollout.

## Record observations, not capability levels

An observation records an actor, the product or model used, a concrete task, an outcome, conditions and sources. An event describes what happened and can have multiple observations. Source claims, original quotations, machine extraction and human review must remain distinguishable. An opinion alone does not establish a completed task.

Evidence types describe the basis of the account: vendor claim, demonstration, own use, production use, measurement or statistic. They do not assign capability points or impose an ordinal cap. Actor roles describe the speaker's relation to this attempt; neither an account's identity nor social engagement verifies the result. Preserve affiliations and source scope when assessing independence.

The ontology defines fields and controlled vocabularies; this document does not create another schema. The generated [public contract](../../public/contract/v1/index.json) and the Agent guide describe the available interface. Unknown quantities remain null; observed zero remains zero. Occurrence, announcement and observation times are distinct. Original quotations remain separate from translations.

## Map to work and count coverage

Markets, activities, occupations and tasks are browsing categories. Observations can map to several categories; machine-proposed mappings remain candidates until confirmed. Stable category IDs survive the retirement of levels. An update linked to an activity is not, by itself, an observation proving that activity was completed.

Counts answer how much relevant evidence has been collected, of which type and period. State the release, cutoff, source coverage and review status. Do not add category counts as though overlapping records were unique. Several sources about one attempt do not establish several independent attempts.

An absence of observations leaves a gap in the collected evidence; it does not establish a zero capability score. More observations can result from expanded monitoring or a changed extractor. They do not establish capability growth. Success and failure counts from selected public accounts cannot be interpreted as a representative success rate, a replacement percentage or employment effects. External studies retain their sample, population, time period and product limits.

## Retain provenance and limits

Collection and extraction run locally. Public pages and Agent reads use released data; reads do not trigger collection or models. Retain source links and quotations, method versions and review status. A valid quotation proves attribution to the source, not independent reproduction of its claim. Keep conditions, human intervention, missing results and contradictory accounts visible.

Quality evaluation must identify its method version, dated sample, checks and errors. Machine proposals are not human confirmations. This document supplies no measured accuracy result. Corrections must remain traceable across versions; expanding coverage and changing methods must be distinguished from new real-world evidence.

## Transition from the retired method

L0–L5, autonomy stages, gate states, minimum-task levels and weighted global takeover progress are retired by the confirmed design. Old definitions and database rows remain historical; do not delete or reinterpret them. Activities remain useful as ungraded categories.

Reader pages have moved away from levels. The legacy Agent `evidence` type was deprecated starting at contract 1.1.0, but removal of that type, the `chain`/`markets`/`tasks`/`progress` publication collections and the daily level/gate calculations is still pending. The snapshot reader retains a compatibility fallback. The [delivery plan](../superpowers/plans/2026-11-03-retire-levels-35.md) defines the code-before-data sequence; removing documentation does not make those dependencies disappear.

The older [simulation](takeover-simulation-v0.3.md), [event/social framework](takeover-progress-framework-v1.md) and [knowledge-graph proposal](ai-progress-knowledge-graph-v1.md) are historical designs. Their formulas and status statements are not current instructions. Original publication dates, IDs and history are preserved.
