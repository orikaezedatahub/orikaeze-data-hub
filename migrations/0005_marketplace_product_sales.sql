-- Temu-style marketplace product pricing and sales indicators.
ALTER TABLE marketplace_products ADD COLUMN original_price_kobo INTEGER;
ALTER TABLE marketplace_products ADD COLUMN sales_count INTEGER NOT NULL DEFAULT 0 CHECK(sales_count >= 0);
