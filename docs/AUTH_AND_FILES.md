# Authentication, notifications and files

All paths below use `/api/v1`. Successful JSON responses use `{ "data": ... }`; errors use `{ "error": { "code", "message", "details"? }, "requestId" }`.

## Sessions

Register:

```http
POST /api/v1/auth/register
Content-Type: application/json
```

```json
{
  "name": "Demo Buyer",
  "email": "buyer@example.test",
  "password": "Choose-a-private-password",
  "phone": "0800000000"
}
```

Public registration always creates a regular user. Extra fields such as `role` are rejected. Passwords need 10–128 characters and at most 256 UTF-8 bytes. Admin CLI and development seed require at least 12 characters.

Login: `POST /auth/login` with `email` and `password`.

Both return `data.user`, `accessToken`, `refreshToken`, `tokenType: "Bearer"` and `expiresIn`. Pass `Authorization: Bearer ACCESS_TOKEN` on protected routes. Tokens are opaque random values; the database keeps hashes, not the raw tokens.

Access lifetime defaults to 15 minutes. Refresh lifetime defaults to an absolute 30 days from login; rotating does not extend that deadline. `POST /auth/refresh` accepts `{ "refreshToken": "..." }`, rotates both tokens, and invalidates the prior access token. Reusing an unexpired already-used refresh token revokes its session. Coordinate refresh calls in the future frontend so simultaneous requests share one refresh operation.

Near the absolute session deadline, both the access expiry and the returned `expiresIn` are capped to the remaining refresh lifetime. A login rechecks the current email/password state before creating a session, so an email changed during an in-flight login cannot authenticate under the old address.

Password and email changes also recheck the originating access token, session expiry, blocked state and current identity inside their write transaction, after password verification/hashing. A request that was already running when its session was logged out, rotated or revoked cannot later commit a sensitive change. The frontend should complete an active refresh before starting a password/email change and sign in again if that operation returns `401 INVALID_SESSION`.

- `GET /auth/me`: current account.
- `POST /auth/logout`: revoke this session.
- `POST /auth/logout-all`: revoke every session for this account.
- `PATCH /me/profile`: optional `name`, `phone`, `address`, `avatarId`. Omitted fields are preserved. Send `avatarId: null` to clear.
- `POST /me/change-password`: `currentPassword`, `newPassword`. Revokes all sessions.
- `POST /me/change-email`: `email`, `currentPassword`. Revokes sessions, invalidates old account action tokens and queues verification for the new email.

There is no browser cookie authentication in this version. CORS allows exact configured origins and bearer headers. Do not place tokens in query strings or image URLs. The frontend integration should define token storage deliberately; keeping access tokens in memory and implementing a controlled refresh flow avoids casually treating localStorage as secure storage. A BFF/cookie design would be a later explicit change, including its CSRF requirements.

The HTTP API never returns password hashes. Passwords are salted with Node scrypt (`N=65536, r=8, p=1`, 64-byte result, random 16-byte salt). Password changes and resets replace the hash and revoke sessions.

Account/authentication and protected responses send `Cache-Control: private, no-store`, including validation errors on protected routes. Responses carry `X-Request-Id`; configured browser origins can read that header, `Retry-After` and `Content-Disposition` through CORS.

## Password recovery and email verification

`POST /auth/forgot-password` takes `{ "email": "..." }` and returns the same message whether an account exists. Eligible accounts receive a queued single-use reset token with a 30-minute lifetime.

`POST /auth/reset-password` takes `{ "token": "...", "newPassword": "..." }`.

`POST /auth/verify-email` takes `{ "token": "..." }`. Verification links expire after 24 hours. Signed-in users can call `POST /auth/resend-verification`.

Queue contents are private database records; no public mail-outbox endpoint exists. The server drains the outbox when background jobs are enabled; `npm run mail:worker` also runs one batch explicitly. In development, delivered messages are written under `var/mail`. Without SMTP, no external email is sent. In production the worker uses the configured SMTP transport. The emitted frontend URL uses a fragment token (`#token=...`); the future React recovery/verification screen needs to read it and submit to the API. Those screens have not been integrated in this task.

Mail delivery uses short database claims and sends outside the transaction. A claim has a ten-minute lease; a worker may take over an abandoned lease. Each claim increments an attempt generation, and both success and failure acknowledgements require the same generation. A delayed worker cannot overwrite a newer worker's result.

Delivery failures use exponential backoff beginning at 30 seconds, with five attempts in total. A crash during the fifth attempt is recovered into terminal `failed` state when its lease expires; it does not remain permanently `processing` or trigger a sixth send. Terminal failure and successful delivery both remove the queued message body, which may contain an account-action token. The user can request a new reset/verification message after delivery failure. Development message files are deliberately retained in the private `MAIL_DIR` for local testing; they are not served by an API.

The worker reports `processed`, `sent`, `failed`, `leaseLost` and `exhausted` counters. `exhausted` includes final failed attempts and previously abandoned final leases; it may overlap `failed`. Shutdown stops new claims and allows a message already being delivered to settle. SMTP delivery is **at least once**: a process can stop after SMTP accepts a message but before the database records success. A stable Message-ID assists correlation but does not guarantee that a receiving mail system suppresses a duplicate.

Email verification is recorded but does not currently block buying or seller application. Changing that is a product policy decision, not an existing enforced rule.

## Image upload

```sh
curl -X POST "http://localhost:4000/api/v1/uploads?kind=proof" \
  -H "Authorization: Bearer ACCESS_TOKEN" \
  -F "file=@sample-proof.png"
```

Kinds: `product`, `avatar`, `proof`, `article`.

- Supply exactly one multipart field named `file`; extra files/fields are rejected.
- Input is at most 1 MiB and must decode as the declared JPEG, PNG, WebP or nonanimated GIF format.
- Decoding is bounded to 12 million pixels. Images are oriented, resized within 2400 × 2400, stripped of ancillary metadata and encoded as WebP.
- Output is at most 2 MiB. The storage key is server-generated and never accepted from a client.
- Product images require seller/admin permission; a seller needs an approved store.
- Article images require admin permission.
- Return value includes `id`, `kind`, `mime`, `sizeBytes` and a relative `url`. Attach the ID to a product, article, avatar or payment proof; do not send browser data URLs into those records.

`GET /uploads/:id` returns the actual image bytes. Unreferenced files remain private. Product images are public only through currently available listings; article images are public only when referenced by a published article. Historical purchased product images are readable by the buyer and the order's store owner. Proofs and avatars are restricted to owner/admin. Unauthorized access returns the same 404 as a missing file.

A shop owner can also read images assigned to their own draft, inactive or archived products, including images uploaded and assigned by an administrator. This does not make the image public or grant the shop owner permission to delete another uploader's file. Shop suspension preserves access needed to manage existing records; a blocked account still cannot authenticate.

A normal `<img src>` does not attach bearer headers. To display a private image after integration, fetch it with the Authorization header, create a temporary object URL, and revoke that URL when replaced/unmounted. Do not make proof files public just to simplify rendering.

`DELETE /uploads/:id` only deletes an owned/admin-accessible unused file. References from profiles, products, articles, historical order items or payment-proof history prevent deletion.

Deletion commits the metadata removal and a private durable cleanup job together, then attempts to remove the physical object. Normal completion returns `200` with `{ "data": { "deleted": true } }`. If storage is temporarily unavailable, the endpoint returns `202` with `{ "data": { "deleted": true, "fileRemovalPending": true } }`. The object is immediately inaccessible through the API and cannot acquire a new reference while its physical removal is pending. The frontend should treat both responses as an accepted deletion; the `202` flag describes deferred storage cleanup, not permission to show or reuse the old upload ID.

Maintenance retries pending physical deletions with exponential backoff capped at one hour, without silently dropping jobs after a fixed number of failures. Missing files count as successfully removed, including recovery after a process stops between unlinking a file and acknowledging its job. Cleanup claims have a ten-minute lease and generation-fenced acknowledgements. Shutdown stops before claiming further jobs. Migration `006_upload_cleanup.sql` adds the private queue; there is no public endpoint exposing filesystem paths or cleanup records. This mechanism tracks deletions requested after the migration; it does not claim to discover untracked filesystem orphans from earlier releases.

## Notifications

- `GET /me/notifications?unread=true&limit=20&offset=0`
- `PATCH /me/notifications/:id/read`
- `POST /me/notifications/read-all`

Orders generate durable buyer/store notifications, and submitted payment proofs notify active administrators. Notification records are scoped to their user. The backend does not send external push/SMS notifications.

Notification query filters and pagination are included in OpenAPI. Unknown parameters, invalid unread values and pagination outside the documented bounds return 400.

## Abuse limits

The API has a 200-request/minute per-IP limiter, with stricter authentication/upload/checkout limits. Failed login counters are also stored by hashed email for a 15-minute window. The per-IP limiter is in-process; deployments with multiple API instances should provide a shared limiter at the gateway or a shared backing store. Reverse-proxy trust is disabled by default and must be configured for the exact deployment topology.
