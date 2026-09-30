import { defineConfig } from 'vitest/config';

// DB tests share one Postgres database, so files run one at a time.
export default defineConfig({ test: { fileParallelism: false, testTimeout: 30_000 } });
