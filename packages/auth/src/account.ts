// dot.li — Product account derivation
//
// Derives a product-specific public key from the user's root public key
// using HDKD soft derivation through junctions ['product', dotDomain, derivationIndex].
// Mirrors context__desktop/src/domains/product/account/service.ts

import { HDKD } from "@scure/sr25519";
import { str, u32 } from "scale-ts";

const createChainCode = (code: string): Uint8Array => {
  const chainCode = new Uint8Array(32);
  chainCode.set(Number.isNaN(+code) ? str.enc(code) : u32.enc(+code));
  return chainCode;
};

export const deriveProductPublicKey = (
  rootPublicKey: Uint8Array,
  productId: string,
  derivationIndex: number,
): Uint8Array => {
  const junctions = ["product", productId, String(derivationIndex)];

  return junctions.reduce((publicKey, junction) => {
    return HDKD.publicSoft(publicKey, createChainCode(junction));
  }, rootPublicKey);
};

// NOTE: Uncomment when derived product accounts get their own on-chain
// allowance (quota) on People Chain. Currently only the root session account
// has allowance, so createProof signs with the root ssSecret directly.
// Once per-product allowance is supported, use this in handleStatementStoreCreateProof
// to sign with the product-derived key instead.
// export const deriveProductSecretKey = (
//   rootSecret: Uint8Array,
//   productId: string,
//   derivationIndex: number,
// ): Uint8Array => {
//   const junctions = ["product", productId, String(derivationIndex)];
//   return junctions.reduce((secret, junction) => {
//     return HDKD.secretSoft(secret, createChainCode(junction));
//   }, rootSecret);
// };
