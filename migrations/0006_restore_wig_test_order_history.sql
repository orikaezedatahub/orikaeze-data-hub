-- Restore the previously tested wig order into production admin history.
-- Clearly labelled TEST data: not a new customer sale or payout.
INSERT OR IGNORE INTO customers
  (id, full_name, email, phone, password_hash, password_salt)
VALUES
  ('test_customer_wig_20261108', 'OrikaEzeMedia (TEST ORDER)', 'marketplace-wig-test-20261108@orikaezemedia.invalid', '', 'NOT_A_LOGIN_ACCOUNT', 'NOT_A_LOGIN_ACCOUNT');

INSERT OR IGNORE INTO marketplace_sellers
  (id, user_id, store_name, store_slug, description, bank_name, account_name, account_number, status)
VALUES
  ('test_seller_wig_20261108', 'test_customer_wig_20261108',
   'TEST RECORD - no seller payout', 'test-wig-order-history-20261108',
   'Placeholder seller record used only to display the restored test order in owner history.',
   '', '', '', 'suspended');

INSERT OR IGNORE INTO marketplace_products
  (id, seller_id, title, description, category, price_kobo, stock_quantity, image_url, status)
VALUES
  ('test_product_wig_20261108', 'test_seller_wig_20261108',
   '4/4 closure pixie 14”', 'Restored historical test item; not for sale.',
   'Test record', 4700000, 0, '', 'archived');

INSERT OR IGNORE INTO marketplace_orders
  (id, reference, buyer_id, seller_id, product_id, quantity, unit_price_kobo,
   total_kobo, commission_kobo, seller_earning_kobo, payment_status, status,
   delivery_details, buyer_note, admin_note)
VALUES
  ('test_order_wig_20261108', 'OMK_373b79db149949b38bb74f1ff3419aec',
   'test_customer_wig_20261108', 'test_seller_wig_20261108', 'test_product_wig_20261108',
   1, 4700000, 4700000, 0, 4700000, 'paid', 'fulfilled',
   '', 'Historical staging test order. Display-only restoration; no new payment was collected.',
   'TEST ORDER - restored to production admin history for visibility only. Not a new sale; do not pay out.');
