# Completeness review — release 1.1.0

This release responds to the request to find and implement remaining backend gaps after the first ZIP. It preserves the original Node.js/TypeScript scope and leaves the React frontend unchanged. The checked requirements are mapped in `REQUIREMENTS_COVERAGE.md`; actual test results are recorded in `VERIFICATION.md`.

## Order and payment lifecycle

- Added configurable unpaid transfer reservation deadlines (`PAYMENT_RESERVATION_MINUTES`, default 1440).
- Added a reusable expiry worker and wired it into maintenance. Expiry locks orders, commits cancellation, releases stock once and records system events without impersonating a user.
- Proofs awaiting review and paid orders are excluded. A rejected proof starts a new payment window. Late proof submission expires the due order before returning a conflict.
- Added server-selected `no_charge` for zero-total orders, including a zero-total store in a mixed checkout. No proof or refund obligation is required for zero money.
- Added administrative late-payment recording on a cancelled order. It moves to a refund obligation while the order remains cancelled and stock remains released; recording/refunding does not call a bank.
- Added audited correction of carrier/tracking for an already shipped order.
- Fixed idempotent replay of an already completed development-payment checkout after that development feature is disabled.
- Kept coupon usage consistent with the existing checkout-use policy; cancellation and expiry do not erase usage history or silently return quota.

Migration `005_commerce_lifecycle.sql` adds deadlines and reconciliation metadata, extends the payment-method constraint and upgrades legacy pending reservations/zero-total orders. Migrations 001–004 remain byte-for-byte unchanged. Existing installations run migrations before this application version starts.

## Store, catalogue and admin corrections

- Product, shop and member searches treat percent, underscore and backslash as literal user input.
- Site contact email can be cleared with an empty string while nonempty values still require valid email syntax.
- Sellers can reduce stock that was legitimately restored above the normal input cap by a cancellation. Additional over-cap increases and negative balances are still rejected.
- Usage reports return an explicit size error rather than silently dropping results beyond 5000 day/page groups; report dates stay calendar-date strings.
- Shop owners can view admin-assigned images on their draft/inactive/archived products. Other users cannot see these files, and payment-proof permissions are unchanged.

## Wellness and content

- Public/admin article searches match every literal word across title, subtitle, category, tag and paragraph content.
- Saved articles support combined search/category/tag filters with account-scoped totals.
- `GET /articles/filters` discovers categories and tags across all published articles; `GET /foods/groups` discovers groups across all active foods. These do not expose drafts or inactive-only values.
- Calorie calculation uses consistent decimal half-up rounding. Daily/export totals sum the same rounded entries shown to users.

## Accounts, privacy and operation

- Access-token expiry and `expiresIn` are capped by the remaining absolute refresh lifetime.
- Login rechecks the current email after password verification, preventing an in-flight login using an address changed before session creation.
- Authentication and protected responses include `Cache-Control: private, no-store`, including protected validation errors.
- CORS exposes request IDs, retry guidance and export filenames to the configured frontend origins.
- Recovery emails contain customer-facing instructions and expiry information without implementation notes.
- Invalid SMTP URLs, public/frontend links and reservation-window values are rejected at configuration loading.
- Readiness now checks database connectivity and every packaged migration checksum; missing/pending/changed migrations return HTTP 503 while liveness remains separate.
- Notification filters and pagination are now explicit in OpenAPI.

## Handoff and integration boundary

The ZIP includes updated request schemas, endpoint index, integration mapping, operational instructions, requirement coverage and regression tests. No dependencies were added for these changes. PostgreSQL and PGlite use the same SQL migrations.

Frontend API wiring and browser integration tests remain for the next authorized phase. External payment, carrier, SMTP account, hosting, backups and deployment configuration remain explicit setup tasks. Docker and GitHub Actions configuration are supplied; their remote execution is not implied by local tests.
