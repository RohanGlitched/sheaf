/**
 * Baskets kept out of the default lists.
 *
 * These were made by our own QA runs to exercise creation and launches on the
 * live site. They are real program accounts and stay reachable by URL, and
 * Explore lists them behind a "show test baskets" switch; they are only left
 * out of what a visitor sees first, because a basket called "QA judge" says
 * nothing about Sheaf.
 */
export const HIDDEN_BASKETS: ReadonlySet<string> = new Set([
  // QAENU6, "QA judge QAENU6", created by QA wallet 6dXoQf…
  "6qxoL6xVW7vtCuMMTSfVDDJkkLfo5e5UXWXCBh7iNxT5",
  // QA3KRA, "QA judge QA3KRA", created by QA wallet wNfb2a…
  "BreYJv2KC1dDswR67Q5qiFijbekEqqpEHzckKN1KQTEA",
]);

/** True for a basket our tests made: listed in full, or named like one. */
export function isTestBasket(basket: { address: string; name?: string; symbol?: string }): boolean {
  if (HIDDEN_BASKETS.has(basket.address)) return true;
  return /^QA\b|\bQA judge\b|^test\b/i.test(basket.name ?? "") || /^QA[A-Z0-9]{2,}$/.test(basket.symbol ?? "");
}
