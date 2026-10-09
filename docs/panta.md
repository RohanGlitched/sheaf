## Panta

Every Sheaf basket carries one prediction market, run on [Panta](https://panta.market): **"Will {basket} ({symbol}) beat SPY this week?"**

The market resolves from a number anyone can recompute: one share's value at two Friday US closes, against SPY's over the same two closes. Sheaf publishes that number as JSON at `/api/nav/<basket>?at=<close>` and names those two URLs as the market's first sources of truth. Every input is public, and the JSON lists a command to fetch each one. The only off-chain inputs are Jupiter's prices and the daily closes.

### The resolution rule, exactly

The rule is built in one place (`web/lib/panta-window.ts`) and used by the market draft, the NAV route and the pages, so they cannot disagree.

- **Window.** `startTime` is when trading opens: two hours out (Panta requires at least one). The measured week starts at the **first Friday US regular-session close (16:00 New York) at or after `startTime`**, and ends at the Friday close a week later, which is Panta's `endTime`. Nothing of the measured week is known when the first share is bought. A market opened on a Thursday waits for Friday's close; one opened on a Saturday waits six days. An earlier version ended at the first Friday at least a day out and measured from the Friday before, so a market opened midweek already knew most of its week; that is fixed. `resolutionTime` is two hours after the second close, once that close is final in Sheaf's history.
- **When to read.** Both `?at=` URLs are read at or after `resolutionTime`. The rule says so, because Yahoo re-adjusts past closes after an ex-dividend date. Read at the same time, both closes use the same adjustment. `?at=` answers are cached for an hour, not a day, for the same reason.
- **Which baskets.** Only baskets whose every holding has a listed close. A basket holding a pre-IPO company (FRNTR holds Anthropic, OpenAI, SpaceX and Anduril) has no `navPerShare.listed`, so no market is offered on it:
  - `/api/nav` answers `resolution: { offered: false, reason }`.
  - The basket page shows "No market on FRNTR" in place of the Panta flow.
  - `/predict` marks the row.
  - `POST /api/panta {kind: "create-quote"}` refuses with a 400.
- **Holidays.** If a Friday is a market holiday, the last close before it is used. The JSON reports the day actually used as `closeDay`.
- **Numbers.** YES if `navPerShare.listed` at the later close divided by `navPerShare.listed` at the earlier close is greater than `spy.adjClose` divided the same way. Both values come from `/api/nav/<basket>?at=<unix>`. NO otherwise, including a tie.
- **What `navPerShare.listed` means at a close.** The sum over components of `unitsPerShare / 10^decimals` x the listed share's adjusted close x the mint's multiplier today. Adjusted closes reinvest dividends, as the multiplier does, so the ratio between two closes is the share's total return. SPY's `adjClose` is on the same basis.

The rule as sent to Panta, for BIG5 opened on Oct 9, 2026:

> YES if BIG5's navPerShare.listed from https://sheaf-index.vercel.app/api/nav/FFGg…iEfJ?at=1792180800 divided by navPerShare.listed from …?at=1791576000 is greater than spy.adjClose divided the same way (the same two URLs). Those times are the US regular-session closes on Fri, Oct 9, 2026, 16:00 New York (2026-10-09T20:00:00Z) and Fri, Oct 16, 2026, 16:00 New York (2026-10-16T20:00:00Z); if either Friday is a market holiday, the last close before it is used, which the JSON states as closeDay. Both URLs are read at or after the resolution time, 2026-10-16T22:00:00Z, so both closes use the same data. NO otherwise, including a tie. Both values are recomputable from the inputs the JSON lists.

Trading on this market opened at 13:37 UTC that Friday, before the first close.

### `/api/nav/<basket>`

- **Without `at`:** the value right now, three ways: `recipe` (units x live Jupiter price x multiplier), `vault` (what the vault holds over shares outstanding) and `listed` (units x the listed share's last price x multiplier). The answer also carries `trailingWeek` (the last five closes against SPY; it was called `week`) and `resolution`, which gives the field names, the next window and the rule text.
- **With `at=<unix seconds>`:** `navPerShare.listed` and `spy.adjClose` at the last US close at or before `at`, with `closeDay`, the inputs per component, and the method. Some requests are refused rather than answered with today's number:
  - A time in the future, or before the one-year history, gets a 400.
  - A close in the last hour gets a 503 with `Retry-After`. History is cached for an hour, so it is not final yet.
  - A close not yet in the history also gets a 503.
  - If the mints' multipliers cannot be read from mainnet, the answer is a 503. It is never computed from Jupiter's copy of the multipliers.

  A basket holding a pre-IPO PreStock has no listed history, so it answers `listed: null` with the reason. Past closes are cached for an hour.
- **`recompute`** lists every input with a command to fetch it:
  - the share supply (`getTokenSupply`)
  - the basket account with the recipe (`getAccountInfo`)
  - every vault balance (`getMultipleAccounts`, jsonParsed)
  - every mainnet mint's multiplier (`getMultipleAccounts`, jsonParsed, `scaledUiAmountConfig`)
  - Jupiter's prices
  - Yahoo Finance's daily chart for each holding and SPY

  `sources` names the history source and its date.

"Powered by Panta", linked to panta.market, appears on every Panta module: the basket page panel (twice), `/predict`, and `/portfolio` once a wallet is connected.

`/predict` also works the rule once on the last full week, from the same two `?at=` reads a resolver makes ("Last week, resolved the way a market would be").

### Endpoint → product mapping

| Panta product | Endpoint | Where in Sheaf |
|---|---|---|
| Discovery | `GET /markets/`, `GET /categories/` | `/predict`, "Panta's catalog, as this key sees it" (read-only, labeled as the sandbox fixture under a `pk_test_` key); basket pages (`GET /api/panta`) |
| Data | `GET /markets/{id}/`, `GET /markets/{id}/trades/` | Position values on `/portfolio` (`GET /api/panta/positions`) |
| Creation: quote | `POST /markets/create/quote/` | Basket page, "Open it on Panta", step 1; `/predict` fee |
| Creation: build | `POST /markets/create/build/` | Step 2 |
| Creation: sign | the wallet's `signTransaction` (never sent) | Step 3 |
| Creation: register | `POST /markets/register/` | Step 4 |
| Trading: quote | `POST /primaryorderquote/` | Basket page, "Take a side", step 1 |
| Trading: build | `POST /primaryorderbuild/` | Step 2 |
| Trading: sign | the wallet's `signTransaction` (never sent) | Step 3 |
| Trading: submit | `POST /primaryordersubmit/` | Step 4 |
| Trading: verify | `POST /primaryorderverify/` | Step 5 |
| Attribution | `POST /trades/` | Step 6, and after a win claim |
| Positions | `GET /positions/?wallet=` | `/portfolio`, "Predictions" |
| Win claims | `POST /claim/build/`, then sign, then `POST /trades/` | `/portfolio`, "Predictions" |
| Creator fees | `POST /claim/creator-fees/build/` | Basket page, "Creator fees" |

Each step in the UI names the endpoint it calls and shows the fields Panta actually returned: `createId`, `expectedEventPda`, `orderId`, instruction count, blockhash and status.

The market Sheaf drafts includes:
- `category`: finance when Panta offers it (it does live); the sandbox lists none, so the sandbox falls back to crypto
- `sourcesOfTruth`: the NAV JSON at both closes (`?at=`), the basket page, and SPY's daily history on Yahoo Finance
- `startTime`, `endTime`, `resolutionTime`: from `marketWindow()`, as described above
- `imageUrl`: a 1024×1024 PNG at `/api/panta/image/<basket>`, the basket's sheaf drawing under its question

Code:
- `web/lib/panta-server.ts`: every Panta call; holds the key.
- `web/lib/panta-window.ts`: the Friday-close window and the rule text.
- `web/app/api/panta/route.ts`: one `kind` per step.
- `web/app/api/panta/positions/route.ts`
- `web/app/api/panta/image/[address]/route.tsx`
- `web/app/api/nav/[address]/route.ts`
- `web/lib/panta-throttle.ts`
- `web/lib/panta-sign.ts`: compiles transactions for the wallet.
- `web/lib/panta-client.ts`
- `web/components/basket-predict.tsx`
- `web/components/panta-steps.tsx`
- `web/components/panta-positions.tsx`
- `web/components/predict-index.tsx`
- `web/app/predict/page.tsx`

### Why sandbox

Opening a market on Panta costs about 50 USDC (`paymentUsdc: 50000000`) plus SOL, and Sheaf spends no real money. A `pk_test_` key runs the identical flow against Panta's sandbox: the same endpoints and request bodies, with fixed fixture answers and nothing on mainnet.

The UI tags every fixture value as "sandbox fixture" (Panta marks these answers with a `disclaimer` field). Three cases matter:
- **Buy quotes.** The sandbox answers every buy with the same fixed quote, "$1.00 buys 2.00 shares". The panel shows the amount you asked for next to Panta's answer and says the answer is fixed.
- **The market.** The sandbox has one fixture market, "Sandbox test market". It is labeled as standing in for the basket's market, never shown as if it were the basket's own.
- **Signing: a stand-in, never broadcast.** Sandbox builds return an empty transaction, no instructions, and a placeholder blockhash, so there is nothing of Panta's to sign. Sheaf compiles a memo-only stand-in on a fresh devnet blockhash and asks the wallet to sign that, and the panel says so. The signed stand-in is **never broadcast** to any cluster. The signature reported to Panta's sandbox afterwards (register, submit, `/trades/`) demonstrates the flow, not a trade. If a wallet declines, the sandbox flow can continue with a clearly labeled placeholder signature. `/predict` and the basket page say this in plain words.

`POST /api/panta` has two throttles: 20 requests a minute per IP, and per-kind caps below Panta's own account limits (24 quotes, 16 builds, 30 reports and 90 reads a minute). Identical create quotes are reused for 60 s. In the sandbox, a buy or claim must name a market in Panta's catalog.

### What changes for live

Only the key changes:

```bash
PANTA_API_KEY=pk_live_...   # was pk_test_...
```

With a live key:
- Discovery, data, positions and quotes read Panta's mainnet catalog.
- The draft files under finance.
- `lib/panta-server.ts` refuses every build, register, submit, verify, report and claim step with `403 SHEAF_SANDBOX_ONLY`. Sheaf stops at the quote, so a live deployment cannot move USDC by accident. Removing that guard is a deliberate code change.

For a real sponsored market, the steps already in place carry over unchanged:
- The wallet signs Panta's own transaction (base64 `VersionedTransaction` for create; an instruction list compiled to v0 for buy and claim), which the user broadcasts.
- Register and submit then receive the real signature, which Panta verifies on chain.

### Try it

```bash
curl -s https://sheaf-index.vercel.app/api/panta | jq '{mode, fixture, category}'
curl -s https://sheaf-index.vercel.app/api/nav/FFGgfTHbv9jAAHHv54aPQM7cdWZcr49m2APrjcPuiEfJ | jq '{question, navPerShare, trailingWeek, resolution}'
# The value at the Oct 8, 2026 close (any time after it and before the next close names the same day):
curl -s 'https://sheaf-index.vercel.app/api/nav/FFGgfTHbv9jAAHHv54aPQM7cdWZcr49m2APrjcPuiEfJ?at=1791489600' | jq '{closeDay, navPerShare, spy}'
# {"closeDay":"2026-10-08","navPerShare":{"listed":100.15053},"spy":{"token":"SPYx","closeDay":"2026-10-08","close":…,"adjClose":773.93}}
```
