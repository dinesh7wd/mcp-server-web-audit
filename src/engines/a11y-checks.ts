import { AuditItem, A11yAuditResult } from '../types.js';
import { ParsedFormInput, ParsedHtml, ParsedImage } from '../parsers.js';
import { penaltyToScore, scoreToRating } from './scoring.js';

function auditImages(images: ParsedImage[], items: AuditItem[]): { penalty: number; missingCount: number } {
  const missingAlt = images.filter((img) => !img.hasAlt && !img.decorative);
  const count = missingAlt.length;

  if (count > 0) {
    items.push({
      id: 'a11y-img-alt-missing',
      title: 'Images Missing Alt Attributes',
      status: 'fail',
      description: `${count} of ${images.length} images lack an alt attribute and are not marked decorative.`,
      recommendation: 'Add descriptive alt text to informative images, or alt="" if purely decorative.',
    });
    return { penalty: Math.min(30, count * 5), missingCount: count };
  }
  if (images.length > 0) {
    items.push({
      id: 'a11y-img-alt-ok',
      title: 'All Images Have Alt Attributes',
      status: 'pass',
      description: `All ${images.length} images have an alt attribute or are marked decorative.`,
    });
  }
  return { penalty: 0, missingCount: 0 };
}

function auditFormInputs(inputs: ParsedFormInput[], items: AuditItem[]): { penalty: number; missingCount: number } {
  const count = inputs.filter((i) => !i.hasLabel).length;

  if (count > 0) {
    items.push({
      id: 'a11y-form-label-missing',
      title: 'Form Inputs Missing Accessible Labels',
      status: 'fail',
      description: `${count} of ${inputs.length} form controls lack a <label>, aria-label, valid aria-labelledby or title.`,
      recommendation: 'Ensure every input has a corresponding <label for="id"> or aria-label attribute.',
    });
    return { penalty: Math.min(25, count * 10), missingCount: count };
  }
  if (inputs.length > 0) {
    items.push({
      id: 'a11y-form-label-ok',
      title: 'Form Controls Properly Labeled',
      status: 'pass',
      description: `All ${inputs.length} interactive form inputs have accessible labels.`,
    });
  }
  return { penalty: 0, missingCount: 0 };
}

function auditHeadings(
  headings: Array<{ level: number; text: string }>,
  items: AuditItem[],
): { penalty: number; skips: number } {
  const skips: string[] = [];
  for (let i = 0; i < headings.length - 1; i++) {
    const current = headings[i].level;
    const next = headings[i + 1].level;
    if (next > current + 1) skips.push(`h${current} → h${next}`);
  }

  if (skips.length > 0) {
    const shown = skips.slice(0, 10).join(', ');
    items.push({
      id: 'a11y-heading-order-skipped',
      title: 'Skipped Heading Levels Detected',
      status: 'warn',
      description: `${skips.length} heading level skip(s): ${shown}${skips.length > 10 ? ', …' : ''}.`,
      recommendation: 'Maintain a sequential heading hierarchy without skipping levels (e.g. h1 → h2 → h3).',
    });
    return { penalty: Math.min(20, skips.length * 5), skips: skips.length };
  }
  if (headings.length > 0) {
    items.push({
      id: 'a11y-heading-order-ok',
      title: 'Logical Heading Hierarchy',
      status: 'pass',
      description: 'Headings follow a logical sequential order.',
    });
  }
  return { penalty: 0, skips: 0 };
}

function auditLandmarksAndLanguage(parsed: ParsedHtml, items: AuditItem[]): number {
  let penalty = 0;
  if (!parsed.landmarks.hasMain) {
    penalty += 15;
    items.push({
      id: 'a11y-main-missing',
      title: 'Missing <main> Landmark',
      status: 'warn',
      description: 'Page lacks a <main> or role="main" landmark region.',
      recommendation: 'Wrap primary page content in a <main> tag to assist screen reader navigation.',
    });
  } else {
    items.push({
      id: 'a11y-main-ok',
      title: 'Main Landmark Region Found',
      status: 'pass',
      description: 'Primary content is bounded within a <main> landmark.',
    });
  }

  if (!parsed.landmarks.hasNav) {
    penalty += 5;
    items.push({
      id: 'a11y-nav-missing',
      title: 'Missing Navigation Landmark',
      status: 'warn',
      description: 'Page lacks a <nav> or role="navigation" landmark.',
      recommendation: 'Wrap primary navigation links in a <nav> element.',
    });
  } else {
    items.push({
      id: 'a11y-nav-ok',
      title: 'Navigation Landmark Found',
      status: 'pass',
      description: 'Navigation is exposed through a <nav> landmark.',
    });
  }

  if (!parsed.language) {
    penalty += 10;
    items.push({
      id: 'a11y-lang-missing',
      title: 'Missing Page Language Declaration',
      status: 'fail',
      description: 'The <html> element lacks a lang attribute.',
      recommendation: 'Add lang attribute (e.g. <html lang="en">) so screen readers use correct pronunciation.',
    });
  } else {
    items.push({
      id: 'a11y-lang-ok',
      title: 'Page Language Declared',
      status: 'pass',
      description: `Language specified as: "${parsed.language}".`,
    });
  }
  return penalty;
}

/**
 * Performs a static-HTML accessibility audit (no rendering, so no contrast checks).
 * @param parsed Parsed HTML representation
 * @param url Analyzed page URL
 * @returns A11yAuditResult
 */
export function auditA11y(parsed: ParsedHtml, url: string): A11yAuditResult {
  const items: AuditItem[] = [];
  const imgResult = auditImages(parsed.images, items);
  const formResult = auditFormInputs(parsed.formInputs, items);
  const headingResult = auditHeadings(parsed.allHeadings, items);
  const penalty =
    imgResult.penalty + formResult.penalty + headingResult.penalty + auditLandmarksAndLanguage(parsed, items);

  const score = penaltyToScore(penalty);
  return {
    url,
    timestamp: new Date().toISOString(),
    score,
    rating: scoreToRating(score),
    items,
    totalImages: parsed.images.length,
    imagesWithoutAlt: imgResult.missingCount,
    formInputsTotal: parsed.formInputs.length,
    formInputsWithoutLabel: formResult.missingCount,
    hasMainLandmark: parsed.landmarks.hasMain,
    hasNavLandmark: parsed.landmarks.hasNav,
    headingOrderValid: headingResult.skips === 0,
    headingSkips: headingResult.skips,
    languageDeclared: Boolean(parsed.language),
  };
}
