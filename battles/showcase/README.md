# Showcase battles

Battle records from the first model battles (AGENT-BATTLES.md "First
battles"). To watch one, open the game, choose **🎬 Watch a replay** on the
menu and paste the file's contents (or pick the file). From a checkout:

```bash
npx vite-node tools/arena.ts replay battles/showcase/<file>.json   # re-run it, check the hash trail
npx vite-node tools/arena.ts watch battles/showcase/<file>.json    # open it in the dev viewer
npx vite-node tools/arena.ts stats battles/showcase/*.json --detail
```

| Record | Blue | Red | Result |
|---|---|---|---|
| `2026-10-11-riverlands-42-gpt-6-luna-vs-gpt-6-luna.json` | GPT-6 Luna (Industry) | GPT-6 Luna (Industry) | blue wins at 4:31 |
| `2026-10-11-dune-sea-7-gpt-6-luna-vs-gpt-6-luna.json` | GPT-6 Luna (Blitz) | GPT-6 Luna (Industry) | blue wins at 6:23 |
| `2026-10-11-riverlands-42-gpt-6-luna-vs-gpt-6-astra.json` | GPT-6 Luna (Industry) | GPT-6 Astra (Industry) | red wins at 4:45 |

The first was played before unit ids were written `"#97"` in the order
reference, so many of its orders were refused. The third was played with
`-o reasoning_effort low` for both seats. The logs databases and tool
transcripts that went with them stayed local (a few MB each).
