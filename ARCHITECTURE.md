# mcp-server-web-audit — Architecture

## Overview
A read-only MCP server that audits public web pages. It supports stdio (default) and stateless Streamable HTTP transports, both built on the official `@modelcontextprotocol/sdk` `McpServer`.

## System Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                 MCP Host (Cursor / Claude / ...)             │
└──────────────┬───────────────────────────────┬───────────────┘
               │ stdio (JSON-RPC)              │ POST /mcp (Streamable HTTP)
┌──────────────▼───────────────────────────────▼───────────────┐
│                mcp-server-web-audit (Node.js 22)             │
│  httpServer.ts: Host check → Origin/CORS → IP rate limit →   │
│                 bearer auth (+ failure limit) → JSON 256 KB  │
│  server.ts: McpServer + registerTool (zod schemas, titles,   │
│             read-only annotations)                           │
│  tools/common.ts: overall deadline + cancellation → validate │
│             → cache → (robots) → fetch → engine → render     │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────┐ ┌─────────┐ │
│  │Performance│ │   SEO    │ │ Security │ │Track │ │  A11y   │ │
│  │synthetic │ │          │ │          │ │      │ │         │ │
│  │ + CrUX   │ │          │ │          │ │      │ │         │ │
│  └──────────┘ └──────────┘ └──────────┘ └──────┘ └─────────┘ │
│  Shared: ip.ts · validators.ts · fetcher.ts (undici, pinned  │
│  DNS) · parsers.ts · robots.ts · cache.ts · logger (stderr)  │
└──────────────────────────────────────────────────────────────┘
```

## Directory Structure

```
mcp-server-web-audit/
├── src/
│   ├── index.ts              # Entry point: stdio or HTTP based on TRANSPORT
│   ├── server.ts             # createMcpServer() + stdio bootstrap
│   ├── httpServer.ts         # Express app for Streamable HTTP (stateless)
│   ├── config.ts             # Env parsing and validation
│   ├── errors.ts             # AppError, error codes, abort helpers
│   ├── ip.ts                 # IP classification (IPv4/IPv6, embedded IPv4)
│   ├── validators.ts         # URL validation, domain policy, DNS SSRF checks
│   ├── fetcher.ts            # safeFetch: undici + pinned lookup, manual redirects, caps
│   ├── robots.ts             # RFC 9309 robots.txt (opt-in)
│   ├── parsers.ts            # Cheerio HTML parsing, Set-Cookie parsing
│   ├── cache.ts              # LRU TTL cache with in-flight de-duplication
│   ├── rateLimit.ts          # Fixed-window limiter with pruning
│   ├── logger.ts             # pino → stderr, URL redaction
│   ├── formatters.ts         # Markdown rendering (page text sanitized)
│   ├── types.ts
│   ├── engines/
│   │   ├── scoring.ts
│   │   ├── seo-checks.ts
│   │   ├── security-checks.ts
│   │   ├── tracking-checks.ts
│   │   ├── a11y-checks.ts
│   │   ├── performance.ts    # Synthetic metrics + CrUX items
│   │   └── crux.ts           # Chrome UX Report API client
│   └── tools/
│       ├── common.ts         # Shared tool pipeline and schemas
│       ├── index.ts          # ALL_TOOLS + registerTools()
│       ├── audit-seo.ts · audit-security.ts · audit-tracking.ts
│       ├── audit-accessibility.ts · audit-performance.ts · audit-full.ts
├── tests/
│   ├── setup.ts              # Global fake DNS (no real DNS in tests)
│   ├── helpers.ts            # Local HTTP server, test network policy
│   ├── unit/
│   └── integration/          # In-memory MCP client, HTTP transport
├── docs/ (TOOL_SPEC.md, SECURITY.md, PROMPTS.md)
├── eslint.config.mjs · vitest.config.ts · tsconfig*.json
├── Dockerfile · .github/workflows/ci.yml
└── README.md
```

## Core Modules

### Tool registration (`src/tools/index.ts`)
Each tool is registered with `McpServer.registerTool(name, { title, description, inputSchema, annotations }, handler)`. Input schemas are fresh zod shapes per tool (`url` with a description, `format` enum), so the published JSON Schema contains no `$ref`. Annotations: `readOnlyHint`, `openWorldHint`, `idempotentHint` true; `destructiveHint` false.

### Tool pipeline (`src/tools/common.ts`)
1. `runAudit` creates one deadline (`AUDIT_TOTAL_TIMEOUT_MS`) combined with the client's abort signal.
2. `validateTarget` checks the scheme, credentials, domain policy and SSRF (DNS included, under the deadline).
3. `auditCache.getOrCompute` serves from cache or de-duplicates concurrent identical calls.
4. `fetchTarget` checks robots.txt when `RESPECT_ROBOTS_TXT=true`, then calls `safeFetch`. Status ≥ 400 → `HTTP_ERROR`.
5. HTML engines require an HTML response (`NOT_HTML` otherwise). The security audit works on any response.
6. `renderResult` produces Markdown or JSON. Errors become `isError: true` results with a code.

### Fetcher (`src/fetcher.ts`)
- undici `fetch` with a per-call `Agent` whose `connect.lookup` resolves, validates **all** addresses, and returns only validated ones (DNS pinning). The lookup is injectable (`NetworkPolicy`) for tests.
- `redirect: 'manual'` with per-hop validation; 3xx bodies are cancelled; `Set-Cookie` headers are collected across hops.
- `Content-Length` pre-check plus a streamed byte cap, with the reader cancelled on overflow.
- Errors are mapped to `TIMEOUT` / `CANCELLED` / `FETCH_FAILED` / `TOO_MANY_REDIRECTS` / `RESPONSE_TOO_LARGE` without leaking resolved IPs.

### Engines
Pure functions over the fetch result / parsed HTML.

| Engine | Input | Highlights |
|---|---|---|
| SEO | Parsed HTML + headers + final URL | noindex/nofollow (meta + `X-Robots-Tag`), canonical resolution/multiplicity, hreflang |
| Security | Headers + cookies + URL | HSTS max-age parsing, CSP directive analysis, frame-ancestors/XFO values, capped cookie penalties |
| Tracking | Parsed HTML | Anchored detection patterns, per-tracker ID extraction, multiple-ID warnings |
| A11y | Parsed HTML | Decorative image exclusion, robust label association, all heading skips |
| Performance | Fetch result + optional CrUX | TTFB, byte size, compression, caching, CrUX LCP/INP/CLS thresholds |

### `audit_full`
One fetch, with CrUX in parallel. Each engine runs in its own try/catch; failed categories appear in `errors` and the overall score is re-weighted over the completed categories. Only complete results are cached.

## Error Handling

| Situation | Result |
|---|---|
| Invalid / blocked URL | `isError`, `Validation Error: SSRF_BLOCKED` / `InvalidParams` / `POLICY_BLOCKED` / `DNS_FAILED` |
| Target 4xx/5xx | `isError`, `HTTP_ERROR` (error pages are not audited) |
| Non-HTML response | `isError`, `NOT_HTML` (security audit still works) |
| Deadline / cancellation | `isError`, `TIMEOUT` / `CANCELLED` |
| One engine fails in `audit_full` | Partial result with per-category error |
| Unexpected exception | `isError`, `InternalError` (details only in stderr logs) |

## Dependencies
- `@modelcontextprotocol/sdk`: MCP server, transports, Host validation middleware
- `undici`: fetch with custom connector (DNS pinning)
- `cheerio`: HTML parsing
- `express` 5: HTTP transport
- `zod`: input schemas
- `pino`: structured logging to stderr
