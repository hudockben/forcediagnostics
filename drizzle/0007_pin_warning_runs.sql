ALTER TABLE "staff_pins" ADD COLUMN "earlier_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "staff_pins" ADD COLUMN "earlier_failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "staff_pins" ADD COLUMN "earlier_failed_device_id" uuid;--> statement-breakpoint
ALTER TABLE "staff_pins" ADD CONSTRAINT "staff_pins_earlier_failed_device_id_bay_devices_id_fk" FOREIGN KEY ("earlier_failed_device_id") REFERENCES "public"."bay_devices"("id") ON DELETE set null ON UPDATE no action;