"use client";

import { useEffect, useState } from "react";
import s from "./agents.module.css";

export type TocItem = { id: string; label: string };

/**
 * The page's contents rail. Links are complete in the server HTML, so the list
 * works with JavaScript off; the script only marks the section being read.
 */
export function AgentsToc({ label, items }: { label: string; items: TocItem[] }) {
  const [current, setCurrent] = useState<string | null>(items[0]?.id ?? null);

  useEffect(() => {
    const nodes = items
      .map((item) => document.getElementById(item.id))
      .filter((node): node is HTMLElement => node !== null);
    if (!nodes.length) return;

    let frame = 0;
    const pick = () => {
      frame = 0;
      let found = nodes[0].id;
      for (const node of nodes) {
        if (node.getBoundingClientRect().top <= 180) found = node.id;
      }
      setCurrent(found);
    };
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(pick);
    };

    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [items]);

  if (!items.length) return null;

  return (
    <nav className={s.toc} aria-label={label}>
      <p className={s.tocLabel}>{label}</p>
      <ol className={s.tocList}>
        {items.map((item, i) => {
          const active = item.id === current;
          return (
            <li key={item.id}>
              <a className={`${s.tocLink} ${active ? s.tocCurrent : ""}`} href={`#${item.id}`} aria-current={active ? "true" : undefined}>
                <span className={s.tocIndex} aria-hidden="true">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span>{item.label}</span>
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
