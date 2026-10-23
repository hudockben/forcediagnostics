CREATE TABLE "diagnosis_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"unit_model_number" text,
	"unit_year" integer,
	"unit_label" text,
	"scope_manual_ids" uuid[],
	"web_search" boolean NOT NULL,
	"web_search_removed" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"tech_messages" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"web_searches" integer DEFAULT 0 NOT NULL,
	"cost_cents" double precision DEFAULT 0 NOT NULL,
	"context_tokens" integer DEFAULT 0 NOT NULL,
	"outcome" jsonb,
	"feedback" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pending_notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "diagnosis_conversations_id_shop" UNIQUE("id","shop_id"),
	CONSTRAINT "diagnosis_conversations_status" CHECK ("diagnosis_conversations"."status" in ('open', 'solved'))
);
--> statement-breakpoint
ALTER TABLE "diagnosis_conversations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "diagnosis_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"user_id" text NOT NULL,
	"tech_text" text NOT NULL,
	"history" json,
	"reply" jsonb,
	"progress" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"seen" jsonb DEFAULT '{"pages":[],"urls":[]}'::jsonb NOT NULL,
	"usage" jsonb,
	"web_searches" integer DEFAULT 0 NOT NULL,
	"cost_cents" double precision DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"error" text,
	"attempts" integer DEFAULT 1 NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stop_requested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "diagnosis_turns_conversation_seq" UNIQUE("conversation_id","seq"),
	CONSTRAINT "diagnosis_turns_seq" CHECK ("diagnosis_turns"."seq" >= 1),
	CONSTRAINT "diagnosis_turns_status" CHECK ("diagnosis_turns"."status" in ('running', 'done', 'failed', 'stopped'))
);
--> statement-breakpoint
ALTER TABLE "diagnosis_turns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "diagnosis_conversations" ADD CONSTRAINT "diagnosis_conversations_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnosis_conversations" ADD CONSTRAINT "diagnosis_conversations_user_shop_fk" FOREIGN KEY ("user_id","shop_id") REFERENCES "public"."users"("id","shop_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnosis_turns" ADD CONSTRAINT "diagnosis_turns_conversation_shop_fk" FOREIGN KEY ("conversation_id","shop_id") REFERENCES "public"."diagnosis_conversations"("id","shop_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnosis_turns" ADD CONSTRAINT "diagnosis_turns_user_shop_fk" FOREIGN KEY ("user_id","shop_id") REFERENCES "public"."users"("id","shop_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "diagnosis_conversations_shop_updated" ON "diagnosis_conversations" USING btree ("shop_id","updated_at");--> statement-breakpoint
CREATE INDEX "diagnosis_turns_shop_created" ON "diagnosis_turns" USING btree ("shop_id","created_at");--> statement-breakpoint
CREATE POLICY "diagnosis_conversations_own_shop" ON "diagnosis_conversations" AS PERMISSIVE FOR SELECT TO "app_user" USING ("diagnosis_conversations"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "diagnosis_conversations_add_own_shop" ON "diagnosis_conversations" AS PERMISSIVE FOR INSERT TO "app_user" WITH CHECK ("diagnosis_conversations"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "diagnosis_conversations_update_own_shop" ON "diagnosis_conversations" AS PERMISSIVE FOR UPDATE TO "app_user" USING ("diagnosis_conversations"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid) WITH CHECK ("diagnosis_conversations"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "diagnosis_turns_own_shop" ON "diagnosis_turns" AS PERMISSIVE FOR SELECT TO "app_user" USING ("diagnosis_turns"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "diagnosis_turns_add_own_shop" ON "diagnosis_turns" AS PERMISSIVE FOR INSERT TO "app_user" WITH CHECK ("diagnosis_turns"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "diagnosis_turns_update_own_shop" ON "diagnosis_turns" AS PERMISSIVE FOR UPDATE TO "app_user" USING ("diagnosis_turns"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid) WITH CHECK ("diagnosis_turns"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid);