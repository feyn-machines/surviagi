"use client";

import { useEffect, useState } from "react";
import s from "./whitepaper.module.css";

/**
 * The document's own index, and where the reader is in it.
 *
 * `/about` was deleted, so this page is now the only route that explains the
 * method; a document this long needs a way in other than the scrollbar. The
 * list is plain anchors and is complete on the server, so it works with
 * JavaScript off. The only thing this component adds is the mark on the section
 * currently under the reader.
 */
export function WhitepaperToc({
  label,
  items,
}: {
  label: string;
  items: { id: string; text: string }[];
}) {
  const [current, setCurrent] = useState<string | null>(items[0]?.id ?? null);

  useEffect(() => {
    const nodes = items
      .map((item) => document.getElementById(item.id))
      .filter((node): node is HTMLElement => node !== null);
    if (!nodes.length) return;

    // The last heading whose top has passed the reading line is the section
    // being read. Measuring live on scroll rather than caching what an
    // IntersectionObserver reported: a cached top is only true for the instant
    // it was taken, which left the mark stuck on the first section.
    let frame = 0;
    const pick = () => {
      frame = 0;
      let found = nodes[0].id;
      for (const node of nodes) {
        if (node.getBoundingClientRect().top <= 140) found = node.id;
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

  if (items.length === 0) return null;

  return (
    <nav className={s.toc} aria-label={label}>
      <p className={s.tocLabel}>{label}</p>
      <ol className={s.tocList}>
        {items.map((item) => {
          const active = item.id === current;
          return (
            <li key={item.id}>
              <a
                className={`${s.tocLink} ${active ? s.tocCurrent : ""}`}
                href={`#${item.id}`}
                aria-current={active ? "true" : undefined}
              >
                <span className={s.tocMark} aria-hidden="true" />
                {item.text}
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
