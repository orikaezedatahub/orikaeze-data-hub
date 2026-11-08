-- Publish the wig as ORIKAEZE HUB-owned stock, separate from the historical test order.
-- Owner-managed seller identity is not a customer login; all orders remain visible to the platform owner.
INSERT OR IGNORE INTO customers
  (id, full_name, email, phone, password_hash, password_salt)
VALUES
  ('orikaeze_hub_owner_marketplace', 'ORIKAEZE HUB', 'owner-marketplace@orikaezedatahub.invalid', '', 'NOT_A_LOGIN_ACCOUNT', 'NOT_A_LOGIN_ACCOUNT');

INSERT OR IGNORE INTO marketplace_sellers
  (id, user_id, store_name, store_slug, description, bank_name, account_name, account_number, status)
VALUES
  ('orikaeze_hub_owner_store', 'orikaeze_hub_owner_marketplace',
   'ORIKAEZE HUB', 'orikaeze-hub-official-store',
   'Official ORIKAEZE HUB store. Platform-owner managed inventory.',
   '', '', '', 'approved');

INSERT OR IGNORE INTO marketplace_products
  (id, seller_id, title, description, category, price_kobo, stock_quantity, image_url, status, sales_count)
VALUES
  ('orikaeze_hub_wig_pixie_14', 'orikaeze_hub_owner_store',
   '4/4 Closure Pixie 14”',
   '4/4 closure pixie wig, 14 inches. Sold directly by ORIKAEZE HUB.',
   'Hair & Beauty', 4700000, 19, '', 'approved', 1);
