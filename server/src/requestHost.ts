// The named-tunnel connector (see namedTunnel.ts) outlives the Node process, so a handful of
// protections the quick tunnel got for free - it died with the server, so a broken/passwordless
// state was never reachable from the public URL for long - now have to be enforced per request.
// Every one of them turns on a single question: did this request arrive over a local path
// (ai.local, the LAN, loopback) or from the public internet through Cloudflare? This module
// answers exactly that, from the Host header alone. Nothing here keys off the specific public
// hostname, so a renamed or misconfigured tunnel still fails safe.

const LOCAL_HOSTNAMES: ReadonlySet<string> = new Set([
  "ai.local",
  "claude.local",
  "localhost",
  "127.0.0.1",
  "::1",
]);

// Strips the ":port" suffix from a Host header value, handling bracketed IPv6 (`[::1]:3001`),
// host:port (`ai.local:80`), and bare IPv6 with no port (`::1`, which must NOT be treated as
// host `::` + port `1`).
function hostnameOf(hostHeader: string): string {
  if (hostHeader.startsWith("[")) {
    const closingBracket: number = hostHeader.indexOf("]");
    return closingBracket === -1 ? hostHeader : hostHeader.slice(1, closingBracket);
  }
  const colonCount: number = (hostHeader.match(/:/g) ?? []).length;
  if (colonCount === 1) {
    return hostHeader.slice(0, hostHeader.lastIndexOf(":"));
  }
  return hostHeader;
}

function isPrivateIPv4(hostname: string): boolean {
  const octets: string[] = hostname.split(".");
  if (octets.length !== 4) {
    return false;
  }
  const numbers: number[] = octets.map((octet) => Number(octet));
  if (numbers.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return false;
  }
  const [first, second] = numbers;
  if (first === 10) {
    return true;
  }
  if (first === 172 && second >= 16 && second <= 31) {
    return true;
  }
  return first === 192 && second === 168;
}

export function isLocalRequestHost(hostHeader: string | undefined): boolean {
  // No Host header at all: HTTP/1.1 requires one and Cloudflare always sends it, so the only
  // callers that omit it are raw local clients (a loopback health check, a probe). Treating
  // "absent" as local keeps those working and never widens public access.
  if (hostHeader === undefined || hostHeader === "") {
    return true;
  }
  const hostname: string = hostnameOf(hostHeader).toLowerCase();
  if (LOCAL_HOSTNAMES.has(hostname)) {
    return true;
  }
  return isPrivateIPv4(hostname);
}
