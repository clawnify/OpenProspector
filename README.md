<img src="readme-banner.png" alt="OpenProspector preview" width="100%" />

# OpenProspector: The Open-Source Clay Alternative for Lead Enrichment

[![Deploy with Clawnify](https://app.clawnify.com/deploy-button.svg)](https://app.clawnify.com/deploy?repo=clawnify/OpenProspector)

Find B2B leads and enrich them with **your own provider keys** — at vendor cost, with no per-lead markup. An open-source app template provided by [Clawnify.com](https://clawnify.com).

Built with **React + Tailwind** on a **Hono API** and a **SQLite** database. Path-based routing, UUID keys, a dark mode that follows the OS, and a full OpenAPI surface so agents can drive it.

## What Is It?

Lead-enrichment SaaS resells contact data. Clay, Apollo, and the newer AI prospecting tools buy credits wholesale from a handful of data vendors and charge you a marked-up per-lead price on top — typically **$0.10–$0.15 per lead**.

OpenProspector inverts that. You bring your own vendor keys, you pay the vendor directly, and the app does the part that actually carries the value: **orchestrating the waterfall**. Try the cheapest provider first, validate the result, fall through to the next one only if it missed, never buy the same person twice.

The savings are not theoretical:

| | Per-lead SaaS | OpenProspector (BYO key) |
|---|---|---|
| Cost per verified email | ~$0.12 | **~$0.02** |
| Re-checking a lead you already own | Full price again | **Free** (cached) |
| Where your contact data lives | Their cloud | Your database |
| Provider order | Fixed | Yours to configure |

> **Where this *doesn't* win.** Most vendors sell credits on a monthly floor — Findymail's entry plan is $99/mo for 5,000 credits. Below roughly **800 leads/month**, a usage-priced SaaS is genuinely cheaper. This template is for teams doing real volume.

## Providers

Each field has its own independently-ordered waterfall. The order below is the shipping default; **you can reorder any of it in the UI**, and you should — the optimal order depends on which vendors you already pay for and how your ICP resolves.

The **Vendor grades it?** column is about the vendor's product, not about this repo: whether that vendor tells you its address is deliverable (✅ asserted, `graded` scored, ❌ neither). It is what the runner's "first verified result wins" rule reads. It is not a claim that anyone has checked our adapter.

That claim is worth stating separately, because there are two levels of it and they are easy to conflate:

- **Every** adapter is written against the vendor's published contract and covered by tests — a hit, a miss, a rejected key, and the eligibility gate that decides whether the vendor is called at all — and **every** endpoint is checked against the live vendor for host, path, API version and auth header (`LIVE_PROVIDER_CHECK`, below). Getting the mapping and the gate confused is what makes a waterfall either stop resolving or quietly keep spending.
- Those tests answer with a *fixture*, though, and a fixture transcribed from the docs by the same reading that wrote the adapter agrees with the adapter by construction. Only a real key settles it. **Proven against a live response so far: Findymail, Prospeo and Wiza** (both subjects). The rest are contract-accurate and unproven — if you hold a key for one, `LIVE_MAPPING_CHECK` below turns it into a checked one in a single command, and a correction is a welcome PR.

You are not relied on to run that, though. A vendor whose response we can no longer read does not fail quietly: when one answers, bills, and the adapter maps nothing out of it, the attempt is logged as **`unmapped`** with the charge intact, naming the vendor and saying the mapping is probably out of date. It is deliberately not a `miss` — a miss means the vendor has no record, which is normal and free; `unmapped` means it had one, you paid for it, and the bug is on our side of the wire. If you see one, please open an issue with the vendor and field: that row is how mapping drift gets found across a registry no single person holds every key for.

### Email waterfall

| # | Provider | Cost on a hit | Vendor grades it? | Needs |
|---|----------|---------------|-----------|-------|
| 1 | **Findymail** | 1 credit | ✅ | name + domain |
| 2 | **LeadMagic** | 1 credit | ✅ | name + domain/company |
| 3 | **Anymail Finder** | 1 credit, **only when valid** | graded | profile URL, or name + company |
| 4 | **Hunter** | 1 credit | graded (SMTP) | name + domain/company |
| 5 | **Skrapp** | 1 credit | graded (SMTP) | name + domain/company |
| 6 | **Tomba** | 1 credit | graded | name + domain/company |
| 7 | **Datagma** | 1 credit, **only when verified** | graded (SMTP) | name + domain/company |
| 8 | **Snov.io** | 1 credit, **only when found** | graded (SMTP) | first + last name + domain |
| 9 | **Surfe** | 1 credit, **only when found** | ✅ | profile URL, or name + domain/company |
| 10 | **Prospeo** | 1 credit | ✅ | profile URL, email, or name + company |
| 11 | **Wiza** | ~2 credits | graded | profile URL, email, or name + company |
| 12 | **RocketReach** | 1 credit, **only when found** | graded (SMTP) | profile URL, email, or name + company |
| 13 | **Apollo** | 1 credit | graded | profile URL, email, or name + company |
| 14 | **People Data Labs** | 1 match | ❌ dataset | profile URL, email, or name + company |
| 15 | **ContactOut** | 2 credits | graded | profile URL, email, or name + company |
| 16 | **Forager** | 1 credit | graded | profile URL |
| 17 | **Dropcontact** ⏳ | 1 credit, **only when found** | graded | profile URL, or name + domain/company |
| 18 | **Kaspr** | 1 credit | ❌ ungraded | profile URL + name |
| 19 | **Zeliq** ⏳ | as reported per call | graded | profile URL, or name + domain/company |

Positions 3–9 are grouped deliberately: **each of those vendors bills only when it actually returns an address**, so an attempt that misses costs nothing. A vendor that is free to try belongs ahead of one that charges whether or not it resolves. Apollo sits behind them because it charges on a match even when the address it returns is a `guessed` one.

⏳ marks a vendor that **answers by callback** rather than in the same request — see [Vendors that answer later](#vendors-that-answer-later). They sit at the end of the default order because a lead that reaches one waits for it; the in-band vendors get their turn first.

### Phone waterfall

| # | Provider | Cost on a hit | Needs |
|---|----------|---------------|-------|
| 1 | **Forager** | 1 credit | profile URL |
| 2 | **People Data Labs** | 1 match | profile URL, email, or name + company |
| 3 | **Datagma** | as reported per call | profile URL, email, or name + company |
| 4 | **Surfe** | 1 mobile credit, **only when found** | profile URL, or name + domain/company |
| 5 | **RocketReach** | 1 premium credit, **only when found** | profile URL, email, or name + company |
| 6 | **Kaspr** | 1 phone credit | profile URL + name |
| 7 | **LeadMagic** | 5 credits | profile URL **or work email** |
| 8 | **Wiza** | ~5 credits | profile URL, email, or name + company |
| 9 | **ContactOut** | 2 credits | profile URL, email, or name + company |
| 10 | **Prospeo** | 10 credits | profile URL, email, or name + company |
| 11 | **Apollo** ⏳ | 8 credits, **only when found** | profile URL, email, or name + company |
| 12 | **Zeliq** ⏳ | as reported per call (~10) | profile URL **or work email** |

Datagma prefers a **mobile** over a switchboard number and reports its own `creditBurn` on every call, so its real cost lands in the ledger rather than an assumed list price.

Phone credits cost meaningfully more than email — Prospeo prices a mobile at **10×** an email — which is why the phone waterfall runs deeper before giving up, and why ordering it well matters more.

**The phone waterfall runs on the email waterfall's output.** Most phone vendors key on a work email or a profile URL, not on a name and a domain, so a freshly sourced lead has nothing they can match. The runner therefore resolves email first and feeds the result forward as an input. Without that, several of the phone vendors could never run at all.

### Company waterfall

A third waterfall, on its own clock and its own vendor list. It resolves the **account**, not the person: industry, HQ city and country, the LinkedIn company page, the ticker for a listed company. It runs once per company domain and the result is stored, so enriching Stripe once serves every Stripe lead sourced afterwards, and it is trusted for **180 days** rather than the 90 a contact gets — a work email dies the day its owner changes job, an HQ city does not.

It exists because the LinkedIn Matched Audiences **company** upload asks for exactly those columns, and a people-sourcing app has none of them.

| # | Provider | Cost on a hit | Fills |
|---|----------|---------------|-------|
| 1 | **Apollo** | 1 credit, **only on a match** | everything, incl. ticker + zip |
| 2 | **Hunter** | 1 credit | everything, incl. ticker + zip |
| 3 | **Wiza** | 2 credits, **as reported per call** | everything, incl. ticker + zip |
| 4 | **RocketReach** | 1 credit | everything, incl. ticker + zip |
| 5 | **People Data Labs** | 1 match | everything, incl. ticker + zip |
| 6 | **Prospeo** | 1 credit, **only on a match**, free again for 90 days | no ticker, no zip |
| 7 | **LeadMagic** | 1 credit, **only when found** | no ticker, no zip |
| 8 | **Datagma** | as reported per call | no ticker |
| 9 | **Tomba** | 1 credit | no ticker |
| 10 | **Forager** | 1 credit | no ticker |
| 11 | **Findymail** | 1 credit, **only when found** | name, industry, page, city, state, country |
| 12 | **ContactOut** | 1 search credit per company found | name, industry, page, country |
| 13 | **Surfe** | 1 credit | no city, state or zip — HQ is one free-text line |
| 14 | **Snov.io** | 1 credit **per request, match or not** | name, industry, city, founded |

**Apollo leads because its key works on the free plan** — the one vendor here you can turn on without buying anything — and it still fills every column.

**This waterfall fills gaps rather than stopping at the first answer**, and that is the one place it differs from the other two. Firmographic coverage is uneven by an order of magnitude: compare rows 1 and 14. If the first vendor to answer decided the record, whichever thin vendor you happened to rank highest would blank the rest of your export — and the store would then trust that half-empty row for six months. So each vendor's answer is merged into one record, earliest-in-order winning per field.

That does **not** mean paying every vendor for every company. The search stops the moment the four fields the upload and the UI actually read are filled — LinkedIn page, industry, city, country — so one full-coverage key still costs exactly one call. And each adapter declares what its vendor can return at all, so a vendor that could only re-buy what you already hold is skipped without being called, and logged as such. A ticker is never chased: most companies do not have one, and hunting it would spend a credit at every configured vendor on nearly every private company.

**Vendors with no company API.** Skrapp and Anymail Finder are person-only. Zeliq's documented API is three endpoints — credit balance, enrich phone, enrich email. Dropcontact returns company fields only bundled into a contact enrichment that requires a contact identifier. Kaspr keys every lookup on a person's profile URL. These are not roadmap items; there is nothing to wait for.

### Vendors that answer later

Not every vendor answers in the request that asked. There are two shapes, and the app handles each differently.

**Finished a few seconds later** (Wiza, Snov.io, Surfe, RocketReach). The vendor acknowledges the lookup with an id and completes it within seconds; the adapter polls that id in the same pass, with a hard cap of 25 seconds, so to the waterfall it is an ordinary in-band vendor. The trade is named in the code: a lookup that outruns the cap is a paid-for result we drop, and its id goes into the attempt log so it can be retrieved by hand.

**Delivered by webhook, minutes later** (Dropcontact, Zeliq, and Apollo's phone numbers). These vendors POST the result to a URL you give them, and there is nothing to poll. The waterfall **pauses** at that vendor: the lead is marked `waiting`, the position it stopped at is stored, and the vendor is handed a one-time callback URL (`/api/callbacks/{token}`, a fresh UUID per pause). When the callback lands, the answer is folded in exactly as if it had come back in-band — a verified hit ends the search and is cached, anything else moves on to the next vendor — and the remaining fields are resolved from there, with a resolved email still fed forward into the phone lookup. Each pause is also given a **10-minute timeout**, delivered by the platform queue: a vendor that never calls back is logged as an `error` naming it, and the waterfall continues. A run stays `enriching` while any of its leads is waiting, and is marked done by whichever callback settles the last one.

Two consequences worth knowing. A deferred vendor placed *early* in a waterfall makes every lead that reaches it wait, which is why the defaults put them last. And the callback URL is built from the app's own origin, so on a local `pnpm dev` no vendor can reach it: deferred vendors are then skipped with an `error` saying so, rather than parking leads that will never resume.

### Not shipped

| Provider | Why |
|----------|-----|
| Bytemine | Shipped once, now parked. `api.bytemine.ai` is a CNAME onto an AWS API Gateway custom domain that stopped serving TLS for that hostname on 2026-09-01: against the same IP in the same second, the gateway's own SNI name completes a TLS 1.3 handshake while `api.bytemine.ai` gets alert 40. Server-side and client-independent, reproduced from three TLS stacks, and still failing the same way on 2026-09-02. The adapter and its tests are kept, so reviving it is one line once the handshake works again. |

### Keys that are not a plain token

- **Forager** puts the account id in the URL path, so its secret is stored as `FORAGER_API_KEY=accountId:apiKey`.
- **Tomba** authenticates with two headers (`X-Tomba-Key` and `X-Tomba-Secret`), so its secret is stored as `TOMBA_API_KEY=key:secret`.
- **Snov.io** uses OAuth client credentials, so its secret is stored as `SNOV_API_KEY=clientId:clientSecret`; the app mints and caches the short-lived bearer token itself.
- Every other vendor takes an opaque key. The settings screen shows the expected shape next to each field.

### What the vendor's plan has to include

Buying a key is not always the same as unlocking the API. The ones that bite: **Snov.io** and **LeadMagic** give no API access on the free tier; **Surfe** lists the API only on its Enterprise plan; **Kaspr** opens the API from its Starter plan; **Wiza** sells API credits separately from plan credits. The `.dev.vars.example` file carries the current notes.

### Adding a provider

An adapter is one file. Implement `EnrichProvider` in `src/server/providers/`, add it to `REGISTRY`, and it appears in the UI with its own key field and reorder controls:

```ts
export const MyProvider: EnrichProvider = {
  id: "myvendor",
  label: "My Vendor",
  fields: ["email"],
  secretName: "MYVENDOR_API_KEY",   // never a literal key in app code
  signupUrl: "https://myvendor.com/api-keys",
  requirements: () => ["fullName", "domain"],
  async find(field, input, apiKey) { /* → EnrichResult */ },
};
```

A vendor that delivers by webhook declares the fields it defers and maps the delivery:

```ts
  deferred: ["email"],
  async find(field, input, apiKey, ctx) {
    // start the lookup with ctx.callbackUrl, then:
    return { outcome: "pending", value: null, verified: false, creditsUsed: 0, requestId };
  },
  parseCallback(field, body) { /* the POSTed body → EnrichResult */ },
```

Adapters are pure request/response wrappers with no app coupling — no database, no caching, no ordering logic. The runner owns all of that, including the pause and resume around a deferred vendor, which is what keeps the registry cheap to extend.

## How a Search Runs

Sourcing and enrichment are deliberately different jobs, and this app only does one of them.

1. **You describe an ICP** — "marketing agencies in Amsterdam, reach the creative director".
2. **Your agent sources.** The app hands the search to your agent, which researches the live web — maps and review sites, job boards, funding news, professional profiles — and posts back a named person, a company domain, and *one line of evidence* for why each lead qualifies. That work needs judgment and a real browser, so it does not run inside the app.
3. **The app enriches.** Every sourced lead goes through the provider waterfall below to resolve a verified email or phone, on your keys, at vendor cost.
4. **You export.** CSV, or a POST to your CRM or sequencer.

Progress shows up on the search itself — sourcing, enriching, done — including a **stalled** state if the agent stops reporting, so a search that died is never mistaken for one still working.

If the app can't reach your agent, it hands you the brief to paste into your agent's chat instead. The search is saved either way, and can be retried.

## How the Waterfall Works

1. **Cache first.** A normalized `(field, name, domain)` key is checked before any vendor call. A hit costs nothing.
2. **Skip what can't help.** Providers with no API key, or missing the inputs they need, are skipped without spending — and *recorded* as skipped, so you can see exactly why coverage looked thin.
3. **First verified result wins.** An unverified value is kept as a fallback but does **not** stop the search, and is never cached — so a better-configured waterfall can retry it later.
4. **Everything is logged.** Every attempt writes provider, outcome, credits, and latency to an append-only ledger. "Why did this lead resolve this way, and what did it cost?" is always answerable.

Cached values expire after **90 days**. Contact data decays as people change jobs, and an unbounded cache would serve confidently-"verified" dead addresses straight into your bounce rate.

## Features

- **Agent-run sourcing** — describe an ICP and your agent researches the live web; progress and failures surface on the search
- **Configurable waterfalls** — independent provider order per field, editable in the UI
- **Enrichment cache** — never buy the same contact twice, with a staleness cap
- **Cost ledger** — per-provider outcome and credit breakdown; spend is read back from the ledger, so a crashed job can't under-report
- **Provider attribution** — every enriched cell shows which vendor produced it
- **CSV import** — bring a list you already have; column headers are matched loosely
- **LinkedIn Matched Audiences export** — contact and company lists in exactly the header shape Campaign Manager expects, so an enriched search becomes an ad audience without a spreadsheet in between
- **Batch enrichment** — large lists process as chained background jobs, safe against redelivery
- **Full OpenAPI** — `/api/openapi.json` and `/llms.txt` for agent-driven use
- **Dark mode** that follows the OS

## What This Deliberately Does Not Do

**It does not send email.** No sequencer, no SMTP, no "enroll 20 leads" button — not even bring-your-own.

That is a considered decision, not a missing feature. Cold-email sending at volume is a deliverability and compliance problem (CAN-SPAM, GDPR) that belongs in a tool you have configured, warmed, and are accountable for. OpenProspector's job ends at a verified, attributed contact record; export it to your CRM or your own sequencer and send from there.

## Quickstart

```bash
git clone https://github.com/clawnify/OpenProspector.git
cd open-prospector
pnpm install

cp .dev.vars.example .dev.vars   # add whichever provider keys you have
pnpm dev                          # UI on :5175, API on :8789
```

Every provider is optional. With no keys at all the app still runs — the waterfall records `unconfigured` for each vendor so you can see what a key would buy you.

```bash
pnpm test        # waterfall ordering, eligibility, cache and TTL behaviour
pnpm typecheck
pnpm build

# Opt-in, and not part of CI: calls every adapter against the real vendor with a
# deliberately invalid key. Spends nothing, and proves the half a stubbed test
# cannot see: that the host, path, API version and auth header are right, rather
# than only that the response mapping is.
LIVE_PROVIDER_CHECK=1 pnpm test

# The other half, and the one that costs money: calls every adapter you hold a
# key for against the real vendor and checks what came back was actually
# *mapped* — a hit that filled no field, or filled one the adapter never
# declared, is the bug a fixture written from the same misreading cannot catch.
# The company half needs no setup; the person half needs a lead to look up, and
# skips without one.
set -a; source .dev.vars; set +a          # the keys the probe should exercise
LIVE_MAPPING_CHECK=1 pnpm vitest run src/server/providers/mapping.test.ts

# Add a lead and the person adapters join in. Without it only the company half
# runs, because no real person belongs hardcoded in a public repo that would
# then look them up at fourteen contact-data vendors.
LIVE_MAPPING_LEAD="Ada Lovelace,stripe.com" \
LIVE_MAPPING_CHECK=1 pnpm vitest run src/server/providers/mapping.test.ts
```

## API

All list endpoints are paginated (`?page=`, `?limit=`, max 100) and searchable — no endpoint returns an unbounded collection.

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/providers?credits=true` | Registry, configuration state, remaining balances |
| `PUT` | `/api/waterfall/{field}` | Set provider order for `email` or `phone` |
| `POST` | `/api/runs` | Start a search from an ICP description |
| `GET` | `/api/runs`, `/api/runs/{id}` | List runs; one run with live credit spend |
| `POST` | `/api/runs/{id}/enrich` | Queue enrichment for a run's pending leads |
| `POST` | `/api/leads` | Import leads (CSV or an existing list) |
| `GET` | `/api/leads`, `/api/leads/{id}` | List leads; one lead with its attempt log |
| `POST` | `/api/leads/{id}/enrich` | Enrich one lead (`?refresh=true` to re-buy); returns `enrich_status: waiting` if it paused on a callback vendor |
| `POST` | `/api/callbacks/{token}` | Where deferred vendors deliver; the token is minted per pause and dies with it |
| `GET` | `/api/export/leads.csv` | Download leads as CSV (bounded; page with `offset`) |
| `GET` | `/api/export/leads.csv?format=linkedin-contacts` | LinkedIn Matched Audiences **contact** list |
| `GET` | `/api/export/leads.csv?format=linkedin-companies` | LinkedIn Matched Audiences **company** list, deduplicated |
| `POST` | `/api/export/push` | POST leads to a CRM, sequencer, or webhook you control |

**Push safety.** The destination is caller-supplied, so it is validated before anything is sent: **https only**, public hosts only (loopback, private ranges, carrier-grade NAT, IPv6 unique/link-local, `.local`/`.internal`, and cloud metadata addresses are all refused), hop-by-hop and `Host` headers stripped, header-injection attempts dropped, and **redirects refused rather than followed** — a permitted host must not be able to bounce your contact data onward.

## License

MIT — see [LICENSE](LICENSE).
