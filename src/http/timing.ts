import { performance } from 'node:perf_hooks';
import { round } from '../utils/objects.js';
import type { Timings } from '../core/types.js';

export class RequestClock {
  readonly started = performance.now();
  private headersAt = this.started;
  private readonly phases: Partial<Pick<Timings, 'dnsMs' | 'tcpMs' | 'tlsMs'>> = {};

  add(phase: 'dnsMs' | 'tcpMs' | 'tlsMs', milliseconds: number): void {
    this.phases[phase] = (this.phases[phase] ?? 0) + Math.max(0, milliseconds);
  }

  headers(): void { this.headersAt = performance.now(); }

  finish(): Timings {
    const ended = performance.now();
    return {
      totalMs: round(ended - this.started),
      headersMs: round(this.headersAt - this.started),
      downloadMs: round(ended - this.headersAt),
      ...Object.fromEntries(Object.entries(this.phases).map(([name, value]) => [name, round(value)])),
    };
  }
}
