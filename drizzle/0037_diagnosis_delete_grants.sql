-- Diagnose: app_user can delete one of its own shop's conversations
-- (row-level security), for managers and admins (diagnostics.delete). Its
-- messages go with it by their foreign key's cascade, which runs as the
-- owner, so app_user still can't delete a message on its own. The Activity
-- log keeps what was deleted, and that can't be deleted
-- (0035_audit_log_locked.sql).
GRANT DELETE ON "diagnosis_conversations" TO app_user;
