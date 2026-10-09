/**
 * The India waitlist's three questions, shared by the form and the API so the
 * server accepts exactly the answers the page offers and nothing else.
 */

export const MONTHLY_BANDS = [
  { key: "under-1k", label: "Under ₹1,000" },
  { key: "1k-5k", label: "₹1,000 to ₹5,000" },
  { key: "5k-25k", label: "₹5,000 to ₹25,000" },
  { key: "25k-1l", label: "₹25,000 to ₹1 lakh" },
  { key: "over-1l", label: "Over ₹1 lakh" },
] as const;

export const US_ROUTES = [
  { key: "none", label: "I don't, yet" },
  { key: "intl-fund", label: "An Indian international fund or FoF" },
  { key: "us-app", label: "A US-stocks app (Vested, INDmoney and the like)" },
  { key: "gift-city", label: "Through GIFT City" },
  { key: "crypto", label: "Tokenized stocks on a crypto exchange" },
  { key: "other", label: "Some other way" },
] as const;

/**
 * Where people live decides whether Sheaf could serve them first: residents of India wait on FEMA and tax
 * treatment; xStocks are not offered in the US, UK, Canada or Australia; Indians living elsewhere are the
 * clearer first users.
 */
export const HOMES = [
  { key: "india", label: "In India" },
  { key: "nri", label: "Abroad as an NRI, e.g. in the Gulf" },
  { key: "nri-closed", label: "In the US, UK, Canada or Australia" },
  { key: "elsewhere", label: "Somewhere else" },
] as const;

export type MonthlyBand = (typeof MONTHLY_BANDS)[number]["key"];
export type UsRoute = (typeof US_ROUTES)[number]["key"];
export type Home = (typeof HOMES)[number]["key"];

/** Longest contact we keep: an email address or a Telegram handle, nothing more. */
export const CONTACT_MAX = 80;

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,100}\.[a-z]{2,24}$/i;
const TELEGRAM = /^@?[a-z0-9_]{5,32}$/i;

/** A clean contact, or "" when none was given, or null when what was given is neither an email nor a handle. */
export function cleanContact(raw: unknown): string | null {
  if (raw == null) return "";
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v) return "";
  if (v.length > CONTACT_MAX) return null;
  if (EMAIL.test(v)) return v.toLowerCase();
  // Telegram handles ignore case, so one person's handle always reads the same.
  if (TELEGRAM.test(v)) return (v.startsWith("@") ? v : `@${v}`).toLowerCase();
  return null;
}

export const isBand = (v: unknown): v is MonthlyBand => MONTHLY_BANDS.some((b) => b.key === v);
export const isRoute = (v: unknown): v is UsRoute => US_ROUTES.some((r) => r.key === v);
export const isHome = (v: unknown): v is Home => HOMES.some((h) => h.key === v);

/** What GET /api/waitlist answers: counts only, never an entry. */
export type WaitlistCounts = { count: number; withContact: number; byHome: Record<Home, number> };
