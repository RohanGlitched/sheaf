import type { Metadata } from "next";
import { ChainsBoard } from "@/components/chains-board";
import { DEPLOYED } from "@/lib/chains";

export const metadata: Metadata = {
  title: "Chains",
  description: "Sheaf on every chain where stocks are tokenized: Solana, Robinhood Chain, Tempo, Arbitrum, Ethereum, Base and Hyperliquid.",
};

export default function ChainsPage() {
  return (
    <div className="mx-auto max-w-[1400px] px-5 pb-24 sm:px-8">
      <section className="max-w-[46rem] pt-16 pb-12">
        <h1 className="display text-hero text-ink">Everywhere stocks are tokenized.</h1>
        <p className="mt-6 max-w-[56ch] text-lg leading-relaxed text-ink-2">
          Tokenized stocks are spreading across chains: xStocks on Solana and Ethereum, Robinhood&apos;s
          tokens on Arbitrum and Robinhood Chain, stock perpetuals on Hyperliquid. Sheaf writes the same
          rules natively on each one. A recipe that can never change, a vault nobody can drain, shares
          created and redeemed in kind, and a desk that turns dollars into shares.
        </p>
        <p className="mt-4 text-sm text-ink-3">
          {DEPLOYED.length + 1} chains live. Every figure on this page is read from the chain it describes
          when you open it.
        </p>
      </section>
      <ChainsBoard />
    </div>
  );
}
