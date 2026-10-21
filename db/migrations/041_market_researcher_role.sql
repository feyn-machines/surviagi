-- Ontology schema v2.3.0: the panel gains a role for third-party institutions
-- that measure markets, adoption or work - investors, consultancies, data
-- firms, public bodies, think tanks - and the people who publish for them.
-- The role only describes what the account posts about; the tier of any
-- evidence still comes from the post and its author's independence
-- (rule:verification-tier).
--
-- No BEGIN/COMMIT here: db.migrate wraps each file in one transaction.

ALTER TABLE public.source_accounts DROP CONSTRAINT source_accounts_panel_role_check;
ALTER TABLE public.source_accounts ADD CONSTRAINT source_accounts_panel_role_check
    CHECK (panel_role IN ('evaluator', 'practitioner', 'adopter', 'researcher', 'commentator', 'executive', 'lab_insider', 'relay', 'official', 'market_researcher', 'unclassified'));
