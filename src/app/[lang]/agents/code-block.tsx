"use client";

import { useEffect, useRef, useState } from "react";
import { bilingual, type Language } from "@/lib/i18n";
import s from "./agents.module.css";

const copy = bilingual({
  en: { copy: "Copy", copied: "Copied", scroll: "scroll ↔" },
  "zh-CN": { copy: "复制", copied: "已复制", scroll: "横向滚动 ↔" },
});

/**
 * A framed code sample with one button: the whole block on the clipboard.
 * `wrap` is for prose (a prompt), which should reflow instead of scrolling.
 * When a line is wider than the frame, the bar says so: a clipped URL with no
 * hint reads as a broken example.
 */
export function CodeBlock({
  language,
  label,
  text,
  wrap = false,
}: {
  language: Language;
  label: string;
  text: string;
  wrap?: boolean;
}) {
  const c = copy[language];
  const [copied, setCopied] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const pre = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (wrap) return;
    const node = pre.current;
    if (!node) return;
    const check = () => setOverflowing(node.scrollWidth > node.clientWidth + 1);
    const observer = new ResizeObserver(check);
    observer.observe(node);
    const frame = requestAnimationFrame(check);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [text, wrap]);

  async function copyText() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className={`${s.codeFrame} ${wrap ? s.codeFrameWrap : ""}`}>
      <div className={s.codeBar}>
        <span className={s.codeLabel}>{label}</span>
        <span className={s.codeTools}>
          {overflowing ? <span className={s.codeHint}>{c.scroll}</span> : null}
          <button type="button" className={s.copyButton} onClick={() => void copyText()}>
            {copied ? c.copied : c.copy}
          </button>
        </span>
      </div>
      <pre ref={pre} className={s.code}>
        <code>{text}</code>
      </pre>
    </div>
  );
}
