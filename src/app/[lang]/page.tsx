import { bilingual } from "@/lib/i18n";
import { getLocale } from "@/lib/locale";
import { pageMetadata, siteLd } from "@/lib/seo";
import { JsonLd } from "@/components/json-ld";
import type { Metadata } from "next";
import { href } from "@/lib/routes";
import { buildHomeData } from "@/lib/home-data";
import { SITE_NAV, siteNavCopy } from "@/lib/site-nav";
import { Overview } from "@/components/home/overview/overview";
import { GraphSection } from "@/components/home/sections/graph-section";
import { CompaniesSection } from "@/components/home/sections/companies-section";
import { DomainsSection } from "@/components/home/sections/domains-section";
import { AttentionSection } from "@/components/home/sections/attention-section";
import { UpdatesSection } from "@/components/home/sections/updates-section";
import { ClosingSection, ReadersSection, RulerSection } from "@/components/home/sections/text-sections";
import { Rail } from "@/components/home/sections/rail";
import { Reveal } from "@/components/home/sections/reveal";
import frame from "@/components/home/sections/section.module.css";
import s from "./home.module.css";

/** Rendered per request from the loaded data release, never at build time. */
export const dynamic = "force-dynamic";

/**
 * The homepage is one story told in chapters, each answering the question the
 * one before it leaves: what is this (the overview), who is it for, what is it
 * measured with, where does it stand, how did it get there, who is moving it,
 * is attention the same thing, and what is the record made of. Every chapter is
 * its own component reading the same `HomeData`, wrapped in `Reveal`, which
 * holds all the motion; the rail carries the level ruler through all of them.
 */
const copy = bilingual({
  en: {
    headline: "How far AI has taken over the world",
    chapters: "Readers|The scale|Where it stands|How it got here|Who is moving it|Attention|The record",
    noData: "No published data yet. The site reads a local snapshot that has not been generated on this build.",
  },
  "zh-CN": {
    headline: "AI 接管世界的进度",
    chapters: "读者|尺度|现状|经过|推动者|关注度|记录",
    noData: "暂无已发布的数据。网站读取本地快照，而这次构建没有生成快照。",
  },
});

export async function generateMetadata(): Promise<Metadata> {
  const { language } = await getLocale();
  return pageMetadata({ language, path: "/" });
}

export default async function Home() {
  const { language } = await getLocale();
  const c = copy[language];
  const nav = siteNavCopy[language];
  const data = buildHomeData();
  const chapters = c.chapters.split("|");
  const index = (n: number) => `${String(n).padStart(2, "0")} / ${String(chapters.length).padStart(2, "0")}`;

  if (!data) {
    return (
      <section className={frame.sec}>
        <JsonLd data={siteLd(language)} />
        <h1 className={frame.h2}>{c.headline}</h1>
        <p className={frame.empty}>{c.noData}</p>
      </section>
    );
  }

  return (
    <div className={s.home}>
      <JsonLd data={siteLd(language)} />
      <Overview data={data} language={language} />
      <Rail levels={[0, 1, 2, 3, 4, 5].map((l) => data.works.filter((w) => w.level === l).length)} from={2} navLabel={nav.navLabel} links={SITE_NAV.map((item) => ({ href: href(language, item.href), label: nav[item.key] }))} />
      <div className={frame.page}>
        <Reveal tone="green" ghost="Readers" chapter={chapters[0]}><ReadersSection data={data} language={language} index={index(1)} /></Reveal>
        <Reveal tone="ink" ghost="Scale" chapter={chapters[1]} travel={200}><RulerSection data={data} language={language} index={index(2)} /></Reveal>
        <Reveal tone="base" ghost="Now" chapter={chapters[2]}><DomainsSection data={data} language={language} index={index(3)} /></Reveal>
        <Reveal tone="ink" ghost="Timeline" chapter={chapters[3]} travel={180}><UpdatesSection data={data} language={language} index={index(4)} /></Reveal>
        <Reveal tone="base" ghost="Companies" chapter={chapters[4]}><CompaniesSection data={data} language={language} index={index(5)} /></Reveal>
        <Reveal tone="ink" ghost="Attention" chapter={chapters[5]}><AttentionSection data={data} language={language} index={index(6)} /></Reveal>
        <Reveal tone="base" ghost="Record" chapter={chapters[6]}><GraphSection data={data} language={language} index={index(7)} /></Reveal>
        <Reveal tone="green" ghost="SurviAGI"><ClosingSection language={language} /></Reveal>
      </div>
    </div>
  );
}
