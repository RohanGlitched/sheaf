"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { LedgerEntry } from "@/lib/ledger";
import { useLedger } from "@/lib/use-ledger";
import { useBaskets } from "@/lib/use-baskets";
import { explorerAddress, explorerTx, WRITE_CLUSTER } from "@/lib/config";
import { count, money, plural, quantity, shortAddress, timeAgo } from "@/lib/format";
import { symbolForWriteMint } from "@/lib/mirror";
import type { Basket } from "@/lib/sheaf";
import { isTeamWallet } from "@/lib/team-wallets";
import { KeeperPulse } from "./keeper-pulse";
import { isTestBasket } from "@/lib/hidden";

/**
 * The program's whole history, from its own logs.
 *
 * Nothing on this page is stored anywhere but Solana. Each row is an event the
 * program emitted in a transaction, decoded on the way through, which is why a
 * creation made from a terminal with no website involved still shows up.
 */

export { useLedger };

const KIND: Record<LedgerEntry["kind"], { label: string; color: string }> = {
  created: { label: "Basket created", color: "var(--color-bind)" },
  minted: { label: "Shares created", color: "var(--color-gain)" },
  redeemed: { label: "Shares redeemed", color: "var(--color-loss)" },
  ordered: { label: "Dollar order", color: "#b9821a" },
  planRun: { label: "Plan run", color: "#2b78a3" },
  filled: { label: "Order filled", color: "var(--color-gain)" },
  returned: { label: "Dollars returned", color: "var(--color-ink-3)" },
  planOpened: { label: "Plan opened", color: "#8a4fa0" },
  sellOrdered: { label: "Sell order", color: "#b9821a" },
  sold: { label: "Shares sold", color: "var(--color-loss)" },
  sellReturned: { label: "Shares returned", color: "var(--color-ink-3)" },
  feeAccrued: { label: "Protocol fee accrued", color: "var(--color-bind)" },
  feeClaimed: { label: "Fee claimed by treasury", color: "var(--color-bind)" },
};

function describe(entry: LedgerEntry, basket: Basket | undefined): string {
  const parts: string[] = [];
  if (entry.kind === "ordered") return "Escrowed; fillers bid to deliver the stocks";
  if (entry.kind === "planRun") return "A plan's scheduled order, run by anyone";
  if (entry.kind === "filled") return "A filler delivered the stocks to the vault and took the dollars";
  if (entry.kind === "returned") return "Nobody filled in time; the dollars went back";
  if (entry.kind === "planOpened") return "Allowed to spend exactly this much per run";
  if (entry.kind === "sellOrdered") return "Escrowed; fillers bid to pay dollars for the shares";
  if (entry.kind === "sold") return "A filler paid the dollars and took the shares";
  if (entry.kind === "sellReturned") return "Nobody bought in time; the shares went back";
  if (entry.kind === "feeAccrued") return "Sheaf's 0.10% of a creation, set aside in new shares, never out of the vault";
  if (entry.kind === "feeClaimed") return "Accrued fee shares minted to the treasury; anyone can send the claim";
  if (!entry.amounts || !basket) return "";
  basket.components.forEach((c, i) => {
    const raw = entry.amounts![i];
    if (!raw || raw === "0") return;
    const label = (symbolForWriteMint(c.mint) ?? "?").replace(/x$/, "");
    parts.push(`${quantity(Number(raw) / 10 ** c.decimals, 4)} ${label}`);
  });
  return parts.join(" · ");
}

/** What moved, with its unit: shares, holdings or dollars, never a bare number. */
function amountOf(e: LedgerEntry): { main: string; notes: string[] } {
  const notes: string[] = [];
  let main: string;
  if (e.kind === "created") {
    const n = e.componentCount ?? 0;
    main = `${n} ${plural(n, "holding")}`;
  } else if (e.kind === "ordered" || e.kind === "planRun" || e.kind === "returned") {
    main = money(e.cash ?? 0);
  } else if (e.kind === "planOpened") {
    main = `${money(e.cash ?? 0)} a run`;
    notes.push(`${count(e.runs ?? 0)} ${plural(e.runs ?? 0, "run")}`);
  } else {
    const n = e.shares ?? 0;
    main = `${quantity(n, 4)} ${plural(n, "share")}`;
    if ((e.kind === "filled" || e.kind === "sold") && e.cash != null) notes.push(`for ${money(e.cash)}`);
  }
  if (e.kind === "feeAccrued") notes.push("Sheaf's 0.10%");
  if (e.kind === "feeClaimed") notes.push("to the treasury");
  if (e.feeShares) notes.push(`+${quantity(e.feeShares, e.feeShares < 0.01 ? 6 : 4)} to the creator`);
  return { main, notes };
}

/** "53 s" or "2 min 29 s": the same short form /business uses. */
function waitFor(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** Distinct wallets behind a set of events, and how many of them are not ours. */
export function walletCounts(entries: LedgerEntry[]) {
  // Fee events name a basket or the treasury's share account, not a person; they are not wallets that acted.
  const wallets = new Set(entries.filter((e) => e.kind !== "feeAccrued" && e.kind !== "feeClaimed").map((e) => e.actor));
  let outside = 0;
  for (const w of wallets) if (!isTeamWallet(w)) outside++;
  return { wallets: wallets.size, outside, actions: entries.length };
}

/** One day, the same everywhere: dates on this site are UTC, so a basket page and the ledger agree. */
export function utcDate(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

type Row = { kind: "one"; entry: LedgerEntry } | { kind: "returns"; id: string; entries: LedgerEntry[] };

/** Three or more refunds in a row fold into one line; each is still one click away. */
const FOLD_RETURNS = 3;

function foldReturns(entries: LedgerEntry[]): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < entries.length; ) {
    let j = i;
    while (j < entries.length && entries[j].kind === "returned") j++;
    if (j - i >= FOLD_RETURNS) {
      rows.push({ kind: "returns", id: `${entries[i].signature}-returns`, entries: entries.slice(i, j) });
      i = j;
    } else {
      rows.push({ kind: "one", entry: entries[i] });
      i++;
    }
  }
  return rows;
}

function foldSummary(entries: LedgerEntry[]) {
  const total = entries.reduce((a, e) => a + (e.cash ?? 0), 0);
  return `${count(entries.length)} orders returned · ${money(total)} back to the buyers`;
}

export function LedgerTable({
  entries,
  baskets,
  showBasket = true,
}: {
  entries: LedgerEntry[];
  baskets: Map<string, Basket>;
  showBasket?: boolean;
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // Every row, with each folded run of refunds as one item until it is opened.
  const visible = useMemo(
    () =>
      foldReturns(entries).flatMap((r): (LedgerEntry | { fold: { id: string; entries: LedgerEntry[] } })[] =>
        r.kind === "one" ? [r.entry] : open.has(r.id) ? r.entries : [{ fold: { id: r.id, entries: r.entries } }],
      ),
    [entries, open],
  );
  return (
    <>
      {/* A phone gets one card per event: what and when, then how much and the proof. */}
      <ul className="divide-y divide-line overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface sm:hidden">
        {visible.map((e) => {
          if ("fold" in e) {
            return (
              <li key={e.fold.id} className="px-4 py-3 text-sm">
                <button type="button" onClick={() => toggle(e.fold.id)} aria-expanded={false} className="flex w-full items-baseline justify-between gap-3 text-left">
                  <span className="flex min-w-0 items-center gap-2">
                    <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: KIND.returned.color }} />
                    <span className="text-ink-2">{foldSummary(e.fold.entries)}</span>
                  </span>
                  <span className="shrink-0 text-xs text-bind">Show</span>
                </button>
              </li>
            );
          }
          const basket = baskets.get(e.basket);
          const kind = KIND[e.kind];
          const amount = amountOf(e);
          return (
            <li key={`${e.signature}-${e.kind}`} className="px-4 py-3 text-sm">
              <p className="flex items-baseline justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2">
                  <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: kind.color }} />
                  <span className="text-ink">{kind.label}</span>
                  {showBasket && (
                    <Link href={`/basket/${e.basket}`} className="text-ink-2 underline decoration-line-strong underline-offset-4">
                      {basket?.symbol ?? e.symbol ?? shortAddress(e.basket)}
                    </Link>
                  )}
                </span>
                <span className="tnum shrink-0 text-xs text-ink-3">{timeAgo(e.time)}</span>
              </p>
              <p className="tnum mt-1.5 flex items-baseline justify-between gap-3 pl-4">
                <span className="min-w-0 text-ink-2">
                  {amount.main}
                  {amount.notes.length > 0 && <span className="text-xs text-ink-3"> · {amount.notes.join(" · ")}</span>}
                </span>
                <a href={explorerTx(e.signature)} target="_blank" rel="noreferrer" className="shrink-0 text-xs text-ink-2 underline decoration-line-strong underline-offset-4">
                  Tx {shortAddress(e.signature, 4, 4)}
                </a>
              </p>
            </li>
          );
        })}
      </ul>

      <div className="hidden min-w-0 overflow-x-auto rounded-[var(--radius-panel)] border border-line bg-surface sm:block">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-ink-3">
              <th className="px-4 py-3 font-normal">When</th>
              <th className="px-4 py-3 font-normal">What</th>
              {showBasket && <th className="px-4 py-3 font-normal">Basket</th>}
              <th className="px-4 py-3 font-normal">Wallet</th>
              <th className="px-4 py-3 text-right font-normal">Amount</th>
              <th className="hidden px-4 py-3 font-normal md:table-cell">Moved through the vault</th>
              <th className="px-4 py-3 text-right font-normal">Tx</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((e) => {
              if ("fold" in e) {
                return (
                  <tr key={e.fold.id} className="border-b border-line/60 last:border-0">
                    <td colSpan={showBasket ? 7 : 6} className="px-4 py-3">
                      <button type="button" onClick={() => toggle(e.fold.id)} aria-expanded={false} className="flex items-center gap-2 text-left text-ink-2 hover:text-ink">
                        <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: KIND.returned.color }} />
                        {foldSummary(e.fold.entries)},{" "}
                        {timeAgo(e.fold.entries[e.fold.entries.length - 1].time) === timeAgo(e.fold.entries[0].time)
                          ? timeAgo(e.fold.entries[0].time)
                          : `${timeAgo(e.fold.entries[e.fold.entries.length - 1].time)} to ${timeAgo(e.fold.entries[0].time)}`}
                        <span className="text-xs text-bind">Show each</span>
                      </button>
                    </td>
                  </tr>
                );
              }
              const basket = baskets.get(e.basket);
              const kind = KIND[e.kind];
              const amount = amountOf(e);
              return (
                <tr key={`${e.signature}-${e.kind}`} className="border-b border-line/60 last:border-0">
                  <td className="tnum whitespace-nowrap px-4 py-3 text-ink-2" title={new Date(e.time * 1000).toISOString()}>
                    {timeAgo(e.time)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <span className="flex items-center gap-2">
                      <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: kind.color }} />
                      <span className="text-ink">{kind.label}</span>
                    </span>
                  </td>
                  {showBasket && (
                    <td className="px-4 py-3">
                      <Link href={`/basket/${e.basket}`} className="text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink-2">
                        {basket?.symbol ?? e.symbol ?? shortAddress(e.basket)}
                      </Link>
                      <span className="ml-2 hidden text-xs text-ink-3 lg:inline">{basket?.name ?? e.name}</span>
                    </td>
                  )}
                  <td className="tnum whitespace-nowrap px-4 py-3">
                    <a href={explorerAddress(e.actor)} target="_blank" rel="noreferrer" className="text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink">
                      {shortAddress(e.actor)}
                    </a>
                    </td>
                  <td className="tnum whitespace-nowrap px-4 py-3 text-right text-ink">
                    {amount.main}
                    {amount.notes.map((n) => (
                      <span key={n} className="block text-xs text-ink-3">{n}</span>
                    ))}
                  </td>
                  <td className="tnum hidden px-4 py-3 text-xs text-ink-3 md:table-cell">
                    {describe(e, basket)}
                  </td>
                  <td className="tnum whitespace-nowrap px-4 py-3 text-right">
                    <a href={explorerTx(e.signature)} target="_blank" rel="noreferrer" className="text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink">
                      {shortAddress(e.signature, 4, 4)}
                    </a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function LedgerPage() {
  const { ledger, stats: served, error, loading, decoding } = useLedger();
  const { baskets } = useBaskets();
  const byAddress = useMemo(() => new Map((baskets ?? []).map((b) => [b.address, b])), [baskets]);

  const stats = useMemo(() => {
    const entries = ledger?.entries ?? [];
    const { wallets, outside } = walletCounts(entries);
    // A filled dollar order creates shares exactly as an in-kind deposit does,
    // and the basket's own count includes both, so the ledger does too.
    const creations = entries.filter((e) => e.kind === "minted" || e.kind === "filled");
    const created = creations.reduce((a, e) => a + (e.shares ?? 0) + (e.feeShares ?? 0), 0);
    const redeemed = entries.filter((e) => e.kind === "redeemed").reduce((a, e) => a + (e.shares ?? 0), 0);
    // A basket counts once, and baskets our own QA runs made are counted apart, as on Explore.
    const createdEvents = entries.filter((e) => e.kind === "created");
    const testBaskets = createdEvents.filter((e) => isTestBasket({ address: e.basket, creator: e.actor })).length;
    return {
      baskets: createdEvents.length - testBaskets,
      testBaskets,
      creations: creations.length,
      redemptions: entries.filter((e) => e.kind === "redeemed").length,
      wallets,
      outside,
      actions: entries.length,
      created,
      redeemed,
      first: entries.length ? entries[entries.length - 1].time : null,
    };
  }, [ledger]);

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-8">
        <div>
          <h1 className="display text-hero leading-[0.95] text-ink">The ledger</h1>
          <p className="mt-4 max-w-[56ch] text-base leading-relaxed text-ink-2">
            Every basket, every share created or redeemed, every dollar order and
            every plan run, read from the events the program wrote into its own
            transactions. There is no database of record: the server keeps a cache
            of the decoded history in a storage bucket, refreshed from the chain every
            half minute, and anyone can rebuild it from the chain.
          </p>
        </div>
        {ledger && (
          <dl className="tnum grid grid-cols-2 gap-x-8 gap-y-4 text-sm sm:flex">
            {([
              ["Actions", count(stats.actions), null],
              ["Baskets", count(stats.baskets), stats.testBaskets > 0 ? `+${count(stats.testBaskets)} demo` : null],
              ["Creations", count(stats.creations), null],
              ["Redemptions", count(stats.redemptions), null],
            ] as [string, string, string | null][]).map(([label, value, note]) => (
              <div key={label}>
                <dt className="text-xs text-ink-3">{label}</dt>
                <dd className="display mt-1 text-xl text-ink">{value}</dd>
                {note && <dd className="mt-0.5 text-xs text-ink-3">{note}</dd>}
              </div>
            ))}
          </dl>
        )}
      </div>

      <KeeperPulse className="mt-6" />

      {loading && <p className="mt-12 text-sm text-ink-3">Reading the program&rsquo;s transactions…</p>}
      {error && (
        <p className="mt-12 border-l-2 border-loss pl-3 text-sm leading-relaxed text-loss">
          {ledger && ledger.done < ledger.total
            ? `The public RPC stopped answering after ${count(ledger.done)} of ${count(ledger.total)} transactions. Reload in a minute to pick up the rest; what is below is already decoded. `
            : "Could not read the ledger. "}
          {error}
        </p>
      )}

      {ledger && (
        <>
          <p className="tnum mt-10 text-xs text-ink-3">
            {decoding
              ? `Decoded ${count(ledger.done)} of ${count(ledger.total)} transactions so far…`
              : `${count(ledger.entries.length)} events on ${WRITE_CLUSTER}`}
            {!decoding && stats.first ? ` since ${utcDate(stats.first)} (UTC)` : ""}
            {!decoding && (
              <>
                {" · "}
                {quantity(stats.created, 2)} shares created and {quantity(stats.redeemed, 2)} redeemed across every basket
              </>
            )}
            {ledger.truncated ? ` · showing the most recent ${count(ledger.entries.length)} events; counts cover the whole history` : ""}
          </p>
          {served && served.orders > 0 && (
            <p className="tnum mt-2 text-xs text-ink-3">
              {count(served.fills)} {plural(served.fills, "fill")} for {money(served.dollarsFilled)}
              {served.byCause
                ? (
                    [
                      ["dollar orders", served.byCause.dollar],
                      ["plan runs", served.byCause.plan],
                    ] as const
                  )
                    .filter(([, f]) => f.orders > 0)
                    .map(
                      ([label, f]) =>
                        ` · ${label}: ${f.fillRate != null ? `${Math.round(f.fillRate * 100)}% filled` : "none finished"}${
                          f.medianSecsToFill != null ? `, median ${waitFor(f.medianSecsToFill)} to fill` : ""
                        }`,
                    )
                    .join("")
                : `${served.fillRate != null ? ` · ${Math.round(served.fillRate * 100)}% of finished orders filled` : ""}${
                    served.medianSecsToFill != null ? ` · median ${waitFor(served.medianSecsToFill)} from order to fill` : ""
                  }`}
              {` · ${count(served.plans)} ${plural(served.plans, "plan")} opened`}
            </p>
          )}
          <p className="mt-2 max-w-[72ch] text-xs leading-relaxed text-ink-3">
            This program was deployed, and its baskets created, on October 8, 2026. Sheaf began as Tessera on September 13;
            that earlier program&rsquo;s history is in{" "}
            <a
              href="https://github.com/RohanGlitched/sheaf"
              target="_blank"
              rel="noreferrer"
              className="text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink"
            >
              the repository
            </a>
            . Dates on this site are in UTC.
          </p>
          <div className="mt-4">
            {ledger.entries.length === 0 && decoding ? (
              <p className="text-sm text-ink-3">Reading the program&rsquo;s transactions…</p>
            ) : ledger.entries.length === 0 ? (
              <p className="border border-dashed border-line-strong/60 px-6 py-10 text-sm text-ink-2 rounded-[var(--radius-control)]">
                The program has not settled anything yet.
              </p>
            ) : (
              <LedgerTable entries={ledger.entries} baskets={byAddress} />
            )}
          </div>
          <p className="mt-6 max-w-[62ch] text-xs leading-relaxed text-ink-3">
            Each row is one event the program emitted (<code className="text-ink-2">BasketCreated</code>,{" "}
            <code className="text-ink-2">SharesMinted</code>, <code className="text-ink-2">SharesRedeemed</code>,{" "}
            <code className="text-ink-2">OrderPlaced</code>, <code className="text-ink-2">OrderFilled</code> and the rest), decoded from
            the <code className="text-ink-2">Program data</code> lines of the
            transaction log. The site&rsquo;s server reads the transactions and decodes them once for
            every visitor (<code className="text-ink-2">/api/ledger</code>, at most 30 seconds old), so a
            visit costs one request; anyone can run the same decoder against the public RPC. Every
            row links to its transaction, so the page is never the source of truth: the chain is.
          </p>
        </>
      )}
    </div>
  );
}

/** One basket's own history, for its page. */
export function BasketHistory({ basket }: { basket: Basket }) {
  const { ledger, error, loading, decoding } = useLedger(basket.address);
  const baskets = useMemo(() => new Map([[basket.address, basket]]), [basket]);
  return (
    <section className="mt-16">
      <h2 className="display text-title text-ink">Everything that has happened to it</h2>
      <p className="mt-3 max-w-[60ch] text-sm leading-relaxed text-ink-2">
        Every creation, redemption, dollar order and plan run since the basket was
        made, decoded from the program&rsquo;s own events. The full ledger across every basket is on{" "}
        <Link href="/ledger" className="text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink-2">
          one page
        </Link>
        .
      </p>
      <div className="mt-7">
        {loading && <p className="text-sm text-ink-3">Reading the transactions…</p>}
        {error && <p className="text-sm text-loss">Could not read the history. {error}</p>}
        {ledger && ledger.entries.length === 0 && !decoding && (
          <p className="border border-dashed border-line-strong/60 px-6 py-8 text-sm text-ink-2 rounded-[var(--radius-control)]">
            Nothing yet beyond the basket being created.
          </p>
        )}
        {ledger && decoding && (
          <p className="mb-3 text-xs text-ink-3">
            Decoding {count(ledger.done)} of {count(ledger.total)} transactions…
          </p>
        )}
        {ledger && ledger.entries.length > 0 && (
          <LedgerTable entries={ledger.entries} baskets={baskets} showBasket={false} />
        )}
      </div>
    </section>
  );
}
