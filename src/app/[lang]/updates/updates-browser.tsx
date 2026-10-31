"use client";

import { dateLabel } from "@/lib/update-date";
import { plural } from "@/lib/plural";
import { useMemo, useState } from "react";
import Link from "next/link";
import type { Language } from "@/lib/i18n";
import { updateHref } from "@/lib/routes";
import { Bar, Blank } from "@/components/blueprint";
import { useScrollPages } from "@/components/scroll-pages";
import s from "./updates.module.css";

/**
 * The 581 updates, as something a reader can work rather than scroll.
 *
 * Every row is rendered on the server, so the page is complete with JavaScript
 * off; search, the publisher chart, the landed/silent split and the sort are
 * enhancements on top of a list that is already there. Nothing here reads the
 * snapshot: `@/lib/snapshot` opens files, and a client component that imports it
 * takes `node:fs` into the browser bundle and fails the build. Everything this
 * component shows is resolved and localised on the server and handed down.
 */

/** One reading an update produced, already worded for the reader's language. */
export type ReadingRow = {
  activity: string;
  market: string | null;
  /** `L2 · <the ladder's own word>`, built from progress.levels. */
  level: string | null;
  /** `T3 → L2` when the evidence tier held the reading below the proposal. */
  cap: string | null;
};

export type UpdateRow = {
  id: string;
  title: string;
  /** Already `2026-09-14`; null when no publication time was recorded. */
  date: string | null;
  timestamp: string | null;
  announced: boolean;
  /** What the reader sees. */
  org: string | null;
  /** The publisher's registry name, which is what the chart filters on: the
      displayed name is localised and would never match an English chart row. */
  orgKey: string | null;
  url: string | null;
  activities: number;
  markets: number;
  /** `L2 · <word>`; null when the update bore on no activity. */
  level: string | null;
  readings: ReadingRow[];
};

/** Rows shown at first, and added by each further request. */
const PAGE = 30;

export type BrowserCopy = {
  fromEyebrow: string;
  fromTitle: string;
  fromLead: string;
  tableEyebrow: string;
  tableTitle: string;
  tableLead: string;
  tableLabel: string;
  searchLabel: string;
  searchPlaceholder: string;
  filterLabel: string;
  filterAll: string;
  filterLanded: string;
  filterSilent: string;
  sortLabel: string;
  sortTime: string;
  sortReach: string;
  showing: string;
  empty: string;
  reset: string;
  colWhen: string;
  colUpdate: string;
  colFrom: string;
  colLanded: string;
  colTop: string;
  openSource: string;
  readingsOpen: string;
  readingsClose: string;
  noDate: string;
  noOrg: string;
  noSource: string;
  noLevel: string;
  capNote: string;
};

type Landed = "all" | "landed" | "silent";
type Sort = "time" | "reach";

const numbers = new Intl.NumberFormat("en-US");

export function UpdatesBrowser({
  rows,
  orgs,
  copy,
  maxActivities,
  language,
}: {
  rows: UpdateRow[];
  orgs: { org: string; label: string; events: number }[];
  copy: BrowserCopy;
  maxActivities: number;
  language: Language;
}) {
  const [query, setQuery] = useState("");
  const [landed, setLanded] = useState<Landed>("landed");
  const [org, setOrg] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>("time");
  const [open, setOpen] = useState<string | null>(null);


  // Search is over the title and the publisher, which is what a reader has in
  // mind when they come looking for one update they remember.
  const haystack = useMemo(
    () =>
      new Map(
        rows.map((r) => [r.id, `${r.title} ${r.org ?? ""} ${r.orgKey ?? ""}`.toLowerCase()]),
      ),
    [rows],
  );

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = rows.filter((row) => {
      if (landed === "landed" && row.activities === 0) return false;
      if (landed === "silent" && row.activities > 0) return false;
      if (org && row.orgKey !== org) return false;
      if (needle && !(haystack.get(row.id) ?? "").includes(needle)) return false;
      return true;
    });
    const byDate = (a: UpdateRow, b: UpdateRow) => (b.timestamp ?? "").localeCompare(a.timestamp ?? "");
    return sort === "time"
      ? [...filtered].sort(byDate)
      : [...filtered].sort((a, b) => b.activities - a.activities || byDate(a, b));
  }, [rows, haystack, query, landed, org, sort]);

  // Re-mounting the body on a filter change is what gives the rows their
  // transition; typing narrows the list fast, so the cost stays small.
  const signature = `${query}|${landed}|${org ?? ""}|${sort}`;
  const filtered = query !== "" || landed !== "landed" || org !== null;
  // A page at a time. The count belongs to one filter state, so changing the filter starts again from the first page.
  const { frame, sentinel, count: visible } = useScrollPages(signature, PAGE);

  return (
    <>
      <div id="all">
        <div className={s.controls}>
          <div className={s.search}>
            <label className={s.fieldLabel} htmlFor="updates-search">
              {copy.searchLabel}
            </label>
            <input
              id="updates-search"
              className={s.searchInput}
              type="search"
              value={query}
              placeholder={copy.searchPlaceholder}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          <div className={s.row}>
            <span className={s.fieldLabel}>{copy.fromEyebrow}</span>
            <div className={s.chips}>
              {orgs.map((row) => (
                <button
                  key={row.org}
                  type="button"
                  className={`${s.chip} ${org === row.org ? s.chipCurrent : ""}`}
                  aria-pressed={org === row.org}
                  onClick={() => setOrg(org === row.org ? null : row.org)}
                >
                  {row.label}
                </button>
              ))}
            </div>
          </div>

          <div className={s.row}>
            <span className={s.fieldLabel}>{copy.sortLabel}</span>
            <div className={s.chips}>
              {(
                [
                  ["time", copy.sortTime],
                  ["reach", copy.sortReach],
                ] as [Sort, string][]
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={`${s.chip} ${sort === key ? s.chipCurrent : ""}`}
                  aria-pressed={sort === key}
                  onClick={() => setSort(key)}
                >
                  <span className={s.chipMark} aria-hidden="true" />
                  {label}
                </button>
              ))}
            </div>
            {filtered ? (
              <button
                type="button"
                className={s.chip}
                onClick={() => {
                  setQuery("");
                  setLanded("landed");
                  setOrg(null);
                }}
              >
                {copy.reset}
              </button>
            ) : null}
          </div>

          <p className={s.result} aria-live="polite">
            {copy.showing
              .replace("{n}", numbers.format(Math.min(visible, shown.length)))
              .replace("{total}", numbers.format(shown.length))}
            {org ? ` · ${orgs.find((o) => o.org === org)?.label ?? org}` : ""}
          </p>
        </div>

        {shown.length === 0 ? (
          <p className={s.empty}>{copy.empty}</p>
        ) : (
          <div
            ref={frame}
            className={`oaw-table-wrap oaw-scroll ${s.tableWrap}`}
            role="region"
            aria-label={copy.tableLabel}
            tabIndex={0}
          >
            <table className={`oaw-table ${s.table}`}>
              <thead>
                <tr>
                  <th scope="col">{copy.colWhen}</th>
                  <th scope="col">{copy.colUpdate}</th>
                  <th scope="col">{copy.colFrom}</th>
                  <th scope="col">{copy.colLanded}</th>
                  <th scope="col">{copy.colTop}</th>
                </tr>
              </thead>
              <tbody key={signature} className={s.rows}>
                {shown.slice(0, visible).map((row) => {
                  const isOpen = open === row.id;
                  return [
                    <tr key={row.id}>
                      <td className={s.cellWhen}>{dateLabel(row.date, row.announced, language) ?? <Blank reason={copy.noDate} />}</td>
                      <th scope="row">
                        {row.readings.length > 0 ? (
                          <Link className={s.title} href={updateHref(language, row.id)}>
                            {row.title} <span aria-hidden="true">→</span>
                          </Link>
                        ) : row.url ? (
                          <a
                            className={s.title}
                            href={row.url}
                            rel="nofollow noopener noreferrer"
                            target="_blank"
                          >
                            {row.title} <span aria-hidden="true">↗</span>
                            <span className="oaw-sr-only"> {copy.openSource}</span>
                          </a>
                        ) : (
                          <span className={s.title}>
                            {row.title} <Blank reason={copy.noSource} />
                          </span>
                        )}
                        {row.readings.length > 0 ? (
                          <button
                            type="button"
                            className={`${s.expand} ${isOpen ? s.expandOpen : ""}`}
                            aria-expanded={isOpen}
                            aria-controls={`readings-${row.id}`}
                            onClick={() => setOpen(isOpen ? null : row.id)}
                          >
                            <span className={s.expandMark} aria-hidden="true" />
                            {plural(isOpen ? copy.readingsClose : copy.readingsOpen, { n: row.readings.length }).replace(
                              "{n}",
                              numbers.format(row.readings.length),
                            )}
                          </button>
                        ) : null}
                      </th>
                      <td>{row.org ?? <Blank reason={copy.noOrg} />}</td>
                      <td>
                        <span className={s.cellLanded}>
                          {row.activities > 0 ? (
                            <span className={s.cellBar}>
                              <Bar
                                share={row.activities / maxActivities}
                                label={`${row.activities} / ${row.markets}`}
                              />
                            </span>
                          ) : null}
                          <span
                            className={`${s.cellCount} ${row.activities === 0 ? s.cellZero : ""}`}
                          >
                            {row.activities} / {row.markets}
                          </span>
                        </span>
                      </td>
                      <td>
                        {row.level ? (
                          <span className={s.level}>{row.level}</span>
                        ) : (
                          <span className={s.levelNone}>{copy.noLevel}</span>
                        )}
                      </td>
                    </tr>,
                    isOpen ? (
                      <tr key={`${row.id}-readings`} className={s.detailRow}>
                        <td colSpan={5} id={`readings-${row.id}`}>
                          <ul className={s.readings}>
                            {row.readings.map((reading, i) => (
                              <li key={`${reading.activity}-${i}`} className={s.reading}>
                                <span className={s.readingName}>
                                  {reading.activity}
                                  {reading.market ? (
                                    <span className={s.readingMarket}>{reading.market}</span>
                                  ) : null}
                                </span>
                                <span className={s.readingRight}>
                                  {reading.level ? (
                                    <span className={s.level}>{reading.level}</span>
                                  ) : (
                                    <Blank reason={copy.noLevel} />
                                  )}
                                  {reading.cap ? (
                                    <span className={s.cap}>
                                      {copy.capNote.replace("{cap}", reading.cap)}
                                    </span>
                                  ) : null}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    ) : null,
                  ];
                })}
              </tbody>
            </table>
            {shown.length > visible ? <div ref={sentinel} className="oaw-scroll-end" /> : null}
          </div>
        )}
      </div>
    </>
  );
}
