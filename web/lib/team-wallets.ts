/**
 * Every wallet that belongs to the people who built Sheaf, so the ledger can
 * say how much of its activity came from anyone else.
 *
 * Public keys only. Each one is either derived from a key file the team holds
 * (the house key, the deploy wallet, the Meteora lifecycle wallets, the EVM
 * deployer and QA throwaways) or is a fresh in-browser test wallet that our own
 * end-to-end and QA scripts generated (scripts/browser-test-wallet.js makes a
 * new keypair on every run and throws it away). Those last ones cannot be
 * derived from anything, so they are listed by hand: each one first acted
 * inside the minutes one of our scripts was running, placed the exact sequence
 * that script places, and its dollar orders were filled by the house filler.
 *
 * If a wallet here is ever wrongly listed, the effect is to undercount real
 * users, never to overcount them. Add new test wallets as runs create them.
 */

import { TEST_WALLETS } from "./test-wallets.generated";

export type TeamRole = "house" | "deploy" | "treasury" | "faucet" | "second filler" | "test";

export type TeamWallet = { address: string; role: TeamRole; label: string };

export const TEAM_WALLETS: TeamWallet[] = [
  // ---------------------------------------------------------------- Solana
  {
    address: "B8dLfY9rokrZwq7ae1CuVfi8deSoeywgJGiS3W2U9U1L",
    role: "house",
    label: "House key: faucet, keeper, house filler, creator of the seeded baskets",
  },
  {
    address: "7md5ecBazJtGoHEkRvQaVSdNz7pyJrbmrHgx1L5NVJb4",
    role: "deploy",
    label: "Deploy wallet: program upgrade authority, default filler key",
  },
  {
    address: "9uuYuCQsZEfjXomEGV7eH5ByDuYLry9oaf1263vPJnuF",
    role: "treasury",
    label: "Treasury: claims launch-market fees and protocol-fee shares",
  },
  {
    address: "EmvPkVx5fTJvmFvyTM4stJ69w9SfmgXHexaSLSu6RCNi",
    role: "faucet",
    label: "Faucet key: pays for test SOL and new token accounts",
  },
  {
    address: "92pGcdsAHGvW2PNezm3QmcaNubadHarYVrSCN1rj6W4T",
    role: "second filler",
    label: "Second filler (ours): runs the published reference filler with its own key and faucet-sourced stocks",
  },
  { address: "7gVxJVLpSZpuuPQ8uaJs7S98NRvj5hMs1h1S9Hr1Y4CT", role: "test", label: "Meteora lifecycle wallet 1" },
  { address: "8vQiyPfcXN9FzLojHdj4hanRvCqWJFxp6ZKXKGnWFvxP", role: "test", label: "Meteora lifecycle wallet 2" },
  { address: "249bT6U4NCEmkw2i3hzgJ8kSRsNWqatHYwJeWjGaY8um", role: "test", label: "Meteora lifecycle wallet 3" },
  // End-to-end runs of scripts/e2e-dollar.cjs and e2e-plan.cjs, 8 October.
  { address: "A7wRGMDT3DNdXtYMKqxk9ecFZJFh8UGVqikyrty5vG85", role: "test", label: "Test wallet, dollar-order run" },
  { address: "55ybxomvgUWWZSGAsyCRRSaBCqud252XBys4uscjKzee", role: "test", label: "Test wallet, dollar-order run" },
  { address: "2FHig65oD6znp82Saz4oVfG4n6DCGnMZArb9gDtV52XA", role: "test", label: "Test wallet, plan run" },
  { address: "3fsrb2h6Byjfc6vwb2h6FeAezxkHnD5Aa6pVdTxXJQYv", role: "test", label: "Test wallet, dollar-order run" },
  // QA rounds against the live site, 9 October.
  { address: "7QVtvLbbzwQ5V1sc43fCf9mUW1rdUAeMEpRXg5WL4gQ1", role: "test", label: "Test wallet, QA round 1" },
  { address: "6dXoQfKGVATpyMsryqvyP3Fjb4AX3LNjgmsLHitzWhdR", role: "test", label: "Test wallet, QA round 1 (created QAENU6)" },
  { address: "5RVx5vixvQEnZzuyTiPnRdbQQ7RfmtxnXtFc3SanQVNh", role: "test", label: "Test wallet, dollar-order run" },
  { address: "34rtG9DyEjNFbFPV3La4bTA1EdEZSY3CYJ5GBAw6H2Q9", role: "test", label: "Test wallet, dollar-order run" },
  { address: "62TkyrtDt6xrTCMbZz8ZpPm3QdLdFukMzd8aNgzCd7tM", role: "test", label: "Test wallet, plan run" },
  { address: "GGe5rqTbKQ6RUXVqgmPdmSMZkFTBu83Ercfmb5a9G1Sd", role: "test", label: "Test wallet, QA round 2" },
  { address: "wNfb2abuRv5ky6z3APRDYBhDEWrJ3iRHStSNcnejfa7", role: "test", label: "Test wallet, QA round 2 (created QA3KRA)" },
  { address: "cQKhoauPParjVawD5zTGFqtGLhi3FHp8g8Qn8H1PtcA", role: "test", label: "Test wallet, QA round 2 (funded by the house faucet, bought BIG5A)" },
  // UI tests of plans and dollar orders, 9 October.
  { address: "G6qHDvZq6KsMQkzTXnB5LhUJZDDhY3PS7RZDNwLHx19", role: "test", label: "Test wallet, UI test" },
  { address: "42pje9iqjHDd9et1mXvEmetTfnDAX3dbspJApCRLAmyB", role: "test", label: "Test wallet, UI test" },
  { address: "95maX5rkFb5WTajSpY8qG8YkZeunh1GYjjPz9yPmjafE", role: "test", label: "Test wallet, UI test" },
  { address: "2Tm8S4u5rqi8g68Upd37McDuS4MMLz8HpWB9Maiohqfy", role: "test", label: "Test wallet, UI test" },
  { address: "3imDKr2iKamYFygTVPmdq9V6QMXHHSz69iEV6PrSNZ9w", role: "test", label: "Test wallet, UI test" },
  { address: "7XEGELR2W8Yivk3bNPkHkfozP3HAAR2R6c1zgU35q5F8", role: "test", label: "Test wallet, UI test" },
  { address: "GaaTVK8doUGxqDawVayKJvtvKz5uD5xCShNrnS8CcCJG", role: "test", label: "Test wallet, UI test" },

  // Judge round 3 QA against the live site, 9 October (.judge/qa3/wallets.txt).
  { address: "HSHma7qF67f6qD3GP4sAnHoqM53fFi91qSTvZRg34LDd", role: "test", label: "Test wallet, QA round 3 (created QAZG1N)" },
  { address: "Fo41veTfXL8dqU4ixLeVcQ3D8yvxFx2XhzGhgCvHNMeb", role: "test", label: "Test wallet, QA round 3" },
  { address: "8rLCuBxm5Fa3Z13WkxtuuUmYj3zxP9m3sRzwbdGczzNg", role: "test", label: "Test wallet, QA round 3 (created QAWSC1)" },
  { address: "8Sz2tn75aqKSNLuVcgN58Z5XSmCXKk9DjZ1rSwnfE3QK", role: "test", label: "Test wallet, QA round 3" },
  { address: "3k6be2LEt7L5XC1sDaYe1YQmYuJFTcF4jQujkjjaJEkX", role: "test", label: "Test wallet, QA round 3" },
  // Judge round 4 QA against the live site, 9 October (.judge/qa4/wallets.txt).
  { address: "PZ9NCefBteZ7SDFPBbQvFhexSRyXCGbdUjX4HcGYLt2", role: "test", label: "Test wallet, QA round 4" },
  { address: "AWwhyVghzrA2MZfkqvWjpMFqwEajV5Uqj8Az6ks77mnm", role: "test", label: "Test wallet, QA round 4 (created QA4LC8)" },
  { address: "QLEkagmL82EiYNvesRAXzD9X1TsB93gKUwznayTSMoy", role: "test", label: "Test wallet, QA round 4" },

  // ------------------------------------------------------------------- EVM
  {
    address: "0x59d3E1239708a1CDD6Ef876688B3cd69d4aB0285",
    role: "house",
    label: "EVM deployer and house filler on all five testnets",
  },
  { address: "0xF948aE3A26341324196ae18381f5B8d01fA79874", role: "test", label: "EVM test wallet, QA round 2" },
  { address: "0x2FD70697FDbC7a9788fbc36a631CDd06834BF38e", role: "test", label: "EVM test wallet, chain walkthroughs" },
  { address: "0x7B854D62B06ac29C32b56ee36a12f5e823262248", role: "test", label: "EVM test wallet, QA round 3 (Arbitrum Sepolia)" },
  // Tempo plan accounts from the "Run it in this browser" SIP, each made in a test run.
  { address: "0xEae83b650726a9bfb600FFF74c3AeD54a54805b8", role: "test", label: "Tempo test plan account, QA round 3" },
  { address: "0xDF9e887bbA6A569845D0cD1ddA91461Bb60321e1", role: "test", label: "Tempo test plan account, QA round 2" },
  { address: "0x71975d3923B467963c675e981641722e92675239", role: "test", label: "Tempo test plan account, chain walkthrough" },
  { address: "0xD93a68464edFA30C929AB9eF71016f01a91BcCaF", role: "test", label: "EVM test wallet, QA round 4 (Arbitrum Sepolia)" },
  { address: "0x1deDD65C95287DAfc128e4Bc752Ab3bE2d250005", role: "test", label: "Tempo test plan account, QA round 4" },
  // Placed seconds after our own Tempo SIP test runs, with the same amount and nonce; counted as ours rather than as outside buyers.
  { address: "0xcDb524B789146A872f4D019e7B2145ef2e2B9ec0", role: "test", label: "Tempo test plan account, chain walkthrough (by timing)" },
  { address: "0x3F3219F8F577772a90367a864153AD1f3BAb180b", role: "test", label: "Tempo test plan account, chain walkthrough (by timing)" },
];

/** Base58 is case-sensitive; only hex EVM addresses are folded to one case. */
const norm = (address: string) => (address.startsWith("0x") ? address.toLowerCase() : address);

const BY_ADDRESS = new Map(TEAM_WALLETS.map((w) => [norm(w.address), w]));
// The 100 fixed-seed wallets every test script now signs with (lib/test-wallets.generated.ts),
// so a test run can never count as an outside user even if nobody lists it here.
TEST_WALLETS.forEach((address, i) => {
  if (!BY_ADDRESS.has(norm(address))) BY_ADDRESS.set(norm(address), { address, role: "test", label: `Fixed test wallet #${i}` });
});

/** How many wallets are ours: the listed ones plus the fixed-seed test set. */
export const TEAM_WALLET_COUNT = BY_ADDRESS.size;

/** The team wallet at this address, if it is one. EVM addresses match in any case. */
export function teamWallet(address: string): TeamWallet | undefined {
  return BY_ADDRESS.get(norm(address));
}

export function isTeamWallet(address: string): boolean {
  return BY_ADDRESS.has(norm(address));
}

/** The short tag a ledger row shows beside a team wallet. */
export function teamTag(address: string): string | null {
  const w = teamWallet(address);
  if (!w) return null;
  return w.role === "test" ? "test wallet" : w.role;
}

/** The tag a ledger row shows ("house", "deploy", "treasury", "faucet", "second filler" or "test wallet"), or null if the wallet is not ours. */
export const teamLabel = teamTag;
