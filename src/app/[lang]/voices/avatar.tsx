"use client";

import { useState } from "react";
import s from "./voices.module.css";

/**
 * The account's profile image, served by the platform itself. When there is no
 * address, or the platform no longer serves it, the initials stand in: a broken
 * image would read as a fault of the page, not as a missing picture.
 */
export function Avatar({ src, name, size = 44 }: { src: string | null; name: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const initials = name.split(/\s+/).map((part) => [...part][0] ?? "").slice(0, 2).join("").toUpperCase();
  return (
    <span className={s.avatar} style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }} aria-hidden="true">
      {src && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element -- a third-party address shown as is; proxying it would copy the image
        <img src={size > 48 ? src.replace("_normal.", "_200x200.") : src} alt="" width={size} height={size} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      ) : initials}
    </span>
  );
}
