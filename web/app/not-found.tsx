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
        This page does not exist. If you followed a basket link, nothing at that
        address belongs to the Sheaf program: it may be on another cluster, or
        the address may have a typo.
      </p>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <Link
          href="/explore"
          className="inline-block rounded-[var(--radius-control)] bg-bind px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-bind-deep"
        >
          See every basket
        </Link>
        <Link
          href="/"
          className="inline-block rounded-[var(--radius-control)] border border-line-strong bg-surface px-5 py-3 text-sm text-ink transition-colors hover:border-ink-3"
        >
          Back to the start
        </Link>
      </div>
    </div>
  );
}
