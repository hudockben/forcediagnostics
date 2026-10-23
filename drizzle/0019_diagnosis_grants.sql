-- Diagnose: app_user can start and read its own shop's conversations and
-- their messages (row-level security) and move them along. Nothing can be
-- deleted, a conversation never changes shop or who started it, and a
-- message never changes who sent it, what it said or where it sits.
GRANT SELECT, INSERT ON "diagnosis_conversations" TO app_user;
--> statement-breakpoint
GRANT UPDATE ("title", "unit_model_number", "unit_year", "unit_label", "scope_manual_ids", "web_search_removed", "status", "tech_messages", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "web_searches", "cost_cents", "context_tokens", "outcome", "feedback", "pending_notes", "updated_at") ON "diagnosis_conversations" TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON "diagnosis_turns" TO app_user;
--> statement-breakpoint
GRANT UPDATE ("history", "reply", "progress", "seen", "usage", "web_searches", "cost_cents", "status", "error", "attempts", "heartbeat_at", "stop_requested_at", "updated_at", "finished_at") ON "diagnosis_turns" TO app_user;
