-- System Admin > Customers: app_user can add, read, change and remove its
-- own shop's customers and their vehicles (row-level security). A customer
-- never changes shop, and a vehicle never moves to another customer. A
-- vehicle with diagnoses can't be removed (its foreign key stops it), and
-- removing a customer removes their vehicles.
GRANT SELECT, INSERT, DELETE ON "customers" TO app_user;
--> statement-breakpoint
GRANT UPDATE ("name", "phone", "email", "address_line1", "address_line2", "city", "state", "postal_code", "notes", "updated_at") ON "customers" TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "customer_vehicles" TO app_user;
--> statement-breakpoint
GRANT UPDATE ("relation", "relation_date", "year", "make", "model", "model_number", "vin", "color", "notes", "updated_at") ON "customer_vehicles" TO app_user;
--> statement-breakpoint
-- Diagnose: a conversation starts with a customer's vehicle (its INSERT
-- grant covers every column) or is linked to one, or unlinked, later.
GRANT UPDATE ("customer_vehicle_id") ON "diagnosis_conversations" TO app_user;
