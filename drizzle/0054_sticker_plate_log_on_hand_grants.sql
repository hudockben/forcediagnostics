-- Handing out a sticker or plate on hand logs it to its customer: app_user
-- sets who logged it and when, as well as the customer (granted in 0031).
GRANT UPDATE ("created_at", "created_by_user_id") ON "sticker_plate_log" TO app_user;
