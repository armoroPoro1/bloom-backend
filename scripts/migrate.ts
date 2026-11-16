import { loadConfig } from '../src/config.js';
import { createDatabase, migrate } from '../src/core/db.js';
const db = await createDatabase(loadConfig());
try {
  const names = await migrate(db);
  console.log('Migrations ready:', names.join(', '));
} finally {
  await db.close();
}
