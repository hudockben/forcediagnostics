CREATE TABLE "manual_page_facts" (
	"manual_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"page_number" integer NOT NULL,
	"status" text NOT NULL,
	"facts" jsonb,
	"dropped" integer DEFAULT 0 NOT NULL,
	"error" text,
	"attempts" integer DEFAULT 1 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_cents" double precision DEFAULT 0 NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manual_page_facts_pk" PRIMARY KEY("manual_id","page_number"),
	CONSTRAINT "manual_page_facts_status" CHECK ("manual_page_facts"."status" in ('reading', 'ready', 'empty', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "manual_page_facts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "manual_page_facts" ADD CONSTRAINT "manual_page_facts_manual_shop_fk" FOREIGN KEY ("manual_id","shop_id") REFERENCES "public"."manuals"("id","shop_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_page_facts" ADD CONSTRAINT "manual_page_facts_page_fk" FOREIGN KEY ("manual_id","page_number") REFERENCES "public"."manual_pages"("manual_id","page_number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "manual_page_facts_own_shop" ON "manual_page_facts" AS PERMISSIVE FOR SELECT TO "app_user" USING ("manual_page_facts"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "manual_page_facts_add_own_shop" ON "manual_page_facts" AS PERMISSIVE FOR INSERT TO "app_user" WITH CHECK ("manual_page_facts"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "manual_page_facts_update_own_shop" ON "manual_page_facts" AS PERMISSIVE FOR UPDATE TO "app_user" USING ("manual_page_facts"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid) WITH CHECK ("manual_page_facts"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid);