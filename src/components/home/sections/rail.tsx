"use client";

import type { Route } from "next";
import Link from "next/link";
import { useEffect, useState } from "react";
import s from "./rail.module.css";

/**
 * The one thing that stays through the whole page: the L0-L5 ruler, with how
 * much work stands at each level. It comes down once the reader is past the
 * first screen and names the chapter being read; from the chapter after the
 * ruler is introduced it shows the ruler itself, so every later figure is read
 * against the same scale.
 *
 * It covers the place the site header scrolled out of, so it also carries the
 * header's links: the page can be left from any chapter.
 */
export function Rail({ levels, from, navLabel, links }: { levels: number[]; from: number; navLabel: string; links: { href: Route; label: string }[] }) {
  const [at, setAt] = useState<{ i: number; n: number; label: string; done: number } | null>(null);

  useEffect(() => {
    let frameId = 0;
    const measure = () => {
      frameId = 0;
      const blocks = [...document.querySelectorAll<HTMLElement>("[data-chapter]")];
      const vh = window.innerHeight;
      let i = -1;
      blocks.forEach((b, k) => { if (b.getBoundingClientRect().top < vh * 0.5) i = k; });
      const done = window.scrollY / Math.max(1, document.documentElement.scrollHeight - vh);
      setAt((prev) => {
        if (i < 0) return null;
        const next = { i, n: blocks.length, label: blocks[i].dataset.chapter ?? "", done: Math.round(done * 200) / 200 };
        return prev && prev.i === next.i && prev.done === next.done && prev.n === next.n ? prev : next;
      });
    };
    const request = () => { if (!frameId) frameId = requestAnimationFrame(measure); };
    measure();
    window.addEventListener("scroll", request, { passive: true });
    window.addEventListener("resize", request);
    return () => { cancelAnimationFrame(frameId); window.removeEventListener("scroll", request); window.removeEventListener("resize", request); };
  }, []);

  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    <div className={`${s.rail} ${at ? s.on : ""}`} inert={!at}>
      <div className={s.chapter} aria-hidden="true"><b>{at ? pad(at.i + 1) : ""}</b> / {at ? pad(at.n) : ""}<span>{at?.label}</span></div>
      <div className={`${s.ruler} ${at && at.i >= from ? s.shown : ""}`} aria-hidden="true">
        {levels.map((n, level) => <i key={level} className={`${level >= 3 ? s.past : ""} ${n ? s.has : ""}`}>L{level}<em>{n || ""}</em></i>)}
      </div>
      <nav className={s.nav} aria-label={navLabel}>{links.map((l) => <Link key={l.href} href={l.href}>{l.label}</Link>)}</nav>
      <div className={s.done} style={{ transform: `scaleX(${at?.done ?? 0})` }} />
    </div>
  );
}
