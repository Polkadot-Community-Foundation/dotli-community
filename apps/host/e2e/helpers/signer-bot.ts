import { setTimeout as sleep } from "node:timers/promises";

const TRANSIENT = new Set([502, 503, 504]);

async function fetchRetry(
  url: string,
  init: RequestInit,
  attempts = 4,
): Promise<Response> {
  let last: unknown = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      const r = await fetch(url, init);
      if (r.ok || !TRANSIENT.has(r.status) || i === attempts) return r;
      console.warn(
        `[bot] ${init.method ?? "GET"} ${url} → ${r.status} (attempt ${i}/${attempts})`,
      );
    } catch (e) {
      last = e;
      if (i === attempts) throw e;
      console.warn(
        `[bot] ${init.method ?? "GET"} ${url} threw "${(e as Error).message}" (attempt ${i}/${attempts})`,
      );
    }
    await sleep(1_000 * 2 ** (i - 1));
  }
  throw last ?? new Error("fetchRetry exhausted");
}

/**
 * Generate a per-run username for the Nova signing bot.
 *
 * Each test run gets its own throwaway user so on-chain state (allowances,
 * permissions, derived product accounts) doesn't leak between PRs. Format:
 * `dotlitests` + 6 lowercase letters → ~3·10^8 namespace, no collisions in
 * practice, and stays inside the bot's strictest username regex (^[a-z]+$)
 * so it works for both regular `username` and `liteUsername` fields if we
 * ever want one.
 */
export function generateUsername(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  let suffix = "";
  for (let i = 0; i < 6; i++) {
    suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `dotlitests${suffix}`;
}

export interface PairResult {
  sessionId: string;
  user: {
    username: string;
    network: string;
    address: string;
    publicKeyHex: string;
    attested?: boolean;
  };
}

/**
 * Pair the bot with a dot.li session via the QR-derived handshake deeplink.
 *
 * The Nova bot's `/api/pair` is one-shot: given a handshake, it
 * (a) creates the user if `username` is new, (b) attests the account on
 * People chain so it has Statement Store allowance, (c) completes the
 * SSO handshake, (d) starts auto-signing future SignRequests for that
 * session. No separate provisioning / poll step needed.
 *
 * `network` should be `paseo-next` for dot.li (Paseo People Next, matching
 * `next-people-paseo` chain spec in packages/config).
 */
export async function pair(
  base: string,
  svcToken: string,
  args: { handshake: string; username: string; network: string },
): Promise<PairResult> {
  const r = await fetchRetry(`${base.replace(/\/$/, "")}/api/pair`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${svcToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!r.ok) {
    throw new Error(`pair ${r.status}: ${await r.text()}`);
  }
  return (await r.json()) as PairResult;
}

/**
 * Tear down a bot session at the end of a test worker. Best-effort —
 * failure to disconnect is non-fatal, the bot times sessions out anyway.
 */
export async function disconnect(
  base: string,
  svcToken: string,
  sessionId: string,
): Promise<void> {
  await fetch(`${base.replace(/\/$/, "")}/api/disconnect`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${svcToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sessionId }),
  }).catch(() => {});
}
