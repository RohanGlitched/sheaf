#!/usr/bin/env bash
#
# Move the write cluster from a local validator to devnet, in one run.
#
# Everything the app reads for prices already comes from mainnet and is untouched
# by this. What moves is settlement: the program, the mirror mints that stand in
# for the xStocks, and the handful of baskets worth looking at.
#
#   ./scripts/go-devnet.sh
#
# The only prerequisite this cannot do for itself is SOL. Deploying a 280 KB
# program plus 20 Token-2022 mints needs roughly 3 SOL on the deploy wallet, and
# the devnet faucet rate-limits by IP, so if the balance check below fails, get
# SOL into the printed address from https://faucet.solana.com and run this again.

set -euo pipefail
cd "$(dirname "$0")/.."

RPC="${DEVNET_RPC:-https://api.devnet.solana.com}"
WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
NEEDED_SOL=3

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

step "Checking the deploy wallet"
ADDRESS=$(solana address --keypair "$WALLET")
BALANCE=$(solana --url "$RPC" balance "$ADDRESS" | awk '{print $1}')
echo "$ADDRESS has $BALANCE SOL on devnet"

if (( $(echo "$BALANCE < $NEEDED_SOL" | bc -l) )); then
  echo
  echo "Not enough SOL. Deploying needs about $NEEDED_SOL."
  echo "Trying the faucet once, then giving up so this does not spin:"
  solana --url "$RPC" airdrop 2 "$ADDRESS" || true
  BALANCE=$(solana --url "$RPC" balance "$ADDRESS" | awk '{print $1}')
  if (( $(echo "$BALANCE < $NEEDED_SOL" | bc -l) )); then
    echo
    echo "Still $BALANCE SOL. Fund $ADDRESS at https://faucet.solana.com and rerun." >&2
    exit 1
  fi
fi

step "Building and deploying the program to devnet"
anchor build
anchor deploy --provider.cluster "$RPC" --provider.wallet "$WALLET"
PROGRAM_ID=$(solana address -k target/deploy/sheaf-keypair.json)
echo "Program $PROGRAM_ID"

step "Creating the mirror mints and regenerating web/lib/mirror.generated.ts"
# Reads each real mint's current ScaledUiAmountConfig multiplier off mainnet, so
# a mirror of a dividend-paying stock starts where the real one stands.
node scripts/setup-mirror.mjs --url devnet

step "Seeding a few baskets"
# Before the faucet split, because seeding mints component tokens to itself and
# needs the mint authority this wallet still holds for one more step.
node scripts/seed-baskets.mjs --url "$RPC" --keypair "$WALLET"

step "Giving the faucet its own key"
# Last, and deliberately so. Until now the deploy wallet has been the mint
# authority, which is fine on a laptop and not fine in a hosting dashboard: that
# wallet also holds the program's upgrade authority. This hands the mints to a key
# that controls nothing else, and writes it into web/.env.local.
node scripts/split-faucet-key.mjs --url "$RPC" --keypair "$WALLET"

step "Done. Point the app at devnet"
cat <<EOF

web/.env.local now holds the faucet key. Set the other three:

  NEXT_PUBLIC_WRITE_CLUSTER=devnet
  NEXT_PUBLIC_WRITE_RPC=$RPC
  NEXT_PUBLIC_SHEAF_PROGRAM_ID=$PROGRAM_ID

Then rebuild:  cd web && pnpm build && pnpm start

To re-seed baskets after this point, pass the faucet key instead of the deploy
wallet, because the deploy wallet is no longer a mint authority:

  node scripts/seed-baskets.mjs --url $RPC --keypair .faucet-key.json
EOF
