# Deployment

One-shot provisioning of a fresh server using `make provision`.
The target is idempotent and safe to re-run, so the same command
works for the first boot and for later top-ups.

## Requirements

### Remote server

- Ubuntu 24.04+ (Noble).
- The SSH user must have **passwordless `sudo`** — the provisioning steps run
  `sudo` non-interactively over SSH (no TTY), so a password prompt makes them
  fail. Either grant the user `NOPASSWD` sudo (e.g. a drop-in in
  `/etc/sudoers.d/`), or connect as `root` directly (`REMOTE=root@<ip>`).
- Reachable over SSH from your machine without a password (key-based auth).
- Public IP with ports `22`, `80`, and `443` open (the firewall step opens these via `ufw`).

### DNS

- The zone for the env's base domain (e.g. `paseo.li`) managed in Cloudflare.
- `A` / `AAAA` records pointing to the box for the apex.
- A Cloudflare API token scoped to **Zone → DNS → Edit** on that zone.

**Important:** The token needs to exist for all the time this is hosted as it will be required to renew the certificates.

### Local machine

- `make`, `ssh`, `rsync`, and [Bun](https://bun.sh) 1.3+.
- SSH agent loaded with the key the remote accepts (`ssh-add`).
- This repo checked out and on the branch/commit you want to deploy.

### Inputs you pass to the command

| Variable               | Required | Notes                                                                                                                                                                                               |
| ---------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ENV`                  | no       | One of `polkadot`, `dev-polkadot`, `paseo`, `dev-paseo`, `dev-test`, `westend`, `dev-westend`, `summit`. Defaults to `polkadot`                                                                     |
| `ADMIN_EMAIL`          | yes      | Let's Encrypt contact email.                                                                                                                                                                        |
| `CLOUDFLARE_API_TOKEN` | yes      | Cloudflare token with DNS edit on the zone.                                                                                                                                                         |
| `REMOTE`               | no       | `user@host` override. When unset, the target resolves from `REMOTE_PRD` / `REMOTE_STG` (see [Configure deploy targets](#configure-deploy-targets)). Pass this to deploy a box not covered by those. |

## Configure deploy targets

The production and staging SSH targets are not committed to the repo. Provide
them in one of two ways:

- **`deploy.env`** (recommended for repeat deploys): copy `deploy.env.example`
  to `deploy.env` (gitignored) and set `REMOTE_PRD` / `REMOTE_STG`. The
  `Makefile` includes it automatically.
- **`REMOTE=user@host`** on the command line: overrides both for a single run,
  useful for a one-off or a brand-new box.

If neither is set, `make deploy` / `make provision` fails fast with a message
telling you to configure a target. CI deploys do not use these: the GitHub
Actions path reads `DEPLOY_HOST` / `DEPLOY_USER` from repository secrets via the
`ci-deploy` target.

## What `make provision` does

`Makefile:81` chains these targets in order:

1. `provision-prereqs` — apt-installs nginx (with brotli modules), certbot,
   the Cloudflare DNS plugin, rsync, ufw, curl; removes the default
   nginx site.
2. `provision-firewall` — allows `OpenSSH` and `Nginx Full`, then enables
   `ufw`. SSH is whitelisted before enable so you don't lock yourself out.
3. `provision-cloudflare-creds` — writes `/etc/letsencrypt/cloudflare.ini`
   (`0600`, `root:root`) from the token you pass in.
4. `provision-cert` — issues a Let's Encrypt cert via DNS-01 covering the
   apex, `*.<base>`, and `*.app.<base>`. `--keep-until-expiring --expand`
   makes re-runs cheap.
5. `provision-renewal` — enables `certbot.timer` for auto-renewal.
6. `deploy` — ensures bun on the remote (`provision-bun`), rsyncs the repo to
   `$(REMOTE_BUILD_PATH)` on the box, runs `bun install --frozen-lockfile &&
bun run build:prod` **on the remote** (the box is sized for the build;
   `VITE_NETWORKS` is injected per-env via `VITE_NETWORKS_<env>`), then installs
   the three `dist/` outputs into the env's web root.
7. `deploy-nginx` — renders `nginx/nginx.conf.template` for the env (envsubst)
   and installs it plus `nginx/snippets/` into `/etc/nginx/`, runs `nginx -t`,
   and reloads nginx. Preview the result with `make render-nginx ENV=<env>`.

## Run it

```sh
make provision \
  ENV=paseo \
  REMOTE=ubuntu@ip.for.machine \
  ADMIN_EMAIL=ops@example.com \
  CLOUDFLARE_API_TOKEN=cf_xxxxxxxxxxxxxxxxxxxxxxxxxxx
```

On success the last line is `Provisioning complete for ENV=<env>.` and the
site is live at `https://<base-domain>`.

## Re-runs and follow-ups

- `make provision` is idempotent; re-run it to pick up nginx config or build changes.
- For code-only redeployments (no infra changes), `make deploy ENV=<env>` is enough.
- For nginx-only updates, `make deploy-nginx ENV=<env>`.

## Summit (`ENV=summit`)

Summit is **not** deployed by CI — `.github/workflows/deploy.yml` only targets the
public dot.li/dev environments (`paseo.li`, `testnet.li`, `paseoli.dev`, …). Summit
is deployed manually from a workstation with IAP access to the box:

- Host: GCE instance `pcf-summit-dotli`, zone `europe-west3-b`, project
  `polkadot-community-foundation`, reached over an IAP TCP tunnel (see the
  `pcf-summit-dotli` `Host` alias in your `~/.ssh/config`, which sets a
  `gcloud compute start-iap-tunnel` `ProxyCommand`). Requires `gcloud auth login`.
- `deploy.env`: `REMOTE_SUMMIT := pcf-summit-dotli` (or pass `REMOTE=pcf-summit-dotli`).
- Build config: the on-box `build:prod` gets `VITE_NETWORKS=summit` injected by the
  Makefile (`VITE_NETWORKS_summit`) — required or the app throws. No local `.env`
  needed; the repo is rsynced to the box and built there.
- Run: `make deploy ENV=summit` then `make deploy-nginx ENV=summit`.

### Automating Summit in CI (TODO — not yet wired)

Unlike the other envs, the Summit box is private (IAP-only, no public SSH), and CI
has no GCP auth today. To let `deploy.yml` deploy Summit, the following is needed:

1. **`pcf-infra` terraform (then `terraform apply`):**
   - Widen the GitHub WIF provider's `attribute_condition` in
     `terraform/identity-federation.tf` to also trust
     `Polkadot-Community-Foundation/dotli-community` (today it trusts only the
     `identity-backend` repos).
   - Add a deploy service account bound to that WIF principal with
     `roles/iap.tunnelResourceAccessor` (IAP TCP, not the existing web-UI IAP),
     `roles/compute.viewer`, and OS Login (`roles/compute.osLogin`) on the
     `pcf-summit-dotli` instance.
2. **`deploy.yml`, gated to the `summit` env:** add `google-github-actions/auth`
   (WIF) + `setup-gcloud`, then replace the `ssh-keyscan` + direct-ssh steps with a
   `start-iap-tunnel` `ProxyCommand` ssh-config (mirroring the local
   `~/.ssh/config` alias, using the SA / OS-Login identity). `make ci-deploy` then
   works unchanged with `DEPLOY_HOST=pcf-summit-dotli`.
3. **GitHub Environment `summit`:** `vars` `NETWORKS=summit`, `APP_URL=https://dot.li`;
   `secrets` `DEPLOY_USER`, `DEPLOY_HOST=pcf-summit-dotli`,
   `DEPLOY_PATH=/var/www/summitli` (+ Sentry/metrics if ever enabled). Protect it
   with a **required reviewer** and drive it from a deliberate trigger
   (`workflow_dispatch`), not auto-on-push — Summit is production.
