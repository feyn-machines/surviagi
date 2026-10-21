-- Ontology schema v2.2.0, rule:search-finds-candidates. A search reaches accounts
-- the panel does not have; when a post found that way makes an update, its
-- author is recorded as a candidate so the update has an actor. Such an
-- account is of unknown owner, unclassified, and known only as "found by
-- search" - a grade below the one the panel needs before it enables anyone.
--
-- No BEGIN/COMMIT here: db.migrate wraps each file in one transaction.

ALTER TABLE public.source_accounts DROP CONSTRAINT source_accounts_owner_kind_check;
ALTER TABLE public.source_accounts ADD CONSTRAINT source_accounts_owner_kind_check
    CHECK (owner_kind IN ('person', 'organization', 'unknown'));

ALTER TABLE public.source_accounts DROP CONSTRAINT source_accounts_owner_is_one;
ALTER TABLE public.source_accounts ADD CONSTRAINT source_accounts_owner_is_one CHECK (
    (owner_kind = 'person' AND person_id IS NOT NULL)
    OR (owner_kind = 'organization' AND person_id IS NULL AND org_name IS NOT NULL)
    OR (owner_kind = 'unknown' AND person_id IS NULL AND org_name IS NULL)
);

ALTER TABLE public.source_accounts DROP CONSTRAINT source_accounts_panel_role_check;
ALTER TABLE public.source_accounts ADD CONSTRAINT source_accounts_panel_role_check
    CHECK (panel_role IN ('evaluator', 'practitioner', 'adopter', 'researcher', 'commentator', 'executive', 'lab_insider', 'relay', 'official', 'unclassified'));

ALTER TABLE public.source_accounts DROP CONSTRAINT source_accounts_identity_grade_check;
ALTER TABLE public.source_accounts ADD CONSTRAINT source_accounts_identity_grade_check
    CHECK (identity_grade IN ('first_party_link', 'official_bio', 'third_party_list', 'found_by_search'));

-- An account found by search can only ever be a candidate until someone gives it an owner.
ALTER TABLE public.source_accounts ADD CONSTRAINT source_accounts_unknown_owner_is_a_candidate
    CHECK (owner_kind <> 'unknown' OR panel_state = 'candidate');
