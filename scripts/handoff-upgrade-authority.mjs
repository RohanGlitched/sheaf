/**
 * Hand the devnet program's upgrade authority to a Squads multisig vault, and
 * print the commands that make the deployed bytes independently verifiable.
 *
 * Prepared for the end of the hackathon, after the final upgrade. NOT run yet.
 * It is a one-way door for the single deploy key: afterwards every upgrade
 * needs the multisig's approval.
 *
 *   node scripts/handoff-upgrade-authority.mjs --vault <SQUADS_VAULT_PUBKEY>          # dry run: prints what it would do
 *   node scripts/handoff-upgrade-authority.mjs --vault <SQUADS_VAULT_PUBKEY> --yes    # does it
 *
 * Create the multisig first at https://devnet.squads.so (free on devnet):
 * members = the team's keys, threshold 2 of 3 (or 1 of 2 for a two-person
 * team). Squads shows the vault address (index 0); that vault, not the
 * multisig account, becomes the upgrade authority.
 *
 * Verifiable build (run before the handoff, from a clean checkout of the
 * tagged commit; needs Docker and `cargo install solana-verify`):
 *
 *   solana-verify build --library-name sheaf -- --features devnet
 *   solana-verify get-executable-hash target/deploy/sheaf.so
 *   # deploy that exact binary (the verifiable build differs from a local
 *   # `anchor build`), then anyone can check it:
 *   solana-verify get-program-hash -u devnet GaYNg5YZdNRa82Qn1383mvF1aEKhjVNmbsWg1UBNt8zz
 *   solana-verify verify-from-repo -u devnet --program-id GaYNg5YZdNRa82Qn1383mvF1aEKhjVNmbsWg1UBNt8zz \
 *     https://github.com/RohanGlitched/sheaf --commit-hash <TAG_COMMIT> --library-name sheaf -- --features devnet
 *
 * Then set `source_release` in the security.txt block (programs/sheaf/src/lib.rs)
 * to that tag, and publish the hash in docs/program.md.
 *
 * Run in WSL; uses the Solana CLI, the default keypair (the current upgrade
 * authority, 7md5ec...) and devnet only.
 */
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const PROGRAM_ID = "GaYNg5YZdNRa82Qn1383mvF1aEKhjVNmbsWg1UBNt8zz";
const AUTHORITY = path.join(os.homedir(), ".config/solana/id.json");
const args = process.argv.slice(2);
const at = args.indexOf("--vault");
const vault = at > -1 ? args[at + 1] : null;
const yes = args.includes("--yes");

if (!vault || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(vault)) {
  console.error("Pass --vault <the Squads vault address>.");
  process.exit(1);
}

const solana = (...a) => execFileSync("solana", a, { encoding: "utf8" }).trim();

console.log(solana("program", "show", PROGRAM_ID, "-u", "devnet"));
const current = solana("address", "-k", AUTHORITY);
console.log(`\ncurrent upgrade authority (signer): ${current}`);
console.log(`new upgrade authority (Squads vault): ${vault}`);

const command = [
  "program",
  "set-upgrade-authority",
  PROGRAM_ID,
  "--new-upgrade-authority",
  vault,
  // The vault is a PDA and cannot sign; Squads executes upgrades through it.
  "--skip-new-upgrade-authority-signer-check",
  "--upgrade-authority",
  AUTHORITY,
  "-u",
  "devnet",
];
console.log(`\nsolana ${command.join(" ")}`);
if (!yes) {
  console.log("\nDry run. Re-run with --yes to hand over the upgrade authority.");
  process.exit(0);
}
console.log(solana(...command));
console.log(solana("program", "show", PROGRAM_ID, "-u", "devnet"));
