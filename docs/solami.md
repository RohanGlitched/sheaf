## Solami

Sheaf reads Solana mainnet through [Solami](https://solami.dev).

**Every basket's value and every Panta resolution read their dividend multipliers through Solami.** Each xStock's dividends live in its Token-2022 `ScaledUiAmount` multiplier, on the mint itself. Sheaf reads all 28 mints in one `getMultipleAccounts` through Solami (`/api/market` `chain: {slot, via}`, and `/api/nav/<basket>` `sources.multipliers`, which names the slot and the RPC). That number:
- sets the value of every basket on every page
- prices `navPerShare.listed` at the two closes a Panta market resolves from

If the read fails, `/api/nav?at=` answers 503 rather than use Jupiter's copy. `/api/market` then reports the reason as `chainError`.

The second thing Solami supplies is the live tape of tokenized-stock trades, on its own page at **[/live](https://sheaf-index.vercel.app/live)**. That page shows the tape full width, with the Solami figures open, and is the page to watch (or record) it on.

### What Sheaf uses, exactly

Sheaf uses one Solami product: the **RPC** (`https://rpc.solami.dev/solana?api-key=…`), on the free tier. It does not use WebSocket, gRPC, Webhooks or the Data API; the next section says why, and what it would take.

| Route | Solami RPC methods | Cadence | What it is for |
|---|---|---|---|
| `GET /api/tape` | `getSlot`, `getSignaturesForAddress` (2 mints per poll, rotating through 10), `getTransaction` (up to 3 that just landed plus up to 2 from the backfill queue per poll, `maxSupportedTransactionVersion: 1`), `getBlockTime` (at most 1 per poll) | One poll at most every 3 s per server instance, plus 2 s of CDN cache | The home page tape: who bought or sold which stock token, at what fill price, through which venue |
| `GET /api/tape` (first poll of an instance) | `getSignaturesForAddress` with `limit: 20` on all 10 mints, then the newest 4 decoded | Once per cold instance | The backfill, so a new instance is not empty |
| `GET /api/tape` (comparison) | `getSlot` sent to Solami and the public RPC at the same instant, 1 warm-up pair plus 3 measured pairs; `getTransaction` on both for the newest signature, if it landed in the last ~30 s | Once a minute | The "What Solami does for this tape" figures under the tape |
| `GET /api/market` | `getMultipleAccounts` over all 28 mints, in one call | Each 10 s of CDN cache | Each mint's Token-2022 `ScaledUiAmount` multiplier and supply. These value every basket. |
| `GET /api/nav/<basket>` | The same `getMultipleAccounts` read (cached 15 s) | On request, 30 s CDN cache | The JSON NAV that a basket's Panta market resolves from |

Code:
- `web/lib/solami.ts`: the client, with pacing, 429 handling, the fallback and the comparison.
- `web/lib/tape-server.ts` and `web/app/api/tape/route.ts`: the tape.
- `web/lib/mainnet.ts`: the mint multipliers. A failed read is logged, puts Solami on its cool-down, and is kept as `lastMintReadFailure()`, which `/api/market` reports as `chainError`. It is never swallowed.
- `web/components/live-tape.tsx`: the tape, on the home page and on `/live` (`web/app/live/page.tsx`).
- `web/lib/tape-store.ts` and `web/app/api/tape/seed/route.ts`: the rolling earlier-trades seed in GCS.
- `scripts/tape-seed.mjs` and `web/public/tape.seed.json`: the committed fallback seed.

### Solami beyond plain RPC, and why the tape does not use it yet

Researched Oct 9, 2026, from `solami.dev/llms.txt`, the live pricing API (`GET https://api.solami.dev/pricing`, no auth) and the API reference at `solami.dev/docs`:

| Product | What it would do for the tape | Free tier | Status in Sheaf |
|---|---|---|---|
| Yellowstone gRPC streams | Push every transaction on the 10 xStock mints the moment it lands, with no polling | `grpc_streams: 0`, `grpc_access: false` (Pro plan and up; a 2-day trial) | Not used. A serverless function also cannot hold a stream open. |
| WebSocket | `logsSubscribe` on the mints | `ws_connections: 0` | Not used |
| Webhooks (`POST /webhooks/create`) | Stream subscriptions delivered to a URL, "filters included, down to individual trades" | `max_webhooks: 1` in the pricing API, but 0 in the site's own plan table | Not used. Creating one needs a signed-in dashboard session (`AccountContext` bearer), not the API key. |
| Data API ("Blur data"): `GET /data/token/trades?chain=solana&address=<mint>` | Decoded trades per mint, with `dex`, `side`, `trader`, `price_usd` and `volume_usd`. That would replace Sheaf's balance-diff decoder and cover all 10 mints in 10 calls. | Billed per GB from a prepaid balance (`payg.blur`); the key needs the `DataApi` permission | Tested with Sheaf's key: **403 "missing required permission: DataApi"**. |

So on the free tier, with no money spent, the only Solami product available to Sheaf is the RPC. The tape therefore makes its case on sustained throughput: thousands of paced reads an hour on one key, with no read dropped after one retry. The public endpoint documents 40 calls per method per 10 s per IP, shared with every app on that IP.

If the owner enables it, the Data API is the one-change upgrade. In the Solami dashboard, grant the key's role the `DataApi` permission (and fund the minimum prepaid balance if Solami requires it for "Blur data"). The backfill can then read `/data/token/trades` per mint instead of `getSignaturesForAddress` plus `getTransaction`. A webhook on the 10 mints into a small receiver route would make the tape push-based. That needs a dashboard session to create it, and storage (the GCS bucket already used for the seed) to hand events to whichever instance answers the page.

### What the tape decodes

From each transaction's pre and post token balances, Sheaf works out three things:
- **The pool**: the account that gave up or took in the most stock, and was paid the opposite way in USDC, USDT or SOL.
- **The side**: from the fee payer's change. A payer that ended flat in both the stock and dollars is labeled `Arb`.
- **The fill price**: the pool's quote leg divided by the stock leg.

The page then:
- multiplies the raw amount by the mint's dividend multiplier, so the price is per UI token
- sets the fill against Jupiter's price **from the moment the trade was read** (`refPrice`, fetched at `refAt`), never today's price. The percentage is shown only when that price is within two minutes of the trade's block time; otherwise the row says "no price then". Seed rows carry the price from their capture.
- shows the dollar value from the decoded quote leg. When the quote leg was not decoded (`usd: null`), the value is estimated from Jupiter's price and marked `≈`. With no price at all, the row shows the token amount in place of a dollar figure, never a bare "—".
- tags the venue from the program ids in the transaction (Jupiter, Meteora, Raydium, Orca and others), on its own line under the trade

Rows are filtered out in these cases:
- worth less than $1, or under 0.0001 tokens (dust)
- not a trade: stock moved but no pool was paid the other way and no swap program ran (a wallet-to-wallet transfer, a mint, a vault deposit)
- a fill more than 15% away from Jupiter's price, which is treated as a mis-decode of a multi-leg route; the trade is still listed, without a price

The tape is a sample: the newest trades on two of ten mints per poll, not every fill.

### Cold starts: backfill and seed

A new serverless instance starts with nothing in memory. Four things keep the tape from sitting empty or hanging:

- **Backfill.** An instance's first poll reads the last 20 signatures on every watched mint (ten paced calls) and decodes the newest four. The rest wait in a queue (at most 80), and while the tape has fewer than 30 rows each later poll decodes one or two of them alongside the new trades. `backlog` in the response says how many are still queued. Backfilled rows are real chain reads with real block times, but they carry `live: false`.
- **First rows in about three seconds.** The backfill reads the two busiest mints (SPY, NVDA) first and decodes their newest two trades straight away. Those rows go into the tape at once, with times placed by slot distance until the block time is read. The whole backfill is about fifteen paced calls, roughly ten seconds at 667 ms. The first caller waits at most four. If it is not done by then, the caller gets a tape marked `warming: true` (not cached by the CDN) that already holds those first rows. The page shows them, its header says "Reading mainnet through Solami" rather than "Connecting", and it asks again in 2.5 s while the rest finishes in `after()`. The keeper's scheduled GET of `/api/tape` every minute keeps an instance warm, and with it the rolling seed.
- **Rolling seed in storage.** A warm instance whose tape has at least 20 live rows writes its newest 40 rows to the project's private GCS bucket (`tape/seed.json`, keyless through Vercel OIDC and workload identity federation, `web/lib/tape-store.ts`), at most every 10 minutes, from `after()`. The page asks `GET /api/tape/seed` first, so on a cold load the earlier trades are as recent as the last busy stretch, not the last deploy. With GCS unset or nothing written yet, that route answers 204 and the page falls back to the committed file below.
- **Committed seed (last fallback).** `web/public/tape.seed.json` holds 40 real trades captured earlier by `scripts/tape-seed.mjs`. The script polls a running Sheaf server's `/api/tape?depth=60` (the same decoder and filters) and stores each row's Jupiter price and dividend multiplier from its own moment. The page shows these rows at once, under an "Earlier trades, not live" divider with the capture time, until eight rows have come from the server. Seed rows show their real block times, are never highlighted, and never feed the figures.

  ```bash
  node scripts/tape-seed.mjs                                 # against http://localhost:3900
  node scripts/tape-seed.mjs https://sheaf-index.vercel.app 40   # against production
  ```

  Run it during US market hours (09:30 to 16:00 New York, which is 19:00 to 01:30 IST in winter and an hour earlier in summer), then redeploy. The script warns if markets are closed. `TAPE_SEED_OUT=<path>` writes somewhere else, for a dry run.

A row is `live: true` only when it landed after the server last read its mint. Only those rows, with a block time from the chain, count toward "block to this screen".

### Serverless: `after()`

`/api/tape` answers from the cached tape when it is 3 to 30 s old and starts the next poll behind the response. The route hands that poll to Next's `after()` (from `next/server`), so on Vercel the function stays alive until the poll finishes. A bare un-awaited promise would be frozen as soon as the response was sent, and the cache would never refresh. A tape older than 30 s is polled while the caller waits.

Times come from the block. Solami answers `blockTime: 0` at `confirmed` commitment, so Sheaf makes one `getBlockTime` call on the newest fresh slot and places nearby slots by slot distance (about 0.4 s a slot). Placed times show with a `~`. The tape never shows "now" for an unknown time.

### Setup and your own key

1. Sign up at [solami.dev](https://solami.dev). The free tier needs no card.
2. Copy the API key into `web/.env.local`:

   ```bash
   SOLAMI_API_KEY=your-key   # server-side only; never sent to the browser
   # Optional: the endpoint used when Solami is unset or failing
   # NEXT_PUBLIC_MAINNET_RPC=https://api.mainnet-beta.solana.com
   ```
3. Start the app with `pnpm dev` in `web/`, then open `/`, or call `/api/tape`.

Without a key, everything still works through the public mainnet RPC, and the page says "read through a public RPC".

### Staying inside the free tier (5 requests a second)

A burst past the limit answers `429` with `Retry-After: 1`. The free tier is 5 requests a second **per key**, and every warm server instance shares that one key.

- **Paced calls: 667 ms apart.** Every Solami call goes through one queue per server instance in `lib/solami.ts`, 667 ms apart: 1.5 a second, so three warm instances together (4.5 a second) stay under five. It was 240 ms (about 4.2 a second) until production showed Vercel keeping three or more instances warm at once; together they drew 429s on 7 of 67 calls on one instance. At 500 ms it was about 1 in 100, and three instances at 2 a second is 6, over the key's 5. Pacing is per instance, not global: a token bucket shared through storage would cost more round trips than the calls it guards, so the rate is set for the instance count observed. A fourth warm instance could still push the key past 5 for a moment, and the one patient retry absorbs that. A tape poll sends its calls one after another, never in parallel. The `/api/market` read uses the same queue through a paced `fetch` handed to `@solana/web3.js`.
- **A smaller comparison.** The once-a-minute comparison is 3 measured pairs plus a warm-up, down from 5. Its calls are counted inside the comparison, not in the tape's totals.
- **Shared caching.**
  - A poll answers every visitor for 3 s.
  - A tape up to 30 s old answers at once while the next poll runs behind it, in `after()`.
  - `/api/tape` sends `cache-control: public, s-maxage=2, stale-while-revalidate=10`, so the CDN coalesces every open tab into at most one request every couple of seconds.
- **429 handling.** A 429 waits out its `Retry-After` (capped at 2 s) and retries once. If it fails again, Solami goes on an 8 s cool-down, and the public RPC answers in the meantime.
- **Honest `via`.** `via` names the RPC that actually answered the poll. When the public RPC stood in for Solami, `fallback` gives the reason, and the page prints it. If the whole poll fails, the last good tape is returned with `stale: true`.
- **No wasted retries.** An error about one request (for example, an unsupported transaction version) is not treated as an outage. That signature is skipped, and Solami is not put on cool-down.

Limit, stated plainly: each route bundle on Vercel can hold its own copy of the pacing queue, so the tape, `/api/market` and `/api/nav` pace independently. The spacing leaves room for that, but it is not a global rate limiter.

On the client, `live-tape.tsx` merges new prints into what is already on screen and keeps a rolling 40. A poll answered by a cold serverless instance cannot thin the list, and a failed poll leaves the last good tape in place.

### Proof that the answers come from Solami

```bash
curl -s https://sheaf-index.vercel.app/api/tape | jq '{slot, via, fallback, stale, backlog, proof}'
```

A real answer from a local dev server on Oct 9, 2026:

```json
{
  "slot": 454832491,
  "via": "solami",
  "backlog": 78,
  "proof": {
    "instance": "wvl7le",
    "since": 1791539805965,
    "rpcMs": 159,
    "compare": {
      "slot": {
        "method": "getSlot", "commitment": "confirmed", "samples": 3,
        "solami": { "medianMs": 151, "slot": 454832518, "answered": 3, "rateLimited": 0 },
        "public": { "medianMs": 88, "slot": 454832516, "answered": 3, "rateLimited": 0 },
        "slotLead": 1,
        "at": 1791539827940
      },
      "freshTx": { "tried": 1, "solami": 1, "public": 1 },
      "upstreams": {
        "solami": { "calls": 22, "ok": 21, "rateLimited": 1, "failed": 0 },
        "public": { "calls": 0, "ok": 0, "rateLimited": 0, "failed": 0 },
        "reads": { "wanted": 21, "solami": 21 }
      }
    },
    "calls": 15,
    "pollMs": 7336
  }
}
```

- `via` is `"solami"` only when Solami answered that poll's reads. It reports the answer, not the presence of a key.
- `proof.instance` and `proof.since` name the server instance and when it started. Counters are per instance. The page keeps the latest answer from each instance and sums them, so a young instance's small totals never replace an older one's.
- `proof.rpcMs` is that poll's `getSlot` round trip. It is null on an instance's first call, which includes the TLS handshake.
- `proof.compare.upstreams` counts the tape's and the market read's own calls: raw 429s, and `reads`, how many reads Solami answered after its one retry. The comparison's calls are not in it.
- Each print carries `live` (landed after the server last read its mint), and `refPrice` and `refAt` (Jupiter's price when it was read).

### What the comparison shows, and what production said

The comparison sits in a disclosure under the trades ("What Solami does for this tape, against the public RPC"). It leads with sustained throughput, then what the tape depends on:
- **Mainnet reads Solami served**, summed across the instances that answered, over the time they cover, with the public endpoint's documented limit beside it (40 calls per method per 10 s per IP, shared with every app on that IP).
- **Chain tip, same instant.** `slotLead`: the median of Solami's slot minus the public RPC's, within pairs sent together.
- **Just-landed transactions served.** `freshTx`: when the newest signature a poll read landed in the last ~30 s, both upstreams are asked for it at once, and this counts how often each returned it rather than null. The signature comes from Solami's own `getSignaturesForAddress`, which favours Solami. Read it as "can the public RPC already serve what just landed", not as a neutral race.
- **Block to this screen.** The median, over the last 15 live trades, of the time from the trade's block to the row reaching the browser. It includes the mint rotation (each mint is read every fifth poll), so it is the end-to-end figure, not the RPC's latency.

Raw round trip is measured the same careful way: same call, same instant, warm sockets, median. It is kept in the JSON and stated in a sentence under the cells, but it is not a headline cell, because **Solami does not win it from where Sheaf runs**. On Vercel (US East), the public RPC answered `getSlot` in a 13 to 15 ms median against Solami's 81 ms. From the dev machine it was 64 to 88 ms against 151 to 174 ms. That is geography: the public endpoint sits next to the server. Solami was one slot ahead in every run we saw. Just-landed transactions were a tie (2 of 2 each in production).

The earlier claim in this doc, that Solami "rate-limited none of 100+ calls", held on one dev instance at 240 ms pacing. It did not hold in production, where several warm instances share the key: 7 of 67 calls on one instance answered 429 (the retry recovered them). That is what the slower spacing (now 667 ms) addresses. What the public RPC cannot offer is the budget. Solana documents it as not meant for production apps, at 100 requests per 10 s per IP and 40 for any single method, shared with everyone on the same IP.

```bash
curl -s https://sheaf-index.vercel.app/api/market | jq .chain
# {"slot":454781334,"via":"solami"}
```

Each row on the tape links to Solscan (the time on phones, the wallet on wider screens), so any trade can be checked against the chain.

### Limits, stated plainly

- Free tier only: polling plus caching, with no WebSocket or gRPC. The site runs live on the free tier, without the Pro trial.
- The tape samples the newest trades on 10 mints; it does not capture every fill.
- Fill prices are decoded from balance changes. Multi-leg routes can mis-decode, and those rows show no price.
- On raw latency from US East, the public RPC is faster than Solami.
