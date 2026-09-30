import { describe, expect, it } from 'vitest';
import { embeddedIpv4, isBlockedIp, isIpLiteral, isLoopbackIp, parseIpv6Groups, stripIpDecorations } from '../../src/ip.js';

describe('ip classification', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '192.0.0.8',
    '192.0.2.1',
    '198.18.0.1',
    '198.19.255.255',
    '198.51.100.7',
    '203.0.113.9',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
  ])('blocks reserved IPv4 %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each([
    '::1',
    '::',
    '[::1]',
    'fe80::1',
    'fe80::1%eth0',
    'fc00::1',
    'fd12:3456:789a::1',
    'fec0::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '[::ffff:7f00:1]',
    '0:0:0:0:0:ffff:7f00:1',
    '::ffff:a9fe:a9fe',
    '::ffff:0:a9fe:a9fe',
    '::127.0.0.1',
    '::7f00:1',
    '64:ff9b::a9fe:a9fe',
    '64:ff9b::10.0.0.1',
    '64:ff9b:1::1',
    '2002:7f00:1::',
    '2002:a9fe:a9fe::1',
    '2001:db8::1',
    '2001::1',
    '3fff::1',
    '100::1',
  ])('blocks non-public IPv6 %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '93.184.215.14', '1.1.1.1', '2606:4700:4700::1111', '2a00:1450:4001::200e', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1'])(
    'allows public address %s',
    (ip) => {
      expect(isBlockedIp(ip)).toBe(false);
    },
  );

  it('never classifies hostnames by prefix', () => {
    for (const host of ['fdic.gov', 'fcbarcelona.com', 'feature.com', 'febreze.com', 'fe80.example']) {
      expect(isIpLiteral(host)).toBe(false);
      expect(isBlockedIp(host)).toBe(false);
    }
  });

  it('parses IPv6 groups including embedded dotted IPv4', () => {
    expect(parseIpv6Groups('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(parseIpv6Groups('1::')).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIpv6Groups('1:2:3:4:5:6:7:8')).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(embeddedIpv4(parseIpv6Groups('2606:4700::1'))).toBeNull();
  });

  it('detects loopback literals in all encodings', () => {
    expect(isLoopbackIp('127.0.0.5')).toBe(true);
    expect(isLoopbackIp('[::1]')).toBe(true);
    expect(isLoopbackIp('::ffff:7f00:1')).toBe(true);
    expect(isLoopbackIp('10.0.0.1')).toBe(false);
    expect(isLoopbackIp('2606:4700::1')).toBe(false);
    expect(isLoopbackIp('example.com')).toBe(false);
    expect(stripIpDecorations('[fe80::1%25eth0]')).toBe('fe80::1');
  });
});
