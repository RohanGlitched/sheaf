import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { WRITE_CLUSTER, WRITE_RPC } from "@/lib/config";
import { clientIp } from "@/lib/faucet-server";
import { faucetHasOwnKey, faucetPayerKeypair } from "@/lib/server-keys";

/**
 * Enough devnet SOL for a first visit: shares in kind, a dollar order, a plan
 * and a sale, most of it rent. A full run that also opens a launch market costs
 * about 0.04 SOL and may need a second source (faucet.solana.com). Only for
 * wallets that are nearly empty, so it covers a first visit rather than funding
 * anyone's testing, and small, so the key that funds the faucet lasts.
 */
const GRANT = 0.03 * LAMPORTS_PER_SOL;
const ONLY_BELOW = 0.01 * LAMPORTS_PER_SOL;
/**
 * What the paying key keeps back. The faucet has its own key (FAUCET_KEY), which
 * only needs enough left for the token faucet's account rent. Without one it
 * pays from the house key, which must also keep the keeper's plan rent (0.5 SOL)
 * and the token faucet's floor (1.5 SOL), so it keeps 2 SOL.
 */
const RESERVE_OWN_KEY = 0.5 * LAMPORTS_PER_SOL;
const RESERVE_HOUSE = 2 * LAMPORTS_PER_SOL;

const IP_WINDOW_MS = 24 * 60 * 60_000;
const IP_MAX_GRANTS = 3;
const grantsByIp = new Map<string, number[]>();
const granted = new Set<string>();

export async function POST(request: Request) {
  if (WRITE_CLUSTER !== "devnet") {
    return Response.json({ error: "Test SOL is only handed out on devnet." }, { status: 400 });
  }
  const keypair = faucetPayerKeypair();
  const RESERVE = faucetHasOwnKey() ? RESERVE_OWN_KEY : RESERVE_HOUSE;
  if (!keypair) {
    return Response.json({ error: "The faucet is not configured on this deployment." }, { status: 503 });
  }

  let owner: PublicKey;
  try {
    const body = (await request.json()) as { owner?: string };
    owner = new PublicKey(body.owner ?? "");
  } catch {
    return Response.json({ error: "That does not look like a Solana address." }, { status: 400 });
  }
  if (!PublicKey.isOnCurve(owner.toBytes())) {
    return Response.json({ error: "That address can't receive test SOL: it is not a wallet." }, { status: 400 });
  }
  const wallet = owner.toBase58();
  if (granted.has(wallet)) {
    return Response.json({ error: "This wallet has already had its test SOL." }, { status: 429 });
  }

  const ip = clientIp(request);
  const now = Date.now();
  const recent = (grantsByIp.get(ip) ?? []).filter((t) => now - t < IP_WINDOW_MS);
  if (recent.length >= IP_MAX_GRANTS) {
    return Response.json(
      { error: "This network has had its test SOL for today. faucet.solana.com has more." },
      { status: 429 },
    );
  }
  // Claim the slot before the first await, so parallel requests cannot all pass
  // the checks above; give it back if nothing is sent.
  granted.add(wallet);
  grantsByIp.set(ip, [...recent, now]);
  const release = () => {
    granted.delete(wallet);
    const list = grantsByIp.get(ip) ?? [];
    const at = list.lastIndexOf(now);
    if (at >= 0) list.splice(at, 1);
  };

  const connection = new Connection(WRITE_RPC, "confirmed");
  let balance: number;
  let reserve: number;
  let account: Awaited<ReturnType<Connection["getAccountInfo"]>>;
  try {
    [account, reserve] = await Promise.all([connection.getAccountInfo(owner), connection.getBalance(keypair.publicKey)]);
    balance = account?.lamports ?? 0;
  } catch {
    release();
    return Response.json({ error: "The faucet could not reach the cluster. Try again in a moment." }, { status: 502 });
  }
  // A wallet is a system account (or not yet an account at all); a program or a data account is not.
  if (account && (account.executable || !account.owner.equals(SystemProgram.programId))) {
    release();
    return Response.json({ error: "That address can't receive test SOL: it is not a wallet." }, { status: 400 });
  }
  if (balance >= ONLY_BELOW) {
    release();
    return Response.json({ error: "This wallet already has enough SOL to try Sheaf." }, { status: 400 });
  }
  if (reserve - GRANT < RESERVE) {
    release();
    return Response.json(
      { error: "Out of test SOL right now: faucet.solana.com hands out devnet SOL, and this faucet is topped up regularly.", empty: true },
      { status: 503 },
    );
  }

  try {
    const signature = await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: owner, lamports: GRANT }),
      ),
      [keypair],
      { commitment: "confirmed" },
    );
    return Response.json({ signature, sol: GRANT / LAMPORTS_PER_SOL });
  } catch {
    release();
    return Response.json({ error: "The transfer failed. Try again in a moment." }, { status: 502 });
  }
}
