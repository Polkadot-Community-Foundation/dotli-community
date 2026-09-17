// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// PCF fork: per-deployment brand variant for the host shell's icons.
//
// `VITE_BRAND_VARIANT` names a directory under `public/brand/`, and the assets
// there replace the favicon, the install (PWA) icons and the social preview
// image. Unset — every upstream build, and any gateway that does not ask for a
// variant — keeps the stock Polkadot icons.
//
// Icons only. The topbar logo is part of the UI package and stays the same on
// every gateway, so the browser tab and the installed app are what carry the
// network's identity.
//
// The assets come from `polkadot-app-brand-assets` (`variants/<channel>/png`),
// whose design language is a white tile for a test network plus a three-letter
// channel label — `DEV` for the products devnet. Re-copy them from that repo
// rather than editing here; it is the source of truth.

import type { Plugin } from "vite";

/** The variant this build targets, or `""` for the stock icons. */
export const BRAND_VARIANT: string = (
  process.env.VITE_BRAND_VARIANT ?? ""
).trim();

const FAVICON = "favicon-64.png";
const ICON_192 = "icon-192.png";
const ICON_512 = "icon-512.png";

function asset(file: string): string {
  return `/brand/${BRAND_VARIANT}/${file}`;
}

/** The PWA manifest's icon set: the variant's, or the stock one. */
export function brandManifestIcons(): {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}[] {
  const icon192 = BRAND_VARIANT === "" ? "/icon-192.png" : asset(ICON_192);
  const icon512 = BRAND_VARIANT === "" ? "/icon-512.png" : asset(ICON_512);
  return [
    { src: icon192, sizes: "192x192", type: "image/png" },
    { src: icon512, sizes: "512x512", type: "image/png" },
    {
      src: icon512,
      sizes: "512x512",
      type: "image/png",
      purpose: "any maskable",
    },
  ];
}

/** The social preview image: the variant's, or the stock one. */
export function brandSocialImage(): string {
  return BRAND_VARIANT === "" ? "/icon-512.png" : asset(ICON_512);
}

/**
 * Point the document's `rel="icon"` at the variant's favicon.
 *
 * Rewrites the tag rather than adding one: two `rel="icon"` links let the
 * browser pick, and it usually prefers the SVG, which is the icon this is
 * replacing.
 */
export function brandFavicon(): Plugin {
  return {
    name: "dotli-brand-favicon",
    transformIndexHtml: {
      order: "pre",
      handler(html: string): string {
        if (BRAND_VARIANT === "") {
          return html;
        }
        return html.replace(
          /<link rel="icon"[^>]*>/,
          `<link rel="icon" type="image/png" href="${asset(FAVICON)}" />`,
        );
      },
    },
  };
}
