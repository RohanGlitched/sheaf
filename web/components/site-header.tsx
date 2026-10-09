"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Wordmark } from "./mark";
import { MarketClock } from "./market-clock";
import { ConnectButton } from "./connect-button";
import { EvmHeaderConnect } from "./evm-wallet";

const NAV = [
  { href: "/compose", label: "Create", long: "Create a basket" },
  { href: "/explore", label: "Explore" },
  { href: "/plans", label: "Plans" },
  { href: "/predict", label: "Predict" },
  { href: "/chains", label: "Chains" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/ledger", label: "Ledger" },
  { href: "/method", label: "How it works" },
];

export function SiteHeader() {
  const pathname = usePathname();
  const strip = useRef<HTMLElement>(null);
  const [atEnd, setAtEnd] = useState(false);

  /* On a phone the destinations scroll sideways. Bring the current one into
     view, and fade the right edge while there is more to scroll to, so the
     last two never look like they are missing. */
  useEffect(() => {
    const nav = strip.current;
    if (!nav) return;
    const current = nav.querySelector<HTMLElement>('[aria-current="page"]');
    if (current) {
      nav.scrollLeft = current.offsetLeft - (nav.clientWidth - current.clientWidth) / 2;
    }
    const check = () => setAtEnd(nav.scrollLeft + nav.clientWidth >= nav.scrollWidth - 4);
    check();
    nav.addEventListener("scroll", check, { passive: true });
    window.addEventListener("resize", check);
    return () => {
      nav.removeEventListener("scroll", check);
      window.removeEventListener("resize", check);
    };
  }, [pathname]);

  const fade = atEnd ? undefined : "linear-gradient(to right, black 82%, transparent)";

  return (
    /* Pinned on a laptop, where the market clock and the wallet are worth keeping
       in reach. On a phone the destinations move to a second row, and two rows of
       chrome following you down a 390-pixel screen is too much to ask, so there
       the header scrolls away with everything else. */
    <header className="border-b border-line bg-page/85 backdrop-blur-md sm:sticky sm:top-0 sm:z-40">
      <div className="mx-auto flex h-16 max-w-[1400px] items-center gap-6 px-5 sm:px-8">
        <Link href="/" className="shrink-0">
          <Wordmark />
        </Link>

        <nav className="ml-2 hidden items-center gap-1 sm:flex">
          {NAV.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`whitespace-nowrap px-3 py-1.5 text-sm transition-colors ${
                  active
                    ? "text-ink"
                    : "text-ink-2 hover:text-ink"
                }`}
              >
                {item.long ? (
                  <>
                    <span className="xl:hidden">{item.label}</span>
                    <span className="hidden xl:inline">{item.long}</span>
                  </>
                ) : (
                  item.label
                )}
                {active && (
                  <span className="mt-1 block h-px bg-bind" aria-hidden />
                )}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-5">
          <div className="hidden md:block">
            <MarketClock compact />
          </div>
          {/* The chain pages run on EVM testnets, so they get an EVM wallet; everywhere else is Solana. */}
          {pathname === "/chains" || pathname.startsWith("/chains/") ? <EvmHeaderConnect /> : <ConnectButton />}
        </div>
      </div>

      {/* The same destinations, laid as tiles across the full width. */}
      <nav
        ref={strip}
        className="flex overflow-x-auto border-t border-line text-sm [scrollbar-width:none] sm:hidden"
        style={{ maskImage: fade, WebkitMaskImage: fade }}
      >
        {NAV.map((item) => {
          const active =
            pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`flex-none whitespace-nowrap border-r border-line px-4 py-3 text-center last:border-r-0 ${
                active ? "bg-raised text-ink" : "text-ink-2"
              }`}
            >
              {item.long ?? item.label}
              {active && (
                <span className="mx-auto mt-1 block h-px w-6 bg-bind" aria-hidden />
              )}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
