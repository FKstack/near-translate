import { describe, expect, it } from 'vitest';
import { readNetworkTiming } from '../../src/platform/network-timing';

const endpoint = 'https://public.example/translate';
function clock(overrides: Partial<PerformanceResourceTiming> = {}) {
  const entry = { name: endpoint, entryType: 'resource', startTime: 100,
    domainLookupStart: 100, domainLookupEnd: 110, connectStart: 110, connectEnd: 510,
    secureConnectionStart: 120, requestStart: 520, responseStart: 720, responseEnd: 725,
    duration: 625, nextHopProtocol: 'h2', ...overrides } as PerformanceResourceTiming;
  return { timeOrigin: 1_000, getEntriesByName: () => [entry] };
}

describe('optional browser network timing', () => {
  it('distinguishes handshake from upstream wait without double counting TLS', () => {
    expect(readNetworkTiming(endpoint, 1100, clock())).toEqual({ dnsMs: 10, connectMs: 400, tlsMs: 390,
      waitMs: 200, downloadMs: 5, totalMs: 625, protocol: 'h2' });
  });

  it('accepts connection reuse but rejects opaque, unrelated and invalid entries', () => {
    expect(readNetworkTiming(endpoint, 1100, clock({ domainLookupEnd: 100, connectStart: 100,
      connectEnd: 100, secureConnectionStart: 100 }))).toMatchObject({ connectMs: 0, tlsMs: 0 });
    expect(readNetworkTiming(endpoint, 1100, clock({ requestStart: 0, responseStart: 0 }))).toBeUndefined();
    expect(readNetworkTiming(endpoint, 1200, clock())).toBeUndefined();
    expect(readNetworkTiming(endpoint, 1100, clock({ name: 'https://private.invalid' }))).toBeUndefined();
    expect(readNetworkTiming(endpoint, 1100, clock({ responseEnd: 1 }))).toBeUndefined();
    expect(readNetworkTiming(endpoint, 1100, clock({ connectEnd: NaN }))).toBeUndefined();
  });

  it('never exposes unknown protocol strings and tolerates missing browser APIs', () => {
    expect(readNetworkTiming(endpoint, 1100, clock({ nextHopProtocol: 'private value' }))).toMatchObject({ protocol: 'unknown' });
    expect(readNetworkTiming(endpoint, 1100, { timeOrigin: 1000, getEntriesByName: () => { throw new Error('Unavailable'); } })).toBeUndefined();
  });
});
