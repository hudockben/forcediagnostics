ALTER TABLE "audit_log" ADD COLUMN "seq" bigint;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "actor_name" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "prev_hash" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_log_shop_seq" ON "audit_log" USING btree ("shop_id","seq");