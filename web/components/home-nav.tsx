"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Wayfinding for the long home page. On wide screens, a rail of short stalks on
 * the left edge, one per chapter, with the blue band from the mark binding the
 * chapter you are reading; hover or focus a stalk to see its name. On narrower
 * screens, a small pill at the bottom says where you are and opens the list.
 * Both carry a way back to the top once the hero is behind you.
 */
const CHAPTERS = [
  { id: "how", label: "How it works" },
  { id: "baskets", label: "Baskets" },
  { id: "plans", label: "Monthly plans" },
  { id: "beside", label: "Beside the share" },
  { id: "more", label: "Go further" },
] as const;

/** A chapter counts as the one being read once its top passes this share of the screen. */
const READ_LINE = 0.4;
const ROW = 22;

export function HomeNav() {
  const [active, setActive] = useState(-1);
  const [past, setPast] = useState(false);
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let frame = 0;
    const read = () => {
      frame = 0;
      const line = window.innerHeight * READ_LINE;
      let at = -1;
      CHAPTERS.forEach((c, i) => {
        const el = document.getElementById(c.id);
        if (el && el.getBoundingClientRect().top <= line) at = i;
      });
      setActive(at);
      setPast(window.scrollY > window.innerHeight * 0.8);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    read();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onDown = (e: PointerEvent) => {
      if (menu.current && !menu.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  const toTop = useCallback(() => {
    setOpen(false);
    window.scrollTo({ top: 0 });
  }, []);

  const current = active >= 0 ? CHAPTERS[active] : null;

  return (
    <>
      {/* ------------------------------------------------ wide screens: the rail */}
      <nav aria-label="On this page" className="fixed left-2 top-1/2 z-30 hidden -translate-y-1/2 xl:block">
        <ol className="relative" style={{ height: CHAPTERS.length * ROW }}>
          {/* the band that binds the chapter being read, as on the mark */}
          <span
            aria-hidden
            className="absolute left-[7px] w-[5px] rounded-[2px] bg-bind transition-[transform,opacity] duration-300 ease-out"
            style={{ top: 3, height: ROW - 6, transform: `translateY(${Math.max(active, 0) * ROW}px)`, opacity: active >= 0 ? 1 : 0 }}
          />
          {CHAPTERS.map((c, i) => (
            <li key={c.id} className="absolute left-0" style={{ top: i * ROW, height: ROW }}>
              <a
                href={`#${c.id}`}
                aria-current={i === active ? "location" : undefined}
                className="group flex h-full items-center pr-3 outline-none"
              >
                <span
                  aria-hidden
                  className={`block h-[2px] rounded-full transition-all duration-300 ${
                    i === active ? "w-[22px] bg-ink" : i < active ? "w-[16px] bg-ink-3" : "w-[12px] bg-line-strong"
                  } group-hover:w-[22px] group-hover:bg-ink group-focus-visible:w-[22px] group-focus-visible:bg-bind`}
                />
                <span className="pointer-events-none ml-3 whitespace-nowrap rounded-[var(--radius-control)] border border-line bg-surface px-2.5 py-1 text-xs text-ink opacity-0 shadow-sm transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100">
                  <span className="tnum mr-1.5 text-ink-3">{i + 1}</span>
                  {c.label}
                </span>
              </a>
            </li>
          ))}
        </ol>
      </nav>

      {/* wide screens: back to the top */}
      <button
        type="button"
        onClick={toTop}
        aria-label="Back to the top"
        tabIndex={past ? 0 : -1}
        className={`fixed bottom-6 right-6 z-30 hidden h-11 w-11 items-center justify-center rounded-full border border-line-strong bg-surface text-ink shadow-sm transition-[opacity,transform] duration-200 hover:border-bind hover:text-bind focus-visible:border-bind xl:flex ${
          past ? "opacity-100" : "pointer-events-none translate-y-2 opacity-0"
        }`}
      >
        <Arrow />
      </button>

      {/* --------------------------------------- narrower screens: the pill */}
      <div
        ref={menu}
        className={`fixed left-1/2 z-30 -translate-x-1/2 transition-[opacity,transform] duration-200 xl:hidden ${
          past ? "opacity-100" : "pointer-events-none translate-y-3 opacity-0"
        }`}
        style={{ bottom: "calc(1rem + env(safe-area-inset-bottom))" }}
      >
        {open && (
          <nav
            id="home-chapters"
            aria-label="On this page"
            className="absolute bottom-full left-1/2 mb-2 w-[min(18rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface py-2 shadow-lg"
          >
            <ol>
              {CHAPTERS.map((c, i) => (
                <li key={c.id}>
                  <a
                    href={`#${c.id}`}
                    onClick={() => setOpen(false)}
                    aria-current={i === active ? "location" : undefined}
                    className={`flex items-center gap-3 px-4 py-2.5 text-sm outline-none focus-visible:bg-raised ${
                      i === active ? "text-ink" : "text-ink-2 hover:text-ink"
                    }`}
                  >
                    <span aria-hidden className={`h-3.5 w-[3px] rounded-[1px] ${i === active ? "bg-bind" : "bg-line-strong"}`} />
                    <span className="tnum w-4 text-xs text-ink-3">{i + 1}</span>
                    {c.label}
                  </a>
                </li>
              ))}
            </ol>
          </nav>
        )}
        <div className="flex items-center rounded-full bg-vault text-vault-ink shadow-lg">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls="home-chapters"
            tabIndex={past ? 0 : -1}
            className="flex max-w-[15rem] items-center gap-2 rounded-l-full py-2.5 pl-4 pr-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-bind"
          >
            <span aria-hidden className="h-3.5 w-[3px] shrink-0 rounded-[1px] bg-bind-wash" />
            <span className="truncate">{current ? current.label : "Contents"}</span>
            {current && (
              <span className="tnum shrink-0 text-xs opacity-70">
                {active + 1}/{CHAPTERS.length}
              </span>
            )}
            <svg aria-hidden viewBox="0 0 12 12" className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}>
              <path d="M2.5 7.5 6 4l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
          <span aria-hidden className="h-5 w-px bg-vault-ink/25" />
          <button
            type="button"
            onClick={toTop}
            aria-label="Back to the top"
            tabIndex={past ? 0 : -1}
            className="flex h-10 w-11 items-center justify-center rounded-r-full outline-none focus-visible:ring-2 focus-visible:ring-bind"
          >
            <Arrow />
          </button>
        </div>
      </div>
    </>
  );
}

function Arrow() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4">
      <path d="M8 13V3.5M3.5 8 8 3.5 12.5 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
