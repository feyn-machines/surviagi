import Link from "next/link";
import { bilingual, type Language } from "@/lib/i18n";
import type { HomeData } from "@/lib/home-data";
import { LEVEL_LINE, LEVEL_MEANINGS } from "@/lib/level-names";
import { LEVEL_NAMES } from "./levels";
import frame from "./section.module.css";
import s from "./text-sections.module.css";
import { href } from "@/lib/routes";

/**
 * The homepage's text modules: a statement that stays in place on the left while
 * its rows pass on the right.
 * They sit between the figures and say in words what the figures assume - who
 * the record is for, what each level means, and what the initiative is.
 */
const copy = bilingual({
  en: {
    forTitle: "Every AI update, mapped to real work.",
    forLead: "Which work. How far AI gets with it. Who can back that up.",
    readers: "Building a product|Startups, one-person companies, independent developers|See which companies are moving into your market.|Coverage by company|#companies;Running a business|One-person companies, small teams, freelancers|See which work can be handed to AI today.|Progress by domain|#domains;Starting out with AI|Employees going independent, people exploring AI|See what AI became able to do this month.|Latest updates|#updates",
    rulerTitle: LEVEL_LINE.en,
    rulerLead: "Six levels. One line that matters.",
    evidence: "Evidence required",
    standing: "Standing here now",
    still: "L0–L2: a person is still doing the work",
    gone: "From L3: a person is no longer doing it",
    forEyebrow: "READERS",
    statUpdates: "AI updates in 30 days",
    statWork: "Kinds of work reached",
    statOrgs: "AI companies tracked",
    endMore: "See every update",
    rulerEyebrow: "THE SCALE",
    now: "{n} kinds of work",
    none: "None yet",
    endTitle: "Every AI update could change your answer.",
    endBody: "SurviAGI is an initiative to make AI’s progress toward taking over the world more transparent and credible.",
    endLink: "Read the whitepaper",
  },
  "zh-CN": {
    forTitle: "每次 AI 更新，落到具体工作上。",
    forLead: "哪项工作。AI 能做到哪一步。谁能证明。",
    readers: "已经在做产品|创业公司、一人公司、独立开发者|看哪家公司的更新进了你的赛道。|各公司的覆盖|#companies;正在运营|一人公司、小团队、自由职业者|看哪些工作现在可以交给 AI。|领域的进度|#domains;想用 AI 做事|想单干的职场人、AI 爱好者|看 AI 这个月新做到了什么。|最新更新|#updates",
    rulerTitle: LEVEL_LINE["zh-CN"],
    rulerLead: "六个级别，一条分界线。",
    evidence: "所需证据",
    standing: "现在处于这一级",
    still: "L0–L2，人仍在干这件活",
    gone: "L3 起，人不再干这件活",
    forEyebrow: "读者",
    statUpdates: "30 天内的 AI 更新",
    statWork: "被涉及的工作",
    statOrgs: "观测的 AI 公司",
    endMore: "查看全部更新",
    rulerEyebrow: "尺度",
    now: "{n} 项工作",
    none: "暂无",
    endTitle: "每一次 AI 更新，都可能会挑战你的答案。",
    endBody: "SurviAGI 是一项让 AI 接管世界的进度更透明、更可信的倡议。",
    endLink: "阅读白皮书",
  },
});

/** Who the record is for, each row leading to the module that answers it. */
export function ReadersSection({ data, language, index }: { data: HomeData; language: Language; index: string }) {
  const c = copy[language];
  const stats: [number, string][] = [
    [data.recentUpdates, c.statUpdates],
    [data.works.length, c.statWork],
    [data.orgsTracked, c.statOrgs],
  ];
  return (
    <section className={`${frame.sec} ${s.split}`}>
      <div className={s.say}>
        <div className={frame.eyebrow}>[ {index} ] &nbsp;{c.forEyebrow}</div>
        <h2 className={`${frame.h2} ${s.statement}`}>{c.forTitle}</h2>
        <p className={`${frame.lead} ${s.sub}`}>{c.forLead}</p>
        <dl className={`${s.stats} ${frame.rise}`}>
          {stats.map(([n, label]) => <div key={label}><dt>{n}</dt><dd>{label}</dd></div>)}
        </dl>
      </div>
      <ul className={`${s.rows} ${frame.rise}`}>
        {c.readers.split(";").map((row) => {
          const [name, who, question, target, href] = row.split("|");
          return (
            <li key={href}>
              <a className={s.row} href={href}>
                <span className={s.name}>{name}<small>{who}</small></span>
                <span className={s.desc}>{question}</span>
                <span className={`${s.to} ${frame.mono}`}>{target} <i aria-hidden="true">→</i></span>
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * The level ruler as a scene: the block pins and the six levels pass from right
 * to left, L0 first, while a marker runs along the ruler underneath. `--h` is
 * the scroll spent so far; without it the levels sit in a row that scrolls sideways.
 */
export function RulerSection({ data, language, index }: { data: HomeData; language: Language; index: string }) {
  const c = copy[language];
  const levels = LEVEL_MEANINGS[language].map(({ roles, evidence }, level) => ({
    level, roles, evidence, n: data.works.filter((w) => w.level === level).length,
  }));
  return (
    <section id="levels" className={s.scene}>
      <div className={s.sceneHead}>
        <div className={frame.eyebrow}>[ {index} ] &nbsp;{c.rulerEyebrow}</div>
        <h2 className={`${frame.h2} ${s.statement}`}>{c.rulerTitle}</h2>
        <p className={`${frame.lead} ${s.sub}`}>{c.rulerLead}</p>
      </div>
      <div className={`${s.viewport} ${frame.rise}`}>
        <ul className={s.track}>
          {levels.map(({ level, roles, evidence, n }) => (
            <li key={level} className={`${s.card} ${level >= 3 ? s.past : ""} ${level === 3 ? s.cut : ""}`}>
              <b className={s.big}>L{level}</b>
              <span className={s.name}>{LEVEL_NAMES[language][level]}</span>
              <span className={s.desc}>{roles}</span>
              <span className={`${s.to} ${frame.mono}`}><em>{c.evidence}</em>{evidence}</span>
              <span className={`${s.to} ${frame.mono}`}><em>{c.standing}</em>{n ? c.now.replace("{n}", String(n)) : c.none}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className={s.ruler} aria-hidden="true">
        {levels.map(({ level }) => <i key={level} className={level >= 3 ? s.past : ""}>L{level}</i>)}
        <span className={s.marker} />
        <span className={s.still}>{c.still}</span>
        <span className={s.gone}>{c.gone}</span>
      </div>
    </section>
  );
}

/** What the initiative is, with the way to the whitepaper. */
export function ClosingSection({ language }: { language: Language }) {
  const c = copy[language];
  return (
    <section className={s.closing}>
      <div>
        <h2 className={frame.h2}>{c.endTitle}</h2>
        <p className={frame.lead}>{c.endBody}</p>
      </div>
      <div className={`${s.ctas} ${frame.rise}`}>
        <Link className={s.cta} href={href(language, "/updates")}>{c.endMore}</Link>
        <Link className={s.cta} href={href(language, "/whitepaper")}>{c.endLink}</Link>
      </div>
    </section>
  );
}
