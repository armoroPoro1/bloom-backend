# Claude handoff — Bloom backend 1.2.0

## Goal and current state

The backend was delivered as a standalone Node.js/TypeScript ZIP. The user's latest handoff request is to give Claude concrete instructions to **integrate the existing React frontend with this server**. Start with [CLAUDE_INTEGRATION.md](CLAUDE_INTEGRATION.md) and execute that next phase when working with the user's frontend source.

This package implements the backend with Fastify, SQL migrations, PostgreSQL/PGlite adapters, authentication, authorization, uploads, commerce, seller/admin management and wellness/CMS. This archive revision adds integration instructions only: the existing pink React frontend was not modified or bundled. Do not assume it already calls these APIs. Locate the separate frontend source, preserve the user's changes, and use the supplied file map and acceptance checklist.

Read in this order:

1. CLAUDE_INTEGRATION.md
2. README.md and docs/VERIFICATION.md
3. docs/FRONTEND_FILE_MAP.md and docs/FRONTEND_INTEGRATION_PLAN.md
4. docs/AUTH_AND_FILES.md
5. docs/CATALOG_API.md, docs/COMMERCE_API.md, docs/WELLNESS_API.md
6. docs/OPERATIONS.md, docs/openapi.json and docs/API_INDEX.md
7. docs/INTEGRATION_ACCEPTANCE.md

This release is the next completeness review after 1.1.0. Read docs/CHANGES_V3.md and docs/REQUIREMENTS_COVERAGE.md; docs/CHANGES_V2.md remains the historical 1.1.0 record. The package contains 165 operations across 123 paths and 37 application tables across six migrations. `npm run openapi` regenerates both the OpenAPI file and API index; do not edit the generated index by hand.

Run `npm run db:migrate` to upgrade an existing database. Version 1.1.0 adds migration 006; version 1.0.0 adds 005 and 006. Migrations 001–005 remain unchanged. Back up data, preserve existing records and do not reset or reseed as an upgrade strategy. Stop a same-directory PGlite API before running the separate migration command.

## User constraints

- React frontend, Node.js + TypeScript backend.
- Preserve Bloom's pink interface and the original written/Context Diagram features.
- The pink reference is a style reference only; do not add face analysis, AI chat, fashion or medical advice features from it.
- A seller is also a buyer.
- Seller application requires admin approval.
- No live payment provider, courier, SMTP account, external database or hosting service has been connected in this task.
- Integrate the existing frontend without rewriting its pink interface or replacing its framework.
- The latest integration assignment is defined in CLAUDE_INTEGRATION.md. The documentation update itself does not establish that connected browser journeys have passed.
- Initial integration uses the existing opaque bearer API with both tokens in memory; reload/new tab requires a fresh login. Do not imply persistent cookie authentication already exists.

## Run baseline

Use Node.js 24 to match the checked runtime.

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run openapi
```

For a local run: copy .env.example to .env, set a local SEED_DEMO_PASSWORD of at least 12 characters, run db:migrate, db:seed, then dev. Never invent a configured API key or connection string. No actual .env or local database is shipped.

Use docs/VERIFICATION.md as the source for exact test counts, database engines, outcomes and limits; do not carry forward earlier-release totals as current evidence. `TEST_DATABASE_URL` selects native PostgreSQL fixtures with isolated schemas. The populated 001–004 to 006 migration-upgrade fixture now honors that selection too and applies both migrations 005 and 006. Tests specifically about PGlite persistence remain PGlite-specific.

Normal API startup uses `BACKGROUND_JOBS=true`, `MAIL_INTERVAL_SECONDS=10` (1–3600) and `MAINTENANCE_INTERVAL_SECONDS=60` (5–3600). Mail and maintenance share the existing API database handle, including in PGlite mode. They tick immediately and periodically, check migration readiness, do not overlap their own batches and drain on SIGINT/SIGTERM. Separate CLI workers remain available; do not open the same PGlite directory in multiple processes. See OPERATIONS.md for disabling in-process jobs in favor of separately scheduled PostgreSQL workers.

## Source ownership by concern

- src/app.ts: Fastify assembly, route schemas, auth middleware, CORS, errors, docs.
- src/server.ts: shared database/app lifetime and signal-driven HTTP/job draining.
- src/config.ts: typed environment validation and production requirements.
- src/core/db.ts: common SQL adapter, migrations, pool, transactions and retry.
- src/core/http.ts: errors, validation, casing, audit/notification and CSV helpers.
- src/core/security.ts: password hashing and random-token hashing.
- src/core/mail.ts: leased database outbox, claim-generation acknowledgments, five-attempt budget and development/SMTP delivery.
- src/core/background.ts: immediate/interval mail and maintenance scheduling, readiness gating, nonoverlap and shutdown signals.
- src/core/maintenance.ts: order expiration, durable upload cleanup and authentication/mail retention shared by API jobs and CLI.
- src/core/upload-cleanup.ts: durable file deletion, ten-minute leases, generation checks and persistent retries.
- src/modules/auth.ts: account/session/recovery lifecycle.
- src/modules/uploads.ts: real image decoding, storage/file permissions and atomic metadata/deletion-queue/audit writes.
- src/modules/catalog.ts: catalog, seller application, stock, users, admin settings/audit.
- src/modules/commerce.ts and commerce-domain.ts: cart, checkout, orders, payments, reviews, promotions and reports.
- src/modules/commerce-lifecycle.ts: one-time cancellation/restocking, payment-deadline expiry and order events shared by HTTP flows and maintenance.
- src/modules/wellness.ts: public/admin content and private wellness records.
- src/modules/notifications.ts: account notification inbox.
- migrations/: checked, ordered SQL migrations.
- scripts/: migrations, seed, admin bootstrap, one-shot mail/maintenance and generated OpenAPI/API index.
- tests/: HTTP injection plus real migrated SQL behavior; not mocked repository tests.

## Contracts that matter

- APIs use UUIDs. Frontend demo IDs such as p1/s1/u1 are not server IDs.
- Responses are camelCase; database columns are snake_case.
- Money is integer satang in *Cents fields. Convert at the future frontend boundary, never trust the frontend's calculated totals.
- Coupon percentage input is percent (10 means 10%); database precision uses basis points. Preserve per-store minimum/cap rules from the existing frontend.
- Server sessions use random bearer tokens, hashed at rest, with refresh rotation and replay revocation. No demo role-switch endpoint exists.
- Password/email changes revalidate the originating access token, absolute session expiry, blocked state and current identity inside their write transaction after password work. Preserve this check: an in-flight request must not commit after logout, refresh rotation or revocation invalidates its original token.
- The frontend's local SHA-256 password checks are not compatible with this server. Do not migrate browser password hashes as production credentials.
- Customer/user DTOs never expose password hashes or session hashes.
- Images upload as multipart; private file reads need Authorization and a frontend object URL.
- Upload DELETE returns 200 on immediate physical removal or 202 with `deleted: true, fileRemovalPending: true` when a durable cleanup job remains. Both mean the upload ID is already inaccessible and cannot be reused. Handle asynchronous physical removal without reattaching the deleted ID or exposing private cleanup records.
- PATCH omits unchanged fields. AJV useDefaults=false is intentional: enabling it previously overwrote omitted PATCH values.
- Zod 4 PATCH schemas use partialSchema() to strip defaults from omitted fields; keep that helper instead of replacing it with a plain partial().
- Body coercion remains disabled. The wrapper normalizes typed numeric query parameters only.
- Account, shop, order, upload and personal-health ownership is enforced on the server, not from incoming userId/role fields.
- The server uses parameterized SQL and transactions. Keep identifiers static or validated; never interpolate user values into SQL.
- Dates representing days stay YYYY-MM-DD strings. Report/coupon boundaries use Asia/Bangkok.
- Delete product means archive. Order and meal snapshots preserve historical values after source edits.
- TRUST_PROXY_CIDRS is an explicit comma-separated IPv4/IPv6 address/CIDR allowlist, empty by default. Trust only direct proxies under deployment control and require them to replace client-supplied forwarding headers. Wildcards, /0 ranges, hostnames and hop-count shortcuts are rejected; HTTP rate limits still use per-process counters.

## Commerce invariants

Checkout locks the buyer, sorted product rows, shop/category availability and the coupon, then creates order groups/items/events, stock movements and coupon usage in one transaction. A failed transaction must leave stock, cart and coupon usage unchanged. Idempotency keys belong to a buyer and a request fingerprint; replay returns the same checkout without repeating deductions.

Payment state and fulfilment state are separate. A cancellation restores stock once. Paid cancellation creates a refund obligation; manual refund recording needs a reference and does not transfer money. Payment proof metadata/reasons are private to buyer/admin; seller-only viewers receive generic payment event details. `GET /orders/:id/payment-proofs` exposes paginated historical uploads and review outcomes only to the buyer/admin; a seller acting as the buyer retains that access.

A suspended store cannot accept new orders but can fulfil existing ones. Reviews require a delivered purchase and are unique per customer/product. Hidden reviews leave public rating aggregates. Public review reads and wishlist saves also require a publicly available product, approved shop, active category and unblocked owner; zero stock alone does not hide an otherwise public product. Own review history and authorized management queues are retained.

Payment reservations have server deadlines. Default background maintenance releases due reservations without requiring customer traffic; when in-process jobs are disabled, schedule the standalone maintenance command. Never expire a proof awaiting admin review or an already paid order. Zero-total orders use server-selected no_charge and require no proof. Cancellation of a zero-total order cannot create a monetary refund obligation. Late transfers on cancelled orders are recorded by an admin and proceed toward a manual refund without restoring the cancelled order or reserving stock again. Coupon usage retains its existing checkout-use semantics after cancellation/expiry.

Financial summaries reject unsafe aggregate integers with 422 REPORT_TOTAL_TOO_LARGE instead of rounding monetary values. Narrow report filters or export exact individual order rows as CSV within the 10,000-row limit. Do not silently coerce these failures into zero sales or a partial summary.

Mail and file workers acknowledge only their own claim generation. Mail has a five-send budget: an abandoned fifth lease becomes terminal failed with the sensitive body scrubbed, without a sixth send. Upload deletion retries persist across restarts with backoff capped at one hour and no silent terminal drop. A stale worker must not overwrite a newer acknowledgment.

During integration, handle paymentDueAt, no_charge, shipment corrections, public filter-discovery endpoints and saved-article filters explicitly. Use server-provided calorie totals. Private records and auth responses are no-store; do not add an application cache that leaks account data across sign-outs.

## Integration and later deployment

Complete local integration first using CLAUDE_INTEGRATION.md and the planned acceptance cases. Rewrite synchronous frontend call sites to await actions, preserve drafts on failure, remove demo role authority, and handle /reset-password and /verify-email pathname routes before the existing hash navigation. The frontend's current Node tests do not replace connected browser testing. Record observed integration results in docs/INTEGRATION_REPORT.md when that work is actually performed.

The following deployment follow-ups are separate from local integration; no provider selection or deployment is required merely to connect the two local applications:

1. Reuse the completed API adapter and integrated frontend from the local acceptance stage.
2. Choose the actual PostgreSQL host, run migrations and create the real admin.
3. Configure persistent uploads, TLS, exact CORS origins, secrets, actual SMTP delivery, background-job ownership and backups.
4. Select/configure a real payment provider or bank-verification service only if automatic money handling is wanted. The implemented manual-transfer workflow works without such a provider.
5. Select a courier integration if live carrier tracking is wanted. Existing tracking is seller-recorded.
6. Rerun the PostgreSQL-backed CI/test mode on the chosen deployment stack, then browser integration tests. Consult docs/VERIFICATION.md for the actual release results. Both ordinary API fixtures and the populated legacy-upgrade fixture honor TEST_DATABASE_URL; PGlite alone serializes operations and does not establish real multi-connection PostgreSQL behavior.
7. Before multiple API replicas, configure shared rate limiting and a correctly trusted proxy.

Do not claim external services or frontend integration are complete until they are actually connected and tested. Keep migrations immutable once applied; add new migrations for changes. Use the existing test suites and add focused regression coverage for changed behavior.
