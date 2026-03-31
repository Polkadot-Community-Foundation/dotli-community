// dot.li — Bulletin Paseo chain connection for preimage operations
//
// Provides a smoldot-backed polkadot-api client for the Bulletin Paseo
// parachain, used to submit preimage data via TransactionStorage.store().
// Uses Alice test signer (DEV_PHRASE) matching the browser host's current
// implementation — TODO: replace with production signer.

import { getSmProvider } from "polkadot-api/sm-provider";
import { createClient, type PolkadotClient } from "polkadot-api";
import { Binary } from "polkadot-api";
import { getPolkadotSigner } from "@polkadot-api/signer";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import {
  DEV_PHRASE,
  entropyToMiniSecret,
  mnemonicToEntropy,
} from "@polkadot-labs/hdkd-helpers";
import { getBulletinChain, makeNonRemovingChain } from "./smoldot";
import { log } from "@dotli/shared/log";

// ── Bulletin client singleton ────────────────────────────────

let bulletinClient: PolkadotClient | null = null;
let bulletinClientPromise: Promise<PolkadotClient> | null = null;

export async function ensureBulletinClient(): Promise<PolkadotClient> {
  if (bulletinClient) {
    return bulletinClient;
  }
  bulletinClientPromise ??= (async () => {
    const chain = await getBulletinChain();
    const provider = getSmProvider(makeNonRemovingChain(chain));
    bulletinClient = createClient(provider);
    await bulletinClient.getFinalizedBlock();
    log.warn("[dot.li bulletin] Client synced to finalized block");
    return bulletinClient;
  })();
  return bulletinClientPromise;
}

// ── Test signer (Alice) ──────────────────────────────────────
// TODO: Replace with production signer (People chain XCM authorization
// + unsigned submission). For testing on Paseo, Alice's account is
// pre-authorized via authorize_account.

export function getTestSigner(): ReturnType<typeof getPolkadotSigner> {
  const entropy = mnemonicToEntropy(DEV_PHRASE);
  const miniSecret = entropyToMiniSecret(entropy);
  const derive = sr25519CreateDerive(miniSecret);
  const alice = derive("//Alice");

  return getPolkadotSigner(alice.publicKey, "Sr25519", (input: Uint8Array) =>
    alice.sign(input),
  );
}

// ── Preimage transaction submission ──────────────────────────

const TX_TIMEOUT_MS = 120_000;

export async function submitPreimageTransaction(
  data: Uint8Array,
  signer: ReturnType<typeof getPolkadotSigner>,
): Promise<void> {
  const client = await ensureBulletinClient();
  const api = client.getUnsafeApi();
  const tx = api.tx.TransactionStorage.store({
    data: Binary.fromBytes(data),
  });

  await new Promise<void>((resolve, reject) => {
    let resolved = false;

    const subscription = tx.signSubmitAndWatch(signer).subscribe({
      next: (ev: { type: string; found?: boolean }) => {
        if (!resolved && ev.type === "txBestBlocksState" && ev.found === true) {
          resolved = true;
          clearTimeout(timeoutId);
          subscription.unsubscribe();
          resolve();
        }
      },
      error: (e: unknown) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutId);
          subscription.unsubscribe();
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      },
    });

    const timeoutId = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        subscription.unsubscribe();
        reject(new Error("Transaction timed out"));
      }
    }, TX_TIMEOUT_MS);
  });
}
