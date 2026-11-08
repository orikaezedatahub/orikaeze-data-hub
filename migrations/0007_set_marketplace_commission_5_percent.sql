-- Set the owner-approved marketplace commission rate for new orders.
-- Existing orders keep the commission amount already recorded on each order.
INSERT INTO marketplace_settings (setting_key, setting_value, updated_at)
VALUES ('commission_percent', '5', CURRENT_TIMESTAMP)
ON CONFLICT(setting_key) DO UPDATE SET
  setting_value = excluded.setting_value,
  updated_at = CURRENT_TIMESTAMP;
