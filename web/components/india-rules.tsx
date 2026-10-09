/**
 * The rules an Indian resident would meet, stated plainly and each linked, so a
 * reader can check every line rather than take the page's word for it.
 * Sources were read on 9 October 2026.
 */

type Source = { label: string; href: string };
type Rule = { name: string; body: string; sources: Source[] };

const RULES: Rule[] = [
  {
    name: "LRS limit",
    body: "A resident may send up to $2,50,000 abroad each financial year under the Liberalised Remittance Scheme. That one limit covers everything together: travel, study, gifts and buying foreign shares.",
    sources: [{ label: "RBI, LRS FAQ", href: "https://www.rbi.org.in/Scripts/FAQView.aspx?Id=115" }],
  },
  {
    name: "TCS on remittances",
    body: "Your bank collects 20% tax at source on investment remittances above ₹10 lakh in a financial year. It isn't a separate tax: you can set it against your income tax when you file your return, or claim it back.",
    sources: [{ label: "Tickertape, updated 18 Aug 2026", href: "https://www.tickertape.in/blog/tcs-on-foreign-remittance/" }],
  },
  {
    name: "Crypto tax",
    body: "Crypto tokens are taxed as virtual digital assets: a flat 30% on gains, losses can't be set off, and 1% TDS on each transfer. Budget 2026 kept all of it. Tokenized stocks are reported to fall under the same rules.",
    sources: [
      { label: "Decrypt, Budget 2026", href: "https://decrypt.co/356601/no-relief-for-crypto-investors-as-india-retains-current-crypto-tax-in-budget-2026" },
      { label: "LetsDataScience, Jun 2026", href: "https://letsdatascience.com/news/indians-purchase-tokenised-us-stocks-anytime-60f9faad" },
    ],
  },
  {
    name: "FEMA",
    body: "Whether a resident may buy a tokenized US stock under FEMA, and whether it counts against LRS, is not settled. Until it is, Sheaf won't offer this to residents.",
    sources: [{ label: "LetsDataScience, Jun 2026", href: "https://letsdatascience.com/news/indians-purchase-tokenised-us-stocks-anytime-60f9faad" }],
  },
  {
    name: "NRIs",
    body: "LRS is a scheme for residents. Non-resident Indians invest under the rules of the country they live in, so they are the clearer first group, through a regulated partner that already does KYC.",
    sources: [{ label: "RBI, LRS FAQ", href: "https://www.rbi.org.in/Scripts/FAQView.aspx?Id=115" }],
  },
];

export function IndiaRules() {
  return (
    <section aria-labelledby="india-rules" className="min-w-0">
      <h2 id="india-rules" className="display text-title max-w-[18ch] text-ink">
        Rules for Indian residents
      </h2>
      <p className="mt-4 max-w-[52ch] text-sm leading-relaxed text-ink-2">
        What applies today if you live in India and want US stocks. Each line links to where it comes from.
      </p>
      <dl className="mt-8 divide-y divide-line border-y border-line">
        {RULES.map((r) => (
          <div key={r.name} className="grid gap-2 py-5 sm:grid-cols-[9.5rem_minmax(0,1fr)] sm:gap-6">
            <dt className="text-sm font-medium text-ink">{r.name}</dt>
            <dd className="min-w-0">
              <p className="text-sm leading-relaxed text-ink-2">{r.body}</p>
              <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                {r.sources.map((s) => (
                  <a key={s.href + s.label} href={s.href} target="_blank" rel="noreferrer" className="text-ink-3 underline decoration-line-strong underline-offset-4 hover:text-ink-2">
                    {s.label}
                  </a>
                ))}
              </p>
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-6 rounded-[var(--radius-panel)] bg-vault p-5 text-vault-ink sm:p-6">
        <p className="text-sm font-medium">What Sheaf is today</p>
        <p className="mt-2 max-w-[60ch] text-sm leading-relaxed opacity-85">
          A working demo on Solana devnet that runs on test dollars. No real money moves, and Sheaf is not available as an
          investment product yet. Nothing on this page is an offer or advice.
        </p>
      </div>
    </section>
  );
}
