// Example k6 suite for the bundled mock, the k6 counterpart of mock/locustfile.py: request names
// are operationIds (PS-D4), createOrder checks the business outcome (PS-B8), and each virtual
// user logs in once with its own account, partitioned by ai-perf worker (PS-B7).
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE_URL || 'http://127.0.0.1:9990';
const WORKER = __ENV.AI_PERF_WORKER || '0';
// Its own options are kept for running it alone: a ramp, a steady state and thresholds per
// operation. ai-perf replaces the stages with the run's profile and judges against slo.json.
export const options = {
  stages: [{ duration: '5s', target: 2 }, { duration: '20s', target: 2 }, { duration: '2s', target: 0 }],
  thresholds: { 'http_req_duration{name:listItems}': ['p(95)<500'], http_req_failed: ['rate<0.01'] },
};

let auth = null;

export default function () {
  if (!auth) {
    const r = http.post(`${BASE}/login`, JSON.stringify({ username: `perf-w${WORKER}-${__VU}` }), { headers: { 'Content-Type': 'application/json' }, tags: { name: 'login' } });
    auth = { headers: { Authorization: `Bearer ${r.json('token')}`, 'Content-Type': 'application/json' } };
  }
  const pick = Math.random() * 10;
  if (pick < 6) http.get(`${BASE}/items`, { ...auth, tags: { name: 'listItems' } });
  else if (pick < 9) http.get(`${BASE}/items/7`, { ...auth, tags: { name: 'getItem' } });
  else {
    const r = http.post(`${BASE}/orders`, JSON.stringify({ item: 7, qty: 1 }), { ...auth, tags: { name: 'createOrder' } });
    check(r, { 'order created': (x) => x.status === 201 && x.json('status') === 'created' });
  }
  sleep(0.05 + Math.random() * 0.1);
}
