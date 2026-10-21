-- SourceAccount.avatar_url (ontology schema v2.1.0): the profile image the
-- platform returned at the account's last lookup. Display only - it is not
-- identity evidence, and null means no lookup has seen one, not "no image".
--
-- No BEGIN/COMMIT here: db.migrate wraps each file in one transaction.

ALTER TABLE public.source_accounts ADD COLUMN IF NOT EXISTS avatar_url text
    CHECK (avatar_url IS NULL OR avatar_url LIKE 'https://%');
