"use client";

import { useId, useMemo, useState } from "react";
import { useScrollPages } from "@/components/scroll-pages";
import Link from "next/link";
import { Bar, Blank, Block } from "@/components/blueprint";
import { Screen } from "@/components/home/reveal";
import type { Language } from "@/lib/i18n";
import { href } from "@/lib/routes";
import { count, fill, indexCopy } from "./copy";
import x from "./markets.module.css";

/**
 * The market index as something a reader can work with.
 *
 * The finding this page carries is a ratio: a few dozen markets have a reading
 * and most have none. So the rung distribution is drawn first and doubles as
 * the filter — clicking a rung is the same act as reading it — and the table
 * below answers "is my own market in here", which is a search box, not a scroll
 * of 265 rows.
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
  scored: number;
  /** Highest published level in the market, fractional, or null for no reading. */
  top: number | null;
  /** The rung that level is on: what the table prints and the chart groups by. */
  rung: number | null;
  occupations: number;
};

type Sort = "top" | "total" | "scored" | "occupations";
type Coverage = "all" | "with" | "without";

export function MarketsExplorer({
  rows,
  rungs,
  levels,
  language,
}: {
  rows: MarketRow[];
  /** The published ladder, empty rungs included: an absent L5 is the finding. */
  rungs: number[];
  /** Rung words, already in the reader's language, straight from the snapshot. */
  levels: Record<string, string>;
  language: Language;
}) {
  const c = indexCopy[language];
  const [query, setQuery] = useState("");
  const [coverage, setCoverage] = useState<Coverage>("all");
  const [rung, setRung] = useState<number | null | "any">("any");
  const [sort, setSort] = useState<Sort>("top");
  const searchId = useId();

  const distribution = useMemo(() => {
    const byRung = new Map<number, number>(rungs.map((value) => [value, 0]));
    let blank = 0;
    for (const row of rows) {
      if (row.rung === null) blank += 1;
      else byRung.set(row.rung, (byRung.get(row.rung) ?? 0) + 1);
    }
    const bars = rungs.map((value) => ({ rung: value, n: byRung.get(value) ?? 0 }));
    const widest = Math.max(blank, ...bars.map((bar) => bar.n), 1);
    return { bars, blank, widest };
  }, [rows, rungs]);

  const withReading = rows.length - distribution.blank;

  const { frame, sentinel, count: visible } = useScrollPages(`${query}|${coverage}|${rung}|${sort}`);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = rows.filter((row) => {
      if (coverage === "with" && row.rung === null) return false;
      if (coverage === "without" && row.rung !== null) return false;
      if (rung !== "any" && row.rung !== rung) return false;
      if (!needle) return true;
      return row.en.toLowerCase().includes(needle) || row.zh.toLowerCase().includes(needle);
    });
    const key = (row: MarketRow) =>
      sort === "top" ? (row.top ?? -1) : sort === "total" ? row.total : sort === "scored" ? row.scored : row.occupations;
    return [...filtered].sort((a, b) => key(b) - key(a) || b.scored - a.scored || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }, [rows, query, coverage, rung, sort]);

  const filtersOn = query !== "" || coverage !== "all" || rung !== "any";
  const reset = () => {
    setQuery("");
    setCoverage("all");
    setRung("any");
  };

  /** Selecting a rung is also a coverage statement, so the two stay in step. */
  const pickRung = (value: number | null) => {
    setRung((current) => (current === value ? "any" : value));
    setCoverage("all");
  };

  return (
    <>
      <Block title={c.distTitle} lead={c.distLead}>
        <Screen>
          <div className={x.dist}>
            {distribution.bars.map((bar) => {
              const on = rung === bar.rung;
              return (
                <button
                  key={bar.rung}
                  type="button"
                  className={`${x.distRow} ${on ? x.distRowOn : ""}`}
                  aria-pressed={on}
                  onClick={() => pickRung(bar.rung)}
                >
                  <span className={x.rung}>L{bar.rung}</span>
                  <span className={x.word}>{levels[String(bar.rung)] ?? ""}</span>
                  <span className={x.track}>
                    <Bar share={bar.n / distribution.widest} />
                  </span>
                  <span className={x.distCount}>{count(bar.n)}</span>
                </button>
              );
            })}
            <button
              type="button"
              className={`${x.distRow} ${x.distRowBlank} ${rung === null ? x.distRowOn : ""}`}
              aria-pressed={rung === null}
              onClick={() => pickRung(null)}
            >
              <span className={x.rung}>{c.blankRung}</span>
              <span className={x.word}>{c.blankWord}</span>
              <span className={x.track}>
                <Bar share={distribution.blank / distribution.widest} />
              </span>
              <span className={x.distCount}>{count(distribution.blank)}</span>
            </button>
          </div>
        </Screen>
      </Block>

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
                  ["with", c.coverageWith, withReading],
                  ["without", c.coverageWithout, distribution.blank],
                ] as [Coverage, string, number][]
              ).map(([key, label, n]) => (
                <button
                  key={key}
                  type="button"
                  className={`${x.chip} ${coverage === key && rung === "any" ? x.chipOn : ""}`}
                  aria-pressed={coverage === key && rung === "any"}
                  onClick={() => {
                    setCoverage(key);
                    setRung("any");
                  }}
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
                  ["top", c.sortTop],
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
                  <th scope="col">{c.colTop}</th>
                  <th scope="col" className="oaw-num">
                    {c.colOccupations}
                  </th>
                </tr>
              </thead>
              {/* Keyed on the query so a filter or a sort re-enters the rows
                  instead of swapping them in place. */}
              <tbody className={x.rows} key={`${query}|${coverage}|${rung}|${sort}`}>
                {shown.slice(0, visible).map((row) => (
                  <tr key={row.id}>
                    <th scope="row" className={x.nameCell}>
                      <Link href={href(language, `/markets/${row.slug}`)}>{row.name}</Link>
                    </th>
                    <td className="oaw-num">{count(row.total)}</td>
                    <td className="oaw-num">{count(row.scored)}</td>
                    <td>
                      {row.rung === null ? (
                        <Blank reason={c.noReading} />
                      ) : (
                        <span className={x.levelCell}>
                          <span className={x.rung}>L{row.rung}</span>
                          <span className={x.track}>
                            <Bar share={row.rung / 5} />
                          </span>
                          <span className={x.levelWord}>{levels[String(row.rung)] ?? ""}</span>
                        </span>
                      )}
                    </td>
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
