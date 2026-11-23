/**
 * Deterministic fault injection shared by both provider fixtures.
 * Faults are consumed in FIFO order for matching targets.
 */
export type FaultType =
  | 'http500'
  | 'http503'
  | 'http429'
  | 'timeout'
  | 'throttled' // Shopify GraphQL THROTTLED error (HTTP 200)
  | 'repeat_page' // Shopify: return the previous page again (cursor does not advance)
  | 'missing_cursor' // Shopify: hasNextPage=true but endCursor=null
  | 'unauthorized' // 401
  | 'reject_record'; // NetSuite: 400 USER_ERROR for one record

export interface Fault {
  target: string; // e.g. 'graphql', 'token', 'record.put', 'suiteql'
  type: FaultType;
  /** Number of times this fault fires before being removed. */
  count: number;
  retryAfterSeconds?: number;
  delayMs?: number;
  message?: string;
}

export class FaultQueue {
  private faults: Fault[] = [];
  readonly fired: { target: string; type: FaultType; at: string }[] = [];

  add(f: Fault): void {
    this.faults.push({ ...f });
  }
  clear(): void {
    this.faults = [];
  }
  list(): Fault[] {
    return this.faults.map((f) => ({ ...f }));
  }
  take(target: string): Fault | undefined {
    const idx = this.faults.findIndex((f) => f.target === target && f.count > 0);
    if (idx < 0) return undefined;
    const f = this.faults[idx]!;
    f.count -= 1;
    if (f.count <= 0) this.faults.splice(idx, 1);
    this.fired.push({ target, type: f.type, at: new Date().toISOString() });
    return f;
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
