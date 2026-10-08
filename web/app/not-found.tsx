import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Not found",
};

export default function NotFound() {
  return (
    <div className="mx-auto max-w-[1400px] px-5 py-32 text-center sm:px-8">
      <p className="tnum text-sm text-ink-3">404</p>
      <h1 className="display text-title mt-3 text-ink">Nothing here.</h1>
      <p className="mx-auto mt-4 max-w-[48ch] text-base leading-relaxed text-ink-2">
        This page does not exist. The market and every basket on the program are
        a click away.
      </p>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <Link
          href="/"
          className="inline-block border border-line px-5 py-3 text-sm text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
        >
          Back to the market
        </Link>
        <Link
          href="/explore"
          className="inline-block border border-line px-5 py-3 text-sm text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
        >
          See every basket
        </Link>
      </div>
    </div>
  );
}
