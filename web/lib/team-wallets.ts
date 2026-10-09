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
  { address: "CeK35721WxGSqa4xtFCbvYTDeZSXc4z8kMbbWBptiWkF", role: "test", label: "Test wallet, browser-wallet walkthrough" },
  { address: "BHE1pAqcktV7fJj28JiMuNYmP7gZpfWzpuQiRCCaj4BA", role: "test", label: "Test wallet, browser-wallet walkthrough (phone)" },
  { address: "0x7E6D86c73db00B53876EafED066Da6ef5D500C43", role: "test", label: "Test wallet, QA round 5" },
  { address: "0x9FA1b452e6c05FED9d401a1F4e0b4FBF70c2382c", role: "test", label: "Test wallet, QA round 5" },
  { address: "252C5uwd5LJLynxbW5DgSPEekhCd2AQt1E9ZU9RtMuwT", role: "test", label: "Test wallet, QA round 5" },
  { address: "3sKceTPJBPbULGzoZcHcr4nxpyPSed9nhHRGgSkVNY7L", role: "test", label: "Test wallet, QA round 5" },
  { address: "4MyzmwzRye4UcnA9NE7WNhdbqs3L7mKEyxBok8ekZ8Qe", role: "test", label: "Test wallet, QA round 5" },
  { address: "4ak7wxstFFCgMUCdbVs2ZJ3jbW7zurwEzCJRPHAY4Ts3", role: "test", label: "Test wallet, QA round 5" },
  { address: "6HY4kKrhHiXhTL78YgHiyw1gCxwf5S8mW7Kz8tWBcvAx", role: "test", label: "Test wallet, QA round 5" },
  { address: "AbDvTG4qB64sHNfC7nChkEGbJjZPhg6XzPLpZ37kH2W", role: "test", label: "Test wallet, QA round 5" },
  { address: "BXUG1WyeuH9vuiFXjTVC5wAds8nYH3ixBmEfwia3dD5F", role: "test", label: "Test wallet, QA round 5" },
  { address: "DFjLxot2mbSyQZwsckY2ZDG3Gb2PrSYZgXM7UdDM2ihp", role: "test", label: "Test wallet, QA round 5" },
  { address: "Dc1f667zv8CEZH1LtqwDcqFDB63gDjF7kf4PdpqDx8hp", role: "test", label: "Test wallet, QA round 5" },
  { address: "Drm5j996Wc9P46CQSxQ1jmaDA6qXzNVr3BTL5PMN2nuC", role: "test", label: "Test wallet, QA round 5" },
  { address: "E1ar22JHqWbUpjJ88Ksb2FJ61iXpJo8vtkHFerzWzHqN", role: "test", label: "Test wallet, QA round 5" },
  { address: "Ep5kyiNSTMz65KHzt4Jem5fZcZXPZGLcCobKATPzrirA", role: "test", label: "Test wallet, QA round 5" },
  { address: "GAPz2cFNVWfTD8NYdyWF8DJeW338H2jbHYJ643Hx1FyH", role: "test", label: "Test wallet, QA round 5" },
  { address: "0x4eA5e49138b663806B3D5D5c9263fa49191D9114", role: "test", label: "Test wallet, QA round 5" },
  { address: "0x8e625b09B7d7Ebd06D8CEfDff05F0e9C37BE40f3", role: "test", label: "Test wallet, QA round 5" },
  { address: "0x9a59582F547F2DE126C775785Ff1d2936BFA750e", role: "test", label: "Test wallet, QA round 5" },
  { address: "GPC7qwjvNhwzeenP1BA4u2nbwZsAEPduznkj1SKCuCgr", role: "test", label: "Test wallet, QA round 5" },
  { address: "0xdae7Ec6a4e41EBBAa29C6eB926fb3E013E536429", role: "test", label: "Tempo test plan account, v3 walkthrough" },
  { address: "0x1AFe2b2af89D238797523387722cea2c8A8123b4", role: "test", label: "Test wallet, QA round 6 / video recording" },
  { address: "0x325a59BdD656AD90C69E518BDe66C62A13473dbD", role: "test", label: "Test wallet, QA round 6 / video recording" },
  { address: "0x47dd2c7bC8A10F84Ec6812f6A7Bb810E2949E48F", role: "test", label: "Test wallet, QA round 6 / video recording" },
  { address: "0xFAc3a514619F49D66D6bEEC49c532a9e3954270D", role: "test", label: "Test wallet, QA round 6 / video recording" },
  { address: "0xb9e8C78C7e1Cf992f72F369DF454789E426620C8", role: "test", label: "Test wallet, QA round 6 / video recording" },
  { address: "0xfcc4C982eEa7FAeE9842a27486cB3B0866Fc03F3", role: "test", label: "Test wallet, QA round 6 / video recording" },
  { address: "3JG7bDNRDCk6kQK481wdS1snLKw5AeffqD5ThVp1sm5u", role: "test", label: "Test wallet, QA round 6 / video recording" },
  { address: "415bTbwo1CvdhWoMaivSiEZmEscGd8r9gwZdVfPjfTiR", role: "test", label: "Test wallet, QA round 6 / video recording" },
  { address: "6CkXQP8g5NN6CfYTgzfAMPBbHiqdhAajMKABwRbcPHYJ", role: "test", label: "Test wallet, QA round 6 / video recording" },
  { address: "6YtTBBjxXrmfRNvnVFC4RwJBMs7EdZwXVTMXBdiB477Y", role: "test", label: "Test wallet, QA round 6 / video recording" },
  { address: "6iFxzbicouunn6ZWdPNaC9nMD2ZJbfmpju87SmGekARJ", role: "test", label: "Test wallet, QA round 6 / video recording" },
  { address: "6pkSsUMc2rd75tbEo2mSPGn1TwRMtDbQEWMHsgfBux2W", role: "test", label: "Test wallet, QA round 6 / video recording" },
  { address: "9jQ6FT7ge93r52qyq8TAmCXGcVKyh1Mp1wericpu2j29", role: "test", label: "Test wallet, QA round 6 / video recording" },
  { address: "AkzCMmFUVTYHLJBCVfU4CcDnfNB41sSBnjHUvzLNWLur", role: "test", label: "Test wallet, QA round 6 / video recording" },
  { address: "BmY9mwRNNGYk4M5DR3GDzBMAQdpL3AfT2Ta9WihzSS4Q", role: "test", label: "Test wallet, QA round 6 / video recording" },
  { address: "CWF686MU2evSiq92pA5ifQPoZ4xMppEjw5Tdba9oZELa", role: "test", label: "Test wallet, QA round 6 / video recording" },
  { address: "CY1dSgNaQNvEDFsXEEY6EDk9S3CcjkPFW1VFPiuubW2Q", role: "test", label: "Test wallet, QA round 6 / video recording" },
  { address: "ChtTKnsXibGSEqRMaAfAUviRxKxGNpumSu4GAbDXeJk7", role: "test", label: "Test wallet, QA round 6 / video recording" },
  { address: "CqgoqMGLSGfdYPDpKmWa9U9EcD2TMYYzDL189BMFgg6m", role: "test", label: "Test wallet, QA round 6 / video recording" },
  { address: "D1gLrdoL1QMpEmpMSt2Ux2mYHVAe2BBEt6dbxzD9JXii", role: "test", label: "Test wallet, QA round 6 / video recording" },
  { address: "DviEARiBA48UnEY8Zf18b2oTKbYT8TxBqj7KXMCByQz2", role: "test", label: "Test wallet, QA round 6 / video recording" },
  { address: "DxUgV4ZoQAqPviE2yf3c4tZ7TFXuqtrZ3iyP2HDqUzea", role: "test", label: "Test wallet, QA round 6 / video recording" },
  { address: "ESCv8gaACkhkbQGM46biTgwfL5Q9FEvSrfu5qtd875is", role: "test", label: "Test wallet, QA round 6 / video recording" },
  { address: "FN11rCyTwsQbqHUjjKfsve57i1qttDBYaf9673dSuYCJ", role: "test", label: "Test wallet, QA round 6 / video recording" },
  { address: "FXEu6Kcq3k32YoUdRZSsJS24zEghqiSjEsGU8DcYNbzF", role: "test", label: "Test wallet, QA round 6 / video recording" },
  { address: "GeRnJqCUjP6j2a2hNta6pCKkBuvL2wiPLdLTXdC3KNq3", role: "test", label: "Test wallet, QA round 6 / video recording" },
  { address: "GpYQw7zX3JuhDQiMebGToqdUVuK8SZYnQArvwLUWATLz", role: "test", label: "Test wallet, QA round 6 / video recording" },
  { address: "GvRxmajustuKKQfdiArFsijZNk8mgugAWA6WJWX8LHgc", role: "test", label: "Test wallet, QA round 6 / video recording" },
  { address: "Gxa3YFM6Cpd5JvaGUx65J7jt3tP3DBZDgYVn4CF11fCW", role: "test", label: "Test wallet, QA round 6 / video recording" },
  { address: "X1WAuW2e44anzyqDhpyqvwWM5jiAxVuo7qML2LmkzxK", role: "test", label: "Test wallet, QA round 6 / video recording" },
  { address: "0xEcb68aa1ec3749173B49F84eCA45659DF4E67355", role: "treasury", label: "EVM v3 treasury (cold key)" },
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
  { address: "0x9Ca9Ec96A31aCC698DE51E516D2B55A7092E4647", role: "test", label: "EVM test wallet, v2 walkthrough (Arbitrum Sepolia)" },
  { address: "0xB60df24c5A8D3eaF12f3b0a5D26147074820d8c1", role: "test", label: "Tempo test plan account, v2 walkthrough" },
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
