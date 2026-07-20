/**
 * k6 load test — flag evaluation engine (PLAN.md §12).
 *
 * Scenarios:
 *   warmup  30 s at a constant low rate (5 req/s) — fills the Redis
 *           flag-config cache so the main phase measures warm latency.
 *   main    ramp 0→50 VUs over 30 s → hold 50 VUs for 2 min → spike to
 *           100 VUs (30 s ramp + 30 s hold) → ramp down.
 *
 * Mix per iteration: ~70 % POST /api/v1/evaluate (single flag key — the hot
 * cache path) and ~30 % POST /api/v1/evaluate/bulk (all active flags).
 * user_id is drawn from a 100 000-user pool: bucketing is deterministic per
 * (tenant, flag, user), so it is DISTINCT users — not repetition — that
 * exercise both the ROLLOUT_MATCH and ROLLOUT_MISS branches of a partial
 * rollout. Flag keys are discovered in setup() from the flags API, so the
 * script works unchanged against the local seed or a CI-minted tenant.
 *
 * Config (environment, pass with `k6 run -e NAME=value`):
 *   K6_BASE_URL     default http://localhost:8080 (local docker-compose)
 *   K6_API_KEY      default = the local compose seed key (never valid in cloud)
 *   K6_TENANT_ID    REQUIRED — UUID of the tenant the API key belongs to
 *   K6_ENVIRONMENT  default staging
 *
 * Thresholds are informational (PLAN §12): none set abortOnFail, so a breach
 * never stops the run. load-test.yml treats the k6 exit code as advisory
 * (continue-on-error) and uploads k6-summary.json either way.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const BASE_URL = __ENV.K6_BASE_URL || 'http://localhost:8080';
// Default is the docker-compose seed key (prisma/seed.ts, local-only credential).
const API_KEY = __ENV.K6_API_KEY || 'ff_local_demo_storefront_key_0000000000000000';
const TENANT_ID = __ENV.K6_TENANT_ID || '';
const ENVIRONMENT = __ENV.K6_ENVIRONMENT || 'staging';

const USER_POOL_SIZE = 100000; // large pool → distinct users hit both rollout branches
const BULK_RATIO = 0.3; // ~30 % bulk, ~70 % single evaluate

const HEADERS = {
  'Content-Type': 'application/json',
  'X-API-Key': API_KEY,
};

// Custom counters: rollout branch outcomes observed in response bodies.
const rolloutMatch = new Counter('rollout_match');
const rolloutMiss = new Counter('rollout_miss');
// Per-endpoint latency (client-side), for the README results table.
const singleDuration = new Trend('evaluate_single_duration', true);
const bulkDuration = new Trend('evaluate_bulk_duration', true);

export const options = {
  scenarios: {
    warmup: {
      executor: 'constant-arrival-rate',
      rate: 5,
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 10,
      maxVUs: 20,
      exec: 'mix',
      tags: { phase: 'warmup' },
    },
    main: {
      executor: 'ramping-vus',
      startTime: '30s', // after warmup
      startVUs: 0,
      stages: [
        { duration: '30s', target: 50 }, // ramp 0→50
        { duration: '2m', target: 50 }, // hold
        { duration: '30s', target: 100 }, // spike ramp
        { duration: '30s', target: 100 }, // spike hold
        { duration: '10s', target: 0 }, // ramp down
      ],
      gracefulRampDown: '10s',
      exec: 'mix',
      tags: { phase: 'main' },
    },
  },
  // Informational targets — deliberately no abortOnFail (PLAN §12).
  thresholds: {
    'http_req_duration{phase:main}': ['p(95)<150'], // warm target, excludes warmup
    http_req_failed: ['rate<0.01'], // error rate < 1 %
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  if (!TENANT_ID) {
    throw new Error(
      'K6_TENANT_ID is required (UUID of the tenant K6_API_KEY belongs to). ' +
        'See load-test/README.md for how to look it up locally.',
    );
  }

  // Discover active flag keys so single-evaluate requests never 404. Works
  // against both the local seed and the throwaway tenant minted by CI.
  const res = http.get(
    `${BASE_URL}/api/v1/tenants/${TENANT_ID}/flags?status=active&per_page=100`,
    { headers: HEADERS, tags: { phase: 'setup' } },
  );
  if (res.status !== 200) {
    throw new Error(
      `setup: could not list flags (HTTP ${res.status}). ` +
        'Check K6_BASE_URL / K6_API_KEY / K6_TENANT_ID.',
    );
  }
  const flagKeys = (res.json('flags') || []).map((f) => f.key);
  if (flagKeys.length === 0) {
    throw new Error(`setup: tenant ${TENANT_ID} has no active flags to evaluate.`);
  }
  return { flagKeys };
}

export function mix(data) {
  // Random user from a large pool — deterministic bucketing means the branch
  // taken (ROLLOUT_MATCH vs ROLLOUT_MISS) varies across users, never per user.
  const userId = `user-${Math.floor(Math.random() * USER_POOL_SIZE)}`;
  const base = { tenant_id: TENANT_ID, environment: ENVIRONMENT, user_id: userId };

  let res;
  if (Math.random() < BULK_RATIO) {
    res = http.post(`${BASE_URL}/api/v1/evaluate/bulk`, JSON.stringify(base), {
      headers: HEADERS,
      tags: { name: 'evaluate_bulk' },
    });
    bulkDuration.add(res.timings.duration);
  } else {
    const key = data.flagKeys[Math.floor(Math.random() * data.flagKeys.length)];
    res = http.post(
      `${BASE_URL}/api/v1/evaluate`,
      JSON.stringify(Object.assign({ flag_keys: [key] }, base)),
      { headers: HEADERS, tags: { name: 'evaluate_single' } },
    );
    singleDuration.add(res.timings.duration);
  }

  const ok = check(res, {
    'status is 2xx': (r) => r.status === 200 || r.status === 201,
    'body has flags': (r) => {
      try {
        const body = r.json();
        return body !== null && typeof body.flags === 'object';
      } catch (_e) {
        return false;
      }
    },
  });
  if (ok) countRolloutReasons(res);

  // Light pacing (~4-5 iter/s/VU) so VU counts map to a sane request rate.
  sleep(0.1 + Math.random() * 0.2);
}

function countRolloutReasons(res) {
  let body;
  try {
    body = res.json();
  } catch (_e) {
    return;
  }
  const flags = (body && body.flags) || {};
  for (const key of Object.keys(flags)) {
    const reason = flags[key] && flags[key].reason;
    if (reason === 'ROLLOUT_MATCH') rolloutMatch.add(1);
    else if (reason === 'ROLLOUT_MISS') rolloutMiss.add(1);
  }
}

// ---------------------------------------------------------------------------
// Summary: k6-summary.json (full metrics) + a compact console table.
// ---------------------------------------------------------------------------

export function handleSummary(data) {
  return {
    'k6-summary.json': JSON.stringify(data, null, 2),
    stdout: consoleTable(data),
  };
}

function metricValues(data, name) {
  const m = data.metrics[name];
  return (m && m.values) || {};
}

function fmt(n, digits) {
  if (n === undefined || n === null || Number.isNaN(Number(n))) return 'n/a';
  return Number(n).toFixed(digits === undefined ? 1 : digits);
}

function thresholdVerdict(data, name) {
  const m = data.metrics[name];
  if (!m || !m.thresholds) return '';
  const failed = Object.keys(m.thresholds).some((t) => !m.thresholds[t].ok);
  return failed ? 'MISSED (informational)' : 'met';
}

function consoleTable(data) {
  const reqs = metricValues(data, 'http_reqs');
  const dur = metricValues(data, 'http_req_duration');
  const durMain = metricValues(data, 'http_req_duration{phase:main}');
  const failed = metricValues(data, 'http_req_failed');
  const checks = metricValues(data, 'checks');
  const single = metricValues(data, 'evaluate_single_duration');
  const bulk = metricValues(data, 'evaluate_bulk_duration');
  const match = metricValues(data, 'rollout_match').count || 0;
  const miss = metricValues(data, 'rollout_miss').count || 0;
  const rolloutTotal = match + miss;
  const matchPct = rolloutTotal > 0 ? (match / rolloutTotal) * 100 : NaN;

  const line = '='.repeat(72);
  const row = (label, value) => `  ${label.padEnd(36, '.')} ${value}\n`;

  let out = '\n' + line + '\n';
  out += `  flagship load test — ${BASE_URL} (${ENVIRONMENT})\n`;
  out += line + '\n';
  out += row('requests', `${reqs.count || 0} total, ${fmt(reqs.rate)}/s`);
  out += row(
    'error rate (http_req_failed)',
    `${fmt((failed.rate || 0) * 100, 2)} %  [target <1 % — ${thresholdVerdict(data, 'http_req_failed') || 'n/a'}]`,
  );
  out += row(
    'latency p50 / p95 / p99 (all)',
    `${fmt(dur.med)} / ${fmt(dur['p(95)'])} / ${fmt(dur['p(99)'])} ms`,
  );
  out += row(
    'latency p95 (main phase, warm)',
    `${fmt(durMain['p(95)'])} ms  [target <150 ms — ${
      thresholdVerdict(data, 'http_req_duration{phase:main}') || 'n/a'
    }]`,
  );
  out += row(
    'single evaluate p50 / p95 / p99',
    `${fmt(single.med)} / ${fmt(single['p(95)'])} / ${fmt(single['p(99)'])} ms`,
  );
  out += row(
    'bulk evaluate p50 / p95 / p99',
    `${fmt(bulk.med)} / ${fmt(bulk['p(95)'])} / ${fmt(bulk['p(99)'])} ms`,
  );
  out += row(
    'rollout MATCH / MISS',
    `${match} / ${miss}  (${fmt(matchPct)} % match observed)`,
  );
  out += row('checks passed', `${fmt((checks.rate || 0) * 100, 2)} %`);
  out += line + '\n';
  out += '  thresholds are informational — full metrics in k6-summary.json\n';
  out += line + '\n';
  return out;
}
