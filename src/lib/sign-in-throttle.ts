import "server-only";

import { clearAttempts, takeAttempt, type AttemptResult } from "@/lib/attempts";

// Better Auth limits sign-in attempts per IP address. This adds a limit per
// account, so guessing one person's password from many addresses still stops.
export const ACCOUNT_ATTEMPT_LIMIT = 10;
export const ACCOUNT_WINDOW_MS = 15 * 60 * 1000;

const keyFor = (username: string) => `account|${username.trim().toLowerCase()}`;

// Takes one password attempt for this account: 10 per 15-minute window.
export function takeSignInAttempt(username: string): Promise<AttemptResult> {
  return takeAttempt(keyFor(username), ACCOUNT_ATTEMPT_LIMIT, ACCOUNT_WINDOW_MS);
}

// A successful sign-in clears the count.
export function clearSignInAttempts(username: string) {
  return clearAttempts(keyFor(username));
}
