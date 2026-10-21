"use client";

import { useSyncExternalStore } from "react";
import { DEFAULT_LANGUAGE, bilingual, localizedPath, splitLanguagePath, type Language } from "@/lib/i18n";
import "./globals.css";

const copy = bilingual({
  en: { eyebrow: "404 · NO SUCH PAGE", title: "Page not found.", home: "Home →" },
  "zh-CN": { eyebrow: "404 · 没有这个页面", title: "页面不存在。", home: "回到首页 →" },
});

const subscribe = () => () => {};
const addressLanguage = (): Language => splitLanguagePath(window.location.pathname).language ?? DEFAULT_LANGUAGE;
const serverLanguage = (): Language => DEFAULT_LANGUAGE;

export default function GlobalNotFound() {
  const language = useSyncExternalStore(subscribe, addressLanguage, serverLanguage);
  const c = copy[language];
  return (
    <html lang={language}>
      <body>
        <main className="wrap">
          <section className="inner-page">
            <p className="eyebrow"><span className="dot" />{c.eyebrow}</p>
            <h1>{c.title}</h1>
            <div className="actions">
              <a className="text-link" href={localizedPath(language, "/")}>{c.home}</a>
            </div>
          </section>
        </main>
      </body>
    </html>
  );
}
