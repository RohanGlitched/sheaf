import { teamTag } from "./team-wallets";

/**
 * Baskets kept out of the default lists.
 *
 * These were made by our own QA runs to exercise creation and launches on the
 * live site. They are real program accounts and stay reachable by URL, and
 * Explore lists them behind a "show test baskets" switch; they are only left
 * out of what a visitor sees first, and out of every basket count, so the
 * numbers agree from page to page.
 *
 * A basket is a test basket when it is listed here or when its creator is one
 * of our test wallets (lib/team-wallets.ts). Nothing is hidden by its name, so
 * a visitor who calls their own basket "Test" still finds it.
 */
export const HIDDEN_BASKETS: ReadonlySet<string> = new Set([
  // QAENU6, "QA judge QAENU6", created by QA wallet 6dXoQf…
  "6qxoL6xVW7vtCuMMTSfVDDJkkLfo5e5UXWXCBh7iNxT5",
  // QA3KRA, "QA judge QA3KRA", created by QA wallet wNfb2a…
  "BreYJv2KC1dDswR67Q5qiFijbekEqqpEHzckKN1KQTEA",
  // QAWSC1, "QA judge QAWSC1", created by QA wallet 8rLCuB…
  "AVqEMiiaDGZEo2ZSq3Bvni1mMNczaJ1p49cwsnqFqsgg",
  // QAZG1N, "QA judge QAZG1N", created by QA wallet HSHma7…
  "6WRU3zPJm9o6qJnZVzxNwyXn2HrBiqM9YokjR9ioDLju",
]);

/** True for a basket our tests made: listed above, or created by one of our test wallets. */
export function isTestBasket(basket: { address: string; creator?: string; name?: string; symbol?: string }): boolean {
  if (HIDDEN_BASKETS.has(basket.address)) return true;
  return basket.creator != null && teamTag(basket.creator) === "test wallet";
}

/** The baskets a visitor sees by default, and how many test baskets were left out. */
export function splitTestBaskets<T extends { address: string; creator?: string }>(baskets: T[]) {
  const shown = baskets.filter((b) => !isTestBasket(b));
  return { shown, tests: baskets.length - shown.length };
}
