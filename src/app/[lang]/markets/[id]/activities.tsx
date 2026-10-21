"use client";

import { useEffect } from "react";
import Link from "next/link";
import { workHref } from "@/lib/routes";
import { Bar, Blank } from "@/components/blueprint";
import { Screen } from "@/components/home/reveal";
import type { Language } from "@/lib/i18n";
import { count, detailCopy, fill } from "../copy";
import x from "../markets.module.css";

/**
 * The activities of one market, each opening onto the readings behind it.
 *
 * The chain is the point of this page — activity, level, the tier that capped
 * it, the update it came from — and a reader should not have to leave the row
 * to follow it. The rows are `<details>` so the whole chain is in the document
 * and openable with no JavaScript at all; the script only opens the row a link
 * from another page pointed at.
 */

export type ReadingView = {
  key: string;
  /** What survives the evidence tier's cap. The only value the site stands behind. */
  published: number | null;
  publishedRung: number | null;
  /** What the judge read out of the update, before the cap. */
  judged: number | null;
  tier: string;
  tierName: string;
  tierCap: number | null;
  title: string;
  url: string | null;
  when: string | null;
};

/** One gate that holds this activity, named rather than counted. */
export type GateView = {
  id: string;
  label: string;
  definition: string;
};

export type ActivityView = {
  id: string;
  /** Fragment other pages link to. Kept stable: the homepage jumps here. */
  anchor: string;
  name: string;
  rung: number | null;
  gated: boolean;
  /** The gates holding it, from the published gate-to-activity edges. */
  gates: GateView[];
  tasks: number;
  readings: ReadingView[];
};

export function Activities({
  activities,
  levels,
  language,
}: {
  activities: ActivityView[];
  levels: Record<string, string>;
  language: Language;
}) {
  const c = detailCopy[language];

  // A link from another page carries the activity in the fragment. Opening it
  // is the difference between landing on a row and landing on its evidence.
  useEffect(() => {
    const open = () => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      if (!id) return;
      const node = document.getElementById(id);
      if (node instanceof HTMLDetailsElement && !node.open) {
        node.open = true;
        node.scrollIntoView({ block: "center", behavior: "auto" });
      }
    };
    open();
    window.addEventListener("hashchange", open);
    return () => window.removeEventListener("hashchange", open);
  }, []);

  return (
    <Screen className={x.acts}>
      {activities.map((activity, index) => (
        <details
          key={activity.id}
          id={activity.anchor}
          className={x.act}
          open={index === 0 && activity.readings.length > 0}
        >
          <summary>
            <span className={x.actName}>
              <span>{activity.name}</span>
              <span className={x.actMeta}>
                <span>
                  {count(activity.readings.length)} {c.readings}
                </span>
                <span aria-hidden="true">·</span>
                <span>
                  {fill(c.tasks, { n: count(activity.tasks) })}
                </span>
                {activity.gated ? (
                  <span className={x.gate}>
                    {c.gated}
                    {activity.gates.length > 0
                      ? ` · ${activity.gates.map((gate) => gate.label).join(" · ")}`
                      : ""}
                  </span>
                ) : null}
              </span>
            </span>
            <span className={x.actRight}>
              {activity.rung === null ? (
                <Blank reason={c.noReading} />
              ) : (
                <span className={x.actLevel}>
                  <span className={x.rung}>L{activity.rung}</span>
                  <span className={x.track}>
                    <Bar share={activity.rung / 5} />
                  </span>
                  <span className={x.levelWord}>{levels[String(activity.rung)] ?? ""}</span>
                </span>
              )}
              <span className={x.caret} aria-hidden="true" />
            </span>
          </summary>

          <div className={x.actBody}>
            {activity.readings.length > 0 && activity.rung ? (
              <p className={x.gateNote}><Link href={workHref(language, activity.id)}>{c.openWork} →</Link></p>
            ) : null}
            {activity.gates.map((gate) => (
              <p key={gate.id} className={x.gateNote}>
                <span className={x.gateName}>{gate.label}</span>
                {gate.definition}
              </p>
            ))}
            {activity.readings.length === 0 ? (
              <div className={x.empty}>
                <p className={x.emptyTitle}>{c.noReadingsTitle}</p>
                <p className={x.emptyWhy}>{c.noReadingsWhy}</p>
              </div>
            ) : (
              <div
                className={`oaw-table-wrap ${x.readings}`}
                role="region"
                aria-label={`${activity.name} — ${c.readingsLabel}`}
                tabIndex={0}
              >
                <table className="oaw-table">
                  <thead>
                    <tr>
                      <th scope="col">{c.colShows}</th>
                      <th scope="col">{c.colJudged}</th>
                      <th scope="col">{c.colTierOne}</th>
                      <th scope="col">{c.colUpdate}</th>
                      <th scope="col">{c.colWhen}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activity.readings.map((reading) => {
                      const cut =
                        reading.judged !== null &&
                        reading.published !== null &&
                        reading.judged > reading.published;
                      return (
                        <tr key={reading.key}>
                          <th scope="row" className={x.plain}>
                            {reading.publishedRung === null ? (
                              <Blank reason={c.noReading} />
                            ) : (
                              <span className={x.levelCell}>
                                <span className={x.rung}>L{reading.publishedRung}</span>
                                <span className={x.track}>
                                  <Bar share={reading.publishedRung / 5} />
                                </span>
                                <span className={x.levelWord}>
                                  {levels[String(reading.publishedRung)] ?? ""}
                                </span>
                              </span>
                            )}
                          </th>
                          <td>
                            {reading.judged === null ? (
                              <Blank reason={c.noReading} />
                            ) : (
                              <span className={x.cut}>
                                <span className={`${x.judged} ${cut ? x.judgedCut : ""}`}>
                                  L{reading.judged}
                                </span>
                                {cut && reading.tierCap !== null ? (
                                  <span className={x.cutNote}>
                                    ↓ {fill(c.capNote, { tier: reading.tier, cap: reading.tierCap })}
                                  </span>
                                ) : null}
                              </span>
                            )}
                          </td>
                          <td>
                            <span className={x.judged}>{reading.tier}</span>
                            <span className={x.sub}>{reading.tierName}</span>
                          </td>
                          <td>
                            <span className={x.updateCell}>
                              {reading.url ? (
                                <a href={reading.url} rel="nofollow noopener noreferrer" target="_blank">
                                  {reading.title} <span aria-hidden="true">↗</span>
                                  <span className="oaw-sr-only"> {c.source}</span>
                                </a>
                              ) : (
                                reading.title
                              )}
                            </span>
                          </td>
                          <td className="oaw-num">
                            {reading.when ?? <Blank reason={c.noReading} />}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </details>
      ))}
    </Screen>
  );
}
