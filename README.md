# 🌐 mcp-server-web-audit

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7+-blue.svg)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-SDK%201.30+-green.svg)](https://modelcontextprotocol.io/)
[![Node](https://img.shields.io/badge/Node-22+-brightgreen.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A **Model Context Protocol (MCP)** server that lets AI agents (Cursor, Claude Desktop, etc.) audit any public URL.

All tools are read-only (a single `GET` of the page the user asked for) and analyse the static HTML and response headers:

- 🔍 **SEO**: title/description length, indexability (robots meta + `X-Robots-Tag`), canonical (resolved), H1, Open Graph, Twitter cards, hreflang, `lang`.
- 🛡️ **Security**: HTTPS, HSTS (parsed `max-age`), CSP (enforced vs report-only, unsafe script sources), clickjacking (`frame-ancestors` / `X-Frame-Options`), `nosniff`, Referrer-Policy, Permissions-Policy, COOP/CORP (informational), cookie flags across redirect hops.
- 📊 **Tracking**: GA4, GTM, Meta Pixel, TikTok, LinkedIn, Hotjar, Clarity; flags multiple IDs for the same tracker.
- ♿ **Accessibility**: image alt text (decorative images excluded), form labels, landmarks, heading-level skips, `lang`.
- ⚡ **Performance**: TTFB, decompressed HTML size, compression, Cache-Control, plus optional Chrome UX Report (CrUX) field data. No headless browser is used.
- 🌐 **`audit_full`**: all five engines from one fetch, with a weighted overall score. If one engine fails, the others are still returned.

---

## 🚀 Quick Start

Requirements: Node.js 22+ and pnpm 10 (`corepack enable` picks up the pinned version from `package.json`).

```bash
cd mcp-server-web-audit
pnpm install
pnpm build
```

### Cursor

`Cursor Settings > MCP > Add New MCP Server`:

```json
{
  "mcpServers": {
    "web-audit": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server-web-audit/dist/index.js"]
    }
  }
}
```

### Claude Desktop

Add the same block to `claude_desktop_config.json`.

### Docker (stdio)

stdio needs an interactive stdin, so run with `-i`:

```bash
docker build -t mcp-server-web-audit .
docker run -i --rm mcp-server-web-audit
```

```json
{
  "mcpServers": {
    "web-audit": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "mcp-server-web-audit"]
    }
  }
}
```

---

## 🌍 Streamable HTTP mode (optional)

Set `TRANSPORT=http` to serve stateless Streamable HTTP on `POST /mcp` (`GET /health` for probes).

| Variable | Default | Purpose |
|---|---|---|
| `MCP_AUTH_TOKEN` | *(required)* | Bearer token, at least 32 characters (`openssl rand -hex 32`). |
| `HOST` | `127.0.0.1` | Bind address. |
| `PORT` | `3100` | Listen port. |
| `MCP_ALLOWED_HOSTS` | loopback names when `HOST` is loopback | Allowed `Host` header hostnames (DNS-rebinding protection). **Required** when `HOST` is not loopback. |
| `MCP_ALLOWED_ORIGINS` | *(empty)* | Browser origins allowed via CORS. Requests with any other `Origin` get 403. |
| `TRUST_PROXY` | `false` | Express `trust proxy` value; set it behind a reverse proxy so per-IP limits see the real client. |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` | `60000` / `30` | Per-IP request limit (applied before auth). |
| `AUTH_FAIL_RATE_LIMIT_MAX` | `10` | Per-IP failed-auth limit per window. |

```bash
docker run --rm -p 3100:3100 \
  -e TRANSPORT=http -e HOST=0.0.0.0 \
  -e MCP_ALLOWED_HOSTS=localhost,127.0.0.1 \
  -e MCP_AUTH_TOKEN="$(openssl rand -hex 32)" \
  mcp-server-web-audit
```

Put a TLS-terminating reverse proxy in front of any non-local deployment.

---

## 🛠️ Tools

| Tool | Description |
|---|---|
| `audit_seo` | Title/description, indexability, canonical, H1, Open Graph, Twitter, hreflang, language |
| `audit_security` | HTTPS, HSTS, CSP, clickjacking, nosniff, Referrer-Policy, Permissions-Policy, COOP/CORP, cookies |
| `audit_tracking` | GA4, GTM, Meta Pixel, TikTok, LinkedIn, Hotjar, Clarity; multiple-ID detection |
| `audit_accessibility` | Image alt, form labels, landmarks, heading skips, language |
| `audit_performance` | TTFB, HTML size, compression, caching, optional CrUX LCP/INP/CLS |
| `audit_full` | All five engines, weighted overall score, partial results on engine failure |

Every tool takes `url` (required) and `format` (`markdown` default, or `json`), and is annotated `readOnlyHint`, `openWorldHint` and `idempotentHint`. Failures return `isError: true` with a code such as `SSRF_BLOCKED`, `HTTP_ERROR`, `NOT_HTML`, `TIMEOUT` or `ROBOTS_DISALLOWED`. See [docs/TOOL_SPEC.md](docs/TOOL_SPEC.md).

---

## ⚙️ Other configuration

See [.env.example](.env.example). Highlights:

- `AUDIT_TIMEOUT_MS` (default 15000, max 30000) per request; `AUDIT_TOTAL_TIMEOUT_MS` (default 45000) overall per tool call, including DNS and CrUX.
- `AUDIT_MAX_REDIRECTS` (default 5, max 10); body cap 5 MB.
- `RESPECT_ROBOTS_TXT` (default `false`): when `true`, the target's `robots.txt` is checked (RFC 9309) before auditing and disallowed paths return `ROBOTS_DISALLOWED`. It is off by default because this is a user-directed single-page auditor, not a crawler.
- `CRUX_API_KEY`: enables CrUX field data (sent via the `X-Goog-Api-Key` header, never in URLs or logs).
- `AUDIT_ALLOWED_DOMAINS` / `AUDIT_BLOCKED_DOMAINS`: domain policies (subdomains included).
- `AUDIT_ALLOWED_PORTS`: ports audits and redirects may target (default `80,443,8080,8443`; `*` = any).
- `AUDIT_CACHE_TTL_MS` (default 5 min; `0` disables) / `AUDIT_CACHE_MAX_ENTRIES`.

---

## 🔒 Security

- **SSRF**: only `http(s)` without credentials. Every hostname is resolved, and **all** resolved addresses must be public. IPv4-mapped/compatible/NAT64/6to4 IPv6 forms are decoded, and anything outside global unicast is blocked. The validated address is **pinned** for the actual connection (no DNS-rebinding window), and every redirect hop is re-validated.
- **Stdio isolation**: logs go only to stderr; logged URLs have query strings removed.
- **HTTP mode**: Host validation, Origin allowlist, per-IP rate limits, constant-time token comparison, 256 KB body limit, loopback bind by default.

Details: [docs/SECURITY.md](docs/SECURITY.md).

---

## 🧪 Development

```bash
pnpm lint            # ESLint (typescript-eslint)
pnpm typecheck       # tsc over src + tests
pnpm test            # vitest (no real network or DNS)
pnpm test:coverage   # with coverage thresholds
pnpm build
```

---

## 📄 Documentation

- [PROJECT_PLAN.md](PROJECT_PLAN.md): roadmap
- [ARCHITECTURE.md](ARCHITECTURE.md): system design and data flow
- [DEVELOPMENT_RULES.md](DEVELOPMENT_RULES.md): coding conventions
- [WORKFLOW.md](WORKFLOW.md): development workflow
- [docs/TOOL_SPEC.md](docs/TOOL_SPEC.md): tool arguments and behaviour
- [docs/SECURITY.md](docs/SECURITY.md): threat model and mitigations
- [docs/PROMPTS.md](docs/PROMPTS.md): example prompts
