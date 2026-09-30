# mcp-server-web-audit — Development Workflow

## Daily Development Loop

### 1. Start Your Day
```bash
# Pull latest changes
git pull origin main

# Install any new dependencies
pnpm install

# Run the full test suite to ensure a green baseline
pnpm test
```

### 2. Pick a Task
- Check `PROJECT_PLAN.md` Phase Roadmap for open items
- Create a branch: `git checkout -b feat/<tool-name>` or `git checkout -b fix/<issue>`
- Update `PROJECT_PLAN.md` to mark the task as "In Progress"

### 3. Design Before Code
- For new tools: write the tool spec in `docs/TOOL_SPEC.md` first
- For new engines: update `ARCHITECTURE.md` with the module design
- For security changes: update `docs/SECURITY.md` with the threat model

### 4. Implement
- Write the code following `DEVELOPMENT_RULES.md`
- Add tests alongside code (TDD preferred)
- Run `pnpm lint` and `pnpm typecheck` frequently
- Use Cursor agent with prompts from `PROMPTS.md`

### 5. Test
```bash
# Unit tests
pnpm test:unit

# Integration tests (in-memory MCP client + HTTP transport on an ephemeral port)
pnpm test:integration

# Full suite with coverage
pnpm test:coverage

# Lint and format
pnpm lint
pnpm format
```

### 6. Commit
```bash
# Stage changes
git add .

# Commit with conventional commit format
git commit -m "feat: add audit_tracking tool with GA4/GTM detection"

# Push branch
git push origin feat/audit-tracking
```

### 7. Pull Request
- Open a PR with a clear description
- Link to the relevant task in `PROJECT_PLAN.md`
- Ensure CI passes (lint, test, audit)
- Request review if the change is non-trivial
- Merge only after approval and green CI

### 8. Update Documentation
- Update `README.md` if user-facing behavior changed
- Update `PROMPTS.md` if tool names or descriptions changed
- Update `TOOL_SPEC.md` with any new or modified tools

---

## Branch Strategy

| Branch | Purpose |
|--------|---------|
| `main` | Production-ready code. All PRs merge here. |
| `feat/*` | New features or tools |
| `fix/*` | Bug fixes |
| `docs/*` | Documentation-only changes |
| `security/*` | Security patches and hardening |
| `release/*` | Release preparation (version bumps, changelogs) |

---

## Release Workflow

### 1. Prepare Release Branch
```bash
git checkout -b release/v0.2.0
```

### 2. Version Bump
```bash
# Update version in package.json
pnpm version minor  # or patch / major

# Update CHANGELOG.md
```

### 3. Final Checks
```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test:coverage
pnpm build
pnpm audit --audit-level=high
```

### 4. Merge & Tag
```bash
git push origin release/v0.2.0
# Open PR, merge to main
git checkout main
git pull origin main
git tag v0.2.0
git push origin v0.2.0
```

### 5. Publish
```bash
# Publish to npm
pnpm publish --access public

# Build and push Docker image
docker build -t <registry>/mcp-server-web-audit:v0.2.0 .
docker push <registry>/mcp-server-web-audit:v0.2.0
```

---

## Cursor IDE Integration Workflow

### Setup (One-Time)
1. Open Cursor Settings > MCP
2. Add a new MCP server:
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
3. Reload Cursor window
4. Verify the server appears in the MCP panel with all tools listed

### Development with Agent
1. Open the Cursor agent chat
2. Use prompts from `PROMPTS.md` to guide the agent
3. The agent can call your tools to audit example sites during development
4. Use the agent to generate tests, docs, and boilerplate

---

## Debugging

### Local Server Testing
```bash
# Build the project
pnpm build

# Run the server over stdio (the MCP handshake must start with "initialize")
node dist/index.js

# Run the HTTP transport locally
TRANSPORT=http MCP_AUTH_TOKEN=$(openssl rand -hex 32) node dist/index.js
```

### With MCP Inspector
```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

### Logging
- All logs go to stderr (never stdout); URLs are logged without query strings
- Use `LOG_LEVEL=debug node dist/index.js` for application-level debug logs
- Tests run with `LOG_LEVEL=silent` (see `vitest.config.ts`)

---

## CI/CD Pipeline

### GitHub Actions Workflow (`.github/workflows/ci.yml`)
Runs on pushes and PRs to `main` with read-only repository permissions, Node 22, and the pnpm version from `packageManager`:
1. `pnpm install --frozen-lockfile`
2. `pnpm lint`
3. `pnpm typecheck` (src + tests)
4. `pnpm test:coverage` (fails below the coverage thresholds)
5. `pnpm build`
6. `pnpm audit --audit-level=high` (fails on HIGH/CRITICAL)

### Required Checks Before Merge
- [ ] CI is green (lint, typecheck, tests + coverage, build, audit)
- [ ] Docs updated for user-facing changes
- [ ] Code review approved (for non-trivial changes)
