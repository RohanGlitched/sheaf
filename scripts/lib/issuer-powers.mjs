/**
 * The issuer powers every real xStock and PreStock carries, for mirror mints
 * that should match mainnet extension for extension.
 *
 * On mainnet each of these is held by the stock's issuer (Backed for xStocks,
 * PreStocks for PreStocks). A mirror gives every one of them to the stand-in
 * issuer key, which the Sheaf program accepts outside a `mainnet` build
 * (KNOWN_ISSUERS in programs/sheaf/src/lib.rs). Under any other key the
 * program refuses the mint as a basket component.
 *
 *   PermanentDelegate              delegate = issuer
 *   PausableConfig                 authority = issuer, not paused
 *   ConfidentialTransferMint       authority = issuer, no auto-approve, no auditor
 *   ConfidentialTransferFeeConfig  authority = issuer (PreStocks only)
 *   TransferHook                   authority = issuer, no program
 *   DefaultAccountState            initialized (needs a freeze authority)
 *   freeze authority               issuer
 *
 * Used by scripts/setup-mirror.mjs and scripts/setup-mirror-prestocks.mjs
 * behind --issuer-powers.
 */
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  AccountState,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  createInitializeDefaultAccountStateInstruction,
  createInitializePausableConfigInstruction,
  createInitializePermanentDelegateInstruction,
  createInitializeTransferHookInstruction,
  getMintLen,
} from "@solana/spl-token";

/** The write cluster's stand-in issuer, as listed in KNOWN_ISSUERS. */
export const STAND_IN_ISSUER = new PublicKey("B8dLfY9rokrZwq7ae1CuVfi8deSoeywgJGiS3W2U9U1L");

/** Extension types @solana/spl-token can size. */
export const ISSUER_EXTENSION_TYPES = [
  ExtensionType.PermanentDelegate,
  ExtensionType.PausableConfig,
  ExtensionType.ConfidentialTransferMint,
  ExtensionType.TransferHook,
  ExtensionType.DefaultAccountState,
];

// ConfidentialTransferFeeConfig (type 16) is not in this spl-token's enum:
// a 4-byte TLV header plus { authority, withdraw-withheld ElGamal key,
// harvest flag, withheld ciphertext } = 129 bytes.
const CT_FEE_CONFIG_TLV = 4 + 129;

/** Exact mint size for `types` plus the issuer powers. */
export function issuerMintLen(types, { confidentialFee = false } = {}) {
  return getMintLen([...types, ...ISSUER_EXTENSION_TYPES]) + (confidentialFee ? CT_FEE_CONFIG_TLV : 0);
}

function confidentialTransferMint(mint, authority) {
  // ConfidentialTransferExtension (27) / InitializeMint (0):
  // authority (OptionalNonZeroPubkey), auto_approve (bool), auditor (OptionalNonZeroElGamalPubkey).
  const data = Buffer.alloc(2 + 32 + 1 + 32);
  data[0] = 27;
  data[1] = 0;
  authority.toBuffer().copy(data, 2);
  return new TransactionInstruction({
    programId: TOKEN_2022_PROGRAM_ID,
    keys: [{ pubkey: mint, isSigner: false, isWritable: true }],
    data,
  });
}

function confidentialTransferFeeConfig(mint, authority) {
  // ConfidentialTransferFeeExtension (37) / InitializeConfidentialTransferFeeConfig (0):
  // authority (OptionalNonZeroPubkey), withdraw-withheld ElGamal pubkey (32 bytes).
  const data = Buffer.alloc(2 + 32 + 32);
  data[0] = 37;
  data[1] = 0;
  authority.toBuffer().copy(data, 2);
  return new TransactionInstruction({
    programId: TOKEN_2022_PROGRAM_ID,
    keys: [{ pubkey: mint, isSigner: false, isWritable: true }],
    data,
  });
}

/**
 * Initialise-extension instructions, to go after the account is created and
 * before InitializeMint2 (whose freeze authority must then be `issuer`).
 * `confidentialFee` needs a TransferFeeConfig initialised as well.
 */
export function issuerPowerInstructions(mint, issuer, { confidentialFee = false } = {}) {
  const ixs = [
    createInitializePermanentDelegateInstruction(mint, issuer, TOKEN_2022_PROGRAM_ID),
    createInitializePausableConfigInstruction(mint, issuer, TOKEN_2022_PROGRAM_ID),
    confidentialTransferMint(mint, issuer),
    createInitializeTransferHookInstruction(mint, issuer, PublicKey.default, TOKEN_2022_PROGRAM_ID),
    createInitializeDefaultAccountStateInstruction(mint, AccountState.Initialized, TOKEN_2022_PROGRAM_ID),
  ];
  if (confidentialFee) ixs.push(confidentialTransferFeeConfig(mint, issuer));
  return ixs;
}
