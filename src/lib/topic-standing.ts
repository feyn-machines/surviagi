import { observationsOfMarket, observationsOfOccupation, type Topic } from "./snapshot";

/**
 * Whether a topic is a page of its own (Issue #32, design 2026-11-02 §8.3 and §8.6): at least two accounts argue it,
 * or the occupation or market it is about has at least one observation. One account's post, with nothing the
 * evidence says about its subject, is only a mention; it is listed on the subject's page as under discussion until a
 * second account or an observation arrives.
 */
export function topicObservationCount(topic: Pick<Topic, "about">): number {
  const about = topic.about;
  if (about?.kind === "occupation") return observationsOfOccupation(about.id).length;
  if (about?.kind === "market") return observationsOfMarket(about.id).length;
  return 0;
}

export const topicStands = (topic: Pick<Topic, "accounts" | "about">): boolean =>
  topic.accounts >= 2 || topicObservationCount(topic) > 0;
