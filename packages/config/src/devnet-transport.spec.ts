// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Devnet's parachains are not in truapi-provider's catalog, so the light client cannot serve it. Own file: the network
// override is module state and would leak into the other suites.

import { describe, expect, it, onTestFinished } from 'vitest';
import { activeNetworkSupportsLightClient } from './activeNetwork.js';
import { activeSettings, setSettings } from './activeSettings.js';
import { getBackend, getDefaultBackend, type Backend } from './backend.js';
import type { Network } from './networkNames.js';
import { getSettings } from './settings.js';

function useNetwork(network: Network, backend?: Backend): void {
  const settings = getSettings();
  onTestFinished(setSettings({ ...settings, network, backend: backend ?? settings.backend }));
}

describe('devnet transport', () => {
  it('As a devnet host, I report that the light client cannot serve the network', () => {
    useNetwork('devnet');

    expect(activeNetworkSupportsLightClient()).toBe(false);
  });

  it('As a devnet host, I default to the trusted providers', () => {
    useNetwork('devnet');

    expect(getDefaultBackend()).toBe('rpc-gateway');
  });

  it('As a devnet host, I serve the trusted providers over a stored light-client choice without erasing it', () => {
    useNetwork('devnet', 'smoldot-direct');

    expect(getBackend()).toBe('rpc-gateway');
    expect(activeSettings()?.backend).toBe('smoldot-direct');
  });

  it('As a host on a network the catalog carries, I keep the light client', () => {
    useNetwork('paseo-next-v2', 'smoldot-direct');

    expect(activeNetworkSupportsLightClient()).toBe(true);
    expect(getDefaultBackend()).toBe('smoldot-direct');
    expect(getBackend()).toBe('smoldot-direct');
  });
});
