"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import bs58 from "bs58";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { ConnectButton } from "./connect-button";
import { FixtureTag, PantaSteps, PoweredByPanta, type Step, type StepState } from "./panta-steps";
import { pantaGet, pantaPost, short, usdcBase, type PantaMode } from "@/lib/panta-client";
import { compileForSigning, signatureOf, type PantaIx } from "@/lib/panta-sign";

type Market = {
  marketId: string;
  title: string;
  category: string;
  phase: string;
  yesPrice: string | null;
  noPrice: string | null;
  volumeUsdc: string;
  endTime: string;
};

// Panta's answers, as the steps read them. Fields are optional because the
// sandbox leaves some out.
type Answer = {
  fixture?: boolean;
  createId?: string;
  expectedEventPda?: string;
  paymentUsdc?: string;
  liquidityInjectionUsdc?: string;
  platformRevenueUsdc?: string;
  categoryPreferred?: boolean;
  draft?: { wallet: string; question: string; resolutionRule: string; sourcesOfTruth: string[]; category: string; startTime: number; endTime: number; imageUrl: string };
  transaction?: string;
  recentBlockhash?: string;
  buildFingerprint?: string;
  instructions?: PantaIx[];
  orderId?: string;
  quoteId?: string;
  marketId?: string;
  status?: string;
  title?: string;
  wallet?: string;
  amountUsdc?: string;
  requestedUsdc?: string;
  shares?: string;
  feeUsdc?: string;
  side?: "yes" | "no";
  claimableFeesUsdc?: string;
  // Filled in by the sign step, not by Panta.
  signature?: string;
  standIn?: boolean;
  placeholder?: boolean;
  blockhashFrom?: string;
  ixCount?: number;
};

const CREATE = ["quote", "build", "sign", "register"] as const;
const BUY = ["quote", "build", "sign", "submit", "verify", "report"] as const;
type CreateKey = (typeof CREATE)[number];
type BuyKey = (typeof BUY)[number];

const cents = (p: string | null | undefined) => (p == null ? "—" : `${Math.round(Number(p) * 100)}¢`);
const day = (unix: number) => new Date(unix * 1000).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
const mono = (s: ReactNode) => <span className="font-mono text-[11px]">{s}</span>;

/**
 * "Will this basket beat SPY this week?" as a Panta prediction market, driven
 * through Panta's whole write lifecycle.
 *
 * Sheaf writes the question and a resolution rule anyone can check (the vault's
 * value, served as JSON at /api/nav/<basket>, against SPY's close), then runs
 * each step of opening the market and buying a side against Panta's API and
 * shows what Panta answered. The wallet is asked to sign and nothing is ever
 * sent: with a pk_test_ key Panta answers from its sandbox, and the server
 * refuses every build step with a live key.
 */
export function BasketPredict({ basket, name, symbol, creator }: { basket: string; name: string; symbol: string; creator: string }) {
  const { publicKey, signTransaction } = useWallet();
  const { connection } = useConnection();
  const me = publicKey?.toBase58() ?? null;
  const question = `Will ${name} (${symbol}) beat SPY this week?`;

  const [mode, setMode] = useState<PantaMode | null>(null);
  const [markets, setMarkets] = useState<Market[]>([]);
  const [category, setCategory] = useState<{ category: string; preferred: boolean } | null>(null);
  const [trades, setTrades] = useState<{ marketId: string; count: number } | null>(null);
  const [c, setC] = useState<Partial<Record<CreateKey, Answer>>>({});
  const [b, setB] = useState<Partial<Record<BuyKey, Answer>>>({});
  const [fees, setFees] = useState<Answer | null>(null);
  const [side, setSide] = useState<"yes" | "no">("yes");
  const [amount, setAmount] = useState("20");
  const [busy, setBusy] = useState<string | null>(null);
  const [fail, setFail] = useState<{ at: string; msg: string; skippable?: boolean } | null>(null);

  useEffect(() => {
    let live = true;
    pantaGet<{
      mode: PantaMode;
      markets: Market[];
      category?: { category: string; preferred: boolean };
      trades?: { marketId: string; count: number } | null;
    }>("/api/panta").then((r) => {
      if (!live) return;
      if (!r.ok) return setMode("off");
      setMode(r.data.mode);
      setMarkets(r.data.markets ?? []);
      if (r.data.category) setCategory(r.data.category);
      if (r.data.trades) setTrades(r.data.trades);
    });
    return () => {
      live = false;
    };
  }, []);

  // The market a buy goes to. In the sandbox Panta has one fixture market for
  // every key, and it stands in for this basket's (it is also what the sandbox
  // registers). Live, it is the market this basket's flow registered, if any.
  const registered = c.register?.marketId ?? null;
  const market =
    markets.find((m) => m.marketId === registered) ??
    (mode === "sandbox"
      ? (markets[0] ?? null)
      : (markets.find((m) => m.title.toLowerCase().startsWith(`${name.toLowerCase()} vs spy`)) ?? null));
  const standIn = mode === "sandbox";

  async function run(at: string, fn: () => Promise<void>) {
    setBusy(at);
    setFail(null);
    try {
      await fn();
    } catch (err) {
      setFail({ at, msg: (err as Error).message || "Something went wrong." });
    } finally {
      setBusy(null);
    }
  }

  async function post(payload: Record<string, unknown>): Promise<Answer> {
    const r = await pantaPost<Answer>(payload);
    if (!r.ok) throw new Error(r.error);
    return r.data;
  }

  /** wallet.signTransaction only. The signed bytes are dropped; only the signature goes on. */
  async function sign(at: string, build: Answer, what: string): Promise<Answer | null> {
    if (!publicKey) throw new Error("Connect a wallet to sign.");
    const compiled = await compileForSigning({
      payer: publicKey,
      transaction: build.transaction || undefined,
      instructions: build.instructions,
      recentBlockhash: build.recentBlockhash,
      memo: `Sheaf x Panta sandbox: ${what} on ${symbol}. Signed to show the flow; never sent.`,
      connection,
    });
    const base = { standIn: compiled.standIn, blockhashFrom: compiled.blockhashFrom, ixCount: compiled.instructions };
    if (!signTransaction) {
      setFail({ at, msg: "This wallet cannot sign without sending, so Sheaf will not ask it to.", skippable: true });
      return null;
    }
    try {
      const signed = await signTransaction(compiled.tx);
      return { ...base, signature: signatureOf(signed) };
    } catch (err) {
      setFail({ at, msg: `The wallet did not sign (${(err as Error).message || "declined"}).`, skippable: true });
      return null;
    }
  }

  /** Sandbox only: go on without a wallet signature. Said plainly in the step. */
  function placeholder(flow: "create" | "buy") {
    const signature = bs58.encode(crypto.getRandomValues(new Uint8Array(64)));
    const answer: Answer = { signature, placeholder: true };
    if (flow === "create") setC((x) => ({ ...x, sign: answer }));
    else setB((x) => ({ ...x, sign: answer }));
    setFail(null);
  }

  const nextCreate = CREATE.find((k) => !c[k]) ?? null;
  const nextBuy = BUY.find((k) => !b[k]) ?? null;

  async function quoteCreate(wallet: string) {
    const q = await post({ kind: "create-quote", wallet, basket, name, symbol });
    setC({ quote: q });
    return q;
  }

  function advanceCreate() {
    const k = nextCreate ?? "quote";
    if (!nextCreate) setC({});
    void run(`create:${k}`, async () => {
      if (k === "quote") {
        await quoteCreate(me ?? creator);
        return;
      }
      if (!me) throw new Error("Connect a wallet to go past the quote.");
      if (k === "build") {
        // A create session is bound to the wallet it was quoted for.
        const q = c.quote?.draft?.wallet === me ? c.quote! : await quoteCreate(me);
        const built = await post({ kind: "create-build", wallet: me, createId: q.createId });
        setC((x) => ({ ...x, quote: q, build: built }));
      } else if (k === "sign") {
        const signed = await sign("create:sign", c.build!, "open a market");
        if (signed) setC((x) => ({ ...x, sign: signed }));
      } else if (k === "register") {
        const reg = await post({ kind: "create-register", createId: c.quote?.createId, signature: c.sign?.signature });
        setC((x) => ({ ...x, register: reg }));
      }
    });
  }

  async function quoteBuy(wallet: string) {
    const q = await post({ kind: "buy-quote", wallet, marketId: market?.marketId, side, amountUsdc: amount });
    setB({ quote: q });
    return q;
  }

  function advanceBuy() {
    const k = nextBuy ?? "quote";
    if (!nextBuy) setB({});
    void run(`buy:${k}`, async () => {
      if (!market) throw new Error("There is no market to buy into yet.");
      if (k === "quote") {
        await quoteBuy(me ?? creator);
        return;
      }
      if (!me) throw new Error("Connect a wallet to go past the quote.");
      if (k === "build") {
        const q = b.quote?.wallet === me ? b.quote! : await quoteBuy(me);
        const built = await post({ kind: "buy-build", wallet: me, quoteId: q.quoteId });
        setB((x) => ({ ...x, quote: q, build: built }));
      } else if (k === "sign") {
        const signed = await sign("buy:sign", b.build!, `buy ${side.toUpperCase()}`);
        if (signed) setB((x) => ({ ...x, sign: signed }));
      } else if (k === "submit") {
        const r = await post({ kind: "buy-submit", wallet: me, orderId: b.build?.orderId, signature: b.sign?.signature });
        setB((x) => ({ ...x, submit: r }));
      } else if (k === "verify") {
        const r = await post({ kind: "buy-verify", wallet: me, orderId: b.build?.orderId, signature: b.sign?.signature });
        setB((x) => ({ ...x, verify: r }));
      } else if (k === "report") {
        const r = await post({
          kind: "buy-report",
          wallet: me,
          marketId: market.marketId,
          signature: b.sign?.signature,
          quoteId: b.quote?.quoteId,
        });
        setB((x) => ({ ...x, report: r }));
      }
    });
  }

  function claimFees() {
    void run("fees", async () => {
      if (!me) throw new Error("Connect a wallet first.");
      if (!market) throw new Error("There is no market yet.");
      setFees(await post({ kind: "creator-fees-build", wallet: me, marketId: market.marketId }));
    });
  }

  if (mode === "off") return null;

  const live = mode === "live";
  const state = (flow: "create" | "buy", k: string, done: boolean, first: boolean): StepState =>
    busy === `${flow}:${k}` ? "running" : fail?.at === `${flow}:${k}` ? "error" : done ? "done" : live && !first ? "blocked" : "todo";
  const signFacts = (s: Answer | undefined): [string, ReactNode][] =>
    !s
      ? []
      : s.placeholder
        ? [["Signature", <>{mono(short(s.signature, 10, 6))} <span className="text-loss">placeholder, no wallet signature</span></>]]
        : [
            ["Signature", mono(short(s.signature, 10, 6))],
            ["Signed", s.standIn ? `memo-only stand-in, blockhash from the ${s.blockhashFrom}` : `${s.ixCount} instructions from Panta`],
            ["Sent", "no, never"],
          ];

  const createSteps: Step[] = [
    {
      key: "quote",
      title: "Quote the market",
      call: "POST /markets/create/quote/",
      state: state("create", "quote", !!c.quote, true),
      facts: c.quote
        ? [
            ["Opening fee", <>{usdcBase(c.quote.paymentUsdc)} USDC: {usdcBase(c.quote.liquidityInjectionUsdc)} seeds the curve, {usdcBase(c.quote.platformRevenueUsdc)} to Panta<FixtureTag show={c.quote.fixture} /></>],
            ["createId", mono(c.quote.createId)],
            ["Market address", <>{mono(short(c.quote.expectedEventPda, 10, 6))}<FixtureTag show={c.quote.fixture} /></>],
            ["Quoted for", c.quote.draft?.wallet === me ? "your wallet" : `the basket's creator, ${short(creator, 4, 4)}`],
          ]
        : undefined,
    },
    {
      key: "build",
      title: "Build the transaction",
      call: "POST /markets/create/build/",
      state: state("create", "build", !!c.build, false),
      facts: c.build
        ? [
            ["Transaction", c.build.transaction ? `${Math.round((c.build.transaction.length * 3) / 4)} bytes, unsigned` : <>empty<FixtureTag show={c.build.fixture} /></>],
            ["Blockhash", <>{mono(short(c.build.recentBlockhash, 10, 6))}<FixtureTag show={c.build.fixture} /></>],
            ["Fingerprint", mono(c.build.buildFingerprint ?? "—")],
          ]
        : undefined,
    },
    {
      key: "sign",
      title: "Sign in your wallet",
      call: "wallet.signTransaction, not sent",
      state: state("create", "sign", !!c.sign, false),
      facts: signFacts(c.sign),
      note: c.sign?.standIn
        ? "The sandbox build has no transaction in it, so Sheaf compiled a memo-only stand-in for your wallet to sign. Live, the wallet signs Panta's transaction here and you broadcast it."
        : undefined,
    },
    {
      key: "register",
      title: "Register it with Panta",
      call: "POST /markets/register/",
      state: state("create", "register", !!c.register, false),
      facts: c.register
        ? [
            ["Status", <>{c.register.status}<FixtureTag show={c.register.fixture} /></>],
            ["Market", <>{mono(short(c.register.marketId, 10, 6))} {c.register.fixture ? `"${c.register.title}"` : ""}</>],
          ]
        : undefined,
      note: c.register?.fixture
        ? "The sandbox registers every create as its one fixture market and does not check the signature. Live, Panta verifies the confirmed transaction on chain before it registers anything."
        : undefined,
    },
  ];

  const asked = b.quote?.requestedUsdc ?? null;
  const fixedFixture = b.quote?.fixture && asked != null && Number(asked) !== Number(b.quote.amountUsdc);
  const buySteps: Step[] = [
    {
      key: "quote",
      title: `Quote ${side === "yes" ? "Yes" : "No"}`,
      call: "POST /primaryorderquote/",
      state: state("buy", "quote", !!b.quote, true),
      facts: b.quote
        ? [
            ["You asked", `$${Number(asked ?? b.quote.amountUsdc).toFixed(2)} on ${b.quote.side === "no" ? "No" : "Yes"}`],
            [
              "Panta answered",
              <>
                ${b.quote.amountUsdc} buys {b.quote.shares} shares, fee ${b.quote.feeUsdc}
                <FixtureTag show={b.quote.fixture} />
              </>,
            ],
            ["quoteId", mono(b.quote.quoteId)],
          ]
        : undefined,
      note: fixedFixture
        ? `Panta's sandbox answers every buy with the same fixed quote ($1.00 for 2 shares), whatever the amount. A live quote prices your $${Number(asked).toFixed(2)} on the bonding curve.`
        : undefined,
    },
    {
      key: "build",
      title: "Build the order",
      call: "POST /primaryorderbuild/",
      state: state("buy", "build", !!b.build, false),
      facts: b.build
        ? [
            ["orderId", mono(b.build.orderId)],
            ["Instructions", <>{b.build.instructions?.length ?? 0}<FixtureTag show={b.build.fixture} /></>],
            ["Blockhash", <>{mono(short(b.build.recentBlockhash, 10, 6))}<FixtureTag show={b.build.fixture} /></>],
          ]
        : undefined,
    },
    {
      key: "sign",
      title: "Sign in your wallet",
      call: "wallet.signTransaction, not sent",
      state: state("buy", "sign", !!b.sign, false),
      facts: signFacts(b.sign),
      note: b.sign?.standIn ? "No instructions came back from the sandbox, so the wallet signed Sheaf's memo stand-in." : undefined,
    },
    {
      key: "submit",
      title: "Submit the signature",
      call: "POST /primaryordersubmit/",
      state: state("buy", "submit", !!b.submit, false),
      facts: b.submit ? [["Status", <>{b.submit.status}<FixtureTag show={b.submit.fixture} /></>]] : undefined,
    },
    {
      key: "verify",
      title: "Verify the order",
      call: "POST /primaryorderverify/",
      state: state("buy", "verify", !!b.verify, false),
      facts: b.verify ? [["Status", <>{b.verify.status}<FixtureTag show={b.verify.fixture} /></>]] : undefined,
      note: b.verify?.fixture ? "The sandbox reports every order confirmed. Live, this stays submitted until the transaction lands." : undefined,
    },
    {
      key: "report",
      title: "Report the trade for attribution",
      call: "POST /trades/",
      state: state("buy", "report", !!b.report, false),
      facts: b.report ? [["Status", <>{b.report.status}<FixtureTag show={b.report.fixture} /></>]] : undefined,
    },
  ];

  const createLabel: Record<CreateKey, string> = {
    quote: "Price this market",
    build: "Build the transaction",
    sign: "Sign (not sent)",
    register: "Register with Panta",
  };
  const buyLabel: Record<BuyKey, string> = {
    quote: `Quote ${side === "yes" ? "Yes" : "No"}`,
    build: "Build the order",
    sign: "Sign (not sent)",
    submit: "Submit signature",
    verify: "Verify",
    report: "Report the trade",
  };

  const action = (flow: "create" | "buy", next: string | null, label: string, onClick: () => void, extra?: ReactNode) => {
    const needsWallet = next != null && next !== "quote" && !me;
    const blocked = live && next != null && next !== "quote";
    return (
      <div className="mt-5 flex flex-wrap items-center gap-3">
        {needsWallet && !blocked ? (
          <ConnectButton />
        ) : (
          <button
            type="button"
            onClick={onClick}
            disabled={busy != null || blocked || (flow === "buy" && !market)}
            className="rounded-[var(--radius-control)] bg-ink px-4 py-2.5 text-sm font-medium text-page transition-colors hover:bg-[#23382c] disabled:opacity-60"
          >
            {busy?.startsWith(`${flow}:`) ? "Asking Panta…" : next == null ? "Run it again" : label}
          </button>
        )}
        {fail?.skippable && fail.at === `${flow}:sign` && mode === "sandbox" && (
          <button
            type="button"
            onClick={() => placeholder(flow)}
            className="rounded-[var(--radius-control)] border border-line-strong px-3.5 py-2.5 text-sm text-ink-2 hover:border-ink-3"
          >
            Continue with a placeholder signature
          </button>
        )}
        {needsWallet && !blocked && <span className="text-xs text-ink-3">The next steps sign with your wallet.</span>}
        {blocked && (
          <span className="max-w-[44ch] text-xs leading-relaxed text-ink-3">
            Live key: Sheaf stops at the quote. Building and signing run against Panta&apos;s sandbox only, so no real USDC can move.
          </span>
        )}
        {extra}
      </div>
    );
  };

  const isCreator = me != null && me === creator;

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-14">
      <div>
        <p className="text-sm text-bind">Prediction market</p>
        <h2 className="display mt-2 text-title max-w-[18ch] text-ink">{question}</h2>
        <p className="mt-5 max-w-[44ch] text-base leading-relaxed text-ink-2">
          A basket has a value anyone can read from its vault, so a bet on it can be settled without
          trusting anyone&apos;s price. Sheaf writes the question and the rule. Panta runs the market on
          Solana, priced on a bonding curve and paid in USDC.
        </p>
        <PoweredByPanta className="mt-6" />
        {mode === "sandbox" && (
          <p className="mt-4 max-w-[46ch] text-xs leading-relaxed text-ink-3">
            Running against Panta&apos;s sandbox (a <code>pk_test_</code> key). Every step on the right is a
            real call to Panta&apos;s API and shows what came back; anything marked{" "}
            <span className="uppercase tracking-wide">sandbox fixture</span> is Panta&apos;s canned test
            answer, not a figure for this basket. Your wallet is asked to sign, and nothing is ever sent:
            no transaction reaches mainnet and no USDC moves.
          </p>
        )}
        {mode === "live" && (
          <p className="mt-4 max-w-[46ch] text-xs leading-relaxed text-ink-3">
            Reading Panta&apos;s live catalog. Sheaf quotes here and stops; it never builds a live transaction.
          </p>
        )}
        <div className="mt-6 grid max-w-[46ch] gap-2 text-sm">
          <a
            href={`/api/nav/${basket}`}
            target="_blank"
            rel="noreferrer"
            className="text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink"
          >
            The number it resolves from, as JSON ↗
          </a>
          <Link href="/predict" className="text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink">
            A market for every basket →
          </Link>
        </div>
      </div>

      <div className="rounded-[var(--radius-panel)] border border-line bg-surface">
        <div className="border-b border-line p-6">
          <p className="text-xs text-ink-3">The question</p>
          <p className="mt-1.5 text-lg text-ink">{question}</p>
          <p className="mt-3 text-sm leading-relaxed text-ink-2">
            Resolves YES if one {symbol} share, valued from its vault at the close, rose more than SPY
            over the same week. The value is published as JSON at{" "}
            <code className="text-xs">/api/nav/{short(basket, 4, 4)}</code>, which is the market&apos;s
            first source of truth.
          </p>
          {c.quote?.draft && (
            <p className="mt-3 text-xs leading-relaxed text-ink-3">
              Runs {day(c.quote.draft.startTime)} to {day(c.quote.draft.endTime)} · category{" "}
              {c.quote.draft.category}
              {c.quote.categoryPreferred === false && " (the sandbox has no finance category; live, it files under finance)"}
              {" · "}
              <a href={c.quote.draft.imageUrl} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                market image
              </a>
            </p>
          )}
          {!c.quote && category && !category.preferred && mode === "sandbox" && (
            <p className="mt-3 text-xs text-ink-3">Filed under {category.category} in the sandbox; finance when live.</p>
          )}
        </div>

        <div className="border-b border-line p-6">
          <p className="mb-4 text-xs text-ink-3">Open it on Panta: quote, build, sign, register</p>
          <PantaSteps steps={createSteps} label="Opening the market" />
          {action("create", nextCreate, nextCreate ? createLabel[nextCreate] : "", advanceCreate)}
          {fail && fail.at.startsWith("create:") && <p className="mt-3 text-sm text-loss">{fail.msg}</p>}
        </div>

        {market ? (
          <div className="border-b border-line p-6">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <p className="text-xs text-ink-3">
                {standIn ? (
                  <>
                    Take a side · Panta&apos;s sandbox fixture market ({mono(short(market.marketId, 6, 4))}, &ldquo;
                    {market.title}&rdquo;) stands in for the {symbol} market
                  </>
                ) : (
                  <>Take a side · {market.title}</>
                )}
              </p>
              <p className="tnum text-xs text-ink-3">
                {Number(market.volumeUsdc).toFixed(2)} USDC traded
                {trades?.marketId === market.marketId && ` · ${trades.count} ${trades.count === 1 ? "trade" : "trades"} on its tape`}
              </p>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3" role="radiogroup" aria-label="Side">
              {(["yes", "no"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={side === s}
                  onClick={() => {
                    setSide(s);
                    setB({});
                  }}
                  className={`rounded-[var(--radius-control)] border px-4 py-3 text-left transition-colors ${
                    side === s ? "border-bind bg-bind-wash" : "border-line hover:border-line-strong"
                  }`}
                >
                  <span className="block text-sm text-ink">{s === "yes" ? "Yes, it beats SPY" : "No, it trails SPY"}</span>
                  <span className={`tnum mt-1 block text-2xl ${s === "yes" ? "text-gain" : "text-loss"}`}>
                    {cents(s === "yes" ? market.yesPrice : market.noPrice)}
                  </span>
                </button>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 rounded-[var(--radius-control)] border border-line px-3 py-2 text-sm">
                <span className="text-ink-3">$</span>
                <input
                  value={amount}
                  onChange={(e) => {
                    setAmount(e.target.value.replace(/[^0-9.]/g, ""));
                    setB({});
                  }}
                  inputMode="decimal"
                  className="tnum w-16 bg-transparent text-ink outline-none"
                  aria-label="Amount in USDC"
                />
              </label>
              <span className="text-xs text-ink-3">USDC, between 1 and 1,000</span>
            </div>
            <div className="mt-5">
              <PantaSteps steps={buySteps} label="Buying a side" />
            </div>
            {action("buy", nextBuy, nextBuy ? buyLabel[nextBuy] : "", advanceBuy)}
            {fail && fail.at.startsWith("buy:") && <p className="mt-3 text-sm text-loss">{fail.msg}</p>}
          </div>
        ) : (
          mode != null && (
            <p className="p-6 text-sm text-ink-3">
              No Panta market on {symbol} yet. Open it above and buying a side appears here.
            </p>
          )
        )}

        {market && (
          <div className="p-6">
            <p className="text-xs text-ink-3">Creator fees</p>
            <p className="mt-1.5 max-w-[60ch] text-sm leading-relaxed text-ink-2">
              Whoever opens a Panta market earns its creator fees once it graduates. For a basket&apos;s
              creator that is a third income beside Sheaf&apos;s creation fee and the launch pool&apos;s fees.
              {isCreator ? " This is your basket." : ` This basket's creator is ${short(creator, 4, 4)}.`}
              {mode === "sandbox" && !isCreator && " The sandbox lets any wallet try the build; live, Panta checks the wallet is the market's creator."}
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              {me ? (
                <button
                  type="button"
                  onClick={claimFees}
                  disabled={busy != null || live}
                  className="rounded-[var(--radius-control)] border border-line-strong px-4 py-2.5 text-sm text-ink transition-colors hover:border-ink-3 disabled:opacity-60"
                >
                  {busy === "fees" ? "Asking Panta…" : "Build the creator-fee claim"}
                </button>
              ) : (
                <ConnectButton />
              )}
              <code className="text-[11px] text-ink-3">POST /claim/creator-fees/build/</code>
            </div>
            {fees && (
              <p className="tnum mt-3 text-sm text-ink-2">
                Claimable {usdcBase(fees.claimableFeesUsdc)} USDC · {fees.instructions?.length ?? 0} instructions to sign
                <FixtureTag show={fees.fixture} />
              </p>
            )}
            {fail?.at === "fees" && <p className="mt-3 text-sm text-loss">{fail.msg}</p>}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-6 py-4 text-xs text-ink-3">
          <span>Markets, quotes and transactions by Panta. Question, rule and NAV by Sheaf.</span>
          <a href="https://panta.market" target="_blank" rel="noreferrer" className="text-ink underline underline-offset-4">
            Powered by Panta
          </a>
        </div>
      </div>
    </div>
  );
}
