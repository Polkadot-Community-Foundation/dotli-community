// dot.li — Signing confirmation modals (vanilla DOM)
//
// Shows Sign/Cancel modals for signPayload and signRaw requests.
// Returns a Promise that resolves with the signing result or rejects on cancel.

import { SigningErr } from "@novasamatech/host-api";
import { toHex } from "@novasamatech/host-api";
import type {
  UserSession,
  SigningPayloadRequest,
  SigningRawRequest,
} from "@novasamatech/host-papp";

export interface SigningResult {
  signature: `0x${string}`;
  signedTransaction?: `0x${string}`;
}

function truncateAddress(address: string): string {
  if (address.length <= 16) {
    return address;
  }
  return `${address.slice(0, 8)}...${address.slice(-8)}`;
}

function createModalDOM(
  title: string,
  fields: { label: string; value: string; mono?: boolean }[],
): {
  backdrop: HTMLDivElement;
  signBtn: HTMLButtonElement;
  cancelBtn: HTMLButtonElement;
} {
  const backdrop = document.createElement("div");
  backdrop.className = "signing-modal-backdrop";

  const modal = document.createElement("div");
  modal.className = "signing-modal";

  const heading = document.createElement("h2");
  heading.textContent = title;
  modal.appendChild(heading);

  const fieldsContainer = document.createElement("div");
  fieldsContainer.className = "signing-fields";

  for (const field of fields) {
    const group = document.createElement("div");
    group.className = "signing-field";

    const label = document.createElement("div");
    label.className = "signing-field-label";
    label.textContent = field.label;
    group.appendChild(label);

    const value = document.createElement("div");
    value.className = "signing-field-value";
    if (field.mono === true) {
      value.classList.add("mono");
    }
    value.textContent = field.value;
    group.appendChild(value);

    fieldsContainer.appendChild(group);
  }
  modal.appendChild(fieldsContainer);

  const footer = document.createElement("div");
  footer.className = "signing-modal-footer";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "signing-btn-cancel";
  cancelBtn.textContent = "Cancel";
  footer.appendChild(cancelBtn);

  const signBtn = document.createElement("button");
  signBtn.className = "signing-btn-sign";
  signBtn.textContent = "Sign";
  footer.appendChild(signBtn);

  modal.appendChild(footer);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  return { backdrop, signBtn, cancelBtn };
}

function removeModal(backdrop: HTMLDivElement): void {
  backdrop.remove();
}

export function showSignPayloadModal(
  session: UserSession,
  payload: SigningPayloadRequest,
): Promise<SigningResult> {
  return new Promise((resolve, reject) => {
    const fields: { label: string; value: string; mono?: boolean }[] = [
      { label: "Signer", value: truncateAddress(payload.address) },
      { label: "Genesis Hash", value: payload.genesisHash, mono: true },
      { label: "Call Data", value: payload.method, mono: true },
    ];

    const { backdrop, signBtn, cancelBtn } = createModalDOM(
      "Sign Transaction",
      fields,
    );

    cancelBtn.addEventListener("click", () => {
      removeModal(backdrop);
      reject(new SigningErr.Rejected());
    });

    signBtn.addEventListener("click", () => {
      signBtn.disabled = true;
      signBtn.textContent = "Signing...";

      void session
        .signPayload({
          ...payload,
          method: payload.method,
          assetId: payload.assetId,
          mode: payload.mode,
          withSignedTransaction: payload.withSignedTransaction,
          metadataHash: payload.metadataHash,
        })
        .match(
          ({ signature, signedTransaction }) => {
            removeModal(backdrop);
            resolve({
              signature: toHex(signature),
              signedTransaction: signedTransaction
                ? typeof signedTransaction === "string"
                  ? (signedTransaction as `0x${string}`)
                  : toHex(signedTransaction)
                : undefined,
            });
          },
          (e) => {
            removeModal(backdrop);
            reject(new SigningErr.Unknown({ reason: e.message }));
          },
        );
    });
  });
}

export function showSignRawModal(
  session: UserSession,
  payload: SigningRawRequest,
): Promise<SigningResult> {
  return new Promise((resolve, reject) => {
    const message =
      payload.data.tag === "Payload"
        ? payload.data.value
        : toHex(payload.data.value);

    const fields: { label: string; value: string; mono?: boolean }[] = [
      { label: "Signer", value: truncateAddress(payload.address) },
      { label: "Message", value: message, mono: true },
    ];

    const { backdrop, signBtn, cancelBtn } = createModalDOM(
      "Sign Message",
      fields,
    );

    cancelBtn.addEventListener("click", () => {
      removeModal(backdrop);
      reject(new SigningErr.Rejected());
    });

    signBtn.addEventListener("click", () => {
      signBtn.disabled = true;
      signBtn.textContent = "Signing...";

      void session.signRaw(payload).match(
        ({ signature, signedTransaction }) => {
          removeModal(backdrop);
          resolve({
            signature: toHex(signature),
            signedTransaction: signedTransaction
              ? typeof signedTransaction === "string"
                ? (signedTransaction as `0x${string}`)
                : toHex(signedTransaction)
              : undefined,
          });
        },
        (e) => {
          removeModal(backdrop);
          reject(new SigningErr.Unknown({ reason: e.message }));
        },
      );
    });
  });
}
