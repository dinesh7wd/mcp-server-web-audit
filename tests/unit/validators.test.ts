import { afterEach, describe, expect, it } from 'vitest';
import { CONFIG } from '../../src/config.js';
import { AppError, ErrorCodes } from '../../src/errors.js';
import type { NetworkPolicy } from '../../src/types.js';
import {
  assertPublicHost,
  defaultNetworkPolicy,
  isLocalhost,
  isPrivateIP,
  normalizeHostname,
  sanitizeUrl,
  validateAuditUrl,
  validateAuditUrlSync,
} from '../../src/validators.js';

const publicPolicy: NetworkPolicy = {
  lookup: async () => [{ address: '93.184.215.14', family: 4 }],
  isAddressBlocked: defaultNetworkPolicy.isAddressBlocked,
};

describe('validators', () => {
  afterEach(() => {
    CONFIG.security.allowedDomains.length = 0;
    CONFIG.security.blockedDomains.length = 0;
  });

  describe('sanitizeUrl', () => {
    it('accepts valid http and https URLs', () => {
      expect(sanitizeUrl('https://example.com')).not.toBeNull();
      expect(sanitizeUrl('http://example.com/path?a=1')).not.toBeNull();
    });

    it('rejects invalid schemes like file://, ftp://, javascript:', () => {
      expect(sanitizeUrl('file:///etc/passwd')).toBeNull();
      expect(sanitizeUrl('ftp://example.com')).toBeNull();
      expect(sanitizeUrl('javascript:alert(1)')).toBeNull();
      expect(sanitizeUrl('')).toBeNull();
      expect(sanitizeUrl('not a url')).toBeNull();
    });
  });

  describe('hostname helpers', () => {
    it('detects localhost variations including trailing dots and encoded loopback', () => {
      expect(isLocalhost('localhost')).toBe(true);
      expect(isLocalhost('LOCALHOST.')).toBe(true);
      expect(isLocalhost('sub.localhost')).toBe(true);
      expect(isLocalhost('127.0.0.1')).toBe(true);
      expect(isLocalhost('[::1]')).toBe(true);
      expect(isLocalhost('[::ffff:7f00:1]')).toBe(true);
      expect(isLocalhost('example.com')).toBe(false);
      expect(normalizeHostname('Example.COM..')).toBe('example.com');
    });

    it('classifies only IP literals and metadata hostnames as private', () => {
      expect(isPrivateIP('10.0.0.1')).toBe(true);
      expect(isPrivateIP('[::ffff:a9fe:a9fe]')).toBe(true);
      expect(isPrivateIP('metadata.google.internal.')).toBe(true);
      expect(isPrivateIP('fdic.gov')).toBe(false);
      expect(isPrivateIP('fcbarcelona.com')).toBe(false);
      expect(isPrivateIP('febreze.com')).toBe(false);
    });
  });

  describe('validateAuditUrlSync (C1 regression)', () => {
    it.each([
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:169.254.169.254]/latest/',
      'http://[::127.0.0.1]/',
      'http://[64:ff9b::a9fe:a9fe]/',
      'http://[2002:7f00:1::]/',
      'http://[fec0::1]/',
      'http://198.18.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://2130706433/',
      'http://0x7f.1/',
    ])('blocks %s', (url) => {
      const res = validateAuditUrlSync(url);
      expect(res.valid).toBe(false);
      if (!res.valid) expect(res.code).toBe(ErrorCodes.SSRF_BLOCKED);
    });

    it('allows domains that merely start with fc/fd/fe (H2 regression)', () => {
      for (const url of ['https://fdic.gov/', 'https://fcbarcelona.com/', 'https://feature.com/', 'https://febreze.com/']) {
        expect(validateAuditUrlSync(url).valid).toBe(true);
      }
    });

    it('rejects embedded credentials and applies allow/block lists', () => {
      expect(validateAuditUrlSync('https://user:pass@example.com/').valid).toBe(false);
      CONFIG.security.blockedDomains.push('example.com');
      const blocked = validateAuditUrlSync('https://sub.example.com/');
      expect(blocked.valid).toBe(false);
      if (!blocked.valid) expect(blocked.code).toBe(ErrorCodes.PolicyBlocked);
      CONFIG.security.blockedDomains.length = 0;
      CONFIG.security.allowedDomains.push('allowed.test');
      expect(validateAuditUrlSync('https://example.com/').valid).toBe(false);
      expect(validateAuditUrlSync('https://www.allowed.test/').valid).toBe(true);
    });
  });

  describe('validateAuditUrl (async + DNS)', () => {
    it('allows public hosts with an injected public lookup', async () => {
      for (const url of ['https://fdic.gov/', 'https://fcbarcelona.com/']) {
        const res = await validateAuditUrl(url, { policy: publicPolicy });
        expect(res.valid).toBe(true);
      }
    });

    it('uses (faked) system DNS by default', async () => {
      const res = await validateAuditUrl('https://example.com/audit');
      expect(res.valid).toBe(true);
      if (res.valid) expect(res.url.hostname).toBe('example.com');
    });

    it('blocks hosts resolving to private or IPv4-mapped metadata addresses without leaking the IP (M3)', async () => {
      for (const url of ['http://internal.example/', 'http://mapped.example/']) {
        const res = await validateAuditUrl(url);
        expect(res.valid).toBe(false);
        if (!res.valid) {
          expect(res.code).toBe(ErrorCodes.SSRF_BLOCKED);
          expect(res.error).not.toMatch(/10\.0\.0\.5|169\.254|ffff/);
        }
      }
    });

    it('rejects literals, localhost and metadata names before DNS', async () => {
      expect((await validateAuditUrl('http://localhost:8080')).valid).toBe(false);
      expect((await validateAuditUrl('http://[::ffff:127.0.0.1]/')).valid).toBe(false);
      expect((await validateAuditUrl('http://[64:ff9b::a9fe:a9fe]/')).valid).toBe(false);
      expect((await validateAuditUrl('http://metadata.google.internal/')).valid).toBe(false);
      expect((await validateAuditUrl('https://93.184.215.14/')).valid).toBe(true);
    });

    it('reports DNS failures and empty answers as DNS_FAILED', async () => {
      const res = await validateAuditUrl('https://does-not-exist.example/');
      expect(res.valid).toBe(false);
      if (!res.valid) expect(res.code).toBe(ErrorCodes.DnsFailed);
      await expect(
        assertPublicHost('empty.test', { lookup: async () => [], isAddressBlocked: () => false }),
      ).rejects.toMatchObject({ code: ErrorCodes.DnsFailed });
    });

    it('bounds DNS time with the abort signal', async () => {
      const hanging: NetworkPolicy = { lookup: () => new Promise(() => undefined), isAddressBlocked: () => false };
      const res = await validateAuditUrl('https://slow.test/', { policy: hanging, signal: AbortSignal.timeout(20) });
      expect(res.valid).toBe(false);
      if (!res.valid) expect(res.code).toBe(ErrorCodes.Timeout);
    });

    it('propagates AppErrors thrown by the lookup', async () => {
      const policy: NetworkPolicy = {
        lookup: async () => {
          throw new AppError(ErrorCodes.SSRF_BLOCKED, 'custom');
        },
        isAddressBlocked: () => false,
      };
      await expect(assertPublicHost('x.test', policy)).rejects.toMatchObject({ message: 'custom' });
    });
  });
});
