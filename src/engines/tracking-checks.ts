import { AuditItem, TrackerCategory, TrackingAuditResult } from '../types.js';
import { ParsedHtml } from '../parsers.js';
import { penaltyToScore, scoreToRating, slug } from './scoring.js';

interface TrackerPattern {
  name: string;
  category: TrackerCategory;
  detect: RegExp[];
  /** Case-sensitive, global patterns whose first capture group is a tracker ID. */
  idExtractors?: RegExp[];
}

const TRACKER_DEFINITIONS: TrackerPattern[] = [
  {
    name: 'Google Analytics 4 (GA4)',
    category: 'analytics',
    detect: [
      /googletagmanager\.com\/gtag\/js\?(?:[^"'\s]*&)?id=G-[A-Z0-9]{4,12}\b/,
      /gtag\s*\(\s*['"]config['"]\s*,\s*['"]G-[A-Z0-9]{4,12}['"]/,
    ],
    idExtractors: [
      /googletagmanager\.com\/gtag\/js\?(?:[^"'\s]*&)?id=(G-[A-Z0-9]{4,12})\b/g,
      /gtag\s*\(\s*['"]config['"]\s*,\s*['"](G-[A-Z0-9]{4,12})['"]/g,
    ],
  },
  {
    name: 'Google Tag Manager (GTM)',
    category: 'tag-manager',
    detect: [/googletagmanager\.com\/gtm\.js\?(?:[^"'\s]*&)?id=GTM-[A-Z0-9]{4,10}\b/, /['"]GTM-[A-Z0-9]{4,10}['"]/],
    idExtractors: [
      /googletagmanager\.com\/gtm\.js\?(?:[^"'\s]*&)?id=(GTM-[A-Z0-9]{4,10})\b/g,
      /['"](GTM-[A-Z0-9]{4,10})['"]/g,
    ],
  },
  {
    name: 'Meta / Facebook Pixel',
    category: 'ads',
    detect: [/connect\.facebook\.net\/[A-Za-z_]+\/fbevents\.js/, /fbq\s*\(\s*['"]init['"]/],
    idExtractors: [/fbq\s*\(\s*['"]init['"]\s*,\s*['"]?(\d{6,20})['"]?/g],
  },
  {
    name: 'TikTok Pixel',
    category: 'ads',
    detect: [/analytics\.tiktok\.com\/i18n\/pixel/, /ttq\.load\s*\(/],
    idExtractors: [/ttq\.load\s*\(\s*['"]([A-Z0-9]{10,30})['"]/g],
  },
  {
    name: 'LinkedIn Insight Tag',
    category: 'ads',
    detect: [/snap\.licdn\.com\/li\.lms-analytics/, /_linkedin_partner_id\s*=/],
    idExtractors: [/_linkedin_partner_id\s*=\s*['"]?(\d{3,12})['"]?/g],
  },
  {
    name: 'Microsoft Clarity',
    category: 'heatmap',
    detect: [/clarity\.ms\/tag\//, /clarity\s*\(\s*['"]init['"]/],
  },
  {
    name: 'Hotjar',
    category: 'heatmap',
    detect: [/static\.hotjar\.com/, /hjid\s*:\s*\d+/],
    idExtractors: [/hjid\s*:\s*(\d{4,10})/g],
  },
];

const CONSENT_MANAGERS: RegExp[] = [
  /consent\.cookiebot\.com|cookiebot/i,
  /cdn\.cookielaw\.org|onetrust|optanon/i,
  /cookieyes|cdn-cookieyes\.com/i,
  /usercentrics/i,
  /didomi/i,
  /iubenda/i,
  /osano\.com/i,
  /termly\.io/i,
  /quantcast\.mgr|quantcast\.com\/choice/i,
  /complianz|cmplz/i,
  /klaro/i,
  /gtag\s*\(\s*['"]consent['"]\s*,\s*['"]default['"]/,
];
const CONSENT_SENSITIVE: TrackerCategory[] = ['ads', 'heatmap'];
const TRACKER_STACK_LIMIT = 4;
const DUPLICATE_PENALTY = 15;
const NO_CONSENT_PENALTY = 20;
const EXTRA_TRACKER_PENALTY = 5;
const BLOCKING_SCRIPT_PENALTY = 5;
const MAX_STACK_PENALTY = 20;
const MAX_BLOCKING_PENALTY = 15;
const MAX_IDENTIFIERS = 20;

function extractIds(text: string, patterns: RegExp[] = []): string[] {
  const ids = new Set<string>();
  for (const pattern of patterns) {
    for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
      if (match[1]) ids.add(match[1]);
      if (ids.size >= MAX_IDENTIFIERS) return [...ids];
    }
  }
  return [...ids];
}

function scriptText(parsed: ParsedHtml): string {
  return parsed.scripts.map((s) => `${s.src || ''} ${s.inline || ''}`).join('\n');
}

function scanTrackers(parsed: ParsedHtml): TrackingAuditResult['detectedTrackers'] {
  const allScriptText = scriptText(parsed);
  return TRACKER_DEFINITIONS.filter((def) => def.detect.some((re) => re.test(allScriptText))).map((def) => ({
    name: def.name,
    category: def.category,
    identifiers: extractIds(allScriptText, def.idExtractors),
  }));
}

function blockingTrackerScripts(parsed: ParsedHtml, detected: TrackingAuditResult['detectedTrackers']): number {
  const defs = TRACKER_DEFINITIONS.filter((def) => detected.some((t) => t.name === def.name));
  return parsed.scripts.filter((s) => s.blocking && s.src && defs.some((def) => def.detect.some((re) => re.test(s.src!))))
    .length;
}

function checkTrackerHygiene(parsed: ParsedHtml, detected: TrackingAuditResult['detectedTrackers'], items: AuditItem[]): number {
  let penalty = 0;
  const sensitive = detected.filter((t) => CONSENT_SENSITIVE.includes(t.category));
  const text = scriptText(parsed);
  if (sensitive.length > 0 && !CONSENT_MANAGERS.some((re) => re.test(text))) {
    penalty += NO_CONSENT_PENALTY;
    items.push({
      id: 'tracking-no-consent-manager',
      title: 'Ad / Heatmap Trackers Without a Detectable Consent Manager',
      status: 'warn',
      description: `${sensitive.map((t) => t.name).join(', ')} load without a recognised consent management platform or Google Consent Mode default in the static HTML.`,
      recommendation: 'Load advertising and session-recording tags only after consent (e.g. via a CMP or Consent Mode v2), as GDPR/ePrivacy require in many regions.',
    });
  }
  if (detected.length > TRACKER_STACK_LIMIT) {
    penalty += Math.min(MAX_STACK_PENALTY, (detected.length - TRACKER_STACK_LIMIT) * EXTRA_TRACKER_PENALTY);
    items.push({
      id: 'tracking-heavy-stack',
      title: 'Many Third-Party Trackers',
      status: 'warn',
      description: `${detected.length} different trackers are loaded; each adds network requests, main-thread work and data-sharing obligations.`,
      recommendation: 'Remove tags that are no longer used, or consolidate them behind a single tag manager.',
    });
  }
  const blocking = blockingTrackerScripts(parsed, detected);
  if (blocking > 0) {
    penalty += Math.min(MAX_BLOCKING_PENALTY, blocking * BLOCKING_SCRIPT_PENALTY);
    items.push({
      id: 'tracking-blocking-scripts',
      title: 'Render-Blocking Tracker Scripts',
      status: 'warn',
      description: `${blocking} tracker script(s) load without async or defer and block HTML parsing.`,
      recommendation: 'Add async (or defer) to third-party tracking scripts.',
    });
  }
  return penalty;
}

/**
 * Audits tracking and marketing tags present in the static HTML.
 * Tags injected at runtime (e.g. by GTM) are not visible to this check.
 * @param parsed Parsed HTML representation
 * @param url Analyzed page URL
 * @returns TrackingAuditResult
 */
export function auditTracking(parsed: ParsedHtml, url: string): TrackingAuditResult {
  const items: AuditItem[] = [];
  const detected = scanTrackers(parsed);
  const duplicates: string[] = [];

  for (const tracker of detected) {
    if (tracker.identifiers.length > 1) {
      duplicates.push(tracker.name);
      items.push({
        id: `tracking-dup-${slug(tracker.name)}`,
        title: `Multiple ${tracker.name} IDs Found`,
        status: 'warn',
        description: `Found multiple IDs configured: ${tracker.identifiers.join(', ')}`,
        recommendation: 'Confirm each ID is intentional; remove redundant snippets to avoid double-counting events.',
      });
    } else {
      items.push({
        id: `tracking-found-${slug(tracker.name)}`,
        title: `${tracker.name} Detected`,
        status: 'info',
        description: `Category: ${tracker.category}.${tracker.identifiers.length > 0 ? ' ID: ' + tracker.identifiers[0] : ''}`,
      });
    }
  }

  if (detected.length === 0) {
    items.push({
      id: 'tracking-none',
      title: 'No Common Third-Party Trackers Found',
      status: 'pass',
      description: 'No common analytics or ad tags found in the static HTML (runtime-injected tags are not detected).',
    });
  }

  const penalty = duplicates.length * DUPLICATE_PENALTY + checkTrackerHygiene(parsed, detected, items);
  const score = penaltyToScore(penalty);
  return {
    url,
    timestamp: new Date().toISOString(),
    score,
    rating: scoreToRating(score),
    items,
    detectedTrackers: detected,
    duplicateTrackers: duplicates,
  };
}
