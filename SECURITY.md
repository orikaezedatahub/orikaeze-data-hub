# ORIKAEZE HUB Security Notes

## Security changes in this branch

- API responses include defensive headers: content-type sniffing protection, clickjacking protection, restrictive referrer policy, restricted browser capabilities, no-store caching, HSTS, and cross-origin isolation policies.
- Founder admin login is rate-limited to 5 attempts per 15 minutes per IP/account combination.
- Customer login is rate-limited to 10 attempts per 15 minutes per IP/account combination.
- Registration is rate-limited to 5 attempts per hour per IP.
- Rate-limit keys are SHA-256 hashes; raw client IPs and account identifiers are not stored in this table.
- Active lockouts do not extend on every blocked request.
- Founder admin sessions expire after 4 hours. Admin token storage in the admin page is session-scoped rather than persistent local storage.
- Existing password hashing, hashed session tokens, Paystack signature verification, server-side order amount verification, and existing VTU flows are retained.

## Staging-first deployment

Do not deploy this branch to the production Worker until the Preview has been tested.

1. The Preview binding must point to the separate D1 database `orikaeze-data-hub-staging`, never the production database.
2. Copy the production database **schema only** (CREATE TABLE / CREATE INDEX statements, no customer or transaction rows) into the staging database. The application baseline schema is currently maintained in the existing production D1 database rather than in a complete initial migration file.
3. Apply the repository migrations to the staging database using the separate migration config:

   ```sh
   npx wrangler d1 migrations apply PREVIEW_DB --remote --config wrangler.preview-migrations.toml
   ```

   This applies the admin-session and security-rate-limit tables. Do not point this command at the production database.
4. In Cloudflare Settings, configure the Preview environment variables/secrets for this Worker (`ADMIN_EMAIL`, `ADMIN_PASSWORD`, and `ALLOWED_ORIGIN`). After changing Preview secrets, trigger a new Preview deployment so the running Worker loads the saved values. Use a dedicated test administrator email/password. Do not copy live Paystack or MELE secrets into Preview; payment and provider delivery must not be tested with live credentials.
5. Test Preview registration, customer login, admin login/session expiry behavior, and read-only API behavior. Confirm the Preview uses only the staging D1 database.
6. Only after those checks pass should the changes be considered for production release.

The production D1 database already has the `security_rate_limits` table, confirmed by the owner. Do not rerun migration 0003 manually against production. The existing production Worker remains unchanged until a reviewed release is deployed.

## Cloudflare dashboard hardening still required

These account-level controls cannot be safely changed through the repository:

1. Enable Cloudflare WAF managed rules for the Worker hostname/zone where available.
2. Add edge rate-limiting rules for `/api/admin/login`, `/api/auth/login`, and `/api/auth/register`.
3. Keep `MELE_SECRET_KEY`, `PAYSTACK_SECRET_KEY`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD` as Worker secrets/variables only. Never put them in frontend files or Git.
4. Use a unique, randomly generated administrator password of at least 16 characters and do not reuse it elsewhere.
5. Restrict GitHub repository write access to trusted maintainers and enable two-factor authentication on the GitHub account.
6. Review Cloudflare Worker logs and D1 backups regularly.

## Scope and limitations

This is a security hardening baseline, not a guarantee that the service cannot be attacked. The marketplace is not implemented by these changes. Seller roles, product uploads, marketplace orders, and seller payouts must receive their own authorization and validation checks before those features launch.

The Preview database and Cloudflare dashboard controls are external deployment steps. Creating this file or merging the branch does not apply them automatically.
