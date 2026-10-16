import { AccountMenu } from "@/components/account/account-menu";
import { Subscribe } from "@/components/account/subscribe";
import { LanguageSwitch } from "@/components/language-switch";
import { appEnabled } from "@/lib/app-config";
import { LANGUAGES, bilingual } from "@/lib/i18n";
import { getLocale } from "@/lib/locale";
import { SITE_NAV, siteNavCopy } from "@/lib/site-nav";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { lang } from "next/root-params";
import localFont from "next/font/local";
import Link from "next/link";
import "../globals.css";
import { href } from "@/lib/routes";
import { SITE_NAME, SITE_URL, SOCIAL_LINKS, siteCopy } from "@/lib/seo";

const copy = bilingual({
  en: {
    brandLabel: "SurviAGI home",
    footerBrand: "SurviAGI · The AGI Survival Guide",
    footerNote: "Evidence first. Opinions that can change.",
    socialLinks: "SurviAGI elsewhere",
    privacy: "Privacy",
    terms: "Terms",
  },
  "zh-CN": {
    brandLabel: "SurviAGI 首页",
    footerBrand: "SurviAGI · 新人类 AI 生存指南",
    footerNote: "以证据为先，判断随事实更新。",
    socialLinks: "SurviAGI 的其他地址",
    privacy: "隐私",
    terms: "条款",
  },
});

/**
 * The design system ships these two variable faces with their OFL licences, and
 * until now nothing loaded them: `--ah-font-display` named "AH Inter Tight", no
 * @font-face ever declared it, and every page fell through to Arial. next/font
 * self-hosts them and hands back the family name to bind the tokens to.
 */
const interTight = localFont({
  src: "../../../design/system-v1/fonts/InterTight-Variable.ttf",
  weight: "100 900",
  display: "swap",
  variable: "--font-display",
  fallback: ["PingFang SC", "Microsoft YaHei", "system-ui", "sans-serif"],
});

// The geometric face for the wordmark and the large headlines (brand type direction 02).
const outfit = localFont({
  src: "../../../design/system-v1/fonts/Outfit-Variable.ttf",
  weight: "100 900",
  display: "swap",
  variable: "--font-heading",
  fallback: ["PingFang SC", "Microsoft YaHei", "system-ui", "sans-serif"],
});

const jetBrainsMono = localFont({
  src: "../../../design/system-v1/fonts/JetBrainsMono-Variable.ttf",
  weight: "100 800",
  display: "swap",
  variable: "--font-mono",
  fallback: ["SFMono-Regular", "Consolas", "monospace"],
});

/** Both languages are the only values of the segment; any other one is a 404. */
export function generateStaticParams() {
  return LANGUAGES.map((lang) => ({ lang }));
}
export const dynamicParams = false;

/** Titles and descriptions follow the language of the address, not the reader's browser. */
export async function generateMetadata(): Promise<Metadata> {
  const { language } = await getLocale();
  return {
    metadataBase: new URL(SITE_URL),
    title: { default: siteCopy[language].title, template: `%s | ${SITE_NAME}` },
    description: siteCopy[language].description,
  };
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // `dynamicParams = false` does not hold for pages rendered per request. The proxy never rewrites to another
  // value, but the paths it leaves to the file server (`/og/...`, `/figures/...`, `/<key>.txt`) reach this
  // segment as they are when no file matches, and would render an English page at that address.
  const segment = await lang();
  if (!LANGUAGES.some((language) => language === segment)) notFound();
  const { language } = await getLocale();
  const c = copy[language];
  const nav = siteNavCopy[language];
  return (
    <html lang={language} className={`${interTight.variable} ${outfit.variable} ${jetBrainsMono.variable}`}>
      <body>
        <header className="header wrap">
          <Link href={href(language, "/")} className="brand" aria-label={c.brandLabel}>Survi<span className="brand-will">AGI</span></Link>
          <div className="header-end">
            <nav aria-label={nav.navLabel}>{SITE_NAV.map((item) => <Link key={item.href} href={href(language, item.href)}>{nav[item.key]}</Link>)}</nav>
            <nav className="header-social" aria-label={c.socialLinks}>
              {SOCIAL_LINKS.map((link) => (
                <a key={link.href} href={link.href} rel="noopener">{link.label}</a>
              ))}
            </nav>
            <LanguageSwitch />
            <AccountMenu language={language} enabled={appEnabled()} />
          </div>
        </header>
        <main className="wrap">{children}</main>
        <footer className="footer wrap">
          <span>{c.footerBrand}</span>
          <span>{c.footerNote}</span>
          <Subscribe language={language} enabled={appEnabled()} />
          <div className="footer-links">
            <Link href={href(language, "/privacy")}>{c.privacy}</Link>
            <Link href={href(language, "/terms")}>{c.terms}</Link>
            {SOCIAL_LINKS.map((link) => (
              <a key={link.href} href={link.href} rel="noopener">{link.label}</a>
            ))}
          </div>
        </footer>
      </body>
    </html>
  );
}
