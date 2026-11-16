# Technical references

The implementation uses the package versions recorded in package-lock.json. The following official documentation informed the implementation; it does not replace the project's observed test results.

- Fastify getting started, validation and testing: https://fastify.dev/docs/latest/Guides/Getting-Started/
- Fastify testing: https://fastify.dev/docs/latest/Guides/Testing/
- Fastify trusted proxy configuration: https://fastify.dev/docs/latest/Reference/Server/#trustproxy
- Node crypto (scrypt, randomBytes, timingSafeEqual): https://nodejs.org/api/crypto.html
- PGlite API and transactions: https://pglite.dev/docs/api
- PostgreSQL explicit locking: https://www.postgresql.org/docs/current/explicit-locking.html
- PostgreSQL transaction isolation: https://www.postgresql.org/docs/current/transaction-iso.html
- PostgreSQL indexes: https://www.postgresql.org/docs/current/indexes.html

Project SQL conventions include bound parameters, indexes on common ownership/filter joins, ordered row locks, short transactions, immutable history snapshots and pooled PostgreSQL connections. Production provider selection and deployment configuration are not implied by these references.

- Zod native JSON Schema conversion: https://zod.dev/json-schema
- Sharp image processing and installation: https://sharp.pixelplumbing.com/install/
