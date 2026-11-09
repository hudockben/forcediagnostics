CREATE TABLE "diagnosis_time_spans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"user_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"stop" text,
	"gap_from" timestamp with time zone,
	CONSTRAINT "diagnosis_time_spans_conversation_seq" UNIQUE("conversation_id","seq"),
	CONSTRAINT "diagnosis_time_spans_seq" CHECK ("diagnosis_time_spans"."seq" >= 1),
	CONSTRAINT "diagnosis_time_spans_stop" CHECK ("diagnosis_time_spans"."stop" in ('pause', 'idle', 'end', 'solved', 'handover')),
	CONSTRAINT "diagnosis_time_spans_times" CHECK ("diagnosis_time_spans"."ended_at" >= "diagnosis_time_spans"."started_at" and ("diagnosis_time_spans"."gap_from" is null or "diagnosis_time_spans"."gap_from" < "diagnosis_time_spans"."started_at"))
);
--> statement-breakpoint
ALTER TABLE "diagnosis_time_spans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "diagnosis_time_spans" ADD CONSTRAINT "diagnosis_time_spans_conversation_shop_fk" FOREIGN KEY ("conversation_id","shop_id") REFERENCES "public"."diagnosis_conversations"("id","shop_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnosis_time_spans" ADD CONSTRAINT "diagnosis_time_spans_user_shop_fk" FOREIGN KEY ("user_id","shop_id") REFERENCES "public"."users"("id","shop_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "diagnosis_time_spans_shop_ended" ON "diagnosis_time_spans" USING btree ("shop_id","ended_at");--> statement-breakpoint
CREATE UNIQUE INDEX "diagnosis_time_spans_one_going" ON "diagnosis_time_spans" USING btree ("conversation_id") WHERE "diagnosis_time_spans"."stop" is null;--> statement-breakpoint
CREATE POLICY "diagnosis_time_spans_own_shop" ON "diagnosis_time_spans" AS PERMISSIVE FOR SELECT TO "app_user" USING ("diagnosis_time_spans"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "diagnosis_time_spans_add_own_shop" ON "diagnosis_time_spans" AS PERMISSIVE FOR INSERT TO "app_user" WITH CHECK ("diagnosis_time_spans"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "diagnosis_time_spans_update_own_shop" ON "diagnosis_time_spans" AS PERMISSIVE FOR UPDATE TO "app_user" USING ("diagnosis_time_spans"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid) WITH CHECK ("diagnosis_time_spans"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid);