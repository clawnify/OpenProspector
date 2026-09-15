-- Fictional demo records only. No provider credentials, agents, or scheduled jobs.
INSERT INTO runs (id, icp_prompt, status, lead_count, credits_spent) VALUES
 ('sample-run', 'Sample: small service businesses improving their client handoff', 'done', 3, 0);
INSERT INTO leads (id, run_id, full_name, title, company, domain, location, source, source_url, evidence, email, enrich_status) VALUES
 ('lead-alex', 'sample-run', 'Alex Morgan', 'Operations Lead', 'Northline Studio', 'northline.example', 'Amsterdam, NL', 'sample', 'https://northline.example/team', 'Fictional example: opening a second studio and improving client onboarding.', 'alex@northline.example', 'done'),
 ('lead-jamie', 'sample-run', 'Jamie Chen', 'Property Manager', 'Harbour Property', 'harbour.example', 'Rotterdam, NL', 'sample', 'https://harbour.example/news', 'Fictional example: adding a new property and coordinating viewings.', 'jamie@harbour.example', 'done'),
 ('lead-sam', 'sample-run', 'Sam Taylor', 'Founder', 'Cedar & Co', 'cedar.example', 'Utrecht, NL', 'sample', 'https://cedar.example/about', 'Fictional example: growing a small service team.', 'sam@cedar.example', 'done');
INSERT INTO signals (id, domain, company, type, summary, source, source_url, occurred_at, dedupe_key) VALUES
 ('signal-northline', 'northline.example', 'Northline Studio', 'hiring', 'Sample: hiring a client operations coordinator.', 'Fictional careers page', 'https://northline.example/careers', datetime('now', '-2 days'), 'northline.example|hiring|https://northline.example/careers'),
 ('signal-harbour', 'harbour.example', 'Harbour Property', 'site_change', 'Sample: a new residential property joins the portfolio.', 'Fictional company update', 'https://harbour.example/news', datetime('now', '-5 days'), 'harbour.example|site_change|https://harbour.example/news');
