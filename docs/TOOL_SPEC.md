# mcp-server-web-audit — Tool Specification

All tools are registered via `McpServer.registerTool` with:

- **Input**: `url` (string, required, trimmed, 1–2048 chars; public `http://` / `https://` URL) and `format` (`"markdown"` | `"json"`, default `"markdown"`).
- **Annotations**: `readOnlyHint: true`, `openWorldHint: true`, `idempotentHint: true`, `destructiveHint: false`, plus a human-readable `title`.
- **Output**: `content: [{ type: "text", text }]`, where the text is Markdown or pretty-printed JSON. Cached Markdown results start with a cache notice.
- **Errors**: `isError: true` with text `Validation Error: <CODE>: <message>` (URL rejected) or `<Label> failed: <CODE>: <message>`.

| Code | Meaning |
|---|---|
| `InvalidParams` | Malformed URL, unsupported scheme, or embedded credentials |
| `POLICY_BLOCKED` | Domain blocked by `AUDIT_BLOCKED_DOMAINS` / not in `AUDIT_ALLOWED_DOMAINS` |
| `SSRF_BLOCKED` | Localhost, private/reserved IP, metadata host, or a hostname resolving to one |
| `DNS_FAILED` | Hostname could not be resolved |
| `HTTP_ERROR` | Target returned status ≥ 400 (error pages are not audited) |
| `NOT_HTML` | Response is not HTML (HTML-based audits only) |
| `ROBOTS_DISALLOWED` | `RESPECT_ROBOTS_TXT=true` and robots.txt disallows the path |
| `TOO_MANY_REDIRECTS` / `RESPONSE_TOO_LARGE` | Limits exceeded |
| `TIMEOUT` / `CANCELLED` | Deadline reached / client cancelled |
| `FETCH_FAILED` | Network error |
| `InternalError` | Unexpected failure (details only in server logs) |

## Tools Overview

| Tool | Title | Primary Output |
|---|---|---|
| `audit_seo` | SEO Audit | Score + SEO findings |
| `audit_security` | Security Headers Audit | Score + security findings |
| `audit_tracking` | Tracking Tags Audit | Score + tracker detections |
| `audit_accessibility` | Accessibility Audit | Score + a11y findings |
| `audit_performance` | Performance Audit | Score + synthetic metrics (+ CrUX) |
| `audit_full` | Full Website Audit | Category scores + weighted overall |

## 1. `audit_seo`
Checks title and meta description length (30–60 / 70–160 chars), indexability (robots / googlebot meta and `X-Robots-Tag`: `noindex`/`none` is a failure, `nofollow` a warning; header directives scoped to a crawler other than Googlebot, e.g. `otherbot: noindex`, are ignored), canonical (resolved against the final URL; missing, invalid, multiple or mismatched), H1 count, Open Graph tags, Twitter card (informational), hreflang codes, and `<html lang>`.

## 2. `audit_security`
Works on any response type. Checks:

- HTTPS.
- HSTS: missing, invalid, `max-age=0`, or shorter than 1 year; reports `includeSubDomains` / `preload`.
- CSP: missing, report-only only, no `script-src`/`default-src`, `'unsafe-inline'`/`'unsafe-eval'`/`*`/scheme sources, `object-src` and `base-uri`.
- Clickjacking: `frame-ancestors` directive, or `X-Frame-Options` `DENY`/`SAMEORIGIN`.
- `X-Content-Type-Options: nosniff`, Referrer-Policy (flags `unsafe-url`), Permissions-Policy, Cross-Origin-Opener-Policy and Cross-Origin-Resource-Policy (informational, no score impact).
- Cookies across all redirect hops: `SameSite=None` without `Secure`, missing `Secure`/`HttpOnly`/`SameSite`. The total cookie penalty is capped.

## 3. `audit_tracking`
Detects GA4, GTM, Meta Pixel, TikTok Pixel, LinkedIn Insight Tag, Hotjar and Microsoft Clarity in static HTML and extracts IDs. Tags injected at runtime (e.g. through GTM) are not visible. The score drops for:

- Multiple IDs for the same tracker.
- Ad or heatmap trackers with no recognisable consent manager (Cookiebot, OneTrust, CookieYes, Usercentrics, Didomi, iubenda, Osano, Termly, Quantcast Choice, Complianz, Klaro) or Google Consent Mode default.
- More than 4 different trackers.
- Tracker scripts loaded without `async`/`defer` (render-blocking).

## 4. `audit_accessibility`
Static checks:

- Image `alt` (images with `alt=""`, `role="presentation"`/`"none"` or `aria-hidden="true"` count as decorative).
- Form control labels (`<label for>`, wrapping label, `aria-label`, non-empty `aria-labelledby`, `title`; hidden/submit/button/reset/image inputs excluded).
- `main` and `nav` landmarks.
- Heading order: the first heading should be `<h1>`, and each skipped level counts (h1 → h4 is 2 skipped levels).
- `<html lang>`.

No colour-contrast or rendered-DOM checks.

## 5. `audit_performance`
Measured from the audit server:

- TTFB.
- Decompressed HTML size in bytes.
- Compression (`gzip`, `br`, `zstd`, `deflate`).
- `Cache-Control`.

With `CRUX_API_KEY`, it adds Chrome UX Report p75 phone data (LCP, INP, CLS, FCP, TTFB; URL-level, falling back to origin-level on 404). LCP/INP/CLS thresholds are applied (needs-improvement −5, poor −15). No browser or Lighthouse is run.

## 6. `audit_full`
Fetches the page once (CrUX in parallel) and runs all five engines. If an engine fails, its category is omitted, listed under `errors` (JSON) or "Partial Result" (Markdown), and the overall score is re-weighted over the completed categories. Partial results are not cached. Progress notifications are sent when the client supplies a `progressToken`.

### Overall score
Weights: SEO 25%, Security 25%, Tracking 15%, Accessibility 15%, Performance 20%.

```
Overall = round( Σ(score_c × weight_c) / Σ(weight_c) )   over completed categories c
```

Ratings: `≥ 80` **GOOD**, `≥ 50` **WARNING**, `< 50` **POOR**.
