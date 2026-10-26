-- Diagnose: app_user sets a conversation's VIN when it starts (its INSERT
-- grant covers every column) and changes it with the unit, as it does the
-- unit's other columns (0019_diagnosis_grants.sql).
GRANT UPDATE ("unit_vin") ON "diagnosis_conversations" TO app_user;
