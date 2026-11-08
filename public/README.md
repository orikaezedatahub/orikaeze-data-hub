# ORIKAEZE HUB Marketplace staging preview

This folder is deployed only by `.github/workflows/marketplace-staging.yml` to the isolated staging Worker.

- `/marketplace.html`: public product catalogue
- `/account.html`: isolated staging customer registration and login
- `/seller.html`: seller application and seller workspace
- `/marketplace-admin.html`: private owner control panel

The staging preview uses the staging D1 database and must never be used for live customer purchases. It is separate from the production data and airtime checkout.

Owner access requires the GitHub repository secrets `MARKETPLACE_ADMIN_EMAIL` and `MARKETPLACE_ADMIN_PASSWORD`. Do not put credentials in source files.


Staging owner credentials are configured through GitHub Actions repository secrets.
