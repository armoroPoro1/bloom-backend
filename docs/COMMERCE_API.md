# Commerce API and integration contract

This document describes the implemented backend. It does not imply that the React frontend has been connected to it. All paths below begin with `/api/v1` and all protected calls require `Authorization: Bearer <accessToken>`.

## Data conventions

- Resource IDs are UUIDs. The human-readable order reference is a separate `number` beginning `BL-`.
- JSON field names use camelCase. SQL columns use snake_case.
- **Money is integer satang**, identified by the `Cents` suffix. For example, `39000` means ฿390.00. Do not send floating baht values as cents.
- Products have `priceCents`; order items keep an immutable `unitPriceCents` snapshot.
- Promotion input/output uses `percent`, for example `10` means 10%. Storage uses `percent_basis_points`, so that input becomes `1000`. Discount calculation uses integer arithmetic and rounds half up to a whole satang.
- Timestamps are instants. Promotion dates and report date filters use calendar dates `YYYY-MM-DD` interpreted in **Asia/Bangkok**.
- Successful resource responses use `{ "data": ... }`. Lists additionally include `page.limit`, `page.offset`, and, where available, `page.total`.
- Request bodies reject unknown properties. A submitted role, buyer ID, shop owner ID, order total or calculated discount cannot override the authenticated actor or server calculation.

## Complete transfer-order example

Use IDs returned by the preceding calls. The example names and amounts are illustrative; IDs are not seeded constants.

### 1. Store an address

`POST /me/addresses`

```json
{
  "label": "บ้าน",
  "name": "ลูกค้าตัวอย่าง",
  "phone": "0800000000",
  "address": "ที่อยู่จัดส่งตัวอย่าง เชียงใหม่",
  "isDefault": true
}
```

The first address becomes the default automatically. At most 20 addresses may be stored. The server validates ownership when checkout uses `addressId`; changing an address later does not change existing orders.

`GET /me/addresses`, `PUT /me/addresses/:id` and `DELETE /me/addresses/:id` read, replace and delete owned addresses. Choosing another default clears the previous default atomically. Deleting the default chooses the oldest remaining address.

### 2. Set cart quantities

`PUT /me/cart/<productId>`

```json
{ "quantity": 2 }
```

This sets the quantity rather than adding 2 repeatedly. Quantity 0 removes the item. The maximum is 100 distinct products and 1,000 units per line, also constrained by available stock.

`GET /me/cart` returns the current product price, stock and availability. `DELETE /me/cart` clears the cart.

After a guest logs in, an integration may call `POST /me/cart/merge`:

```json
{
  "items": [{ "productId": "<product UUID>", "quantity": 1 }]
}
```

The server merges repeated product IDs, combines quantities with the account cart and clips to available stock and line limits. Unavailable products are reported in `skippedProductIds`. The frontend should clear its guest cart only after a successful response. This endpoint exists; no automatic React login integration has been added.

### 3. Request the current server quote

`POST /checkout/quote`

```json
{ "couponCode": "BLOOM10" }
```

An empty string omits the coupon. The result includes `groups` by store and `subtotalCents`, `shippingCents`, `discountCents`, `totalCents` for each group and the combined checkout.

Shipping is calculated per store. The free-shipping threshold uses that store's product subtotal before discount. Promotions apply to eligible stores only. The minimum spend and maximum discount are evaluated **per store**, matching the existing frontend. A site-wide coupon can therefore discount more than one eligible store, while a shop coupon affects its store only.

The quote is informational: checkout recomputes it from current database records and does not accept an asserted client total.

### 4. Upload a transfer proof, optionally

Use `POST /uploads?kind=proof` with one multipart file field named `file`. The kind is a query parameter, not a form field. The uploaded record must belong to the buyer and have kind `proof`.

A transfer order may be created before a proof is uploaded. It then has `paymentStatus: "unpaid"` and a server-issued `paymentDueAt` deadline. A proof can be submitted before that deadline through the order endpoint below. The default window is 24 hours; see reservation expiration below.

### 5. Submit one checkout

`POST /checkout`

Required additional header:

```http
Idempotency-Key: 2b6bf834-b370-4e56-9294-aeaf527f90ed
```

```json
{
  "addressId": "<address UUID>",
  "couponCode": "BLOOM10",
  "paymentMethod": "transfer",
  "proofUploadId": "<optional proof upload UUID>"
}
```

Omit `proofUploadId` when no proof is available; do not send the placeholder text or `null`. `paymentMethod` defaults to `transfer`.

The checkout transaction:

1. Serializes this buyer's cart mutations and checks the account.
2. Checks the idempotency key and request fingerprint.
3. Reads an owned shipping address and any owned proof upload.
4. Locks products in a stable order, checks store/category availability and stock, then locks the coupon.
5. Recomputes amounts and creates one order per store with immutable product, price, image and address snapshots.
6. Deducts stock, records stock movements, payment proof history, order events, notifications and audit entries.
7. Records one coupon use for the entire checkout, clears the cart and saves the idempotency record.

A new checkout returns HTTP 201 with `checkoutId`, calculated amounts, `orders` and `replayed: false`. Retrying the same key and body returns HTTP 200 with the same checkout identity, current order details and `replayed: true`; it does not deduct stock or consume another coupon use. Reusing the key with a different body returns HTTP 409. Use a new key for a new user-confirmed checkout. Idempotency keys are scoped to the authenticated buyer.

The implementation retains checkout idempotency records. There is no automatic expiry/reuse of an old key. A replay includes the same `groups`, `subtotalCents`, `shippingCents`, `discountCents`, `totalCents` and `couponCode` as the original response, reconstructed from immutable order/item snapshots. Current order statuses may have progressed; later product, price, address or promotion edits do not rewrite the replayed checkout amounts. The request fingerprint remains based on the validated request body, including its defaults and trimmed strings.

The `development` payment method exists only when `ALLOW_DEV_PAYMENTS=true` in a nonproduction configuration. It immediately creates a paid development order and does not charge money. Production configuration rejects new checkouts using this option. An already completed, correctly authenticated idempotency replay still succeeds after the development-payment flag is disabled because it creates no payment or new order.

When a store group's server-calculated total is zero, the server assigns `paymentMethod: "no_charge"`, `status: "paid"` and `paymentStatus: "paid"` without requiring a proof or calling a gateway. This internal method cannot be requested by the client. A mixed checkout can contain a no-charge store order and another transfer order with a positive shipping balance. No-charge groups have no payment deadline and receive no proof attachment.

### 6. Admin reviews a transfer proof

`POST /admin/orders/<orderId>/payment-review`

```json
{ "decision": "reject", "reason": "กรุณาส่งภาพที่อ่านจำนวนเงินได้ชัดเจน" }
```

Only an admin can review an order currently awaiting proof review. A rejection requires a reason and leaves the order pending with `paymentStatus: "rejected"`, starting a fresh configured payment-proof window.

The buyer uploads a corrected image, then calls:

`POST /orders/<orderId>/payment-proof`

```json
{ "uploadId": "<new proof upload UUID>" }
```

Only the buyer can submit a proof, and only while the pending transfer order is unpaid or rejected and its deadline has not expired. Submission clears the deadline while admin review is pending. The server retains the previous proof review history. Another user's upload is rejected.

`GET /orders/<orderId>/payment-proofs?limit=20&offset=0` lets the buyer or an admin inspect that retained history, including the original rejected upload after a replacement is submitted. It returns newest submissions first, with deterministic ordering and `page.total`:

```json
{
  "data": [
    {
      "id": "<proof record UUID>",
      "orderId": "<order UUID>",
      "uploadId": "<upload UUID>",
      "status": "rejected",
      "reason": "กรุณาส่งภาพที่อ่านจำนวนเงินได้ชัดเจน",
      "createdAt": "2026-11-14T08:00:00.000Z",
      "reviewedAt": "2026-11-14T08:10:00.000Z",
      "reviewerName": "ผู้ดูแลระบบ"
    }
  ],
  "page": { "limit": 20, "offset": 0, "total": 1 }
}
```

The allowed statuses are `submitted`, `approved` and `rejected`. Review fields are null until a review exists. Limits default to 20 and permit 1–100; offsets permit 0–100,000. Read the image through authenticated `GET /uploads/<uploadId>`. A store seller cannot read proof history for a customer order and receives HTTP 404, as do unrelated accounts. A seller account that is itself the buyer retains normal buyer access. Reviewer email addresses and other administrator profile details are not returned.

Admin approval:

```json
{ "decision": "approve" }
```

Approval records the admin's manual verification, moves the order to `paid`, and sets `paymentStatus: "paid"`. It does not invoke a bank API, charge a card or verify a bank transfer automatically. No external payment gateway is configured.

### 7. Seller fulfils the order

`POST /orders/<orderId>/prepare` starts preparation of a paid order.

`POST /orders/<orderId>/ship`

```json
{ "carrier": "ชื่อบริษัทขนส่ง", "tracking": "TRACKING-REFERENCE" }
```

Only the owning seller or an admin can prepare/ship. A seller whose shop is suspended may finish existing orders; suspension prevents new sales. A repeated prepare request while already preparing is safe. A repeated ship request with the same carrier/reference while already shipped is safe; a conflicting transition is rejected.

`GET /orders/<orderId>/tracking` returns seller-recorded carrier/reference, status and history. It identifies the source as `seller-recorded`. It does not query a courier API.

If the carrier or tracking reference was mistyped, the owning seller/admin can call `PATCH /orders/<orderId>/shipment` while the order is still shipped:

```json
{ "carrier": "ชื่อบริษัทขนส่ง", "tracking": "CORRECTED-REFERENCE", "reason": "แก้ไขเลขพัสดุที่กรอกผิด" }
```

The server keeps the original shipping timestamp, retains the previous/new values and reason in the event/audit history, and notifies the buyer. Repeating the same corrected values produces no duplicate event. Other sellers and the buyer cannot edit tracking, and this route does not rewrite delivered orders.

### 8. Buyer confirms delivery and reviews

`POST /orders/<orderId>/receive` is buyer-only. It changes shipped to delivered; repeating it for an already delivered order is safe.

`POST /products/<productId>/reviews`

```json
{ "rating": 5, "text": "ได้รับสินค้าแล้ว" }
```

A delivered purchase of this product is required. There can be one review per product per buyer. Duplicate submissions are rejected. Public product rating/count queries exclude hidden reviews.

## Status transitions

| Current order/payment state                    | Action                               | Actor                  | Result                                           |
| ---------------------------------------------- | ------------------------------------ | ---------------------- | ------------------------------------------------ |
| New transfer checkout without proof            | Checkout                             | Buyer                  | pending / unpaid                                 |
| New transfer checkout with proof               | Checkout                             | Buyer                  | pending / awaiting_review                        |
| Zero-balance store group                       | Server checkout calculation          | Server                 | paid / paid with no_charge method                |
| pending / unpaid or rejected                   | Submit proof                         | Buyer                  | pending / awaiting_review                        |
| pending / awaiting_review                      | Reject proof with reason             | Admin                  | pending / rejected                               |
| pending / awaiting_review                      | Approve proof manually               | Admin                  | paid / paid                                      |
| paid / paid                                    | Prepare                              | Owning seller or admin | preparing / paid                                 |
| preparing / paid                               | Ship                                 | Owning seller or admin | shipped / paid                                   |
| shipped / paid                                 | Confirm receipt                      | Buyer                  | delivered / paid                                 |
| pending                                        | Cancel                               | Buyer or admin         | cancelled / unpaid; stock restored once          |
| paid or preparing                              | Cancel                               | Admin                  | cancelled / refund_pending; stock restored once  |
| cancelled / refund_pending                     | Record completed manual refund       | Admin                  | cancelled / refunded                             |
| pending / unpaid or rejected, deadline reached | Expire reservation                   | System                 | cancelled / unpaid; stock restored once          |
| cancelled / unpaid transfer                    | Record verified late transfer        | Admin                  | cancelled / refund_pending; stock stays released |
| shipped / paid                                 | Correct carrier/tracking with reason | Owning seller or admin | shipped / paid; original shipping time preserved |

There is no post-delivery returns workflow in the supplied requirements, and no shipment reversal or arbitrary status-edit endpoint. Those policies would need separate product decisions before implementation.

## Cancellation and refunds

`POST /orders/:id/cancel` requires:

```json
{ "reason": "เหตุผลการยกเลิก" }
```

Buyers can cancel only pending orders. Admins can cancel pending, paid or preparing orders. Sellers do not get a buyer cancellation right over other people's orders. Shipped/delivered orders cannot be cancelled using this endpoint.

Cancellation locks the order, restores stock once, records a stock movement/event and marks the order as cancelled. Repeating an authorized cancellation returns the existing cancelled order. Coupon usage is not restored automatically after cancellation or reservation expiry: it measures completed checkout use, and the original usage history is retained.

A paid cancellation with a positive total sets `refund_pending`. It does **not** mean money has been returned. A cancelled no-charge order has no refund obligation and cannot use the refund-recording endpoint. Admin records an externally completed/manual refund with:

`POST /admin/orders/:id/refund`

```json
{ "reference": "BANK-REFUND-REFERENCE", "note": "บันทึกหลังดำเนินการคืนเงินจริงแล้ว" }
```

The API stores the reference, timestamp and audit record. It does not initiate the transfer. Repeating the same reference on a refunded order returns the existing result; a different reference returns HTTP 409.

### Reservation expiration

`PAYMENT_RESERVATION_MINUTES` defaults to **1440 minutes (24 hours)** and permits a configured window from 5 minutes to 7 days. Only pending transfer orders with `unpaid` or `rejected` payment status expire. Orders awaiting admin review and orders already paid never expire through this worker.

The API starts maintenance automatically with `BACKGROUND_JOBS=true` by default. It attempts a tick immediately after startup, then every `MAINTENANCE_INTERVAL_SECONDS` (default 60, allowed 5–3600). The job shares the API's existing database handle, works in local PGlite mode, does not overlap its previous batch and checks migration readiness before processing. A complete maintenance batch handles up to 100 order expirations, up to 50 durable upload deletions and authentication/mail retention cleanup.

`npm run maintenance` remains a one-shot command for manual or separately scheduled operation. If `BACKGROUND_JOBS=false`, arrange regular maintenance so expired reservations are released even without traffic. Stop an API using the same PGlite directory before starting a separate maintenance process; PostgreSQL supports concurrent worker processes through database locks/leases. See `OPERATIONS.md` for job, mail and shutdown configuration.

Each order is processed in its own short transaction with a row lock, so overlapping workers, cancellation and proof submission cannot restore stock twice. Quote/checkout requests also sweep a bounded batch of due reservations. Proof submission checks its own order's deadline under its row lock; a late submission commits the cancellation/stock release and then returns HTTP 409 with `PAYMENT_RESERVATION_EXPIRED`, rather than rolling the cancellation back with the error.

Expiration sets the order to cancelled, clears `paymentDueAt`, preserves the order/item snapshots and coupon usage, restores stock once, records system events/audit history with a null actor, and notifies the buyer/store. Proof rejection starts a fresh configured window; submitting valid proof pauses expiry by clearing the deadline.

The internal `expireUnpaidOrders(ctx, limit, signal?)` worker accepts an optional shutdown signal. It finishes any already claimed order transaction, then stops before claiming another order; a later pass processes the remaining reservations. A stopped batch does not leave partial stock restoration or duplicate expiration events.

Migration `005_commerce_lifecycle.sql` backfills pre-existing unpaid/rejected transfer orders with a deterministic 24-hour window from creation or the latest proof rejection. Already-old reservations become eligible for the next maintenance pass. Historical pending zero-balance orders are upgraded to no-charge paid orders with explicit migration events; their monetary/item snapshots remain unchanged.

Version 1.2.0 adds `006_upload_cleanup.sql`. Apply all pending migrations with `npm run db:migrate` before startup; migrations `001`–`005` are unchanged. Proof uploads referenced by current or historical payment records remain protected from deletion. Deletion of an otherwise unused upload is queued atomically with metadata removal; HTTP 202 `fileRemovalPending: true` means the file is no longer API-readable and physical cleanup will retry, not that an order proof can be removed from history.

### Verified transfers found after cancellation or expiration

A late transfer must not silently reopen the order or reserve stock again. After independently verifying the actual receipt, an admin can call `POST /admin/orders/:id/late-payment`:

```json
{
  "reference": "BANK-INCOMING-REFERENCE",
  "amountCents": 43000,
  "receivedAt": "2026-11-14T08:00:00Z",
  "note": "ตรวจสอบเงินเข้าหลังคำสั่งซื้อถูกยกเลิกแล้ว"
}
```

`amountCents` must equal the cancelled transfer order's positive total. `receivedAt` is optional; the server records the current time when omitted. An optional `proofUploadId` must refer to a proof owned by that buyer. No new buyer-submitted document is mandatory for this admin reconciliation action. If an unpaid reservation is already due but maintenance has not processed it, this action expires it inside the same transaction before recording the verified incoming transfer.

The order remains cancelled with its stock released, while payment becomes `refund_pending`. The server stores `paymentReference`/`paymentReceivedAt` and an audit event. Repeating the same incoming reference is safe; a different reference cannot overwrite an already recorded payment. The existing manual refund route completes the separate refund record. This workflow records the exact order amount; it is not a bank integration or a general overpayment/partial-payment ledger.

Buyer/admin order details can read the reconciliation reference and note. Seller-only views and seller CSV omit those private financial details, just as they omit private proof-review/refund information.

## Order reads, searching and receipt data

| Endpoint                         | Visibility                                                                                                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /me/orders`                 | Authenticated buyer's orders, including seller accounts buying from stores                                                                                       |
| `GET /seller/orders`             | Owning seller's store orders                                                                                                                                     |
| `GET /admin/orders`              | All orders, admin-only                                                                                                                                           |
| `GET /orders/:id`                | Buyer, owning seller or admin; proof references, payment rejection detail and incoming-payment/refund references/notes omitted for a seller who is not the buyer |
| `GET /orders/:id/payment-proofs` | Buyer or admin only; paginated private upload and review history, including rejected submissions                                                                 |
| `GET /orders/:id/tracking`       | Same order access rule                                                                                                                                           |
| `GET /orders/:id/receipt`        | Same order access rule; snapshot data plus current public site settings                                                                                          |

Order lists support `q`, `status`, `paymentStatus`, `shopId`, `dateFrom`, `dateTo`, `sort=newest|oldest`, `limit` and `offset`. Search matches order reference, product names, store name and tracking reference. Seller/buyer filters are always combined with server ownership constraints; a supplied shop ID cannot widen access.

Lists default to 20 rows, with a maximum of 100. Pagination offsets are bounded. Cross-account direct order access returns a generic 404. Order history labels and notification titles are Thai text; stable machine event codes are in `events[].detail.code`. Sellers still receive the generic payment event label/status/timestamp, without the private proof-review or refund detail. Active admins receive notifications when proofs need review.

The receipt endpoint returns JSON for rendering. It is marked `documentType: "order-receipt"` and `taxInvoice: false`; it is not a generated statutory tax invoice/PDF.

## Promotions

- `GET /promotions` is public and lists currently eligible promotions on approved, unblocked stores, plus site-wide promotions.
- `GET|POST /seller/promotions` and `PUT|DELETE /seller/promotions/:id` manage the seller's own store promotions.
- Equivalent `/admin/promotions` routes manage site-wide and store promotions.

Example creation:

```json
{
  "code": "BLOOM10",
  "title": "ลด 10%",
  "percent": 10,
  "active": true,
  "startsAt": "2026-11-14",
  "endsAt": "2026-11-30",
  "minSpendCents": 30000,
  "maxDiscountCents": 10000,
  "usageLimit": 100
}
```

Dates, maximum discount and usage limit may be omitted or `null`. Admin may specify `shopId`; a null/omitted shop means a site-wide coupon. Sellers cannot create site-wide or another store's coupons. Shop ownership cannot be changed on an existing promotion. The delete operation archives a promotion and preserves its code/history. Suspended shops cannot activate coupons, but can deactivate existing ones.

## Reviews and wishlists

- `GET /products/:id/reviews`: public visible reviews for a publicly available product. Draft/archived products, inactive categories, suspended shops and blocked shop owners return HTTP 404, matching public product details. A stock balance of zero does not hide an otherwise public listing or its reviews.
- `GET /me/reviews`: own reviews, including moderation outcome.
- `GET /seller/reviews` and `GET /admin/reviews`: scoped management queues.
- `PUT /reviews/:id/reply` with `{ "text": "..." }`: owning seller or admin.
- `PUT /admin/reviews/:id/moderation` with `{ "hidden": true, "reason": "..." }`: admin-only.
- `GET /me/wishlist`, `PUT /me/wishlist/:productId`, `DELETE /me/wishlist/:productId`: account-owned saved products. Listing and saving use the same public product availability rules. Saving a private/unavailable product returns HTTP 404 and creates no entry; saving a public out-of-stock product remains allowed. Existing entries are retained when a product becomes unavailable but omitted from the list, and an owned entry can still be removed.

The buyer's own review list and authorized seller/admin review queues retain their existing access to reviews when a product stops being public. Product availability does not delete review history.

## Sales reports and CSV

`GET /seller/reports/sales` and `GET /admin/reports/sales` return summaries. Append `.csv` for an order-level export, for example `/admin/reports/sales.csv`.

Filters use the same `dateFrom`, `dateTo`, `status`, `paymentStatus`, `shopId`, `q` and `sort` semantics as order lists. Date boundaries include the entire last date in Bangkok time. The response identifies `basis: "order-created-at"`, `timeZone: "Asia/Bangkok"`, `currency: "THB"` and `moneyUnit: "satang"`.

Reports aggregate **all filtered rows**, rather than paginating the calculation. `limit`/`offset` are not used to truncate a report. The limit is 10,000 matching orders; a broader request returns HTTP 422 asking for a narrower date range. Order-list endpoints provide pagination separately. CSV returns the same filtered set, including recipient/address and shipment fields, under the same seller/admin permissions. Manual refund references are included only in admin CSV. CSV cells quote embedded characters and neutralize formula-like user strings.

Every summary amount must also fit an exact JavaScript/JSON safe integer (at most `9007199254740991` satang). A larger aggregate returns HTTP 422 with `REPORT_TOTAL_TOO_LARGE` instead of returning a rounded financial total. Narrow the report filters or use the order-level CSV export: CSV remains available within the 10,000-row limit because each individual order amount is exact and no oversized aggregate is emitted.

Summary fields:

| Field                 | Meaning                                                                    |
| --------------------- | -------------------------------------------------------------------------- |
| `orderCount`          | All matching orders, including cancelled                                   |
| `paidOrders`          | Matching noncancelled orders whose payment status is paid                  |
| `noChargeOrders`      | The subset of those paid orders whose zero total uses the no_charge method |
| `netMerchandiseCents` | Subtotal minus discount for those paid, noncancelled orders                |
| `discountCents`       | Discount for those paid, noncancelled orders                               |
| `shippingCents`       | Shipping for those paid, noncancelled orders                               |
| `collectedCents`      | Total of those paid, noncancelled orders                                   |
| `pendingPaymentCents` | Noncancelled unpaid, awaiting-review or rejected-proof totals              |
| `refundPendingCents`  | Cancelled totals awaiting a recorded refund                                |
| `refundedCents`       | Totals whose manual refund has been recorded                               |

The response also includes per-store summaries. These are order-creation-date operational reports. `collectedCents` is not a cash balance because cancelled/refund-pending orders are represented separately. The reports do not calculate profit, payment-settlement fees, tax, bank reconciliation or marketplace seller payouts.

## Database and test notes

Transactions, checks, foreign keys, row locks and unique constraints enforce inventory, review uniqueness and checkout idempotency. The PostgreSQL adapter retries serialization/deadlock failures; database writes and notifications/audit entries belong to the same transaction.

The commerce tests exercise actual HTTP handlers and migrated SQL tables. Simultaneous HTTP requests test checkout replay, stock exhaustion and coupon limits. When run with PGlite, transactions are serialized by the development adapter; this does not by itself prove multi-connection PostgreSQL lock behavior. Follow the main verification document for the exact database environment used in each run.

The frontend adapter still needs to map existing local string IDs to returned UUIDs, convert baht to/from satang, replace synchronous actions with asynchronous requests, keep an idempotency key during retries, and show loading/error/retry states. No frontend source was changed for this backend delivery.
