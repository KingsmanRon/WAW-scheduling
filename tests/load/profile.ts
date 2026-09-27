const base = process.env.LOAD_BASE_URL ?? "http://localhost:3001";
const concurrency = Number(process.env.LOAD_CONCURRENCY ?? 10),
  requests = Number(process.env.LOAD_REQUESTS ?? 200);
const samples: number[] = [];
let errors = 0;
const start = Date.now();
for (let i = 0; i < requests; i += concurrency)
  await Promise.all(
    Array.from({ length: Math.min(concurrency, requests - i) }, async () => {
      const t = performance.now();
      try {
        const r = await fetch(`${base}/health`);
        if (!r.ok) errors++;
      } catch {
        errors++;
      }
      samples.push(performance.now() - t);
    }),
  );
samples.sort((a, b) => a - b);
const pct = (p: number) =>
  samples[Math.min(samples.length - 1, Math.floor(samples.length * p))];
const result = {
  profile: "single-small-practice-v1",
  requests,
  concurrency,
  throughput_rps: requests / ((Date.now() - start) / 1000),
  latency_ms: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99) },
  errors,
  provisional_limits: {
    burst: 10,
    artifact_bytes: 10_000_000,
    active_tenants: 25,
    target_p95_ms: 250,
  },
};
console.log(JSON.stringify(result, null, 2));
if (errors || Number(result.latency_ms.p95) > 250) process.exitCode = 1;
