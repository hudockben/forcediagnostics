-- Diagnose: app_user ticks a conversation's checks off (done, OK or a
-- problem found) and marks them heard by Claude, as it does the tech's
-- presses on causes (0019_diagnosis_grants.sql).
GRANT UPDATE ("step_checks") ON "diagnosis_conversations" TO app_user;
