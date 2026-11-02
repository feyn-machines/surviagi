"use client";

import { useId, useMemo, useState } from "react";
import { useScrollPages } from "@/components/scroll-pages";
import Link from "next/link";
import { Block } from "@/components/blueprint";
import { Screen } from "@/components/home/reveal";
import type { Language } from "@/lib/i18n";
import { href } from "@/lib/routes";
import { count, fill, indexCopy } from "./copy";
import x from "./markets.module.css";

/**
 * The market index as something a reader can work with.
 *
 * The finding this page carries is a ratio: a few dozen markets have collected
 * updates and most have none. The table answers "is my own market in here",
 * which is a search box, not a scroll of 265 rows.
 *
 * Everything is rendered on the server first. The controls narrow what is
 * already in the document; with JavaScript off the full list is still there.
 */

export type MarketRow = {
  id: string;
  slug: string;
  en: string;
  zh: string;
  /** The name in the reader's language, resolved on the server. */
  name: string;
  total: number;
  /** Kinds of work that at least one collected update bears on. */
  scored: number;
  /** Collected updates that bear on any work in the market, once each. */
  updates: number;
  occupations: number;
};

type Sort = "updates" | "total" | "scored" | "occupations";
type Coverage = "all" | "with" | "without";

export function MarketsExplorer({
  rows,
  language,
  initialQuery = "",
}: {
  rows: MarketRow[];
  language: Language;
  /** The search the reader arrived with, e.g. from the home page. */
  initialQuery?: string;
}) {
  const c = indexCopy[language];
  const [query, setQuery] = useState(initialQuery);
  const [coverage, setCoverage] = useState<Coverage>("all");
  const [sort, setSort] = useState<Sort>("updates");
  const searchId = useId();

  const blank = useMemo(() => rows.filter((row) => row.updates === 0).length, [rows]);
  const withUpdates = rows.length - blank;

  const { frame, sentinel, count: visible } = useScrollPages(`${query}|${coverage}|${sort}`);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = rows.filter((row) => {
      if (coverage === "with" && row.updates === 0) return false;
      if (coverage === "without" && row.updates > 0) return false;
      if (!needle) return true;
      return row.en.toLowerCase().includes(needle) || row.zh.toLowerCase().includes(needle);
    });
    const key = (row: MarketRow) =>
      sort === "updates" ? row.updates : sort === "total" ? row.total : sort === "scored" ? row.scored : row.occupations;
    return [...filtered].sort((a, b) => key(b) - key(a) || b.scored - a.scored || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }, [rows, query, coverage, sort]);

  const filtersOn = query !== "" || coverage !== "all";
  const reset = () => {
    setQuery("");
    setCoverage("all");
  };

  return (
    <>
      <Block title={c.tableTitle} lead={c.tableLead}>
        <div className={x.controls}>
          <div className={x.field}>
            <label className={x.fieldLabel} htmlFor={searchId}>
              {c.searchLabel}
            </label>
            <input
              id={searchId}
              className={x.input}
              type="search"
              autoComplete="off"
              placeholder={c.searchPlaceholder}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          <div className={x.field}>
            <span className={x.fieldLabel} id={`${searchId}-coverage`}>
              {c.coverageLabel}
            </span>
            <div className={x.chipRow} role="group" aria-labelledby={`${searchId}-coverage`}>
              {(
                [
                  ["all", c.coverageAll, rows.length],
                  ["with", c.coverageWith, withUpdates],
                  ["without", c.coverageWithout, blank],
                ] as [Coverage, string, number][]
              ).map(([key, label, n]) => (
                <button
                  key={key}
                  type="button"
                  className={`${x.chip} ${coverage === key ? x.chipOn : ""}`}
                  aria-pressed={coverage === key}
                  onClick={() => setCoverage(key)}
                >
                  {label}
                  <span className={x.chipCount}>{count(n)}</span>
                </button>
              ))}
            </div>
          </div>

          <div className={x.field}>
            <span className={x.fieldLabel} id={`${searchId}-sort`}>
              {c.sortLabel}
            </span>
            <div className={x.chipRow} role="group" aria-labelledby={`${searchId}-sort`}>
              {(
                [
                  ["updates", c.sortUpdates],
                  ["total", c.sortActivities],
                  ["scored", c.sortScored],
                  ["occupations", c.sortOccupations],
                ] as [Sort, string][]
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={`${x.chip} ${sort === key ? x.chipOn : ""}`}
                  aria-pressed={sort === key}
                  onClick={() => setSort(key)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <p className={x.result} aria-live="polite">
          {fill(c.showing, { n: count(shown.length), total: count(rows.length) })}
        </p>

        {shown.length === 0 ? (
          <div className={x.empty}>
            <p className={x.emptyTitle}>{c.emptyTitle}</p>
            <p className={x.emptyWhy}>{c.emptyWhy}</p>
            <button type="button" className={x.chip} onClick={reset}>
              {c.reset}
            </button>
          </div>
        ) : (
          <Screen>
          <div
            ref={frame}
            className="oaw-table-wrap oaw-scroll"
            role="region"
            aria-label={c.tableLabel}
            tabIndex={0}
          >
            <table className="oaw-table">
              <thead>
                <tr>
                  <th scope="col">{c.colMarket}</th>
                  <th scope="col" className="oaw-num">
                    {c.colActivities}
                  </th>
                  <th scope="col" className="oaw-num">
                    {c.colAssessed}
                  </th>
                  <th scope="col" className="oaw-num">
                    {c.colUpdates}
                  </th>
                  <th scope="col" className="oaw-num">
                    {c.colOccupations}
                  </th>
                </tr>
              </thead>
              {/* Keyed on the query so a filter or a sort re-enters the rows
                  instead of swapping them in place. */}
              <tbody className={x.rows} key={`${query}|${coverage}|${sort}`}>
                {shown.slice(0, visible).map((row) => (
                  <tr key={row.id}>
                    <th scope="row" className={x.nameCell}>
                      <Link href={href(language, `/markets/${row.slug}`)}>{row.name}</Link>
                    </th>
                    <td className="oaw-num">{count(row.total)}</td>
                    <td className="oaw-num">{count(row.scored)}</td>
                    <td className="oaw-num">{count(row.updates)}</td>
                    <td className="oaw-num">{count(row.occupations)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {shown.length > visible ? <div ref={sentinel} className="oaw-scroll-end" /> : null}
          </div>
          </Screen>
        )}

        {filtersOn && shown.length > 0 ? (
          <p className={x.result}>
            <button type="button" className={x.chip} onClick={reset}>
              {c.reset}
            </button>
          </p>
        ) : null}
      </Block>
    </>
  );
}
