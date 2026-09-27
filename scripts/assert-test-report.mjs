// Fails CI if a vitest JSON report contains skipped/todo tests, failures, or
// fewer tests than expected: production-critical suites must never be
// silently skipped.
import { readFileSync } from "node:fs";
const [file, minimum] = process.argv.slice(2);
const report = JSON.parse(readFileSync(file, "utf8"));
const skipped = report.numPendingTests + report.numTodoTests;
const summary = {
  file,
  total: report.numTotalTests,
  passed: report.numPassedTests,
  failed: report.numFailedTests,
  skipped,
  suites: report.numTotalTestSuites,
};
console.log(JSON.stringify(summary));
if (!report.success || report.numFailedTests > 0) process.exit(1);
if (skipped > 0) {
  console.error("skipped or todo tests are not allowed in CI");
  process.exit(1);
}
if (report.numTotalTests < Number(minimum ?? 1)) {
  console.error(
    `expected at least ${minimum} tests, found ${report.numTotalTests}`,
  );
  process.exit(1);
}
