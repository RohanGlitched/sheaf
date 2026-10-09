"use client";

import { useEffect } from "react";
import Link from "next/link";

/**
 * A basket page that failed to render. The likeliest cause is a read from the
 * devnet RPC that timed out or was rate-limited, which a retry usually fixes;
 * the basket itself lives on the chain and is not affected.
 */
export default function BasketError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="mx-auto max-w-[1400px] px-5 py-32 text-center sm:px-8">
      <h1 className="display text-title text-ink">This basket did not load.</h1>
      <p className="mx-auto mt-4 max-w-[52ch] text-base leading-relaxed text-ink-2">
        Reading it from devnet failed, most often because the public connection was busy. The basket and its vault are
        unaffected; try again in a moment.
      </p>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="rounded-[var(--radius-control)] bg-bind px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-bind-deep"
        >
          Try again
        </button>
        <Link
          href="/explore"
          className="rounded-[var(--radius-control)] border border-line-strong bg-surface px-5 py-3 text-sm text-ink transition-colors hover:border-ink-3"
        >
          See every basket
        </Link>
      </div>
    </div>
  );
}
