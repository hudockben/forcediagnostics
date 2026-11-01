-- NUSR: app_user can log, read, correct and remove its own shop's sales
-- (row-level security). A sale never changes shop, who logged it and when,
-- or where an import found it; its customer can be changed, to another
-- customer of the same shop (its foreign key on customer and shop sees to
-- that). Every change is written to the Activity log, which can't be
-- changed.
GRANT SELECT, INSERT, DELETE ON "unit_sales" TO app_user;
--> statement-breakpoint
GRANT UPDATE ("sold_on", "salesperson", "customer_id", "customer_name", "customer_address", "customer_phone", "unit_year", "unit_model", "condition", "unit_type", "vin", "category", "msrp_cents", "sales_price_cents", "dealer_cost_cents", "unit_labor_cents", "rebate_cents", "acc_price_cents", "acc_cost_cents", "acc_labor_cents", "esc_price_cents", "esc_cost_cents", "rewards_cents", "holdback_rate_bp", "bonus_rate_bp", "notes", "finance_company", "amount_financed_cents", "down_payment_cents", "bonus_adjustment_cents", "funding_received_on", "paid_on", "coms_number", "updated_at") ON "unit_sales" TO app_user;
