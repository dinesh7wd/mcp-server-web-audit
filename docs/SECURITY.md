# Security Architecture & Policies

## Overview
`mcp-server-web-audit` is a read-only auditor: each tool call performs a single `GET` of the user-supplied page (plus `robots.txt` when `RESPECT_ROBOTS_TXT=true`, and the optional CrUX API call). The main threats are SSRF against the host's network, resource exhaustion, and unauthorised use of the HTTP transport.

## 1. SSRF mitigation

Implemented in `src/ip.ts`, `src/validators.ts` and `src/fetcher.ts`.

- **Scheme and credentials**: only `http:` and `https:`; URLs containing `user:pass@` are rejected.
- **Domain policy**: `AUDIT_ALLOWED_DOMAINS` / `AUDIT_BLOCKED_DOMAINS` (subdomains included).
- **Port policy**: `AUDIT_ALLOWED_PORTS` (default `80,443,8080,8443`) stops audits and redirects from probing internal services on arbitrary ports.
- **Names**: `localhost`, `*.localhost` and cloud metadata names (`metadata.google.internal`, `metadata.goog`) are rejected.
- **IP literals** (including bracketed IPv6 and zone IDs) are classified directly:
  - IPv4 blocked: `0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.88.99/24`, `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/4`, `240/4`.
  - IPv6: anything outside global unicast `2000::/3` is blocked (loopback, unspecified, `fc00::/7`, `fe80::/10`, multicast, ...), as are `2001::/23`, `2001:db8::/32` and `3fff::/20`.
  - Embedded IPv4 is decoded and re-checked for IPv4-mapped (`::ffff:a.b.c.d`, including hex form `::ffff:7f00:1`), SIIT (`::ffff:0:a.b.c.d`), IPv4-compatible (`::a.b.c.d`), NAT64 (`64:ff9b::/96`) and 6to4 (`2002::/16`).
- **Hostnames** are resolved with `dns.lookup({ all: true })`. If **any** resolved address is blocked, the request is rejected (`SSRF_BLOCKED`). Hostnames are never pattern-matched as IPs, so names such as `fdic.gov` or `fcbarcelona.com` are not falsely blocked.
- **DNS pinning (anti-rebinding)**: the actual connection uses an undici `Agent` whose `connect.lookup` re-resolves, re-validates every address, and hands only the validated address to the socket. There is no gap between check and connect.
- **Redirects** are followed manually (`redirect: 'manual'`). Each hop is re-validated (scheme, policy, DNS) and 3xx bodies are discarded.
- **No IP disclosure**: error messages never include resolved addresses.

## 2. Resource limits
- Per-request timeout `AUDIT_TIMEOUT_MS` (default 15 s, max 30 s).
- One overall deadline per tool call `AUDIT_TOTAL_TIMEOUT_MS` (default 45 s), covering DNS, redirects, body download, robots.txt and CrUX. Client cancellation (`notifications/cancelled`) aborts in-flight work.
- Max `AUDIT_MAX_REDIRECTS` hops (default 5, max 10).
- Body cap 5 MB (512 KB for robots.txt): checked via `Content-Length` and enforced while streaming, and the stream is cancelled on overflow.
- In-memory LRU cache (default 5 min / 100 entries) with in-flight de-duplication, so concurrent identical calls fetch once.

## 3. Transports
- **stdio** (default): JSON-RPC on stdout, logs on stderr only (pino, fd 2). URLs are logged without query strings or fragments.
- **Streamable HTTP** (`TRANSPORT=http`, stateless `POST /mcp`):
  - Binds to `HOST` (default `127.0.0.1`).
  - `Host` header validation against `MCP_ALLOWED_HOSTS` (DNS-rebinding protection). This is required for non-loopback binds.
  - `Origin` allowlist (`MCP_ALLOWED_ORIGINS`). Disallowed origins get 403, and CORS headers are only sent for allowed origins.
  - Per-IP rate limit applied **before** authentication, plus a stricter per-IP failed-authentication limit (`AUTH_FAIL_RATE_LIMIT_MAX`). Buckets are pruned and capped. A shared global bucket (10× the per-IP limits) also caps total traffic, so rotating source addresses cannot multiply the budget.
  - Bearer token of at least 32 characters, compared in constant time (SHA-256 digests + `timingSafeEqual`).
  - JSON body limit 256 KB. `GET`/`DELETE /mcp` return 405 (no sessions).
  - Set `TRUST_PROXY` behind a reverse proxy so limits key on the real client IP.

## 4. robots.txt
Off by default (`RESPECT_ROBOTS_TXT=false`): the server audits only the single URL a user explicitly requests, while RFC 9309 addresses automated crawlers. When enabled, `robots.txt` is fetched through the same SSRF-safe fetcher and evaluated per RFC 9309 (product token from `AUDIT_USER_AGENT`, longest match, `*`/`$` wildcards). A 4xx response means allow all; a 5xx response or an unreachable file means disallow all.

## 5. CrUX
`CRUX_API_KEY` is optional and is sent only in the `X-Goog-Api-Key` header to `chromeuxreport.googleapis.com`, never in URLs or logs. CrUX failures degrade to synthetic metrics.

## 6. Supply chain
CI runs `pnpm install --frozen-lockfile`, lint, typecheck, tests with coverage thresholds, build, and `pnpm audit --audit-level=high` (failing the build). The Docker image pins Node 22 and pnpm, installs from the lockfile with `--ignore-scripts`, and runs as the non-root `node` user.
