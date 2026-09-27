import { setLogSink } from "../../packages/observability/src/index.js";

// Structured logs are asserted in tests/unit/logging.test.ts; elsewhere they
// are noise. Set ACCESS_TEST_LOGS=1 to see them while debugging.
if (process.env.ACCESS_TEST_LOGS !== "1") setLogSink(() => undefined);
