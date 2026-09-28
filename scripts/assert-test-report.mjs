// Fails CI if a vitest or Playwright JSON report contains skipped/todo
// tests, failures (or, for Playwright, flaky passes), or fewer tests than
// expected: production-critical suites must never be silently skipped.
import { readFileSync } from "node:fs";
const [file, minimum] = process.argv.slice(2);
const report = JSON.parse(readFileSync(file, "utf8"));

function summarise() {
  if (report.stats && report.config) {
    // Playwright: stats.expected passed, unexpected failed, flaky passed on retry.
    const s = report.stats;
    return {
      total: s.expected + s.unexpected + s.flaky + s.skipped,
      passed: s.expected,
      failed: s.unexpected + s.flaky,
      skipped: s.skipped,
      ok: s.unexpected === 0 && s.flaky === 0,
    };
  }
  return {
    total: report.numTotalTests,
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    skipped: report.numPendingTests + report.numTodoTests,
    ok: report.success && report.numFailedTests === 0,
  };
}
const { ok, ...summary } = summarise();
console.log(JSON.stringify({ file, ...summary }));
if (!ok || summary.failed > 0) process.exit(1);
if (summary.skipped > 0) {
  console.error("skipped or todo tests are not allowed in CI");
  process.exit(1);
}
if (summary.total < Number(minimum ?? 1)) {
  console.error(`expected at least ${minimum} tests, found ${summary.total}`);
  process.exit(1);
}
