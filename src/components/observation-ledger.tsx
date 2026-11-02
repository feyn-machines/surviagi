import { Block } from "@/components/blueprint";
import { termDefinition, termNameOrRaw } from "@/components/ontology-labels";
import type { Language } from "@/lib/i18n";
import {
  ACTOR_ROLES,
  actorLine,
  figure,
  fill,
  ledger,
  ledgerCopy,
  monthTypes,
  overview,
  typeMeaning,
  typeName,
  type Overview,
} from "@/lib/observation-view";
import { EVIDENCE_ORDER, observationDate, type ObservationRow, type ObservationStats } from "@/lib/snapshot";
import { plural } from "@/lib/plural";
import l from "./observation-ledger.module.css";

/**
 * The evidence section of a market or an occupation page: the counts by
 * evidence type side by side, then the observations themselves, each with the
 * words it was read from and a link to the post. The page's Markdown copy says
 * the same through `ledgerMarkdown`.
 */
export function ObservationLedger({
  rows,
  name,
  language,
}: {
  rows: ObservationRow[];
  name: string;
  language: Language;
}) {
  const c = ledgerCopy[language];
  const view = ledger(rows, name, language);
  return (
    <Block id="evidence" title={c.title} lead={c.lead}>
      {view.state === "unpublished" ? (
        <p className={l.empty}>{c.notPublished}</p>
      ) : view.state === "none" ? (
        <div className={l.empty}>
          <p className={l.emptyTitle}>{c.none}</p>
          <p>{c.noneWhy}</p>
        </div>
      ) : (
        <>
          {/* The sentence an engine can quote, with the counts it rests on. */}
          <p className={l.answer}>{view.answer}</p>
          <ul className={l.notes}>
            {view.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
          <EvidenceCounts stats={view.stats} language={language} />
          <p className={l.machine}>{c.machine}</p>

          <h3 className={l.h3}>{c.strongest}</h3>
          <p className={l.sub}>{c.strongestLead}</p>
          <Observations rows={view.strongest} language={language} />

          {view.otherWay.length > 0 ? (
            <>
              <h3 className={l.h3}>{c.otherWay}</h3>
              <p className={l.sub}>{c.otherWayLead}</p>
              <Observations rows={view.otherWay} language={language} />
            </>
          ) : null}

          {view.rest.length > 0 ? (
            <details className={l.more}>
              <summary>{plural(c.all, { n: view.rest.length }).replace("{n}", String(view.rest.length))}</summary>
              <Observations rows={view.rest} language={language} />
            </details>
          ) : null}
          {view.unlisted > 0 ? <p className={l.sub}>{c.more.replace("{n}", String(view.unlisted))}</p> : null}
        </>
      )}
    </Block>
  );
}

/**
 * The head of a list page (Issue #32): the same counts by evidence type as a
 * market or occupation page, over every observation mapped to any of them,
 * then when they were said, who says them, and what the counts stand on.
 */
export function ObservationOverview({
  byPage,
  kind,
  language,
}: {
  byPage: ObservationRow[][];
  kind: "markets" | "occupations";
  language: Language;
}) {
  const c = ledgerCopy[language];
  const view = overview(byPage, kind, language);
  return (
    <Block id="evidence" title={view.title} lead={c.lead}>
      {view.state === "unpublished" ? (
        <p className={l.empty}>{c.notPublished}</p>
      ) : (
        <>
          <p className={l.answer}>{view.answer}</p>
          <ul className={l.notes}>
            {view.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
          <EvidenceCounts stats={view.stats} language={language} />
          <p className={l.machine}>{c.machine}</p>
          {view.stats.total > 0 ? <Spread view={view} language={language} /> : null}
          <h3 className={l.h3}>{c.coverageTitle}</h3>
          <ul className={l.notes}>
            {view.coverage.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </>
      )}
    </Block>
  );
}

/** Months as bars of the same scale, then the actors' roles and the names that occur most. */
function Spread({ view, language }: { view: Extract<Overview, { state: "some" }>; language: Language }) {
  const c = ledgerCopy[language];
  const peak = Math.max(...view.months.map((m) => m.total), 1);
  return (
    <>
      <h3 className={l.h3}>{c.whenTitle}</h3>
      <p className={l.sub}>{c.whenLead}</p>
      <ol className={l.months}>
        {view.months.map((m) => (
          <li key={m.month ?? "undated"} className={m.total === 0 ? l.zero : undefined}>
            <span className={l.month}>{m.month ?? c.undatedMonth}</span>
            <span className={l.bar} aria-hidden="true">
              <i style={{ width: `${(m.total / peak) * 100}%` }} />
            </span>
            <b>{m.total}</b>
            <small>
              {monthTypes(m, language)}
              {m.against > 0 ? <span className={l.against}> · {fill(c.againstShort, { n: m.against })}</span> : null}
            </small>
          </li>
        ))}
      </ol>

      <h3 className={l.h3}>{c.whoTitle}</h3>
      <p className={l.sub}>{c.whoLead}</p>
      <dl className={`${l.types} ${l.roles}`}>
        {ACTOR_ROLES.map((role) => (
          <div key={role} className={`${l.type} ${view.roles[role] === 0 ? l.zero : ""}`}>
            <dt>{termNameOrRaw("observation_actor_role", role, language)}</dt>
            <dd>
              {view.roles[role]}
              <small>{termDefinition("observation_actor_role", role, language)?.text}</small>
            </dd>
          </div>
        ))}
      </dl>
      <ol className={l.actors}>
        {view.actors.map((a) => (
          <li key={a.key}>
            <span>{a.name}</span>
            <small>{termNameOrRaw("observation_actor_role", a.role, language)}</small>
            <b>{fill(c.actorCount, { n: a.total })}</b>
          </li>
        ))}
      </ol>
      {view.otherActors > 0 ? <p className={l.sub}>{fill(c.othersActors, { n: view.otherActors })}</p> : null}
    </>
  );
}

/** The six evidence types side by side, each with its count and what it means; a zero is shown as 0. */
function EvidenceCounts({ stats, language }: { stats: ObservationStats; language: Language }) {
  return (
    <dl className={l.types}>
      {EVIDENCE_ORDER.map((type) => (
        <div key={type} className={`${l.type} ${stats.byType[type] === 0 ? l.zero : ""}`}>
          <dt>{typeName(type, language)}</dt>
          <dd>
            {stats.byType[type]}
            <small>{typeMeaning(type, language)}</small>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Observations({ rows, language }: { rows: ObservationRow[]; language: Language }) {
  const c = ledgerCopy[language];
  const zh = language === "zh-CN";
  return (
    <ul className={l.list}>
      {rows.map((row) => (
        <li key={row.observation_id} id={row.observation_id} className={l.row}>
          <div className={l.when}>
            <b>{observationDate(row) ?? "—"}</b>
            {typeName(row.evidence_type, language)}
          </div>
          <div className={l.what}>
            {/* Read by a model in English; the quotes below are the post's own words. */}
            <span className={l.task} lang="en">{row.task}</span>
            {zh ? <em className={l.original}>{c.original}</em> : null}
            <p>{actorLine(row, language)}</p>
            {row.facts.length > 0 ? (
              <ul className={l.figures}>
                {row.facts.map((fact) => (
                  <li key={fact.fact_id}>
                    <b lang="en">{figure(fact)}</b>
                    <q>{fact.quote}</q>
                  </li>
                ))}
              </ul>
            ) : null}
            {row.scale ? <p>{c.scale}{zh ? "：" : ": "}<span lang="en">{row.scale}</span></p> : null}
            {row.conditions ? <p>{c.conditions}{zh ? "：" : ": "}<span lang="en">{row.conditions}</span></p> : null}
            {row.sources.map((source) => (
              <small key={source.source_ref}>
                <a href={source.url} rel="nofollow noopener" target="_blank">{c.source} ↗</a> “{source.quote}”
              </small>
            ))}
          </div>
          <div className={l.how}>
            <span className={l.tag}>{termNameOrRaw("event_result", row.outcome, language)}</span>
            <span className={row.direction === "human_still_needed" ? l.against : undefined}>
              {termNameOrRaw("observation_direction", row.direction, language)}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}
