import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LEVEL_NAMES, TIER_NAMES, levelClass } from "@/components/home/sections/levels";
import s from "@/components/detail.module.css";
import { getLocale } from "@/lib/locale";
import { breadcrumbLd, pageMetadata } from "@/lib/seo";
import { JsonLd } from "@/components/json-ld";
import { termNameOrRaw } from "@/components/ontology-labels";
import { detailCopy, fill } from "@/app/[lang]/markets/copy";
import { siteNavCopy } from "@/lib/site-nav";
import { copy } from "./copy";
import { href, marketHref, updateHref, workHref, workSlug } from "@/lib/routes";
import { activities, activitiesOfMarket, countedReadings, levelSteps, gatesOfActivity, gates as allGates, manifest, marketSlug, type Confirmation } from "@/lib/snapshot";

/** Rendered per request from the loaded data release, never at build time. */
export const dynamic = "force-dynamic";

/**
 * One kind of work: the level it stands at, and every update that put it
 * there. Only work some update bears on has a page.
 */

type Props = { params: Promise<{ id: string }> };
const reached = () => activities().filter((a) => a.evidence_rows && a.level);
const find = (slug: string) => reached().find((a) => workSlug(a.activity_id) === slug);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { language } = await getLocale();
  const id = (await params).id;
  const work = find(id);
  if (!work) notFound();
  const name = (language === "zh-CN" ? work.label_zh_cn : work.label_en) ?? work.label_en;
  const level = Math.round(work.level ?? 0);
  const levelName = LEVEL_NAMES[language][level];
  return pageMetadata({
    language,
    path: `/work/${id}`,
    title: `${name} · L${level} ${levelName}`,
    description: fill(copy[language].metaDescription, { name, level, levelName, count: work.evidence_rows ?? 0 }),
    markdown: true,
  });
}

export default async function WorkPage({ params }: Props) {
  const { language } = await getLocale();
  const c = copy[language];
  const work = find((await params).id);
  if (!work) notFound();

  const zh = language === "zh-CN";
  const name = (zh ? work.label_zh_cn : work.label_en) ?? work.label_en;
  const market = (zh ? work.market_zh_cn : work.market_en) ?? work.market_en;
  const level = Math.round(work.level ?? 0);
  const rows = countedReadings(work.activity_id);
  // The tier of everything counted, confirmations included, as the level was computed.
  const tier = work.best_tier ?? "T3";
  const companies = new Set(rows.map((r) => r.org_name).filter(Boolean));
  const gateById = new Map(allGates().map((g) => [g.gate_id, g]));
  const held = work.gated ? gatesOfActivity(work.activity_id).map((id) => gateById.get(id)).filter((g) => g !== undefined) : [];
  const siblings = activitiesOfMarket(work.market_id).filter((a) => a.activity_id !== work.activity_id && a.evidence_rows && a.level);
  const levelText = `L${level} ${LEVEL_NAMES[language][level]}`;
  const steps = levelSteps(work.activity_id);
  const confirms = (v: Confirmation, title: string) =>
    fill(detailCopy[language].confirms, {
      handle: v.handle ?? v.account_key,
      nature: termNameOrRaw("post_nature", v.post_nature, language),
      title,
    });
  const reachedOn = steps.at(-1)?.date?.slice(0, 10);

  const slug = (await params).id;
  const trail = [
    { name: siteNavCopy[language].markets, path: "/markets" },
    { name: market, path: `/markets/${marketSlug(work.market_id)}` },
    { name, path: `/work/${slug}` },
  ];

  return (
    <div className={s.page}>
      <JsonLd data={breadcrumbLd(language, trail)} />
      <Link className={s.back} href={marketHref(language, work.market_id)}>{c.back.replace("{market}", market)}</Link>
      <div className={s.eyebrow}>{c.eyebrow} · <Link href={marketHref(language, work.market_id)}>{market}</Link></div>
      <h1 className={s.title}>{name}</h1>
      <p className={s.say}>
        {c.say.replace("{date}", manifest()?.generated_at.slice(0, 10) ?? "").replace("{n}", String(rows.length)).replace("{tier}", TIER_NAMES[language][tier] ?? tier).split("{level}")[0]}
        <b>{levelText}</b>
        {c.say.replace("{date}", "").replace("{n}", String(rows.length)).replace("{tier}", TIER_NAMES[language][tier] ?? tier).split("{level}")[1]}
      </p>

      <dl className={s.facts}>
        <div className={s.fact}><dt>{c.level}</dt><dd className={level >= 3 ? s.sig : ""}>L{level}<small>{LEVEL_NAMES[language][level]}</small></dd></div>
        <div className={s.fact}><dt>{c.updates}</dt><dd>{rows.length}</dd></div>
        <div className={s.fact}><dt>{c.companies}</dt><dd>{companies.size}<small>{[...companies].slice(0, 3).join(" · ")}</small></dd></div>
        <div className={s.fact}><dt>{c.evidence}</dt><dd>{tier}<small>{TIER_NAMES[language][tier] ?? tier}</small></dd></div>
      </dl>

      <div className={s.ruler} aria-label={`${c.here}: ${levelText}`}>
        {LEVEL_NAMES[language].map((label, l) => (
          <i key={l} className={l === level ? s.here : l < level ? s.below : ""}>L{l}<small>{label}</small></i>
        ))}
      </div>

      {held.length > 0 && (
        <p className={s.note}><b>{c.held}</b> {held.map((g) => (zh ? g.label_zh_cn : g.label_en) ?? g.label_en).join(" · ")}. {c.heldNote}</p>
      )}

      {steps.length > 0 && (
        <>
          <h2 className={s.h2}>{c.historyTitle}</h2>
          <p className={s.sub}>
            {reachedOn && `${fill(c.historyReached, { level, date: reachedOn })}${zh ? "" : " "}`}
            {c.historySub}
          </p>
          <ul className={s.list}>
            {steps.map((step) => (
              <li key={`${step.reading.event_id}-${step.confirmation?.source_id ?? ""}`} className={s.row}>
                <div className={s.when}>
                  <b>{step.date ? step.date.slice(0, 10) : c.undated}</b>
                  {step.confirmation ? `@${step.confirmation.handle ?? step.confirmation.account_key}` : step.reading.org_name}
                </div>
                <div className={s.what}>
                  {step.confirmation ? (
                    step.confirmation.url ? (
                      <a className={s.name} href={step.confirmation.url} target="_blank" rel="nofollow noopener noreferrer">
                        {confirms(step.confirmation, step.reading.title)}
                      </a>
                    ) : (
                      <span className={s.name}>{confirms(step.confirmation, step.reading.title)}</span>
                    )
                  ) : (
                    <Link className={s.name} href={updateHref(language, step.reading.event_id)}>{step.reading.title}</Link>
                  )}
                </div>
                <div className={s.how}>
                  <span className={`${s.tag} ${s[levelClass(step.to)]}`}>
                    {step.from === null ? "" : `L${Math.round(step.from)} → `}L{Math.round(step.to)} {LEVEL_NAMES[language][Math.round(step.to)]}
                  </span>
                  <span>{TIER_NAMES[language][step.confirmation?.evidence_tier ?? step.reading.evidence_tier] ?? step.reading.evidence_tier}</span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <h2 className={s.h2}>{c.listTitle}</h2>
      <p className={s.sub}>{c.listSub}</p>
      <ul className={s.list}>
        {rows.map((r) => (
          <li key={r.event_id} className={s.row}>
            <div className={s.when}><b>{r.occurred_at ? r.occurred_at.slice(0, 10) : c.undated}</b>{r.org_name}</div>
            <div className={s.what}>
              <Link className={s.name} href={updateHref(language, r.event_id)}>{r.title}</Link>
              <p>{r.summary}</p>
              {r.confirmations?.map((v) => (
                <small key={v.source_id}>
                  {c.confirmedBy}
                  {v.url ? <a href={v.url} target="_blank" rel="nofollow noopener noreferrer">@{v.handle}</a> : `@${v.handle ?? v.account_key}`}
                  {" · "}{termNameOrRaw("post_nature", v.post_nature, language)} · L{v.level} · {TIER_NAMES[language][v.evidence_tier] ?? v.evidence_tier}
                </small>
              ))}
            </div>
            <div className={s.how}>
              <span className={`${s.tag} ${s[levelClass(r.level ?? 0)]}`}>L{r.level} {LEVEL_NAMES[language][r.level ?? 0]}</span>
              {(r.observed_level ?? 0) > (r.level ?? 0) && <span className={s.warn}>{c.claimed.replace("{c}", String(r.observed_level)).replace("{a}", String(r.level))}</span>}
              <span>{TIER_NAMES[language][r.evidence_tier] ?? r.evidence_tier}</span>
              {r.source_urls[0] && <a className={s.out} href={r.source_urls[0]} target="_blank" rel="nofollow noopener noreferrer">{c.source}</a>}
            </div>
          </li>
        ))}
      </ul>

      {siblings.length > 0 && (
        <>
          <h2 className={s.h2}>{c.more.replace("{market}", market)}</h2>
          <div className={s.links} style={{ marginTop: 18 }}>
            {siblings.map((a) => (
              <Link key={a.activity_id} className={s.chip} href={workHref(language, a.activity_id)}>
                {(zh ? a.label_zh_cn : a.label_en) ?? a.label_en}<small>L{Math.round(a.level ?? 0)}</small>
              </Link>
            ))}
          </div>
        </>
      )}

      <div className={s.cta}>
        <Link href={marketHref(language, work.market_id)}>{c.market}</Link>
        <Link href={href(language, "/updates")}>{c.all}</Link>
      </div>
    </div>
  );
}
