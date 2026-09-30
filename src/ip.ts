import net from 'node:net';

const BLOCKED_IPV4_SUBNETS: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

/** Reserved ranges inside 2000::/3 (everything outside 2000::/3 is blocked outright). */
const BLOCKED_IPV6_SUBNETS: Array<[string, number]> = [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['3fff::', 20],
];

const ipv4BlockList = new net.BlockList();
for (const [address, prefix] of BLOCKED_IPV4_SUBNETS) {
  ipv4BlockList.addSubnet(address, prefix, 'ipv4');
}

const ipv6BlockList = new net.BlockList();
for (const [address, prefix] of BLOCKED_IPV6_SUBNETS) {
  ipv6BlockList.addSubnet(address, prefix, 'ipv6');
}

/**
 * Removes URL brackets and any IPv6 zone identifier.
 * @param raw Hostname or IP literal
 * @returns Bare address string
 */
export function stripIpDecorations(raw: string): string {
  const unbracketed = raw.trim().replace(/^\[/, '').replace(/\]$/, '');
  const zoneIdx = unbracketed.indexOf('%');
  return zoneIdx === -1 ? unbracketed : unbracketed.slice(0, zoneIdx);
}

/**
 * Returns true when the value is an IPv4 or IPv6 literal (brackets allowed).
 * @param host Hostname or IP literal
 * @returns boolean
 */
export function isIpLiteral(host: string): boolean {
  return net.isIP(stripIpDecorations(host)) !== 0;
}

/**
 * Expands a valid IPv6 address into its eight 16-bit groups.
 * @param address IPv6 address (validated by net.isIPv6)
 * @returns Array of 8 numbers
 */
export function parseIpv6Groups(address: string): number[] {
  let text = address.toLowerCase();
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const o = tail.split('.').map(Number);
    const hi = ((o[0] << 8) | o[1]).toString(16);
    const lo = ((o[2] << 8) | o[3]).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  let parts: string[];
  if (text.includes('::')) {
    const [head, rest] = text.split('::');
    const headParts = head ? head.split(':') : [];
    const restParts = rest ? rest.split(':') : [];
    const fill = new Array<string>(8 - headParts.length - restParts.length).fill('0');
    parts = [...headParts, ...fill, ...restParts];
  } else {
    parts = text.split(':');
  }
  return parts.map((p) => parseInt(p, 16));
}

function groupsToIpv4(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/**
 * Extracts an IPv4 address embedded in IPv4-mapped, IPv4-compatible,
 * SIIT-translated, NAT64 (64:ff9b::/96) or 6to4 (2002::/16) IPv6 addresses.
 * @param groups Eight IPv6 groups
 * @returns Embedded IPv4 or null
 */
export function embeddedIpv4(groups: number[]): string | null {
  const zero = (from: number, to: number) => groups.slice(from, to).every((g) => g === 0);
  if (zero(0, 5) && groups[5] === 0xffff) return groupsToIpv4(groups[6], groups[7]);
  if (zero(0, 4) && groups[4] === 0xffff && groups[5] === 0) return groupsToIpv4(groups[6], groups[7]);
  if (zero(0, 6)) return groupsToIpv4(groups[6], groups[7]);
  if (groups[0] === 0x64 && groups[1] === 0xff9b && zero(2, 6)) return groupsToIpv4(groups[6], groups[7]);
  if (groups[0] === 0x2002) return groupsToIpv4(groups[1], groups[2]);
  return null;
}

/**
 * Returns true when an IP literal is private, loopback, link-local, reserved,
 * multicast, documentation, or otherwise not public unicast.
 * Non-IP input returns false; callers must resolve hostnames first.
 * @param raw IP literal (brackets / zone id allowed)
 * @returns boolean
 */
export function isBlockedIp(raw: string): boolean {
  const ip = stripIpDecorations(raw);
  const family = net.isIP(ip);
  if (family === 4) return ipv4BlockList.check(ip, 'ipv4');
  if (family !== 6) return false;

  const groups = parseIpv6Groups(ip);
  const v4 = embeddedIpv4(groups);
  if (v4) return ipv4BlockList.check(v4, 'ipv4');
  if ((groups[0] & 0xe000) !== 0x2000) return true;
  return ipv6BlockList.check(groups.map((g) => g.toString(16)).join(':'), 'ipv6');
}

/**
 * Returns true for loopback literals (127.0.0.0/8, ::1 and their IPv6-embedded forms).
 * @param raw IP literal
 * @returns boolean
 */
export function isLoopbackIp(raw: string): boolean {
  const ip = stripIpDecorations(raw);
  const family = net.isIP(ip);
  if (family === 4) return ip.startsWith('127.');
  if (family !== 6) return false;
  const groups = parseIpv6Groups(ip);
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true;
  const v4 = embeddedIpv4(groups);
  return v4 !== null && v4.startsWith('127.');
}
