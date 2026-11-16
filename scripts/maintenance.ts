import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/core/db.js';
import { runMaintenance } from '../src/core/maintenance.js';
const config = loadConfig();
const db = await createDatabase(config);
try {
  console.log(JSON.stringify(await runMaintenance({ db, config })));
} finally {
  await db.close();
}
