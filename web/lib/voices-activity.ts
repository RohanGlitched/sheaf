import type { LedgerEntry } from "./ledger";
import { money, plural, quantity } from "./format";

/**
 * What one wallet has done on Sheaf, in plain words, from the program's own
 * events on /api/ledger: "opened a plan", "bought $50 of BIG5", "created a basket".
 * Each line links to the newest transaction behind it.
 */

export type Deed = { text: string; signature: string; time: number };

/** Every wallet's events, grouped once so each card is a lookup. */
export function byActor(entries: LedgerEntry[]): Map<string, LedgerEntry[]> {
  const m = new Map<string, LedgerEntry[]>();
  for (const e of entries) {
    const xs = m.get(e.actor);
    if (xs) xs.push(e);
    else m.set(e.actor, [e]);
  }
  return m;
}

export function deedsOf(entries: LedgerEntry[], symbolOf: (basket: string) => string): Deed[] {
  type Acc = { amount: number; n: number; signature: string; time: number };
  const groups = new Map<string, Acc>();
  const add = (key: string, e: LedgerEntry, amount = 0) => {
    const g = groups.get(key);
    // Entries arrive newest first, so the first one seen links the line.
    if (g) {
      g.amount += amount;
      g.n++;
    } else groups.set(key, { amount, n: 1, signature: e.signature, time: e.time });
  };
  const filledOrders = new Set(entries.filter((e) => e.kind === "filled" && e.order).map((e) => e.order));
  const returnedOrders = new Set(entries.filter((e) => e.kind === "returned" && e.order).map((e) => e.order));

  for (const e of entries) {
    const b = e.basket;
    switch (e.kind) {
      case "created":
        add(`created|${b}`, e);
        break;
      case "planOpened":
        add(`plan|${b}`, e, e.cash ?? 0);
        break;
      case "filled":
        add(`bought|${b}`, e, e.cash ?? 0);
        break;
      case "ordered":
        if (e.order && !filledOrders.has(e.order) && !returnedOrders.has(e.order)) add(`waiting|${b}`, e, e.cash ?? 0);
        break;
      case "returned":
        add(`returned|${b}`, e, e.cash ?? 0);
        break;
      case "minted":
        add(`minted|${b}`, e, e.shares ?? 0);
        break;
      case "redeemed":
        add(`redeemed|${b}`, e, e.shares ?? 0);
        break;
      case "planRun":
        add(`ran|*`, e);
        break;
    }
  }

  const deeds: Deed[] = [];
  for (const [key, g] of groups) {
    const [kind, b] = key.split("|");
    const sym = b === "*" ? "" : symbolOf(b);
    const text =
      kind === "created"
        ? `created the ${sym} basket`
        : kind === "plan"
          ? g.n > 1
            ? `opened ${g.n} plans into ${sym}`
            : `opened a plan into ${sym}, ${money(g.amount)} a run`
          : kind === "bought"
            ? `bought ${money(g.amount)} of ${sym}`
            : kind === "waiting"
              ? `has a ${money(g.amount)} order for ${sym} waiting`
              : kind === "returned"
                ? `got ${money(g.amount)} back on an unfilled ${sym} order`
                : kind === "minted"
                  ? `put stocks in for ${quantity(g.amount, 2)} ${sym} ${plural(g.amount, "share")}`
                  : kind === "redeemed"
                    ? `redeemed ${quantity(g.amount, 2)} ${sym} ${plural(g.amount, "share")} for the stocks`
                    : `ran ${g.n} scheduled ${plural(g.n, "plan order")} for other people`;
    deeds.push({ text, signature: g.signature, time: g.time });
  }
  return deeds.sort((a, b) => b.time - a.time);
}
