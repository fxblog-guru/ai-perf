// Credentials in text that goes into run evidence are masked (design §7.3): tokens in a query
// string, auth headers, and user:password in a URL. Same rules as the Locust shim's mask().
const SECRETS = [
  [/([?&](?:access_token|token|api_?key|key|password|secret|sig)=)[^&\s'"]+/gi, '$1***'],
  [/\b(Bearer|Token|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@'"]+:[^\s/@'"]+@/gi, '$1***@'],
  // NAME=value on a command line or in a tool's output: PGPASSWORD=…, API_KEY=…, --password=…
  [/\b([A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY)[A-Z0-9_]*|--?password)(=|\s+)(?!\*\*\*)[^\s&'"]+/gi, '$1$2***'],
];

export function mask(text) {
  return SECRETS.reduce((s, [re, to]) => s.replace(re, to), String(text));
}
