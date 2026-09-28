// Loopback-only mock of the two Praesidia routes the release gate calls.
// The request body's `evalRunId` picks the scenario; any other key -> 401.
import { createServer } from 'node:http';

export const KEY = 'pra_test_key';
const verdict = (effectiveResult) => ({
  id: 'e1', result: effectiveResult, effectiveResult, failingThresholds: [],
  evidenceRef: { type: 'eval_run', id: 'r1' },
});
const SCENARIOS = {
  pass: [201, verdict('pass')],
  fail: [201, verdict('fail')],
  advisory: [201, verdict('advisory_fail')],
  report: [201, { ...verdict('pass'), reportUrl: 'https://app.example/r/e1' }],
  noverdict: [201, { id: 'e1' }],
  malformed: [201, '{not json'],
  conflict: [409, { statusCode: 409, message: 'bound to another commit' }],
};

export function startMock() {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: raw });
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };
      if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { statusCode: 401 });
      if (req.url.endsWith('/aibom/import')) return send(201, { id: 'b1', created: true });
      const run = JSON.parse(raw).evalRunId;
      send(...(SCENARIOS[run] ?? [404, { statusCode: 404 }]));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close() }),
    ),
  );
}

// CLI (self-test workflow): print the base URL, then serve until killed.
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const { url } = await startMock();
  console.log(url);
}
