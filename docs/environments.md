---
summary: "All dot.li deploy targets, the chain network each build dials, and how each is deployed"
read_when:
  - You need to know which URL maps to which build, or which build is reaching which chain
  - You are dispatching a manual deploy and need to pick a target
  - You are debugging an env-specific failure (wrong chain, wrong target)
  - You are adding a new deploy target or a new chain endpoint
title: "Environments"
---

dot.li ships from one repo to seven URLs. `paseo.li` and `paseoli.dev` dial paseo-next-v2 (V2 system parachains, `para_id` 1500 / 1502 / 1501); the other targets dial the original Paseo testnet (V1, `para_id` 1000 / 5118). Per-network service config (genesis hashes, RPC arrays, IPFS gateways, dotNS contract addresses + storage slots) lives in [packages/config/src/network.ts](../packages/config/src/network.ts) under `NETWORK_NAME_TO_SERVICES_CONFIG`, keyed by `NetworkName`. The per-target GitHub Environment only carries deploy secrets (SSH, Sentry, metrics).

<table>
  <thead>
    <tr>
      <th>URL</th>
      <th>Tier</th>
      <th>Network</th>
      <th>Server</th>
      <th>Trigger</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><a href="https://dot.li">dot.li</a></td>
      <td>production</td>
      <td rowspan="2" valign="top">
        Paseo Relay <a href="../packages/config/src/network.ts#L47">network.ts:47</a><br/>
        Paseo Asset Hub V1 <a href="../packages/config/src/network.ts#L57">network.ts:57</a><br/>
        Paseo People V1 <a href="../packages/config/src/network.ts#L73">network.ts:73</a><br/>
        Paseo Bulletin V1 <a href="../packages/config/src/network.ts#L67">network.ts:67</a><br/>
        dotNS V1 (slots 0/1) <a href="../packages/config/src/network.ts#L78">network.ts:78</a>
      </td>
      <td>51.158.111.82</td>
      <td>GitHub release</td>
    </tr>
    <tr>
      <td><a href="https://dotli.dev">dotli.dev</a></td>
      <td>development</td>
      <td>51.159.177.252</td>
      <td>Manual dispatch</td>
    </tr>
    <tr>
      <td><a href="https://paseo.li">paseo.li</a></td>
      <td>staging</td>
      <td rowspan="2" valign="top">
        Paseo Relay <a href="../packages/config/src/network.ts#L85">network.ts:85</a><br/>
        Paseo Asset Hub Next V2 <a href="../packages/config/src/network.ts#L95">network.ts:95</a><br/>
        Paseo People Next V2 <a href="../packages/config/src/network.ts#L106">network.ts:106</a><br/>
        Paseo Bulletin Next V2 <a href="../packages/config/src/network.ts#L100">network.ts:100</a><br/>
        dotNS V2 (slots 0/0) <a href="../packages/config/src/network.ts#L111">network.ts:111</a>
      </td>
      <td>51.159.177.252</td>
      <td>Push to main</td>
    </tr>
    <tr>
      <td><a href="https://paseoli.dev">paseoli.dev</a></td>
      <td>development</td>
      <td>51.159.177.252</td>
      <td>Manual dispatch</td>
    </tr>
    <tr>
      <td><a href="https://westend.li">westend.li</a></td>
      <td>development</td>
      <td rowspan="2" valign="top">
        Paseo Relay <a href="../packages/config/src/network.ts#L47">network.ts:47</a><br/>
        Paseo Asset Hub V1 <a href="../packages/config/src/network.ts#L57">network.ts:57</a><br/>
        Paseo People V1 <a href="../packages/config/src/network.ts#L73">network.ts:73</a><br/>
        Paseo Bulletin V1 <a href="../packages/config/src/network.ts#L67">network.ts:67</a><br/>
        dotNS V1 (slots 0/1) <a href="../packages/config/src/network.ts#L78">network.ts:78</a>
      </td>
      <td>51.159.177.252</td>
      <td>Manual dispatch</td>
    </tr>
    <tr>
      <td><a href="https://westendli.dev">westendli.dev</a></td>
      <td>development</td>
      <td>51.159.177.252</td>
      <td>Manual dispatch</td>
    </tr>
    <tr>
      <td><a href="https://testnet.li">testnet.li</a></td>
      <td>development</td>
      <td valign="top">
        Paseo Relay <a href="../packages/config/src/network.ts#L47">network.ts:47</a><br/>
        Paseo Asset Hub V1 <a href="../packages/config/src/network.ts#L57">network.ts:57</a><br/>
        Paseo People V1 <a href="../packages/config/src/network.ts#L73">network.ts:73</a><br/>
        Paseo Bulletin V1 <a href="../packages/config/src/network.ts#L67">network.ts:67</a><br/>
        dotNS V1 (slots 0/1) <a href="../packages/config/src/network.ts#L78">network.ts:78</a>
      </td>
      <td>51.159.177.252</td>
      <td>Manual dispatch</td>
    </tr>
  </tbody>
</table>

Source of truth: [Makefile](../Makefile) (URLs, hosts), [.github/workflows/](../.github/workflows/) (triggers, GitHub Environments), [packages/config/src/network.ts](../packages/config/src/network.ts) (chain endpoints + dotNS contracts). Only `dot.li` runs on the prod box; everything else shares the staging box.

The dotNS storage-slot column captures where each `DotnsContentResolver` lays out its `contenthashes` mapping: V1 keeps it at slot 1 (alongside the `registry` field at slot 0); V2 dropped the `registry` field and shifted `contenthashes` up to slot 0. The shape is per-network — extending dotli to a new network just adds a row to the dict.

The user picks the active network at runtime; switching triggers a full wipe + reload so no in-flight provider survives the change. Network selection persists in `localStorage["dotli:network"]`.

Manual dispatch:

```sh
gh workflow run "Deploy Development" --repo paritytech/dotli \
  --ref <branch> -f target=<dev-paseo|dev-polkadot|dev-test|westend|dev-westend>
```

`testnet.li` (target `dev-test`) is the generic sandbox with no chain implied in the name; preferred slot for one-off experiments. The other dev targets mirror their staging URLs.
