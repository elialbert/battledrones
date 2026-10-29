#!/bin/bash
# xbatch.sh <diff> <ours> <theirs> : 24 games (6 maps x SEEDS x both sides), one process each, 24 at once.
# Runs in the worktree at $RPS_TREE (default: this repo). BAL='{"ECONOMY.harvestRate":17}' patches balance.
cd "${RPS_TREE:-$(dirname "$0")/../..}"
for m in riverlands frostbite dune-sea archipelago ashlands proving-grounds; do for sd in ${SEEDS:-1 2}; do for side in blue red; do echo "$m $sd $1 $side $2 $3"; done; done; done |
  xargs -P 24 -L 1 sh -c 'timeout 180 npx vite-node tools/rps/rush.ts $0 $1 $2 $3 $4 $5 q 2>&1 | tail -1'
