-- Demo data for screenshots and local development.
--
-- Every row hangs off one fixed sample run id, so the set is identifiable and
-- re-runnable without duplicating:
--   DELETE FROM leads WHERE run_id = '11111111-1111-4111-8111-111111111111';
-- The `source` column is deliberately NOT used as the marker — it carries the
-- real signal type (job-board, funding-news, …), which is what makes the demo
-- representative of a genuine run.
--
-- The people are invented. Provider attribution is only ever 'findymail',
-- because that is the one adapter actually implemented — a screenshot showing
-- results attributed to providers we have not shipped would be advertising a
-- capability that does not exist.

DELETE FROM enrichment_attempts WHERE run_id LIKE '_______1-1111-4111-8111-111111111111'
   OR run_id IN ('22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333');
DELETE FROM leads WHERE run_id = '11111111-1111-4111-8111-111111111111';
DELETE FROM runs WHERE id IN (
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333');

-- Three runs so the Searches panel shows its whole vocabulary: a finished run,
-- one the agent is still working, and one it gave up on with a reason. A demo
-- where everything succeeded misrepresents what sourcing actually looks like.
INSERT INTO runs (id, icp_prompt, status, lead_count, credits_spent, error, updated_at) VALUES
  ('11111111-1111-4111-8111-111111111111',
   '[sample] Series A fintech companies in Amsterdam that just hired a Head of Compliance',
   'done', 14, 9, '', datetime('now')),
  -- Fresh, so it reads "Sourcing" rather than tripping the 15-minute staleness rule.
  ('22222222-2222-4222-8222-222222222222',
   '[sample] Dutch accounting firms with 10-50 staff that mention AI on their site',
   'sourcing', 0, 0, '', datetime('now')),
  ('33333333-3333-4333-8333-333333333333',
   '[sample] Series B logistics startups hiring a Head of Ops in the Nordics',
   'failed', 0, 0, 'No job boards returned matches for the Nordics filter', datetime('now'));

INSERT INTO leads (
  id, run_id, full_name, title, company, domain, location,
  source, source_url, evidence,
  email, email_verified, email_provider, enrich_status
) VALUES
  ('a0000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','Marijke de Vries','Head of Compliance','Bunq','bunq.com','Amsterdam, NL','job-board','https://example.com/jobs/1','Posted a Head of Compliance role on 12 Jul','marijke.devries@bunq.com',1,'findymail','done'),
  ('a0000000-0000-4000-8000-000000000002','11111111-1111-4111-8111-111111111111','Tomas Ridder','VP Finance','Mollie','mollie.com','Amsterdam, NL','funding-news','https://example.com/news/2','Announced a EUR 22M Series A on 3 Jul','t.ridder@mollie.com',1,'findymail','done'),
  ('a0000000-0000-4000-8000-000000000003','11111111-1111-4111-8111-111111111111','Elena Kowalski','Chief Risk Officer','Adyen','adyen.com','Amsterdam, NL','press-release','https://example.com/news/3','Named CRO in a 9 Jul press release','e.kowalski@adyen.com',1,'findymail','done'),
  ('a0000000-0000-4000-8000-000000000004','11111111-1111-4111-8111-111111111111','Daan Vermeer','Head of Legal & Compliance','Tikkie','tikkie.me','Amsterdam, NL','job-board','https://example.com/jobs/4','Two compliance roles opened in the last 30 days','daan.vermeer@tikkie.me',1,'findymail','done'),
  ('a0000000-0000-4000-8000-000000000005','11111111-1111-4111-8111-111111111111','Sofia Bergmann','Compliance Officer','Tribe Payments','tribepayments.com','Amsterdam, NL','company-blog','https://example.com/blog/5','Blog post announcing the compliance team build-out','s.bergmann@tribepayments.com',1,'findymail','done'),
  ('a0000000-0000-4000-8000-000000000006','11111111-1111-4111-8111-111111111111','Pieter Janssen','Director of Risk','Silverflow','silverflow.com','Amsterdam, NL','job-board','https://example.com/jobs/6','Hiring a Risk & Compliance Manager','p.janssen@silverflow.com',1,'findymail','done'),
  ('a0000000-0000-4000-8000-000000000007','11111111-1111-4111-8111-111111111111','Anouk Willems','Head of Compliance','Fourthline','fourthline.com','Amsterdam, NL','funding-news','https://example.com/news/7','Raised Series A, expanding regulatory team','a.willems@fourthline.com',1,'findymail','done'),
  ('a0000000-0000-4000-8000-000000000008','11111111-1111-4111-8111-111111111111','Luca Ferrari','General Counsel','Payaut','payaut.com','Amsterdam, NL','press-release','https://example.com/news/8','Appointed GC covering compliance, 1 Jul','l.ferrari@payaut.com',1,'findymail','done'),
  ('a0000000-0000-4000-8000-000000000009','11111111-1111-4111-8111-111111111111','Nadia Haddad','Compliance Lead','Twikey','twikey.com','Amsterdam, NL','job-board','https://example.com/jobs/9','Compliance Lead vacancy posted 8 Jul','n.haddad@twikey.com',1,'findymail','done'),
  -- Enriched but unresolved: an honest outcome the table must show plainly.
  ('a0000000-0000-4000-8000-000000000010','11111111-1111-4111-8111-111111111111','Ruben Smit','Head of Compliance','Stealth Fintech','stealthfintech.example','Amsterdam, NL','job-board','https://example.com/jobs/10','Anonymous job posting, company inferred','',0,'','done'),
  ('a0000000-0000-4000-8000-000000000011','11111111-1111-4111-8111-111111111111','Ingrid Larsen','Risk Manager','Bitvavo','bitvavo.com','Amsterdam, NL','company-blog','https://example.com/blog/11','Team page lists a new risk hire','',0,'','done'),
  -- Not yet enriched.
  ('a0000000-0000-4000-8000-000000000012','11111111-1111-4111-8111-111111111111','Karim Boujida','Compliance Officer','Peaks','peaks.com','Amsterdam, NL','job-board','https://example.com/jobs/12','Posted a compliance vacancy 14 Jul','',0,'','pending'),
  ('a0000000-0000-4000-8000-000000000013','11111111-1111-4111-8111-111111111111','Hanna Meijer','Head of Financial Crime','Blanco','blanco.com','Amsterdam, NL','press-release','https://example.com/news/13','Announced financial-crime function, 10 Jul','',0,'','pending'),
  ('a0000000-0000-4000-8000-000000000014','11111111-1111-4111-8111-111111111111','Victor Oyelaran','Compliance Analyst','Five Degrees','fivedegrees.com','Amsterdam, NL','job-board','https://example.com/jobs/14','Compliance Analyst role opened 11 Jul','',0,'','pending');

-- A plausible attempt ledger for the sample run, so the cost story is visible.
DELETE FROM enrichment_attempts WHERE run_id = '11111111-1111-4111-8111-111111111111';
INSERT INTO enrichment_attempts (id, lead_id, run_id, provider_id, field, outcome, credits_used, ms, detail)
SELECT
  lower(hex(randomblob(4))) || '-0000-4000-8000-' || lower(hex(randomblob(6))),
  id, run_id, 'findymail', 'email',
  CASE WHEN email != '' THEN 'hit' ELSE 'miss' END,
  CASE WHEN email != '' THEN 1 ELSE 0 END,
  380 + (abs(random()) % 220),
  CASE WHEN email != '' THEN '' ELSE 'No record found' END
FROM leads
WHERE run_id = '11111111-1111-4111-8111-111111111111' AND enrich_status = 'done';
