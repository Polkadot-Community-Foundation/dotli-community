#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only

# Ties every change to a gateway to that gateway's lane branch.
#   scripts/lane-deploy.sh check <env>         refuses unless HEAD is the lane's clean, pushed head
#   scripts/lane-deploy.sh tag <env> <site>    tags HEAD <lane>/<YYYY-MM-DD>.<n> and pushes the tag

set -euo pipefail

usage() {
  echo "usage: $0 check <env> | tag <env> <site>" >&2
  exit 2
}

[ $# -ge 2 ] || usage
cmd=$1
env=$2
remote=origin

# dot.li (summit) serves the devnet, like dev-dot.li.
case "$env" in
  devnet | summit) lane=devnet ;;
  *)
    echo "ENV=$env has no lane branch, so it is not deployed from this repository." >&2
    exit 1
    ;;
esac

case "$cmd" in
  check)
    [ $# -eq 2 ] || usage
    branch=$(git symbolic-ref --quiet --short HEAD || true)
    if [ "$branch" != "$lane" ]; then
      echo "ENV=$env deploys only from branch $lane, not ${branch:-a detached HEAD}." >&2
      exit 1
    fi
    if [ -n "$(git status --porcelain)" ]; then
      echo "The working tree has changes or untracked files, which the deploy would ship." >&2
      exit 1
    fi
    git fetch --quiet "$remote" "$lane"
    if [ "$(git rev-parse HEAD)" != "$(git rev-parse FETCH_HEAD)" ]; then
      echo "HEAD is not $remote/$lane. Pull it, or merge the change into $lane first." >&2
      exit 1
    fi
    ;;
  tag)
    [ $# -eq 3 ] || usage
    git fetch --quiet --tags "$remote"
    prefix="$lane/$(date -u +%F)."
    n=1
    while git rev-parse --quiet --verify "refs/tags/$prefix$n" >/dev/null; do
      n=$((n + 1))
    done
    git tag -a "$prefix$n" -m "Deployed to $3" HEAD
    git push --quiet "$remote" "refs/tags/$prefix$n"
    echo "Tagged $prefix$n"
    ;;
  *) usage ;;
esac
