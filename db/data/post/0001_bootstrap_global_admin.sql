-- Bootstrap the first global admin so someone can open the Access page and
-- grant everybody else. user_id is the Digital Fabric user UUID (the
-- DSP-Token `user_id` claim). Idempotent.
INSERT INTO role_assignments (user_id, user_name, role, company_id, created_by)
VALUES ('739b29c7-f2e7-4b60-bf52-7be131b7ba27', 'Fernando Caamaño', 'global_admin', NULL,
        '739b29c7-f2e7-4b60-bf52-7be131b7ba27')
ON CONFLICT DO NOTHING;
