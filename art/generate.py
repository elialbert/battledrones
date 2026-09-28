#!/usr/bin/env python3
"""Generate raw art from the catalogue with the OpenAI Images API.

Usage:
    python3 art/generate.py                 # every asset that has no raw yet
    python3 art/generate.py hq wasp         # just these (glob patterns ok)
    python3 art/generate.py 'tex-*' --force # regenerate matches
    python3 art/generate.py --list

Raws land in art/raw/<name>.webp (lossy RGB, lossless alpha — small enough to
commit, faithful enough to re-process). Needs OPENAI_API_KEY.
"""

from __future__ import annotations

import argparse
import fnmatch
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from catalog import A  # noqa: E402
from imagegen import MODEL, generate  # noqa: E402

RAW = Path(__file__).parent / "raw"


def job(name: str) -> str:
    spec = A[name]
    t = time.time()
    img = generate(
        spec["prompt"],
        size=spec["size"],
        quality=spec["quality"],
        transparent=spec["transparent"],
    )
    RAW.mkdir(exist_ok=True)
    img.save(RAW / f"{name}.webp", quality=92, method=6)
    return f"{name}: {img.size[0]}x{img.size[1]} in {time.time() - t:.0f}s"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("names", nargs="*")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("-j", "--jobs", type=int, default=8)
    args = ap.parse_args()

    if args.list:
        for n in A:
            print(("✓ " if (RAW / f"{n}.webp").exists() else "  ") + n)
        return

    pats = args.names or ["*"]
    names = [n for n in A if any(fnmatch.fnmatch(n, p) for p in pats)]
    if not args.force:
        names = [n for n in names if not (RAW / f"{n}.webp").exists()]
    print(f"{MODEL}: generating {len(names)} assets with {args.jobs} workers")
    failed = []
    with ThreadPoolExecutor(args.jobs) as pool:
        futs = {pool.submit(job, n): n for n in names}
        for f in as_completed(futs):
            try:
                print(f.result(), flush=True)
            except Exception as e:  # keep going; report at the end
                failed.append(futs[f])
                print(f"FAILED {futs[f]}: {e}", flush=True)
    if failed:
        print("failed:", " ".join(failed))
        sys.exit(1)


if __name__ == "__main__":
    main()
