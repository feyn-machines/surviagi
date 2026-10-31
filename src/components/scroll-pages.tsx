"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A long list in a frame of fixed height: the frame scrolls, and the list
 * grows by a page each time the reader nears its end. `signature` is the
 * filter state the list was built from - a new one starts again at the first
 * page, at the top of the frame.
 *
 * Put `frame` on the scrolling element and `sentinel` on an empty element
 * after the last rendered row while more remain.
 */
export function useScrollPages(signature: string, page = 30) {
  const frame = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const [state, setState] = useState({ signature, count: page });
  // Commit the new filter even when its result is shorter than one page and
  // no sentinel is mounted. Otherwise clearing it restores the old page count.
  if (state.signature !== signature) setState({ signature, count: page });
  const count = state.signature === signature ? state.count : page;

  useEffect(() => {
    const root = frame.current, target = sentinel.current;
    if (!root || !target || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => { if (entries.some((entry) => entry.isIntersecting)) setState({ signature, count: count + page }); },
      { root, rootMargin: "0px 0px 240px 0px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [signature, page, count]);

  useEffect(() => { frame.current?.scrollTo({ top: 0 }); }, [signature]);

  return { frame, sentinel, count };
}
