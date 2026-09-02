# OpenProspector — agent guide

## What you do, and what you must not

**You do discovery. The app does enrichment.** That split is the architecture.

- **You** find companies and people matching an ICP by researching the live web.
  Low volume, high judgment, unstructured sources.
- **The app** resolves emails and phone numbers through a provider waterfall.
  High volume, mechanical, runs as background jobs.

**Never look up email addresses or phone numbers yourself.** Post the people you
found and let the waterfall resolve them — it buys contact details far more
cheaply than you can find them, and validates every one before delivery.

**Never send email.** This app deliberately has no sending capability. Your job
ends at a verified, attributed contact record.

## Your main job: sourcing

Searches usually reach you as a **task**, not a chat message: the user describes
an ICP in the app, the app hands it to you, and the run is already marked
`sourcing` before you see it. That means nobody is watching a chat window for
your reply — **the run row is the only place your progress is visible**, and an
unreported task looks identical to a dead one.

1. **Read the ICP for the *signal*, not just the filters.** "Just hired a
   compliance officer" is a job-board and press-release signal. "Series A
   fintech" is a funding-database signal. "Uses Shopify" is a tech-stack signal.
   The signal decides which sources are worth opening.
2. **Search several source types, not one.** Maps and review sites for local
   businesses; job boards for hiring signals; funding news and company blogs for
   growth signals; professional profiles for the people. A single source yields
   a list a database could already sell them — the combination is the point.
3. **Identify the person, not just the company.** A company with no named
   contact cannot be enriched. Get a full name and the company's bare domain
   (`acme.com`, not `https://www.acme.com/about`) — those two fields are what
   the email providers need.

   **Also get the person's professional profile URL whenever you can.** It is
   not a nice-to-have: several phone vendors key *only* on a profile URL or a
   work email, and two of them can resolve an email from nothing else. A row
   with a profile URL reaches every provider in both waterfalls; a row without
   one is skipped by several of them before a single credit is spent.
4. **Record why each lead qualifies.** Every row takes `evidence` (one line:
   *"Posted a Head of Compliance role on 12 Jul"*) and `source_url`. A list
   without citations is unauditable and the user cannot act on it.
5. **Report progress as you go.** The user sees nothing else — your session is
   isolated and does not appear in their chat, so the run row is the only signal
   the app can show. `PATCH /api/runs/{id}`:
   - `{"status":"sourcing"}` the moment you start,
   - `{"status":"done"}` when finished,
   - `{"status":"failed","error":"<one line>"}` if you cannot continue.

   A run with no update for 15 minutes is shown as **Stalled** — accurate if you
   died, misleading if you simply forgot to report. So on a long search, PATCH
   `sourcing` again periodically: each one is a heartbeat that resets that clock.
   Do not send `lead_count`; it is derived from the rows you post.

   **Failing loudly matters more here than anywhere else.** A task you abandon
   silently leaves the user staring at a search that looks alive for 15 minutes
   and then dead with no reason. If you cannot find anything, that is a `done`
   with zero leads, not a failure — say which sources you tried in the reply.
6. **Post the leads**, then tell the user how many you added and let them enrich.

## Pages

- `/` — the whole app: ICP box, both waterfall panels, and the leads table.
  **Screenshot-friendly**: the leads table with resolved emails and provider
  attribution is the money shot.

## API

Full schemas: `GET /llms.txt` (index) or `GET /api/openapi.json`. Every list
endpoint is paginated (`?page=`, `?limit=` max 100, `?search=`) — nothing
returns an unbounded collection, so always page.

**The one call you write most — `POST /api/leads`:**

```json
{
  "run_id": "optional-run-uuid",
  "leads": [
    {
      "full_name": "Ada Lovelace",
      "title": "Head of Compliance",
      "company": "Acme",
      "domain": "acme.com",
      "location": "Austin, TX",
      "source": "job-board",
      "source_url": "https://…",
      "evidence": "Posted a Head of Compliance role on 12 Jul"
    }
  ]
}
```

Max **500 per call**. A lead with neither `full_name` nor `domain` is rejected —
no provider could resolve it. `domain` is normalized server-side. `imported` may
be lower than what you sent; the difference is the unenrichable rows.

| Reach for | When |
|---|---|
| `POST /api/runs` | Group a search before posting leads to it. |
| `PATCH /api/runs/{id}` | Report progress: `sourcing` → `done`, or `failed` with a one-line reason. The user's only view into your work. |
| `POST /api/runs/{id}/enrich` | Enrich every pending lead in a run. Returns `202`; poll `GET /api/leads?run_id=…&enrich_status=pending` to watch it drain. |
| `GET /api/leads/{id}` | One lead **plus its attempt log** — how you answer "why has this lead got no email?" |
| `POST /api/leads/{id}/enrich` | One lead. Cache by default (**free**); `?refresh=true` re-buys and always costs. Comes back `enrich_status: waiting` when it paused on a vendor that answers by callback — poll `GET /api/leads/{id}` rather than calling enrich again, which would cancel the wait. |
| `GET /api/providers?credits=true` | Which vendors are configured and their remaining balances. |
| `PUT /api/waterfall/{field}` | Reorder the `email` or `phone` waterfall. |
| `GET /api/export/leads.csv` | Hand the user a file. **Don't call this to read data** — it returns up to 1000 rows and will flood your context; use `GET /api/leads` instead. Add `?format=linkedin-contacts` or `?format=linkedin-companies` when the user wants a LinkedIn Matched Audiences upload; the company list is deduplicated for them. |
| `POST /api/export/push` | Send leads to a CRM/sequencer the user names. `{ url, headers?, run_id?, only_with_email? }` — https only, public hosts only, redirects refused. |

## Reading the attempt log

| Outcome | Meaning |
|---|---|
| `hit` | Provider returned a value; cost is in `credits_used`. |
| `miss` | Provider ran, has no record. Normal — the waterfall moved on. |
| `ineligible` | Lead lacked the inputs that provider needs — usually a domain, or a missing profile URL on the phone waterfall. **Your** fix: source a better row. |
| `unconfigured` | No API key for that vendor. Tell the user which key would have run. |
| `no_credits` | Vendor balance exhausted; the user must top up. |
| `pending` | Provider answers by callback; the lead is `waiting` on it (at most 10 minutes). A second row with the real outcome follows. |
| `error` | Vendor/transport failure, or a callback that never came. The waterfall continued to the next provider. |

If coverage looks poor, read the log before blaming the data: `ineligible` means
the sourcing was thin, `unconfigured` means the waterfall is short a vendor.

## Cost

The user pays their vendors directly with no markup, so credits are real money.

- **Never** call `?refresh=true` in bulk.
- Resolved values are cached 90 days, so re-enriching a list the user already
  bought is free. Prefer re-running enrichment over re-sourcing.
