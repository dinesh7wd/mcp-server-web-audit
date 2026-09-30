# mcp-server-web-audit — Development Rules

## 1. Code Quality
- All code must be TypeScript with strict mode enabled (`strict: true` in `tsconfig.json`)
- Every exported function must have a JSDoc comment with `@param` and `@returns`
- Prefer `async/await` over raw Promises
- No `any` types unless absolutely necessary, and always with a `// eslint-disable-next-line @typescript-eslint/no-explicit-any` comment explaining why
- Max function length: 40 lines. Split into smaller pure functions.
- Max file length: 300 lines. Split into modules.

## 2. MCP-Specific Rules
- **Never write to stdout** except through the MCP SDK. Use `console.error()` or a logger that writes to stderr
- Never use `console.log()` anywhere in the codebase
- All tool names must be `snake_case`
- All tool descriptions must be written for an LLM: clear, concise, and include expected input/output
- Every tool must have a Zod schema for input validation
- Every tool must return `content: [{ type: "text", text: ... }]`
- If a tool encounters an error, return `{ content: [...], isError: true }`
- Tool handlers must be pure async functions with no side effects outside the audit scope

## 3. URL & Network Safety
- All outbound page requests go through `safeFetch()` (`src/fetcher.ts`), which validates every hop with `validateAuditUrl()` and pins validated DNS answers
- Reject private/reserved IP ranges (including embedded IPv4 in IPv6), localhost, and metadata hosts (SSRF prevention)
- Reject URLs with non-HTTP(S) protocols (`file://`, `ftp://`, etc.) or embedded credentials
- Enforce the configured redirect limit (default 5) and the 5 MB response size limit
- Always set a custom `User-Agent` header (`mcp-server-web-audit/<version>`)
- Honour `robots.txt` when `RESPECT_ROBOTS_TXT=true` (off by default for user-directed single-page audits)
- Never include resolved IP addresses in client-facing errors; log URLs without query strings

## 4. Audit Rules
- All audits are **read-only**. Never POST, PUT, DELETE, or mutate target sites
- Never attempt to bypass authentication, WAFs, or rate limits
- Never scan ports, paths, or endpoints not explicitly provided by the user
- If a site blocks the audit (403, 429, WAF challenge), return the status and explain gracefully
- Do not include raw HTML bodies in tool output unless explicitly requested

## 5. Error Handling
- Never throw unhandled exceptions. Always catch and return structured error responses
- Network errors: return `isError: true` with the error message and suggestion
- Timeout errors: every tool call runs under one deadline (`AUDIT_TOTAL_TIMEOUT_MS`) and returns `TIMEOUT`
- Engine failures in `audit_full`: return the remaining categories with per-category errors
- Always log errors to stderr with context (tool name, redacted URL, error code)

## 6. Testing
- Coverage thresholds are enforced by `pnpm test:coverage` (≥ 85% lines/statements/functions, ≥ 80% branches)
- Tools are exercised through an in-memory MCP client (`InMemoryTransport`) and the HTTP transport on an ephemeral port
- Use local HTTP servers (`tests/helpers.ts`) with an injected `NetworkPolicy` for fetcher tests
- DNS is faked globally in `tests/setup.ts`; never make real network or DNS calls in tests
- `pnpm typecheck` covers tests as well as `src`

## 7. Documentation
- Every new tool must be documented in `TOOL_SPEC.md` before implementation
- Every new engine must be documented in `ARCHITECTURE.md`
- Update `README.md` when adding, removing, or changing tools
- Keep `PROMPTS.md` in sync with actual tool names and descriptions

## 8. Git & Commits
- Use conventional commits: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `security:`
- One logical change per commit
- All commits must pass `pnpm lint`, `pnpm typecheck` and `pnpm test` before pushing
- Branch naming: `feat/<name>`, `fix/<name>`, `docs/<name>`, `security/<name>`

## 9. Dependencies
- Pin all production dependencies to exact versions in `package.json`
- Only add a new dependency after documenting the justification in the PR description
- Prefer native Node.js APIs over new packages when possible
- Keep the total dependency tree under 50 direct dependencies

## 10. Security
- Run `pnpm audit` in CI and fail the build on HIGH or CRITICAL vulnerabilities
- Never hardcode secrets, tokens, or API keys
- Use `.env` for local configuration and `.env.example` for documentation
- Keep `SECURITY.md` updated with all known attack vectors and mitigations
