/**
 * The API limits POST /api/auth/login to 10 per minute per client (a product control, kept as is).
 * The suite logs in more often than that, so every login helper calls this first: it keeps logins at
 * no more than 9 in any 61-second span, which guarantees no fixed one-minute window on the server sees
 * more than 10. Shared across spec files because Playwright runs them in one worker (workers: 1).
 * Logins made outside the suite (e.g. a demo run moments before) are not counted.
 */
import { test } from '@playwright/test';

const SPAN_MS = 61_000;
const MAX_IN_SPAN = 9;
const stamps: number[] = [];

export async function paceLogin(): Promise<void> {
  const prune = () => {
    while (stamps.length && Date.now() - stamps[0]! > SPAN_MS) stamps.shift();
  };
  prune();
  if (stamps.length >= MAX_IN_SPAN) {
    const waitMs = stamps[0]! + SPAN_MS - Date.now() + 250;
    test.info().setTimeout(test.info().timeout + waitMs);
    await new Promise((r) => setTimeout(r, waitMs));
    prune();
  }
  stamps.push(Date.now());
}
