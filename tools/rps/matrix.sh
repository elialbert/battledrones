#!/bin/zsh
# matrix.sh <tag> : each PAIRS "a:b" matchup (24 games) under BAL, all in one queue (sweep.mjs); results in $OUT (default /tmp/rps)
D=${0:A:h}
PAIRS=${PAIRS:-"rush:greed rush:turtle greed:turtle"} NOBASE=1 exec node $D/sweep.mjs "$1=${BAL:-{\}}"
