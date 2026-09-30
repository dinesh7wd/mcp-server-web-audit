# mcp-server-web-audit — Project Plan

## Vision
A Model Context Protocol (MCP) server that lets AI agents (Cursor, Claude Desktop, etc.) audit any public URL with safe, read-only tools covering performance, SEO, security headers, accessibility and tracking hygiene.

## Tech Stack
- **Runtime**: Node.js 22+ (TypeScript, ESM)
- **MCP SDK**: `@modelcontextprotocol/sdk` ≥ 1.30 (`McpServer.registerTool`)
- **Transport**: stdio (default) and stateless Streamable HTTP
- **Audit engines**: fetch-based analysers (undici with pinned DNS + Cheerio) and the optional Chrome UX Report API for field data
- **Package manager**: pnpm (pinned via `packageManager`)
- **Linting**: ESLint + typescript-eslint, Prettier
- **Testing**: Vitest with v8 coverage thresholds

## Phase Roadmap

### Phase 1: Foundation
- [x] Scaffold TypeScript project with the MCP SDK
- [x] stdio transport
- [x] Cursor IDE rules and prompts
- [x] ESLint, Prettier, Vitest
- [x] README and ARCHITECTURE docs

### Phase 2: Core Audit Tools
- [x] `audit_performance` (synthetic metrics + CrUX field data)
- [x] `audit_seo` (meta tags, indexability, canonical, headings, hreflang)
- [x] `audit_security` (HTTPS, HSTS, CSP, clickjacking, cookies)
- [x] `audit_tracking` (GA4, GTM, Meta Pixel, ...)
- [x] `audit_accessibility`
- [x] `audit_full` with partial results
- [x] Input validation and SSRF-hardened fetcher with DNS pinning

### Phase 3: Safety & Polish
- [x] Overall per-call deadline and client cancellation
- [x] Domain allowlist / blocklist
- [x] Opt-in robots.txt support (`RESPECT_ROBOTS_TXT`)
- [x] Structured JSON + Markdown output
- [x] In-memory TTL cache with in-flight de-duplication
- [x] Streamable HTTP hardening (Host/Origin validation, per-IP limits, constant-time auth)

### Phase 4: Distribution
- [ ] npm package publish (`mcp-server-web-audit`)
- [x] Docker image (Node 22, non-root, healthcheck for HTTP mode)
- [x] Claude Desktop / Cursor configuration examples
- [x] GitHub Actions CI (lint, typecheck, coverage, build, audit)

### Possible next steps
- `outputSchema` / `structuredContent` for JSON results
- Rendered-DOM checks (contrast, runtime-injected tags) via an isolated browser worker

## Success Criteria
- Every tool call finishes within `AUDIT_TOTAL_TIMEOUT_MS` (default 45 s) with actionable results
- No HIGH/CRITICAL `pnpm audit` findings
- Coverage thresholds (≥ 85% lines/statements/functions, ≥ 80% branches) enforced in CI
- Works out of the box with Cursor and Claude Desktop

## Key Constraints
- Never write to stdout except via the MCP SDK (stdio transport)
- Never mutate target sites (single read-only GET per audit)
- Always validate URLs and pin validated DNS answers to prevent SSRF
- Do not hammer targets (cache, de-duplication, per-IP rate limits); honour robots.txt when configured
