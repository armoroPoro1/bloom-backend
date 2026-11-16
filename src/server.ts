import { loadConfig } from './config.js';
import { createDatabase } from './core/db.js';
import { buildApp } from './app.js';
import { startBackgroundJobs } from './core/background.js';
const config = loadConfig();
const db = await createDatabase(config);
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let jobs: ReturnType<typeof startBackgroundJobs> | undefined;
let closing: Promise<void> | undefined;
const stop = () => {
  closing ??= (async () => {
    // Stop accepting new jobs, then drain current jobs/HTTP before closing SQL.
    const jobDrain = jobs?.stop() ?? Promise.resolve();
    try {
      const results = await Promise.allSettled([jobDrain, app?.close()]);
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    } finally {
      await db.close();
    }
  })();
  return closing;
};
try {
  app = await buildApp({ db, config });
  const shutdown = () =>
    void stop().catch(() => {
      process.exitCode = 1;
    });
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  await app.listen({ host: config.host, port: config.port });
  if (!closing)
    jobs = startBackgroundJobs(
      { db, config },
      {
        onEvent: (event) => {
          if (event.status === 'failed') app!.log.error(event, 'Background job failed; will retry');
          else app!.log.debug(event, 'Background job completed or deferred');
        },
      },
    );
} catch (error) {
  await stop();
  console.error(error instanceof Error ? error.message : 'Startup failed');
  process.exitCode = 1;
}
