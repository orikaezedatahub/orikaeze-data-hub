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

## Required deployment step

Before deploying this branch to production, apply:

```sh
npx wrangler d1 migrations apply orikaeze-data-hub-db --remote
```

This applies `migrations/0003_security_rate_limits.sql`. Do not deploy the Worker changes before the migration is applied: login and registration rate limiting depends on this table.

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

The D1 migration and Cloudflare dashboard controls are external deployment steps; creating this file or merging the branch does not apply them automatically.
