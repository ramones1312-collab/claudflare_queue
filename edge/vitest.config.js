import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

// Tests run inside workerd, the real Workers runtime, with a real SQLite-backed Durable Object.
export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        main: './test/_test-entry.js',
        // One runtime per test FILE: each scenario gets its own worker, its own Durable Object
        // instance and its own SQLite state. Storage isolation per *test* is unsupported for
        // SQLite-backed DOs, so isolation is achieved at file granularity instead.
        isolatedStorage: false,
        singleWorker: false,   // SQLite-backed DOs are unsupported by per-test isolation in this pool version
        miniflare: {
          compatibilityDate: '2024-12-18',
          compatibilityFlags: ['nodejs_compat'],
          durableObjects: {
            SEQUENCER: { className: 'EdgeSequencerTestable', useSQLite: true },
          },
          queueProducers: { SIGNAL_QUEUE: 'kawa-signal-buffer', DLQ: 'kawa-signal-buffer-dlq' },
          // No auto-consumer: the tests drive delivery explicitly so queue draining cannot race
          // the assertions. Production wiring lives in wrangler.consumer.toml.
          bindings: {
            WEBHOOK_PATH_TOKEN: 'test-path-token',
            KAWA_WEBHOOK_URL: 'https://kawa.test/webhook/tok',
            DELIVERY_TIMEOUT_MS: '5000',
            // The DO reads this from its OWN env, so it must be a runtime binding, not a
            // per-scenario Worker env value.
            HALT_NOTIFY_URL: 'https://halt-notify.test/hook',
          },
        },
      },
    },
  },
});
