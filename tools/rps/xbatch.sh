#!/bin/bash
# xbatch.sh <diff> <ours> <theirs> : 24 games (6 maps x SEEDS x both sides), one process each, P (12) at once.
# Bundles rush.ts from $RPS_TREE (default: this repo) first, so src can be edited while it runs.
# BAL='{"ECONOMY.harvestRate":17}' patches balance. (sweep.mjs runs configs x matchups in one queue.)
cd "${RPS_TREE:-$(dirname "$0")/../..}"
B=$(mktemp -d)/rush.mjs
node_modules/.bin/esbuild tools/rps/rush.ts --bundle --platform=node --format=esm --outfile=$B --log-level=warning || exit 1
for m in riverlands frostbite dune-sea archipelago ashlands proving-grounds; do for sd in ${SEEDS:-1 2}; do for side in blue red; do echo "$m $sd $1 $side $2 $3"; done; done; done |
  B=$B xargs -P ${P:-12} -L 1 sh -c 'timeout 180 node $B $0 $1 $2 $3 $4 $5 q 2>&1 | tail -1'
rm -rf "$(dirname $B)"
