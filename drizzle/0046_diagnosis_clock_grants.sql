-- Diagnose's clock: app_user can start, read and move along its own shop's
-- stretches of work on a diagnosis (row-level security): carry one on to
-- its last use, stop it, and stretch it back over a gap its person says
-- they worked through. A stretch never changes diagnosis, shop, person or
-- place in the list, and none is deleted on its own: they go with their
-- diagnosis, by the foreign key's cascade, which runs as the owner.
GRANT SELECT, INSERT ON "diagnosis_time_spans" TO app_user;
--> statement-breakpoint
GRANT UPDATE ("started_at", "ended_at", "stop", "gap_from") ON "diagnosis_time_spans" TO app_user;
