// Smoke test for the browser RPC proxy: POSTs each method the app and the Meteora
// SDKs use to <base>/api/rpc and reports whether the proxy forwards it or refuses it.
//
//   node scripts/smoke-rpc.mjs [baseUrl]      (default http://localhost:3900)
//
// Plain fetch, no @solana/web3.js, so it runs under Windows node as well as WSL.

const base = (process.argv[2] ?? "http://localhost:3900").replace(/\/$/, "");
const SHEAF = "GaYNg5YZdNRa82Qn1383mvF1aEKhjVNmbsWg1UBNt8zz";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SYSTEM = "11111111111111111111111111111111";
const SIG = "1".repeat(64);

// [method, params, expected]
const CASES = [
  ["getAccountInfo", [SYSTEM, { encoding: "base64" }], "allowed"],
  ["getBalance", [SYSTEM], "allowed"],
  ["getBlockHeight", [], "allowed"],
  ["getBlockTime", [1], "allowed"],
  ["getEpochInfo", [], "allowed"],
  ["getFeeForMessage", ["AA==", {}], "allowed"],
  ["getGenesisHash", [], "allowed"],
  ["getHealth", [], "allowed"],
  ["getLatestBlockhash", [{ commitment: "confirmed" }], "allowed"],
  ["getMinimumBalanceForRentExemption", [165], "allowed"],
  ["getMultipleAccounts", [[SYSTEM], { encoding: "base64" }], "allowed"],
  ["getProgramAccounts", [SHEAF, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }], "allowed"],
  ["getRecentPrioritizationFees", [[]], "allowed"],
  ["getSignatureStatuses", [[SIG]], "allowed"],
  ["getSignaturesForAddress", [SHEAF, { limit: 1 }], "allowed"],
  ["getSlot", [], "allowed"],
  ["getTokenAccountBalance", [SYSTEM], "allowed"],
  ["getTokenAccountsByOwner", [SYSTEM, { programId: TOKEN_2022 }, { encoding: "jsonParsed" }], "allowed"],
  ["getTokenSupply", [SYSTEM], "allowed"],
  ["getTransaction", [SIG, { maxSupportedTransactionVersion: 0 }], "allowed"],
  ["getVersion", [], "allowed"],
  ["isBlockhashValid", [SYSTEM, {}], "allowed"],
  ["sendTransaction", ["AA==", { encoding: "base64" }], "allowed"],
  ["simulateTransaction", ["AA==", { encoding: "base64" }], "allowed"],
  // Must stay refused.
  ["requestAirdrop", [SYSTEM, 1], "refused"],
  ["getProgramAccounts", [TOKEN_2022, { encoding: "base64" }], "refused"],
  ["getBlock", [1], "refused"],
  ["getLargestAccounts", [], "refused"],
];

let failures = 0;
for (const [method, params, expected] of CASES) {
  let status = 0;
  let note = "";
  try {
    const res = await fetch(`${base}/api/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    status = res.status;
    const json = await res.json().catch(() => null);
    note = json?.error?.message ?? (json && "result" in json ? "result" : "");
  } catch (err) {
    note = `fetch failed: ${err.message}`;
  }
  // The proxy refuses with 403; anything else means it forwarded (the upstream may still reject bad params).
  const got = status === 403 ? "refused" : status === 429 ? "rate-limited" : status ? "allowed" : "error";
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${got.padEnd(12)} ${String(status).padEnd(4)} ${method.padEnd(36)} ${String(note).slice(0, 70)}`);
}
console.log(failures ? `\n${failures} unexpected result(s)` : "\nall as expected");
process.exit(failures ? 1 : 0);
