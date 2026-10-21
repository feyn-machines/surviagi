import type { Metadata } from "next";
import { type Language } from "@/lib/i18n";
import { getLocale } from "@/lib/locale";
import { pageMetadata } from "@/lib/seo";
import { manifest, snapshotExists, sources as allSources, type Source } from "@/lib/snapshot";
import { NoSnapshot, PageHeader, Section, bilingual, dataStyles as d, formatNumber, isoDate } from "@/components/data-page";
import { termName } from "@/components/ontology-labels";
import { MySubmissions } from "@/components/account/my-submissions";
import { SubmitAccount } from "@/components/account/submit-account";
import { appEnabled } from "@/lib/app-config";
import { Avatar } from "./avatar";
import s from "./voices.module.css";

/** Rendered per request from the loaded data release, never at build time. */
export const dynamic = "force-dynamic";

/**
 * Who the record is collected from, and what they last said.
 *
 * Companies and people share the page because they are one list - the accounts
 * a collection run asks about - and the reader's question is the same for both:
 * whose words are these figures built on. The top block is the people with the
 * largest audience the platform reported. Every post is the account's own, shown
 * in its original language, and links out: nothing here restates a post. The
 * copy stays product language - names and counts, no method notes.
 */

const TOP = 12;

const copy = bilingual({
  en: {
    eyebrow: "Voices",
    title: "Voices",
    lead: "What the people and companies building AI are saying.",
    topTitle: "Top voices",
    peopleTitle: "People",
    orgsTitle: "Companies",
    listLabel: "{title} list",
    followers: "{n} followers",
    open: "View post",
    empty: "Nothing here yet.",
    metaTitle: "Voices",
    metaDescription: "What the people and companies building AI are saying.",
  },
  "zh-CN": {
    eyebrow: "声音",
    title: "声音",
    lead: "做 AI 的人和公司，最近在说什么。",
    topTitle: "头部声音",
    peopleTitle: "人物",
    orgsTitle: "公司",
    listLabel: "{title}列表",
    followers: "{n} 关注者",
    open: "查看原帖",
    empty: "暂无内容。",
    metaTitle: "声音",
    metaDescription: "做 AI 的人和公司，最近在说什么。",
  },
});

export async function generateMetadata(): Promise<Metadata> {
  const { language } = await getLocale();
  return pageMetadata({ language, path: "/voices", title: copy[language].metaTitle, description: copy[language].metaDescription });
}

const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));

const compact = (n: number, language: Language) =>
  new Intl.NumberFormat(language, { notation: "compact", maximumFractionDigits: 1 }).format(n);

/** Role, then where the person works; an organization account shows its role only. */
function about(source: Source, language: Language): { role: string; at: string | null } {
  const role = termName("panel_role", source.panel_role, language) ?? source.panel_role;
  const first = source.affiliations[0];
  if (!first) return { role, at: null };
  return { role, at: first.role_title ? `${first.org_name} · ${first.role_title}` : first.org_name };
}

const displayName = (source: Source, language: Language) =>
  (language === "zh-CN" ? source.name_zh_cn : null) ?? source.name;

const byLatest = (a: Source, b: Source) =>
  (b.latest[0]?.published_at ?? "").localeCompare(a.latest[0]?.published_at ?? "") || a.handle.localeCompare(b.handle);

function Identity({ source, language, size }: { source: Source; language: Language; size?: number }) {
  const { role, at } = about(source, language);
  const name = displayName(source, language);
  return (
    <div className={s.who}>
      <Avatar src={source.avatar_url} name={name} size={size} />
      <div className={s.id}>
        <span className={s.name}>{name}</span>
        <span className={s.meta}><span className={s.role}>{role}</span> · @{source.handle}</span>
        {at ? <span className={s.meta} title={at}>{at}</span> : null}
      </div>
    </div>
  );
}

function Rows({ list, language, label }: { list: Source[]; language: Language; label: string }) {
  return (
    <div className="oaw-scroll" role="region" aria-label={label} tabIndex={0}>
      <ul className={s.list}>
        {list.map((source) => {
          const post = source.latest[0];
          return (
            <li key={source.account_key} className={s.row}>
              <Identity source={source} language={language} size={36} />
              <p className={s.line} lang={post.language ?? undefined}>
                <a href={post.url} target="_blank" rel="noreferrer">{post.excerpt}</a>
              </p>
              <span className={s.when}>{isoDate(post.published_at) ?? "—"}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default async function VoicesPage() {
  const { language } = await getLocale();
  const c = copy[language];

  if (!snapshotExists() || !manifest()) {
    return (
      <div className={s.page}>
        <PageHeader eyebrow={c.eyebrow} title={c.title} />
        <NoSnapshot language={language} />
      </div>
    );
  }

  const enabled = appEnabled();
  // Only accounts with something to show: a row saying "no posts" is not a voice.
  const sources = allSources().filter((x) => x.latest.length > 0);
  const people = sources.filter((x) => x.owner_kind === "person");
  const orgs = sources.filter((x) => x.owner_kind === "organization").sort(byLatest);
  const top = people
    .filter((x) => x.followers !== null && x.latest.length > 0)
    .sort((a, b) => (b.followers ?? 0) - (a.followers ?? 0))
    .slice(0, TOP);
  const topKeys = new Set(top.map((x) => x.account_key));
  const rest = people.filter((x) => !topKeys.has(x.account_key)).sort(byLatest);

  return (
    <div className={s.page}>
      <PageHeader
        eyebrow={c.eyebrow}
        title={c.title}
        lead={c.lead}
      />

      <MySubmissions language={language} enabled={enabled} />

      {sources.length === 0 && !enabled ? <p className={d.note}>{c.empty}</p> : null}

      {top.length > 0 ? (
        <Section id="top" title={c.topTitle}>
          <ul className={s.top}>
            {top.map((source) => {
              const post = source.latest[0];
              return (
                <li key={source.account_key}>
                  <article className={s.card}>
                    <Identity source={source} language={language} size={56} />
                    <p className={s.quote} lang={post.language ?? undefined}>{post.excerpt}</p>
                    <div className={s.foot}>
                      <span>{fill(c.followers, { n: compact(source.followers ?? 0, language) })} · {isoDate(post.published_at)}</span>
                      <a href={post.url} target="_blank" rel="noreferrer">{c.open} ↗</a>
                    </div>
                  </article>
                </li>
              );
            })}
          </ul>
        </Section>
      ) : null}

      {rest.length > 0 || enabled ? (
        <Section
          id="people"
          title={c.peopleTitle}
          note={rest.length > 0 ? formatNumber(rest.length) : undefined}
          action={<SubmitAccount language={language} ownerKind="person" enabled={enabled} anchor="people" />}
        >
          {rest.length > 0 ? (
            <Rows list={rest} language={language} label={fill(c.listLabel, { title: c.peopleTitle })} />
          ) : (
            <p className={d.note}>{c.empty}</p>
          )}
        </Section>
      ) : null}

      {orgs.length > 0 || enabled ? (
        <Section
          id="companies"
          title={c.orgsTitle}
          note={orgs.length > 0 ? formatNumber(orgs.length) : undefined}
          action={<SubmitAccount language={language} ownerKind="organization" enabled={enabled} anchor="companies" />}
        >
          {orgs.length > 0 ? (
            <Rows list={orgs} language={language} label={fill(c.listLabel, { title: c.orgsTitle })} />
          ) : (
            <p className={d.note}>{c.empty}</p>
          )}
        </Section>
      ) : null}
    </div>
  );
}
