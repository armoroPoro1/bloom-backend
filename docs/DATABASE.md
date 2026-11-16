# Database map

The 1.2.0 package contains **37 application tables in six SQL migrations**, plus the runtime-managed `schema_migrations` table. Migration 005 extends existing order tables; migration 006 adds durable upload deletion. The original migrations `001`–`005` remain unchanged.

The same migration files are used by the PostgreSQL and PGlite adapters. The production database is accessed by the Node service, not directly by the browser.

## Tables by responsibility

| Migration                  | Tables                                                              | Responsibility                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 001_core.sql               | users, sessions, used_refresh_tokens, account_tokens, auth_attempts | Accounts, hashed credentials/tokens, replay detection and failed-login counters                                                     |
| 001_core.sql               | uploads, mail_outbox                                                | Private file metadata and asynchronous account mail                                                                                 |
| 001_core.sql               | audit_events, notifications, settings, page_visits                  | Server history, user inbox, public settings and page-usage events                                                                   |
| 002_catalog.sql            | shops, categories, products, stock_movements                        | Store applications, public availability, integer-satang prices and audited inventory                                                |
| 003_commerce.sql           | addresses, cart_items, wishlists                                    | Customer-owned shopping state                                                                                                       |
| 003_commerce.sql           | promotions, promotion_uses                                          | Scoped discount rules and one recorded use per checkout                                                                             |
| 003_commerce.sql           | checkout_groups, checkout_requests                                  | Multi-store checkout grouping and buyer/request idempotency                                                                         |
| 003_commerce.sql           | orders, order_items, order_events, order_payment_proofs             | Store-specific orders, immutable snapshots, history and proof review                                                                |
| 003_commerce.sql           | reviews                                                             | Delivered-purchase feedback, replies and moderation                                                                                 |
| 004_wellness.sql           | articles, article_bookmarks                                         | Public/draft editorial content and private bookmarks                                                                                |
| 004_wellness.sql           | foods, meal_templates, meal_template_entries                        | Admin-managed food catalogue and reusable plans                                                                                     |
| 004_wellness.sql           | exercise_templates                                                  | Reusable seven-day schedules                                                                                                        |
| 004_wellness.sql           | meal_entries, exercise_entries, health_profiles                     | Owner-only diary, copied schedule and self-entered profile                                                                          |
| 005_commerce_lifecycle.sql | Extends orders; no new tables                                       | Payment deadlines and index, no-charge orders, incoming late-payment references, and deterministic upgrade of existing reservations |
| 006_upload_cleanup.sql     | upload_deletion_jobs                                                | Durable physical-file deletion retries with claim generations, availability timestamps and leases                                   |

## Relationships

A user can own one store. A store owns products and its orders. An order belongs to one buyer and one store, while a checkout group can include several orders. Order items retain the purchased product name, price and image reference separately from the current listing.

Cart/wishlist/addresses and personal wellness rows reference their owning user. Template copies and meal snapshots preserve historical information, so editing a source food/template does not rewrite personal records.

Uploads belong to their uploader and have a fixed purpose. Products, articles, avatars and payment proofs refer to upload IDs. The API checks purpose and ownership before adding references. Upload deletion checks both current and historical references.

An unused upload's metadata removal, deletion-job creation and audit entry commit together. `upload_deletion_jobs` deliberately has no foreign key to the removed upload row: it retains the UUID and validated storage key until physical file removal succeeds. Its `attempts` field is also the claim generation, preventing a delayed worker from acknowledging a newer claim. Availability and stale-lease indexes support durable retries. Immediate disk success returns HTTP 200; pending removal returns HTTP 202 with `deleted: true` and `fileRemovalPending: true`, and the deleted metadata can no longer authorize file reads.

## Data rules

- IDs are UUIDs. Human-readable order numbers are a separate unique value.
- Money columns use bigint integer satang with bounded API inputs and safe-number checks. There is no floating-point baht arithmetic in checkout. A financial summary that exceeds the exact JSON safe-integer range fails with HTTP 422 `REPORT_TOTAL_TOO_LARGE`; its individual order rows can still be exported within the CSV row limit.
- Coupon precision is basis points internally; API percentage input/output uses percent.
- Day values use PostgreSQL date and remain strings in the driver. Events use timestamptz.
- Per-store shipping, discount cap and minimum-spend rules match the existing frontend contract.
- Unique constraints protect email identity, one shop per owner, cart/wishlist pairs, product review identity and checkout request keys.
- Stock cannot become negative. Stock changes and movement records share a transaction.
- Lists use bounded pagination; owner/filter/time indexes support the main access paths.
- Product removal is archival, preserving historical orders and image references.
- Public review reads and wishlist saves use the same availability rules as product detail: active/unarchived product, active category, approved shop and unblocked owner. Zero stock alone does not hide a listing.
- Payment-proof history remains separate from order events and is exposed through a paginated buyer/admin-only route. A store seller cannot obtain customer proof references or review reasons; seller accounts retain buyer access for their own purchases.
- The server enforces authorization before and inside relevant mutations. This package is not a browser-accessible database service.

## Migrations and restoration

Applied migration checksums are checked on every migration run. Run `npm run db:migrate` before starting 1.2.0: existing 1.1.0 installations verify `001`–`005` and apply `006_upload_cleanup.sql`; older installations also apply any missing preceding migrations. Add a new numbered migration for later changes; do not edit already-applied SQL. Review `OPERATIONS.md` before deployment and back up both database records and the corresponding upload directory.

`GET /ready` and automatic background-job ticks check that every packaged migration has the expected recorded checksum. Missing/mismatched migrations prevent readiness and background processing until corrected; these checks do not apply SQL automatically.

Order `payment_due_at` is present only for pending transfer orders whose payment state is unpaid or rejected. The expiry worker locks one order at a time and uses the same stock-release invariant as manual cancellation. Zero-total orders use the server-selected `no_charge` method. Incoming transfer references and receipt times are private financial metadata, separate from outgoing refund references. Migration 005 backfills a deterministic 24-hour window for legacy unpaid/rejected reservations; future deadlines use the configured window.

With `BACKGROUND_JOBS=true` (the default), API mail/maintenance jobs share its existing database handle. Mail runs immediately and at the configured 10-second default interval; maintenance runs immediately and at the 60-second default interval. Each job is nonoverlapping within one process. PostgreSQL workers coordinate order/file/message claims through row locks and leases. Upload deletions retry with a ten-minute lease and backoff capped at one hour; they persist until removal is acknowledged. Mail's five-attempt budget is separate: an exhausted stale lease becomes terminal failed and its sensitive body is scrubbed.

The PostgreSQL test mode isolates each fixture in its own random schema. The local persisted PGlite mode is single-process development storage: automatic jobs are supported within the API, but a separate migration/mail/maintenance command must not open that same directory while the API is running. The verification record states which engine was actually exercised.
