// dot.li — TrUAPI debug package public API.
//
// Host-side debug panel that listens to the experimental
// `onHostApiDebugMessage` hook from `@novasamatech/host-container` and
// renders every host <-> product message in a docked, filterable panel.

export { setupTruapiDebugPanel, type SetupOptions } from "./panel.ts";
