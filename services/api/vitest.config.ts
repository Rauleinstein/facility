import { defineConfig } from "vitest/config";

// Integration tests import src/config.ts, which loads the repository .env and its
// development DATABASE_URL. Pin the test database before any test module loads, so
// a test run never writes into the development database. An explicit DATABASE_URL
// (CI, or a one-off fresh database) still wins.
export default defineConfig({
  test: {
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ?? "postgres://facility:facility@localhost:5461/facility_test",
    },
  },
});
