export interface NetworkTiming {
  dnsMs: number;
  /** Includes TLS; never add connectMs and tlsMs together. */
  connectMs: number;
  tlsMs: number;
  /** Network round trip plus upstream waiting, not model compute time. */
  waitMs: number;
  downloadMs: number;
  totalMs: number;
  protocol: 'h2' | 'h3' | 'http/1.1' | 'unknown';
}

/** Read-only, optional timing. Missing/opaque entries must not affect translation. */
export function readNetworkTiming(endpoint: string, startedAt: number,
  clock: Pick<Performance, 'timeOrigin' | 'getEntriesByName'> | undefined = globalThis.performance): NetworkTiming | undefined {
  try {
    if (!clock || !Number.isFinite(clock.timeOrigin)) return;
    const entries = clock.getEntriesByName(endpoint, 'resource') as PerformanceResourceTiming[];
    const candidates = entries.filter(entry => entry.name === endpoint && entry.entryType === 'resource'
      && Math.abs(clock.timeOrigin + entry.startTime - startedAt) <= 25);
    const entry = candidates.sort((left, right) => Math.abs(clock.timeOrigin + left.startTime - startedAt)
      - Math.abs(clock.timeOrigin + right.startTime - startedAt))[0];
    // Cross-origin timing without permission/TAO is opaque. Do not turn zeros into a cold/warm claim.
    if (!entry || !(entry.requestStart > 0) || entry.responseStart < entry.requestStart || entry.responseEnd < entry.responseStart) return;
    const elapsed = (end: number, start: number) => Number.isFinite(end) && Number.isFinite(start) && end >= start
      ? Math.round((end - start) * 10) / 10 : undefined;
    const dnsMs = elapsed(entry.domainLookupEnd, entry.domainLookupStart);
    const connectMs = elapsed(entry.connectEnd, entry.connectStart);
    const tlsMs = entry.secureConnectionStart > 0 ? elapsed(entry.connectEnd, entry.secureConnectionStart) : 0;
    const waitMs = elapsed(entry.responseStart, entry.requestStart);
    const downloadMs = elapsed(entry.responseEnd, entry.responseStart);
    if ([dnsMs, connectMs, tlsMs, waitMs, downloadMs].some(value => value === undefined)
      || !Number.isFinite(entry.duration) || entry.duration < 0) return;
    const protocol = ['h2', 'h3', 'http/1.1'].includes(entry.nextHopProtocol)
      ? entry.nextHopProtocol as NetworkTiming['protocol'] : 'unknown';
    return { dnsMs: dnsMs!, connectMs: connectMs!, tlsMs: tlsMs!, waitMs: waitMs!, downloadMs: downloadMs!,
      totalMs: Math.round(entry.duration * 10) / 10, protocol };
  } catch { return; }
}
