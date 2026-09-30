# mcp-server-web-audit — Agent Prompts Guide

Use these prompt patterns in Cursor, Claude Desktop, or your MCP-compatible IDE.

## 1. Complete Website Audit
```
Please audit the website https://example.com using the audit_full tool and give me a breakdown of the lowest scoring areas.
```

## 2. Security Headers Inspection
```
Audit the security headers for https://example.com using audit_security. Point out any missing headers like CSP, HSTS, or clickjacking protection and suggest the exact Nginx/Cloudflare configuration to fix them.
```

## 3. SEO & Metadata Verification
```
Run an SEO audit on https://example.com using audit_seo. Check if the page title, description, canonical link, and OpenGraph tags are properly set up.
```

## 4. Third-Party Tracker Audit
```
Audit https://example.com with audit_tracking to see which marketing and analytics tags (such as GA4, GTM, or Meta Pixel) are active, and verify whether there are any duplicate tracking IDs.
```

## 5. Accessibility Assessment
```
Inspect the accessibility of https://example.com using audit_accessibility. Highlight any missing image alt attributes or unlabeled form controls.
```

## 6. Performance Audit
```
Run audit_performance on https://example.com. Check TTFB, response compression, and HTML payload size.
```
