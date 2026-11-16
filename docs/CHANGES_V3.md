# Completeness review — release 1.2.0

This release addresses concrete gaps found after the 1.1.0 standalone backend handoff. The React frontend, pink theme, original written requirements and Context Diagram remain unchanged. No frontend integration, external provider connection or deployment is included. `CHANGES_V2.md` remains the historical 1.1.0 record; `REQUIREMENTS_COVERAGE.md` maps the implemented scope, and `VERIFICATION.md` records exact test results.

## Automatic jobs during normal startup

`npm run dev` and `npm start` now run account mail and maintenance automatically using the API's existing database handle. This works inside the single PGlite API process as well as with PostgreSQL.

| Configuration                  | Default | Accepted values   |
| ------------------------------ | ------- | ----------------- |
| `BACKGROUND_JOBS`              | `true`  | `true` or `false` |
| `MAIL_INTERVAL_SECONDS`        | `10`    | Integer 1–3600    |
| `MAINTENANCE_INTERVAL_SECONDS` | `60`    | Integer 5–3600    |

Each job attempts a first tick immediately after listening, then runs at its configured interval without overlapping its own batch. Every tick checks database readiness and packaged migration checksums. Deferred/failed ticks retry later instead of applying schema changes implicitly. SIGINT/SIGTERM stops scheduling and claiming further work, drains current jobs/HTTP requests, then closes the database.

Background mail handles up to 20 messages per batch. Maintenance handles up to 100 due order reservations, up to 50 queued file deletions and authentication/sent-mail retention cleanup. Standalone mail and maintenance commands remain available for one-shot or separately scheduled operation. A separate command must not open the same PGlite directory while the API is running; use the automatic shared-handle jobs or stop the API first. PostgreSQL workers coordinate claims through existing row locks and leases.

## Durable file deletion

Migration `006_upload_cleanup.sql` adds `upload_deletion_jobs`. An authorized unused-upload deletion checks current/historical references, removes metadata, creates a cleanup job and records its audit entry in one database transaction. Referenced uploads remain protected.

The API attempts physical deletion immediately after commit:

- HTTP 200 with `deleted: true` means physical removal completed.
- HTTP 202 with `deleted: true, fileRemovalPending: true` means the metadata is already removed and physical cleanup remains queued. The upload ID can no longer be read or referenced and must not be reused by a client.

Both successful response variants are explicitly described in live Swagger and the generated OpenAPI schema, including the required `fileRemovalPending: true` field on HTTP 202.

Jobs survive process restarts. Cleanup uses a ten-minute claim lease, attempt-generation checks and exponential retry delay capped at one hour. Missing files count as success, including after a crash between physical deletion and acknowledgment. Other disk failures remain queued without a fixed terminal attempt cutoff. Shutdown finishes a claimed attempt and stops before claiming another. This tracks requested deletions after the migration; it does not scan for untracked old filesystem orphans.

## Account and mail concurrency corrections

Password and email changes now recheck the originating access-token hash, access/absolute-session expiry, blocked state and current identity inside the write transaction after password verification/hashing. A request already in flight when logout, refresh rotation or another revocation invalidates its token cannot later commit the sensitive change. Existing login identity checks and absolute refresh lifetime behavior are retained.

Mail acknowledgments and failure updates now match their own claim generation, preventing a delayed worker from overwriting a later worker's result. A stale processing lease at the fifth send attempt becomes terminal `failed`, its lease is cleared and its sensitive body is scrubbed. There is no sixth send. Successful sends and terminal send failures also clear the stored body. SMTP delivery remains at least once: a process can fail after a remote server accepts mail but before its acknowledgment is stored.

## Commerce corrections and proof-history workflow

- Added `GET /api/v1/orders/:id/payment-proofs` for buyer/admin-only paginated upload/review history, including rejected proofs after replacement. Store sellers and unrelated accounts cannot read customer proof IDs/reasons; a seller purchasing from another store retains buyer access.
- Public product reviews and wishlist saves now use the same public availability rules as product detail. Draft/archived products, inactive categories, suspended shops and blocked owners are unavailable. Zero stock alone does not hide an otherwise public listing. Own reviews and authorized management queues retain history.
- Financial summaries reject unsafe aggregate integers with HTTP 422 `REPORT_TOTAL_TOO_LARGE` instead of emitting rounded monetary totals. Narrow filters or export exact order rows as CSV within the existing 10,000-order limit. The separate row-limit error remains `REPORT_TOO_LARGE`.
- The order-expiry worker accepts an optional shutdown signal. A claimed order finishes cancellation/restocking atomically before the worker stops claiming additional orders.

## Proxy configuration and generated API handoff

`TRUST_PROXY_CIDRS` accepts explicit comma-separated IPv4/IPv6 addresses or bounded CIDRs and defaults to no trusted proxies. Wildcards, `/0`, hostnames and hop-count shortcuts are rejected. Configure only trusted direct proxies and require the ingress to replace client-supplied forwarding headers. HTTP rate-limit counters remain per process; shared enforcement is a separate deployment concern.

`npm run openapi` generates both `docs/openapi.json` and `docs/API_INDEX.md` from current route registrations. The release contains **165 operations across 123 paths, 37 application tables and six migrations**. The generated index should not be edited by hand. Handoff documents now explain deferred HTTP 202 upload deletion, private proof history, report errors, automatic jobs and the migration path.

## Upgrade and verification boundaries

Back up the database and upload directory, then run `npm run db:migrate` before starting this version:

- From 1.1.0, apply migration 006.
- From 1.0.0, apply migrations 005 and 006 in order.
- Migrations 001–005 remain unchanged. Do not reset the database or reseed over existing data as an upgrade procedure.

Regression coverage resides in the commerce, authentication-race, mail, background-job, proxy and upload-cleanup tests. The populated 001–004 to 006 migration-upgrade fixture now applies both migrations 005 and 006 and honors `TEST_DATABASE_URL`, so the selected native PostgreSQL run exercises that fixture rather than silently falling back to PGlite. Tests specifically about PGlite persistence remain PGlite-specific.

Consult `VERIFICATION.md` for final counts, database versions, outcomes and evidence. Source/configuration coverage does not imply that React integration, Docker, remote CI, a payment/courier provider or an actual external SMTP account has been exercised.
