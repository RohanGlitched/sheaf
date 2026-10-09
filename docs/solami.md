## Solami

Sheaf reads Solana mainnet through [Solami](https://solami.dev). Solami supplies two things: a live tape of tokenized-stock trades, and every xStock's Token-2022 dividend multiplier, which sets basket NAV.

### What Sheaf uses, exactly

Sheaf uses one Solami product: the **RPC** (`https://rpc.solami.dev/solana?api-key=…`), on the free tier. It does not use WebSocket, gRPC, Webhooks or the Data API.

| Route | Solami RPC methods | Cadence | What it is for |
|---|---|---|---|
| `GET /api/tape` | `getSlot`, `getSignaturesForAddress` (2 mints per poll, rotating through 10), `getTransaction` (up to 3 unseen per poll, `maxSupportedTransactionVersion: 1`), `getBlockTime` (at most 1 per poll) | One poll at most every 3 s per server instance, plus 2 s of CDN cache | The home page tape: who bought or sold which stock token, at what fill price, through which venue |
| `GET /api/tape` (proof strip) | `getSlot` once against Solami and once against the public RPC, back to back | Every 30 s | The "Solami vs public" round-trip figure shown on the page |
| `GET /api/market` | `getMultipleAccounts` over all 28 mints, in one call | Each 10 s of CDN cache | Each mint's Token-2022 `ScaledUiAmount` multiplier and supply. These value every basket. |
| `GET /api/nav/<basket>` | The same `getMultipleAccounts` read (cached 15 s) | On request, 30 s CDN cache | The JSON NAV that a basket's Panta market resolves from |

Code:
- `web/lib/solami.ts`: the client, with pacing, 429 handling and the fallback.
- `web/lib/tape-server.ts` and `web/app/api/tape/route.ts`: the tape.
- `web/lib/mainnet.ts`: the mint multipliers.
- `web/components/live-tape.tsx`: the page.

### What the tape decodes

From each transaction's pre and post token balances, Sheaf works out three things:
- **The pool**: the account that gave up or took in the most stock, and was paid the opposite way in USDC, USDT or SOL.
- **The side**: from the fee payer's change. A payer that ended flat in both the stock and dollars is labelled `Arb`.
- **The fill price**: the pool's quote leg divided by the stock leg.

The page then:
- multiplies the raw amount by the mint's dividend multiplier, so the price is per UI token
- shows the fill against Jupiter's price for the same token
- tags the venue from the program ids in the transaction (Jupiter, Meteora, Raydium, Orca and others)

Rows are filtered out in these cases:
- worth less than $1, or under 0.0001 tokens (dust)
- a fill more than 15% away from Jupiter's price, which is treated as a mis-decode of a multi-leg route; the trade is still listed, without a price

The tape is a sample: the newest trades on two of ten mints per poll, not every fill.

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

A burst past the limit answers `429` with `Retry-After: 1`. The free tier is 5 requests a second, and Sheaf stays under it in five ways:

- **Paced calls.** Every Solami call goes through one queue per server instance in `lib/solami.ts`, at least 240 ms apart (about 4.2 a second). A tape poll sends its calls one after another, never in parallel. The `/api/market` read uses the same queue through a paced `fetch` handed to `@solana/web3.js`, so it shares the budget with the tape.
- **Shared caching.**
  - A poll answers every visitor for 3 s.
  - A tape up to 30 s old answers at once while the next poll runs behind it.
  - `/api/tape` sends `cache-control: public, s-maxage=2, stale-while-revalidate=10`, so the CDN coalesces every open tab into at most one request every couple of seconds.
- **429 handling.** A 429 waits out its `Retry-After` (capped at 2 s) and retries once. If it fails again, Solami goes on an 8 s cool-down, and the public RPC answers in the meantime.
- **Honest `via`.** `via` names the RPC that actually answered the poll. When the public RPC stood in for Solami, `fallback` gives the reason, and the page prints it. A `getSlot` failure no longer turns the response into a 502: the poll carries on, and if the whole poll fails, the last good tape is returned with `stale: true`.
- **No wasted retries.** An error about one request (for example, an unsupported transaction version) is not treated as an outage. That signature is skipped, and Solami is not put on cool-down.

On the client, `live-tape.tsx` merges new prints into what is already on screen and keeps a rolling 40. A poll answered by a cold serverless instance cannot thin the list, and a failed poll leaves the last good tape in place.

### Proof that the answers come from Solami

```bash
curl -s https://sheaf-index.vercel.app/api/tape | jq '{slot, via, fallback, stale, proof}'
```

```json
{
  "slot": 454781294,
  "via": "solami",
  "fallback": null,
  "stale": false,
  "proof": {
    "rpcMs": 183,
    "race": { "solamiMs": 169, "publicMs": 238, "at": 1791526024313 },
    "calls": 7,
    "pollMs": 1630
  }
}
```

- `via` is `"solami"` only when Solami answered that poll's reads. It reports the answer, not the presence of a key.
- `proof.rpcMs` is that poll's `getSlot` round trip.
- `proof.race` is the latest side-by-side `getSlot`, Solami against the public RPC.

The home page shows these figures under the tape, along with how long the newest print took to reach the screen after its block.

```bash
curl -s https://sheaf-index.vercel.app/api/market | jq .chain
# {"slot":454781334,"via":"solami"}
```

Each row on the tape links to Solscan, so any trade can be checked against the chain.

### Limits, stated plainly

- Free tier only: polling plus caching, with no WebSocket or gRPC. The site runs live on the free tier, without the Pro trial.
- The tape samples the newest trades on 10 mints; it does not capture every fill.
- Fill prices are decoded from balance changes. Multi-leg routes can mis-decode, and those rows show no price.
