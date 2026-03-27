// Statement store type mapping between Host API and SDK formats.
//
// Host API uses SCALE codec types (PascalCase tags, Uint8Array fields).
// SDK uses substrate-bindings types (camelCase types, hex string fields).
// Cherry-picked from browser/src/widgets/ProductContainerBinding/integrations/statementStore.ts

import {
  type CodecType,
  type SignedStatement as HostSignedStatement,
  type Statement as HostStatement,
  fromHex,
  toHex,
} from "@novasamatech/host-api";
import type {
  Proof,
  SignedStatement,
  Statement,
} from "@novasamatech/sdk-statement";

export function mapHostProof(
  proof: CodecType<typeof HostSignedStatement>["proof"],
): Proof {
  switch (proof.tag) {
    case "Ecdsa":
      return {
        type: "ecdsa",
        value: {
          signature: toHex(proof.value.signature),
          signer: toHex(proof.value.signer),
        },
      };
    case "Ed25519":
      return {
        type: "ed25519",
        value: {
          signature: toHex(proof.value.signature),
          signer: toHex(proof.value.signer),
        },
      };
    case "Sr25519":
      return {
        type: "sr25519",
        value: {
          signature: toHex(proof.value.signature),
          signer: toHex(proof.value.signer),
        },
      };
    case "OnChain":
      return {
        type: "onChain",
        value: {
          who: toHex(proof.value.who),
          blockHash: toHex(proof.value.blockHash),
          event: proof.value.event,
        },
      };
  }
}

export function mapFromHostSignedStatement(
  statement: CodecType<typeof HostSignedStatement>,
): SignedStatement {
  const result: SignedStatement = {
    proof: mapHostProof(statement.proof),
    topics: statement.topics.map(toHex),
  };
  if (statement.expiry !== undefined) {
    result.expiry = statement.expiry;
  }
  if (statement.channel) {
    result.channel = toHex(statement.channel);
  }
  if (statement.data) {
    result.data = statement.data;
  }
  /* eslint-disable @typescript-eslint/no-deprecated */
  if (statement.decryptionKey) {
    result.decryptionKey = toHex(statement.decryptionKey);
  }
  /* eslint-enable @typescript-eslint/no-deprecated */
  return result;
}

export function mapFromHostStatement(
  statement: CodecType<typeof HostStatement>,
): Statement {
  // Only include fields that have values — the SDK's SCALE codec iterates
  // object keys and crashes on `proof: undefined` (reads `proof.type`).
  const result: Statement = {
    topics: statement.topics.map(toHex),
  };
  if (statement.proof) {
    result.proof = mapHostProof(statement.proof);
  }
  if (statement.expiry !== undefined) {
    result.expiry = statement.expiry;
  }
  if (statement.channel) {
    result.channel = toHex(statement.channel);
  }
  if (statement.data) {
    result.data = statement.data;
  }
  /* eslint-disable @typescript-eslint/no-deprecated */
  if (statement.decryptionKey) {
    result.decryptionKey = toHex(statement.decryptionKey);
  }
  /* eslint-enable @typescript-eslint/no-deprecated */
  return result;
}

export function mapSdkSignedStatement(
  statement: SignedStatement,
): CodecType<typeof HostSignedStatement> {
  const result: Record<string, unknown> = {
    proof: mapSdkProof(statement.proof),
    topics: (statement.topics ?? []).map((t) => fromHex(t)),
  };
  if (statement.expiry !== undefined) {
    result.expiry = statement.expiry;
  }
  if (statement.channel) {
    result.channel = fromHex(statement.channel);
  }
  if (statement.data) {
    result.data = statement.data;
  }
  /* eslint-disable @typescript-eslint/no-deprecated */
  if (statement.decryptionKey) {
    result.decryptionKey = fromHex(statement.decryptionKey);
  }
  /* eslint-enable @typescript-eslint/no-deprecated */
  return result as CodecType<typeof HostSignedStatement>;
}

export function mapSdkProof(
  proof: Proof,
): CodecType<typeof HostSignedStatement>["proof"] {
  switch (proof.type) {
    case "ecdsa":
      return {
        tag: "Ecdsa",
        value: {
          signature: fromHex(proof.value.signature),
          signer: fromHex(proof.value.signer),
        },
      };
    case "ed25519":
      return {
        tag: "Ed25519",
        value: {
          signature: fromHex(proof.value.signature),
          signer: fromHex(proof.value.signer),
        },
      };
    case "sr25519":
      return {
        tag: "Sr25519",
        value: {
          signature: fromHex(proof.value.signature),
          signer: fromHex(proof.value.signer),
        },
      };
    case "onChain":
      return {
        tag: "OnChain",
        value: {
          who: fromHex(proof.value.who),
          blockHash: fromHex(proof.value.blockHash),
          event: proof.value.event,
        },
      };
  }
}
