# Running and operating the backend

## Runtime and commands

The package was exercised with Node.js v24.22.1. Runtime code is TypeScript compiled to `dist/src`; scripts compile to `dist/scripts`. Run from the project root so `migrations` resolves correctly.

```sh
npm ci
npm run db:migrate
npm run build
npm start
```

Use `npm run dev` during development. The environment template defaults to a persisted local PGlite database. Production requires PostgreSQL, HTTPS public/frontend URLs, configured SMTP and development payments disabled.

No service has been deployed as part of this handoff.

`GET /health` reports process liveness. `GET /ready` returns 200 only when the database is reachable and every migration shipped with this version has the expected recorded checksum. A missing migration table, pending migration, changed checksum or unavailable database returns 503 with `NOT_READY`. Database internals are not returned in the public error. Readiness does not apply migrations; run the migration command before moving traffic to an updated instance.

## Migrations

SQL migrations are applied in filename order, in a transaction, and recorded with checksums in `schema_migrations`. PostgreSQL uses an advisory lock to serialize concurrent migration runners. Re-running unchanged migrations is safe. Modifying an already-applied migration produces an explicit error: add a new numbered migration instead.

Run migrations as a deployment step before serving the new API. The server does not silently mutate schemas at startup. Use a database role with migration privileges for that step and a restricted application role for normal operation.

For an existing 1.1.0 database, run `npm run db:migrate` before starting 1.2.0. It verifies unchanged migrations `001`–`005` and applies `006_upload_cleanup.sql`, which adds the durable file-deletion queue. Do not edit or manually reapply the original five SQL files. Back up the database and upload directory before the upgrade. An installation upgrading from an earlier version also receives any missing migrations in order.

The PostgreSQL adapter uses a connection pool of 10 connections and a 15-second statement timeout. Multi-record mutations run at serializable isolation and retry serialization/deadlock errors up to three attempts. Keep transaction callbacks free of external side effects.

PGlite is a local, single-process development database. Its adapter serializes operations. The API's automatic mail and maintenance jobs safely share its existing database handle; they do not open another PGlite process. Do not run several local API/worker processes against the same PGlite data directory. Stop the development API before invoking a separate migration, mail or maintenance command against that directory, or use PostgreSQL for concurrent services.

## PostgreSQL and Docker

`compose.yaml` supplies a local PostgreSQL 17 database with a named volume and a loopback-only port. Set `POSTGRES_PASSWORD` before `docker compose up -d db`, then configure the API's `DATABASE_URL` with the same credentials.

`Dockerfile` builds the API and runs as the non-root `node` user. Production configuration is intentionally mandatory; do not ship development seed credentials. Example deployment sequence with your own environment and persistent upload volume:

```sh
docker build -t bloom-backend .
docker run --rm --env-file .env.production bloom-backend node dist/scripts/migrate.js
docker run --rm --env-file .env.production bloom-backend node dist/scripts/create-admin.js
docker run -d --env-file .env.production -p 127.0.0.1:4000:4000 -v bloom_uploads:/app/var/uploads bloom-backend
```

Set `HOST=0.0.0.0` inside a container and put a TLS reverse proxy in front. Environment, DNS, certificates, database reachability and email credentials are deployment choices not configured by this source export. The example commands are supplied instructions; this environment did not run Docker.

## Admin bootstrap

Set `ADMIN_EMAIL`, `ADMIN_PASSWORD` (at least 12 characters) and optionally `ADMIN_NAME`, then run `npm run admin:create` or its compiled script. It creates a new administrator and fails on an existing email; it does not silently promote or overwrite an existing account.

`db:seed` is development-only and refuses production. It requires a supplied `SEED_DEMO_PASSWORD`, preserves existing records and never resets changed passwords on rerun. Do not run the seed as part of production deployment.

## Automatic background jobs

Normal `npm run dev` and `npm start` startup enables mail delivery and maintenance in the API process. Both jobs use the API's existing database handle, including in local PGlite mode.

| Environment variable           | Default | Accepted values   | Behavior                                                   |
| ------------------------------ | ------- | ----------------- | ---------------------------------------------------------- |
| `BACKGROUND_JOBS`              | `true`  | `true` or `false` | Enable the in-process mail and maintenance jobs            |
| `MAIL_INTERVAL_SECONDS`        | `10`    | Integer 1–3600    | Interval between mail ticks; at most 20 messages per batch |
| `MAINTENANCE_INTERVAL_SECONDS` | `60`    | Integer 5–3600    | Interval between maintenance ticks                         |

Each job attempts a first tick immediately after the server starts listening, then runs at its configured interval. A job never overlaps its own previous batch in the same process; mail and maintenance may run independently. Every tick checks database readiness and migration checksums before doing work. Unready schemas and failed ticks defer processing and are retried on later ticks; the worker does not apply migrations itself.

On `SIGINT` or `SIGTERM`, the server stops scheduling/claiming new work and drains in-flight jobs and HTTP requests before closing the database. A claimed order transaction, mail delivery/acknowledgment or file-deletion attempt is allowed to finish; the shutdown signal prevents the next item from being claimed.

Set `BACKGROUND_JOBS=false` when a PostgreSQL deployment deliberately assigns these tasks to separate scheduled workers. PostgreSQL jobs use database row locks, leases and claim generations to coordinate overlapping processes. The API's per-process HTTP rate limiter is a separate mechanism and does not become shared through these worker locks.

## Mail delivery and one-shot worker

With the default background settings, no separate command is needed to deliver local account mail. `npm run mail:worker` (or `node dist/scripts/mail-worker.js` in the image) remains a one-shot operational command: each invocation handles at most 100 messages and exits. Observe the same-directory PGlite restriction above before running it beside an API process.

Messages are claimed with a row lock and a ten-minute lease, sent outside the database transaction, then acknowledged. Each claim increments an attempt generation; a delayed older worker cannot overwrite a newer worker's acknowledgment. Failed sends retry with bounded exponential delay, up to five send attempts. A stale processing lease may be reclaimed after ten minutes only within that send budget. An abandoned fifth-attempt lease becomes terminal `failed` with its lease cleared and message body erased; it does not cause a sixth send. Terminal send failures and successful sends also erase the outbox body, while metadata remains.

SMTP requires TLS in production.

Delivery is at least once: a process failure after SMTP accepts a message but before the database acknowledges it can cause a resend. Messages use stable Message-ID values. Monitor failed/outstanding counts with an operator-only SQL query. There is no public outbox or token-retrieval route.

Without `SMTP_URL`, development messages are private JSON files in `MAIL_DIR`; this is deliberate local delivery, not an external email service.

## Maintenance and retention

The automatic maintenance job and one-shot `npm run maintenance` command use the same implementation. Each complete batch processes up to 100 eligible unpaid bank-transfer order expirations and up to 50 queued upload file deletions, then removes expired sessions, account tokens, expired refresh replay records, login counters older than one day and sent-mail metadata older than 30 days. Shutdown may stop a batch between items; later ticks resume outstanding work.

Order expiration releases reserved stock exactly once. Monitor background-job failures and maintenance summaries, including `expiredUnpaidOrders` and file-cleanup results. Configure the payment window with `PAYMENT_RESERVATION_MINUTES` (default 1440, allowed 5–10080). Submitted proofs awaiting review and paid orders are excluded. Rejected proofs receive a fresh payment window. Quote/new-checkout flows also sweep eligible expired reservations. With `BACKGROUND_JOBS=false`, schedule the standalone maintenance command regularly so cleanup and reservation release continue without customer traffic.

Migration `005_commerce_lifecycle.sql` introduced deterministic payment deadlines and payment reconciliation fields; migration `006_upload_cleanup.sql` adds durable file deletion. Apply all pending migrations before starting this version. See `COMMERCE_API.md` for zero-total orders, tracking corrections, private proof history and late-payment reconciliation; recording a payment or refund is an internal administrative record, not a bank transfer.

Business orders, reviews, stock history and audit events are retained. Personal wellness records have an owner-only deletion/export API. The code does not invent a universal legal retention duration; establish your product's policy before production use.

Audit entries persist server-side. Database administrators can still change database contents; this is not a tamper-proof external audit archive.

## Backups and file storage

Back up the PostgreSQL database and the persistent upload directory as a coordinated pair. Test restoration before relying on backups. Do not put uploads under a temporary container filesystem. Local PGlite development backups should be taken with the process stopped or through an appropriate database export mechanism, not by copying files during writes.

The storage implementation is a configured local directory with private server-generated filenames. S3 or other object storage can be added later behind the upload handling; no third-party bucket is connected.

Deleting an unused upload checks ownership and all current/historical references, removes the metadata, records an audit entry and inserts an `upload_deletion_jobs` record in one database transaction. A referenced file remains protected with HTTP 409. After commit, the API attempts physical removal immediately. Success returns HTTP 200 with `{ "data": { "deleted": true } }`; a retained cleanup job returns HTTP 202 with `{ "data": { "deleted": true, "fileRemovalPending": true } }`. The metadata is already deleted in the latter case, so the API no longer serves the file even if the bytes remain temporarily on disk.

Maintenance retries the durable queue across restarts. File claims have a ten-minute lease, attempts use a generation check before acknowledgment, and retry backoff is capped at one hour. A missing file counts as successful cleanup, including a retry after a crash between physical removal and database acknowledgment. Other disk failures remain queued for retry; there is no five-attempt terminal cutoff for file cleanup. Protect the upload directory from direct public serving and monitor persistent permission/storage failures.

## Network and credentials

Only configured exact CORS origins receive browser permission headers. Cookies are not used for authentication. Keep database/SMTP credentials in server environment variables or a deployment secret store. Never copy them into React `VITE_*` values.

Startup validates SMTP URL syntax and restricts public/frontend links to HTTP(S) without embedded credentials, query strings or fragments. These checks reject unusable configuration before a recovery email is queued; they do not establish that a remote mail server can be reached or will deliver mail.

`TRUST_PROXY_CIDRS` defaults to an empty string, so forwarded client-IP headers are not trusted. When the API is behind a proxy, list only the explicit IPv4/IPv6 addresses or bounded CIDRs of trusted proxies that can connect directly to it, separated by commas. For example, `127.0.0.1/32,::1/128` is appropriate only when the trusted ingress actually uses loopback. Do not list arbitrary client networks. Configuration rejects hostnames, hop counts, wildcards and `/0` ranges.

The trusted proxy must strip or replace client-supplied forwarding headers and construct the upstream client chain itself. Restrict direct API access to the intended ingress so a client cannot impersonate an allowed proxy. This setting controls how the API derives the client IP for logging/rate limits; it does not configure the proxy or TLS for you.

Rate limiting still keeps IP counters per process. Before horizontally scaling, add shared enforcement at the application or trusted ingress layer. Keep database and upload access private, and disable or restrict `DOCS_ENABLED` if the deployment should not expose API docs.

## Testing PostgreSQL

`TEST_DATABASE_URL` selects the PostgreSQL driver in API tests. Each fixture creates a random schema named `bloom_test_...`, applies migrations, and drops only that schema afterward. Use a dedicated test database and a role allowed to create schemas.

GitHub Actions includes PostgreSQL 17 and runs type checking, the API tests, build and OpenAPI generation. The workflow is supplied but was not executed remotely during this task. The local test results and the exact database engine used are recorded in `VERIFICATION.md`.
