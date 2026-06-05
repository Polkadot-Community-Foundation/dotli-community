// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// TrUAPI debug package public API.
//
// Host-side debug panel that listens to the experimental
// `onHostApiDebugMessage` hook from `@novasamatech/host-container` and
// renders every host <-> product message in a docked, filterable panel.

export { setupTruapiDebugPanel, type SetupOptions } from "./panel.ts";
