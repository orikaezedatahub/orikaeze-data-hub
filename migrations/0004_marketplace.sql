-- Marketplace foundation. These tables are separate from the existing data/airtime wallet and order tables.
CREATE TABLE IF NOT EXISTS marketplace_sellers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES customers(id) ON DELETE CASCADE,
  store_name TEXT NOT NULL,
  store_slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  bank_name TEXT NOT NULL,
  account_name TEXT NOT NULL,
  account_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','suspended')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_marketplace_sellers_status ON marketplace_sellers(status, created_at DESC);

CREATE TABLE IF NOT EXISTS marketplace_products (
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL REFERENCES marketplace_sellers(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  price_kobo INTEGER NOT NULL CHECK(price_kobo > 0),
  stock_quantity INTEGER NOT NULL DEFAULT 0 CHECK(stock_quantity >= 0),
  image_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','archived')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_marketplace_products_public ON marketplace_products(status, category, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketplace_products_seller ON marketplace_products(seller_id, created_at DESC);

CREATE TABLE IF NOT EXISTS marketplace_orders (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  buyer_id TEXT NOT NULL REFERENCES customers(id),
  seller_id TEXT NOT NULL REFERENCES marketplace_sellers(id),
  product_id TEXT NOT NULL REFERENCES marketplace_products(id),
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  unit_price_kobo INTEGER NOT NULL CHECK(unit_price_kobo > 0),
  total_kobo INTEGER NOT NULL CHECK(total_kobo > 0),
  commission_kobo INTEGER NOT NULL DEFAULT 0 CHECK(commission_kobo >= 0),
  seller_earning_kobo INTEGER NOT NULL DEFAULT 0 CHECK(seller_earning_kobo >= 0),
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK(payment_status IN ('unpaid','paid','refunded')),
  status TEXT NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','accepted','processing','fulfilled','cancelled')),
  delivery_details TEXT NOT NULL DEFAULT '',
  buyer_note TEXT NOT NULL DEFAULT '',
  admin_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_buyer ON marketplace_orders(buyer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_seller ON marketplace_orders(seller_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_status ON marketplace_orders(status, payment_status);

CREATE TABLE IF NOT EXISTS marketplace_payout_requests (
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL REFERENCES marketplace_sellers(id),
  amount_kobo INTEGER NOT NULL CHECK(amount_kobo > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','paid','rejected')),
  payout_reference TEXT NOT NULL DEFAULT '',
  admin_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_marketplace_payouts_seller ON marketplace_payout_requests(seller_id, created_at DESC);

CREATE TABLE IF NOT EXISTS marketplace_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO marketplace_settings(setting_key, setting_value) VALUES ('commission_percent', '0');
