CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"actor_user_id" text,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_shop_created" ON "audit_log" USING btree ("shop_id","created_at");--> statement-breakpoint
CREATE POLICY "users_update_own_shop" ON "users" AS PERMISSIVE FOR UPDATE TO "app_user" USING ("users"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid) WITH CHECK ("users"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "audit_log_read_own_shop" ON "audit_log" AS PERMISSIVE FOR SELECT TO "app_user" USING ("audit_log"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "audit_log_add_own_shop" ON "audit_log" AS PERMISSIVE FOR INSERT TO "app_user" WITH CHECK ("audit_log"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid);