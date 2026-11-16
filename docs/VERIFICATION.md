# Backend verification record — release 1.2.0

## Integration-documentation revision

The archive was subsequently updated on 14 November 2026 with `CLAUDE_INTEGRATION.md`, the frontend file map, planned acceptance checklist and aligned handoff instructions. This update changes documentation only. Runtime code, dependency manifests/lockfile, scripts, tests, SQL migrations and runtime configuration were compared byte-for-byte with the previously verified 1.2.0 archive and remain unchanged. The test results below are retained baseline evidence; the backend suites were not rerun merely for this documentation update. Connected React/browser integration has not been performed by preparing these documents. All 67 named integration acceptance cases and responsive checks remain planned.

Verified on **14 November 2026**, using **Node.js v24.22.1** on Linux. These are observed local results for the standalone backend in this ZIP. The existing pink React frontend was unchanged and was not integrated.

## Results

| Check                                      | Observed result                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Dependency installation from the lockfile  | `npm ci --no-audit --no-fund` passed                                                              |
| Strict TypeScript                          | `npm run typecheck` passed                                                                        |
| Compiled build                             | `npm run build` passed                                                                            |
| Default PGlite suite                       | **85 passed, 0 failed, 0 cancelled, 0 skipped**; 137.130 seconds                                  |
| PostgreSQL 17.11 mode                      | **85 passed, 0 failed, 0 cancelled, 0 skipped**; 78.662 seconds                                   |
| Populated legacy upgrade                   | **001–004 → 001–006 passed on both database drivers**                                             |
| Native test cleanup                        | **0 residual isolated test schemas**; temporary PostgreSQL server stopped                         |
| Actual compiled server entrypoint over TCP | Liveness 200; readiness **503 before migrations**, **200 after**; article filters 200             |
| Automatic jobs in the compiled server      | Local mail delivered and acknowledged; queued upload physically removed                           |
| Graceful compiled-server shutdown          | SIGTERM exited with code 0 before migrations and after jobs; persisted state survived reopen      |
| OpenAPI and index generation               | Passed together; **165 API operations across 123 paths**, version 1.2.0                           |
| Schema                                     | **6 migrations, 37 application tables**, plus `schema_migrations`                                 |
| Existing migration compatibility           | Migrations **001–005 byte-identical** to the delivered 1.1.0 ZIP                                  |
| Source/export consistency                  | Every frozen runtime, test, migration, package and configuration file matched the tested snapshot |
| Production dependency audit                | **0 reported vulnerabilities** at the time of the check                                           |

Evidence included with the source:

- [PGlite test output](test-results-pglite.txt)
- [PostgreSQL test output](test-results-postgres.txt)
- [Native PostgreSQL validation summary](postgres-validation.json)
- [Compiled server smoke result](compiled-smoke.json)
- [Dependency audit output](dependency-audit.json)
- [OpenAPI document](openapi.json) and [generated API index](API_INDEX.md)
- [Database map](DATABASE.md)
- [Export metadata](../SOURCE_VERSION.json)
- `FILE_MANIFEST.sha256` in the archive root

The dependency audit describes advisories reported by that check. It is not proof that every possible security defect has been eliminated.

## Database coverage

The default run used actual migrated PGlite databases and completed in **137129.843713 ms**. The file persistence test opens a disk-backed database, closes it and reopens it to check that committed data survives restart.

The second run used a native **PostgreSQL 17.11** server (`server_version_num=170011`) through localhost TCP with password authentication. `TEST_DATABASE_URL` selected the pooled PostgreSQL adapter for all shared database fixtures, including background jobs, auth, uploads, commerce, concurrent checkout and the populated legacy migration test. Each fixture used its own randomly named schema, applied real migrations and dropped its schema afterward. The complete run took **78661.928859 ms**.

The populated upgrade fixture first loads migrations 001–004 and creates historical orders, items, payment proofs and stock. It then applies 005 and 006 and checks payment deadline backfill, a fresh deadline after a recent proof rejection, zero-total conversion, preserved historical item values, an initially empty upload deletion queue and repeat-migration idempotence. The native run explicitly reported `Populated 001–004 to 006 migration upgrade driver: postgres`; this case took **212.213747 ms**. The previous release's PGlite-only limitation for this fixture is resolved.

The dedicated **file persistence** test remains intentionally PGlite even during PostgreSQL mode. PostgreSQL coverage therefore means the full suite passed with shared fixtures on PostgreSQL; it does not mean a PGlite persistence test was converted into a PostgreSQL file test.

Native PostgreSQL exercised pooled connections, row locks, serializable transactions and retry behavior, including competing buyers, stock contention, coupon limits and checkout replay. At completion, the validation harness found **zero** remaining `bloom_test_...` schemas and stopped the temporary server. The PostgreSQL binary/harness is not shipped or required by the backend package; PostgreSQL connectivity uses the existing `pg` dependency.

## Test suites

| File                           |  Tests | Main coverage                                                                                                                                       |
| ------------------------------ | -----: | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/auth.test.ts`           |     11 | Registration/login, profile/password, sessions, refresh replay, recovery, verification, ownership, rate limiting, docs and production configuration |
| `tests/auth-lifecycle.test.ts` |      5 | Absolute expiry, stale login identity, no-store/CORS, migration readiness and configuration validation                                              |
| `tests/auth-races.test.ts`     |      3 | Sensitive changes cannot commit after newer email changes, logout, blocking or bearer rotation                                                      |
| `tests/background.test.ts`     |      4 | Shared-handle real jobs, disabled jobs, readiness recovery, no overlap and shutdown drain                                                           |
| `tests/catalog.test.ts`        |     13 | Seller approval/suspension, product/category/stock ownership, visibility, admin, literal search and safe PATCH                                      |
| `tests/commerce.test.ts`       |     18 | Atomic checkout, concurrency, proof history/privacy, expiry, zero-total, late payment, shipment, reviews, reports and populated upgrade             |
| `tests/db.test.ts`             |      2 | File persistence, migration idempotence, rollback and owner-scoped notifications                                                                    |
| `tests/mail.test.ts`           |      5 | Exhausted leases, stale-worker fencing, retry bounds/body clearing, abort and transport cleanup                                                     |
| `tests/proxy.test.ts`          |      3 | Explicit IP/CIDR configuration and trusted/untrusted forwarded-address rate limiting                                                                |
| `tests/seed.test.ts`           |      2 | Repeatable development seed and production protection                                                                                               |
| `tests/upload-cleanup.test.ts` |      4 | Storage failure/recovery, crash after unlink, missing files, stale claims, long-lived retry and abort                                               |
| `tests/uploads.test.ts`        |      5 | Real image bytes/re-encoding, private access, rejected inputs and protected references                                                              |
| `tests/wellness.test.ts`       |     10 | Published content, bookmarks, meal/exercise snapshots, decimal calories, private export/deletion and PATCH                                          |
| **Total**                      | **85** | Multiple HTTP and SQL assertions per test                                                                                                           |

HTTP tests assemble the real Fastify application and exercise actual SQL migrations and mutations. Commerce and authorization are not replaced with mocked repository responses. Mail failure/concurrency tests deliberately mock the SMTP transport; file/race tests use controlled failures to reach the regression. No external email is sent by these tests.

## Changes verified in this review

Coverage increased from **61 to 85 tests**: 24 new cases, with existing cases expanded where appropriate. No dependency versions changed. See [release changes](CHANGES_V3.md) and [requirement coverage](REQUIREMENTS_COVERAGE.md) for the implementation mapping.

### Automatic operation and shutdown

The API's job runner uses its existing database handle. Tests observed automatic private development mail delivery, expiry of an unpaid order, exactly-once stock restoration, queued file removal and retention cleanup. Disabled jobs left pending work untouched. A migration checksum mismatch prevented processing, and processing resumed after the checksum was restored. A slow send did not start an overlapping mail batch; shutdown waited for the claimed send and left the next message pending.

The separate compiled smoke check spawned **`dist/src/server.js`**, used a real loopback HTTP listener and a persisted local database, and observed readiness 503 before migrations. After stopping the process, applying migrations and queuing work, it restarted the compiled server and observed readiness 200, actual mail-file delivery and physical upload deletion. Both SIGTERM shutdowns exited normally. Reopening the database confirmed the mail acknowledgement/body removal and an empty deletion queue.

### Account and file race recovery

Sensitive account changes recheck the session, presented bearer and current identity inside the write transaction. Tests reproduce invalidation during work rather than merely sending already-invalid tokens. An old email/password request cannot overwrite a newer identity or commit after logout/blocking/rotation.

Mail tests reproduce worker takeover and an abandoned fifth attempt. A delayed worker cannot overwrite a newer delivery outcome; terminal messages lose sensitive body content and do not receive a sixth send. Delivery remains at least once because an external mail service and SQL acknowledgement cannot form one database transaction.

Upload deletion now commits metadata removal and a durable cleanup job atomically. A physical storage error yields HTTP 202 while API access is already removed. The generated and live Swagger contracts both describe HTTP 200 and HTTP 202, and the regression checks the documented 202 fields against the actual response. Tests repair the storage failure and retry, recover after unlink without acknowledgement, accept `ENOENT`, fence stale generations and retain jobs beyond 100 failed attempts with capped delay. Migration 006 tracks new deletions; it does not discover older untracked orphan files automatically.

### Marketplace consistency and exact money

Private payment-proof history contains original/replacement proof references, review decisions and reasons, with pagination and deterministic ordering. Tests deny store sellers and unrelated users while allowing the buyer/admin and a seller account purchasing as a buyer.

Public reviews and wishlist saves follow public product visibility across product, category, shop and owner status. Zero-stock public products remain readable and saveable. Oversized sales aggregates now return **422 `REPORT_TOTAL_TOO_LARGE`** rather than silently rounding an integer-satang total; individual CSV rows remain exact.

Proxy tests send forged `X-Forwarded-For` values from untrusted peers and still reach the same rate limit. Only an explicitly configured trusted direct proxy can supply distinct client addresses, and repeatedly supplying the same address is still limited. Rate-limit counters remain local to each API process.

## Boundaries

- **React was not integrated or changed.** No browser end-to-end test of a connected frontend was performed. The reference frontend commit remains `563a659eee0e25cdb8b1a21516345b2fcccea05d`, with a clean worktree.
- No live bank transfer, gateway charge/refund or courier lookup was performed. Payments use administrative proof review and manual refund records; tracking is seller-entered.
- No external SMTP account, hosted database, bucket or hosting service was connected. Tests used private development mail files or mocked SMTP transport and local storage.
- Docker and PostgreSQL-backed GitHub Actions configuration are included. Docker builds and remote Actions runs were not executed here.
- Local native PostgreSQL verification is not a load, failover or hosting-provider acceptance test. TLS, persistent volumes, real SMTP delivery, backups, exact proxy trust and shared rate limiting for multiple replicas still depend on the chosen deployment.

When frontend integration is authorized, follow `FRONTEND_INTEGRATION_PLAN.md` and test the connected browser journeys as their own stage. Apply the shipped migrations before starting an upgraded API; retain existing data and do not edit applied migration files.
