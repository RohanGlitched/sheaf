import type { Metadata } from "next";
import { headers } from "next/headers";
import { VoicesPage } from "@/components/voices-page";
import { oidcFrom } from "@/lib/voices-gcs";
import { voicesAnswer, voicesConfigured } from "@/lib/voices-store";
import type { VoicesAnswer } from "@/lib/voices-message";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "People who tried Sheaf",
  description:
    "Every name here signed with the wallet that used Sheaf, on Solana or an EVM testnet, so you can check it.",
};

/** The list is rendered on the server, so the names are there without JavaScript; the page refreshes it after that. */
async function initial(): Promise<VoicesAnswer> {
  const closed: VoicesAnswer = { open: false, voices: [], waiting: 0, ours: 0, refs: [], asOf: Date.now() };
  if (!voicesConfigured()) return closed;
  try {
    oidcFrom(await headers());
    return await voicesAnswer();
  } catch {
    return { ...closed, open: true, message: "Couldn't read the list just now." };
  }
}

export default async function Page({ searchParams }: PageProps<"/voices">) {
  // The invite-link builder is for whoever recruits testers, so it sits behind ?invite=1.
  const showInvite = (await searchParams).invite === "1";
  return <VoicesPage initial={await initial()} showInvite={showInvite} />;
}
