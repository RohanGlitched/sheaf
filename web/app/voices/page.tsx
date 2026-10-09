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
    "Every name here signed with the wallet that used Sheaf, so you can check it. Our own wallets are counted apart, never listed.",
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

export default async function Page() {
  return <VoicesPage initial={await initial()} />;
}
