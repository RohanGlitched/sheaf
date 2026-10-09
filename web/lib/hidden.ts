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
  // QA4LC8, "QA judge QA4LC8", created by QA wallet AWwhyV…
  "FzHUmTWLhvxpbdvWqeict9ZeQqcqeJryGSHNjNoQEUwK",
  // QA4ATV, "QA judge QA4ATV", created by fixed-seed test wallet 71 (HsVLmM…), round-7 QA compose + launch run
  "89YfckYY7SakKm3xiSM3FH88zyMa3icgGN6vTNDXXEzs",
  // QAKRRQ, "QA judge QAKRRQ", created by test wallet 6YtTBB…
  "FXEu6Kcq3k32YoUdRZSsJS24zEghqiSjEsGU8DcYNbzF",
  // QA3V9W, "QA judge QA3V9W", created by test wallet Ep5kyi…
  "DFjLxot2mbSyQZwsckY2ZDG3Gb2PrSYZgXM7UdDM2ihp",
  // DIVDEMO, "Dividend payers, demo", created by test wallet Gxa3YF… for a video
  "DviEARiBA48UnEY8Zf18b2oTKbYT8TxBqj7KXMCByQz2",
]);

/**
 * Baskets the house created and lists first: the ones Sheaf curates. Every
 * other basket that isn't a test is a community basket, listed behind a switch
 * on Explore so a lookalike name never sits beside the house's by default.
 */
export const isHouseBasket = (basket: { creator?: string }) => basket.creator != null && teamTag(basket.creator) === "house";

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
