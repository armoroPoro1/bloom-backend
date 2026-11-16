import type { Context } from './contracts.js';
import { databaseReady } from './db.js';
import { deliverMailBatch } from './mail.js';
import { runMaintenance } from './maintenance.js';

export type BackgroundEvent = {
  job: 'mail' | 'maintenance';
  status: 'completed' | 'not_ready' | 'failed';
  result?: Record<string, unknown>;
  code?: string;
};

/**
 * One API process shares its existing database handle with both jobs. Each job
 * has at most one in-flight batch. PostgreSQL workers also use database locks.
 */
export function startBackgroundJobs(
  ctx: Context,
  options: { onEvent?: (event: BackgroundEvent) => void } = {},
) {
  const controller = new AbortController();
  const running = new Map<BackgroundEvent['job'], Promise<void>>();
  const timers: ReturnType<typeof setInterval>[] = [];
  let stopping: Promise<void> | undefined;
  const emit = (event: BackgroundEvent) => {
    try {
      options.onEvent?.(event);
    } catch {
      /* Observer failures must not stop durable jobs. */
    }
  };
  const schedule = (
    job: BackgroundEvent['job'],
    seconds: number,
    execute: () => Promise<Record<string, unknown>>,
  ) => {
    const tick = () => {
      if (controller.signal.aborted || running.has(job)) return;
      const task = Promise.resolve()
        .then(async () => {
          if (controller.signal.aborted) return;
          if (!(await databaseReady(ctx.db))) {
            emit({ job, status: 'not_ready' });
            return;
          }
          if (controller.signal.aborted) return;
          const result = await execute();
          emit({ job, status: 'completed', result });
        })
        .catch((error: unknown) => {
          const code =
            error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
              ? error.code
              : 'BACKGROUND_JOB_FAILED';
          emit({ job, status: 'failed', code });
        })
        .finally(() => {
          running.delete(job);
        });
      running.set(job, task);
    };
    const timer = setInterval(tick, seconds * 1000);
    timer.unref();
    timers.push(timer);
    tick();
  };
  if (ctx.config.backgroundJobs) {
    schedule('mail', ctx.config.mailIntervalSeconds, () =>
      deliverMailBatch(ctx, 20, { signal: controller.signal }),
    );
    schedule('maintenance', ctx.config.maintenanceIntervalSeconds, () =>
      runMaintenance(ctx, { signal: controller.signal }),
    );
  }
  return {
    stop(): Promise<void> {
      if (!stopping) {
        controller.abort();
        for (const timer of timers) clearInterval(timer);
        stopping = Promise.all([...running.values()]).then(() => undefined);
      }
      return stopping;
    },
  };
}
