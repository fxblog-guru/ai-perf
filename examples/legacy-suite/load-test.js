// A legacy k6 suite with the defects /perf-audit must find (tests/suites.test.mjs plants and checks
// each one). Not for running.
import http from 'k6/http';

export const options = { vus: 50, duration: '5m' };

const API_KEY = 'sk_live_abcdefghijklmnop';

export default function () {
  const login = http.post('https://api.prod.example.com/login', JSON.stringify({ username: 'loadtest', password: 'secret' }));
  const token = login.json('token');
  http.get(`https://api.prod.example.com/items/${Math.floor(Math.random() * 100)}`, { headers: { Authorization: `Bearer ${token}` } });
  http.post('https://api.prod.example.com/orders', JSON.stringify({ item: 7 }), { headers: { Authorization: `Bearer ${token}` } });
}

export function handleSummary(data) {
  const avgP95 = (data.metrics.p95_list || []).reduce((a, b) => a + b, 0) / 2; // mean(p95) of two runs
  return { stdout: `avg p95 ${avgP95}` };
}
