"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Blank } from "@/components/blueprint";
import { Screen } from "@/components/home/reveal";
import type { Language } from "@/lib/i18n";
import { updateHref } from "@/lib/routes";
import { count, detailCopy, fill } from "../copy";
import x from "../markets.module.css";

/**
 * The kinds of work in one market, each opening onto the updates that bear on it.
 *
 * A reader should not have to leave the row to see what the claim rests on: the
 * rows are `<details>`, so every update is in the document and openable with no
 * JavaScript at all; the script only opens the row a link from another page
 * pointed at.
 */

export type UpdateView = {
  key: string;
  eventId: string | null;
  title: string;
  /** The original post or page, when the update has one. */
  url: string | null;
  org: string | null;
  when: string | null;
  /** Set when this line is a post by someone else that also says so. */
  alsoBy: string | null;
};

export type ActivityView = {
  id: string;
  /** Fragment other pages link to. Kept stable: update and occupation pages jump here. */
  anchor: string;
  name: string;
  tasks: number;
  updates: UpdateView[];
};

/** The day stays on one line; the word "announced" beside it may wrap on a phone. */
function When({ label }: { label: string }) {
  const parts = label.match(/^(.*?)(\d{4}-\d{2}-\d{2})(.*)$/);
  if (!parts) return <>{label}</>;
  return (
    <>
      {parts[1]}
      <span className={x.day}>{parts[2]}</span>
      {parts[3]}
    </>
  );
}

export function Activities({
  activities,
  language,
}: {
  activities: ActivityView[];
  language: Language;
}) {
  const c = detailCopy[language];

  // A link from another page carries the activity in the fragment. Opening it
  // is the difference between landing on a row and landing on its updates.
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
      {activities.map((activity, index) => {
        const own = activity.updates.filter((update) => update.alsoBy === null).length;
        return (
          <details
            key={activity.id}
            id={activity.anchor}
            className={x.act}
            open={index === 0 && own > 0}
          >
            <summary>
              <span className={x.actName}>
                <span>{activity.name}</span>
                <span className={x.actMeta}>
                  <span>
                    {count(own)} {c.updates}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>{fill(c.tasks, { n: count(activity.tasks) })}</span>
                </span>
              </span>
              <span className={x.actRight}>
                <span className={x.caret} aria-hidden="true" />
              </span>
            </summary>

            <div className={x.actBody}>
              {activity.updates.length === 0 ? (
                <div className={x.empty}>
                  <p className={x.emptyTitle}>{c.noUpdatesTitle}</p>
                  <p className={x.emptyWhy}>{c.noUpdatesWhy}</p>
                </div>
              ) : (
                <div
                  className={`oaw-table-wrap ${x.readings}`}
                  role="region"
                  aria-label={`${activity.name} — ${c.updatesLabel}`}
                  tabIndex={0}
                >
                  <table className="oaw-table">
                    <thead>
                      <tr>
                        <th scope="col">{c.colUpdate}</th>
                        <th scope="col">{c.colWho}</th>
                        <th scope="col">{c.colWhen}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activity.updates.map((update) => (
                        <tr key={update.key}>
                          <th scope="row" className={x.plain}>
                            <span className={x.updateCell}>
                              {update.eventId ? (
                                <Link href={updateHref(language, update.eventId)}>{update.title}</Link>
                              ) : (
                                update.title
                              )}
                              {update.url ? (
                                <>
                                  {" "}
                                  <a href={update.url} rel="nofollow noopener noreferrer" target="_blank">
                                    <span aria-hidden="true">↗</span>
                                    <span className="oaw-sr-only"> {c.source}</span>
                                  </a>
                                </>
                              ) : null}
                            </span>
                          </th>
                          <td>{update.org ?? <Blank reason={c.noReading} />}</td>
                          <td className={`oaw-num ${x.when}`}>
                            {update.when ? <When label={update.when} /> : <Blank reason={c.noReading} />}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </details>
        );
      })}
    </Screen>
  );
}
