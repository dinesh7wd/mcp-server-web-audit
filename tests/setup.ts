import { vi } from 'vitest';

type FakeRecord = { address: string; family: number };

declare global {
  var __fakeDns: Map<string, FakeRecord[]>;
}

/** Deterministic DNS for every test: unknown hosts fail with ENOTFOUND, nothing hits the network. */
globalThis.__fakeDns = new Map<string, FakeRecord[]>([
  ['example.com', [{ address: '93.184.215.14', family: 4 }]],
  ['fdic.gov', [{ address: '23.52.44.10', family: 4 }]],
  ['fcbarcelona.com', [{ address: '104.18.20.5', family: 4 }]],
  ['internal.example', [{ address: '10.0.0.5', family: 4 }]],
  ['mapped.example', [{ address: '::ffff:169.254.169.254', family: 6 }]],
]);

vi.mock('node:dns/promises', () => {
  const lookup = async (hostname: string) => {
    const records = globalThis.__fakeDns.get(hostname.toLowerCase());
    if (!records) {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
    }
    return records;
  };
  return { default: { lookup }, lookup };
});
