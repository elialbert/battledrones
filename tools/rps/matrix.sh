#!/bin/zsh
# matrix.sh <tag> : each PAIRS "a:b" matchup (24 games) under BAL; results in $OUT (default /tmp/rps)
D=${0:A:h}; OUT=${OUT:-/tmp/rps}; mkdir -p $OUT
P=${PAIRS:-"rush+r1:greed rush+r1:turtle+t4 greed:turtle+t4 rush+r1:ironclad greed:ironclad"}
for pair in ${=P}; do
  a=${pair%%:*}; b=${pair##*:}; f=$OUT/x_$1_${a}_$b.txt
  $D/xbatch.sh hard $a $b > $f
  echo "$1 $a vs $b: $(grep -c ' W ' $f)W $(grep -c ' L ' $f)L $(grep -c ' D ' $f)D / $(wc -l < $f)"
done
