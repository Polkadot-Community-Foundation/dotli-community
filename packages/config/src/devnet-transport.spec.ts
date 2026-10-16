// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// PCF fork: devnet's parachains are not in truapi-provider's catalog, so the
// light-client transports cannot serve it. Own file because the network
// override below is module state and would leak into the other suites.

import { describe, expect, it, onTestFinished } from 'vitest';
import { activeSettings, setSettings } from './active-settings.js';
import { defaultBackend, getBackend } from './mode.js';
import { NetworkName, activeNetworkSupportsLightClient, type Network } from './network.js';
import { getSettings } from './settings.js';
import type { Backend } from './mode.js';

function useNetwork(network: Network, backend?: Backend): void {
  const settings = getSettings();
  onTestFinished(setSettings({ ...settings, network, backend: backend ?? settings.backend }));
}

describe('devnet transport', () => {
  it('As a devnet host, I report that the light client cannot serve the network', () => {
    useNetwork(NetworkName.DEVNET);

    expect(activeNetworkSupportsLightClient()).toBe(false);
  });

  it('As a devnet host, I default to the trusted providers', () => {
    useNetwork(NetworkName.DEVNET);

    expect(defaultBackend()).toBe('rpc-gateway');
  });

  it('As a devnet host, I serve the trusted providers over a stored light-client choice without erasing it', () => {
    useNetwork(NetworkName.DEVNET, 'smoldot-direct');

    expect(getBackend()).toBe('rpc-gateway');
    expect(activeSettings()?.backend).toBe('smoldot-direct');
  });

  it('As a host on a network the catalog carries, I keep the light client', () => {
    useNetwork(NetworkName.PASEO, 'smoldot-direct');

    expect(activeNetworkSupportsLightClient()).toBe(true);
    expect(defaultBackend()).toBe('smoldot-direct');
    expect(getBackend()).toBe('smoldot-direct');
  });
});
