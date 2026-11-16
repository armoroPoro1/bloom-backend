import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/core/db.js';
import { deliverMailBatch } from '../src/core/mail.js';
const config = loadConfig();
const db = await createDatabase(config);
try {
  console.log(await deliverMailBatch({ db, config }, 100));
} finally {
  await db.close();
}
