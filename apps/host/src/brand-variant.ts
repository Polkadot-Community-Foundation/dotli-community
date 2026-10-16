// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Per-deployment brand variant for the host shell's icons. `VITE_BRAND_VARIANT` names a directory under
// `public/brand/` whose assets replace the favicon, the PWA icons and the social preview image; unset keeps the stock
// icons. The assets are copied from `polkadot-app-brand-assets`.

/** The variant this build targets, or `""` for the stock icons. */
const BRAND_VARIANT: string = (process.env['VITE_BRAND_VARIANT'] ?? '').trim();

const FAVICON = 'favicon-64.png';
const ICON_192 = 'icon-192.png';
const ICON_512 = 'icon-512.png';

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
  const icon192 = BRAND_VARIANT === '' ? '/icon-192.png' : asset(ICON_192);
  const icon512 = BRAND_VARIANT === '' ? '/icon-512.png' : asset(ICON_512);
  return [
    { src: icon192, sizes: '192x192', type: 'image/png' },
    { src: icon512, sizes: '512x512', type: 'image/png' },
    {
      src: icon512,
      sizes: '512x512',
      type: 'image/png',
      purpose: 'any maskable',
    },
  ];
}

/** The social preview image: the variant's, or the stock one. */
export function brandSocialImage(): string {
  return BRAND_VARIANT === '' ? '/icon-512.png' : asset(ICON_512);
}

/** The `rel="icon"` link: the variant's PNG favicon, or the stock SVG. */
export function brandFavicon(): { type: string; href: string } {
  return BRAND_VARIANT === ''
    ? { type: 'image/svg+xml', href: '/favicon.svg' }
    : { type: 'image/png', href: asset(FAVICON) };
}
