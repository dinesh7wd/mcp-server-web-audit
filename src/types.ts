/**
 * Shared TypeScript interfaces and types for mcp-server-web-audit.
 */

export type AuditStatus = 'pass' | 'fail' | 'warn' | 'info';

export type OverallRating = 'good' | 'warning' | 'poor';

export interface AuditItem {
  id: string;
  title: string;
  status: AuditStatus;
  description: string;
  recommendation?: string;
  details?: Record<string, unknown> | string;
}

export interface BaseAuditResult {
  url: string;
  timestamp: string;
  score: number;
  rating: OverallRating;
  items: AuditItem[];
}

export interface SeoAuditResult extends BaseAuditResult {
  title?: string;
  titleLength?: number;
  description?: string;
  descriptionLength?: number;
  canonical?: string;
  canonicalResolved?: string;
  canonicalMatches?: boolean;
  robots?: string;
  xRobotsTag?: string;
  indexable: boolean;
  h1Count: number;
  h1Content: string[];
  openGraph: Record<string, string>;
  twitterCard: Record<string, string>;
  hreflangCount: number;
  language?: string;
}

export interface SecurityAuditResult extends BaseAuditResult {
  isHttps: boolean;
  hstsHeader?: string;
  hstsMaxAge?: number;
  cspHeader?: string;
  cspReportOnlyHeader?: string;
  xFrameOptions?: string;
  xContentTypeOptions?: string;
  referrerPolicy?: string;
  permissionsPolicy?: string;
  cookieFlags: Array<{
    name: string;
    secure: boolean;
    httpOnly: boolean;
    sameSite?: string;
  }>;
}

export type TrackerCategory = 'analytics' | 'tag-manager' | 'ads' | 'heatmap';

export interface TrackingAuditResult extends BaseAuditResult {
  detectedTrackers: Array<{
    name: string;
    category: TrackerCategory;
    identifiers: string[];
  }>;
  duplicateTrackers: string[];
}

export interface A11yAuditResult extends BaseAuditResult {
  totalImages: number;
  imagesWithoutAlt: number;
  formInputsTotal: number;
  formInputsWithoutLabel: number;
  hasMainLandmark: boolean;
  hasNavLandmark: boolean;
  headingOrderValid: boolean;
  headingSkips: number;
  languageDeclared: boolean;
}

export interface FieldMetrics {
  scope: 'url' | 'origin';
  lcpMs?: number;
  inpMs?: number;
  cls?: number;
  fcpMs?: number;
  ttfbMs?: number;
}

export interface PerformanceAuditResult extends BaseAuditResult {
  engine: 'synthetic';
  timing: {
    ttfbMs: number;
    downloadMs: number;
    totalMs: number;
  };
  payloadSize: number;
  compression?: string;
  cacheControl?: string;
  fieldData?: FieldMetrics;
}

export type AuditCategory = 'seo' | 'security' | 'tracking' | 'accessibility' | 'performance';

export interface FullAuditResult {
  url: string;
  timestamp: string;
  overallScore: number;
  overallRating: OverallRating;
  seo?: SeoAuditResult;
  security?: SecurityAuditResult;
  tracking?: TrackingAuditResult;
  accessibility?: A11yAuditResult;
  performance?: PerformanceAuditResult;
  errors: Partial<Record<AuditCategory, string>>;
}

export interface FetchResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  setCookies: string[];
  contentType?: string;
  body: string;
  finalUrl: string;
  timing: {
    ttfbMs: number;
    downloadMs: number;
    totalMs: number;
  };
  redirectCount: number;
}

export interface LookupAddress {
  address: string;
  family: number;
}

export type LookupFn = (hostname: string) => Promise<LookupAddress[]>;

/**
 * Outbound network policy. `lookup` resolves hostnames; `isAddressBlocked`
 * decides whether a resolved or literal address may be contacted.
 */
export interface NetworkPolicy {
  lookup: LookupFn;
  isAddressBlocked: (ip: string) => boolean;
}

export interface FetchOptions {
  timeoutMs?: number;
  maxRedirects?: number;
  maxSizeBytes?: number;
  userAgent?: string;
  accept?: string;
  signal?: AbortSignal;
  policy?: NetworkPolicy;
}

export type AuditFormat = 'markdown' | 'json';
