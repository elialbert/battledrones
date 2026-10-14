# Showcase battles

Saved model battle records (see also AGENT-BATTLES.md "First battles"). The site publishes them beside the game, so each one replays from its link (`/?replay=battles/showcase/<file>.json`) and opens in the record viewer (`/record-viewer.html?replay=…`): the links are in the table below and in the README. Or open the game, choose **🎬 Watch a replay** on the menu and paste the file's contents (or pick the file). From a checkout:

```bash
npx vite-node tools/arena.ts replay battles/showcase/<file>.json   # re-run it, check the hash trail
npx vite-node tools/arena.ts watch battles/showcase/<file>.json    # open it in the dev viewer
npx vite-node tools/arena.ts stats battles/showcase/*.json --detail
```

| Record | Blue | Red | As played | Now (re-simulated) | |
|---|---|---|---|---|---|
| `2026-10-11-riverlands-42-gpt-6-luna-vs-gpt-6-luna.json` | GPT-6 Luna (Industry) | GPT-6 Luna (Industry) | blue wins at 4:31 | blue wins at 4:31 | [replay](https://simonw.github.io/battledrones/?replay=battles/showcase/2026-10-11-riverlands-42-gpt-6-luna-vs-gpt-6-luna.json) · [record](https://simonw.github.io/battledrones/record-viewer.html?replay=battles/showcase/2026-10-11-riverlands-42-gpt-6-luna-vs-gpt-6-luna.json) |
| `2026-10-11-dune-sea-7-gpt-6-luna-vs-gpt-6-luna.json` | GPT-6 Luna (Blitz) | GPT-6 Luna (Industry) | blue wins at 6:23 | blue wins at 7:52 | [replay](https://simonw.github.io/battledrones/?replay=battles/showcase/2026-10-11-dune-sea-7-gpt-6-luna-vs-gpt-6-luna.json) · [record](https://simonw.github.io/battledrones/record-viewer.html?replay=battles/showcase/2026-10-11-dune-sea-7-gpt-6-luna-vs-gpt-6-luna.json) |
| `2026-10-11-riverlands-42-gpt-6-luna-vs-gpt-6-astra.json` | GPT-6 Luna (Industry) | GPT-6 Astra (Industry) | red wins at 4:45 | red wins at 7:50 | [replay](https://simonw.github.io/battledrones/?replay=battles/showcase/2026-10-11-riverlands-42-gpt-6-luna-vs-gpt-6-astra.json) · [record](https://simonw.github.io/battledrones/record-viewer.html?replay=battles/showcase/2026-10-11-riverlands-42-gpt-6-luna-vs-gpt-6-astra.json) |
| `2026-10-11-archipelago-42-gpt-5.6-sol-vs-gpt-6.1-sol.json` | GPT-5.6 Sol (Air Wing) | GPT-6.1 Sol (Air Wing) | red wins at 11:45 | (played on this sim) | [replay](https://simonw.github.io/battledrones/?replay=battles/showcase/2026-10-11-archipelago-42-gpt-5.6-sol-vs-gpt-6.1-sol.json) · [record](https://simonw.github.io/battledrones/record-viewer.html?replay=battles/showcase/2026-10-11-archipelago-42-gpt-5.6-sol-vs-gpt-6.1-sol.json) |
| `2026-10-14-riverlands-42-gpt-6-astra-vs-gemini-4-argon.json` | GPT-6 Astra (Industry) | Gemini 4 Argon (Blitz) | blue wins at 5:35 | (played on this sim) | [replay](https://simonw.github.io/battledrones/?replay=battles/showcase/2026-10-14-riverlands-42-gpt-6-astra-vs-gemini-4-argon.json) · [record](https://simonw.github.io/battledrones/record-viewer.html?replay=battles/showcase/2026-10-14-riverlands-42-gpt-6-astra-vs-gemini-4-argon.json) |
| `2026-10-14-archipelago-42-claude-opus-5.5-vs-gemini-4-argon.json` | Claude Opus 5.5 (Industry) | Gemini 4 Argon (Industry) | blue wins at 4:12 | (played on this sim) | [replay](https://simonw.github.io/battledrones/?replay=battles/showcase/2026-10-14-archipelago-42-claude-opus-5.5-vs-gemini-4-argon.json) · [record](https://simonw.github.io/battledrones/record-viewer.html?replay=battles/showcase/2026-10-14-archipelago-42-claude-opus-5.5-vs-gemini-4-argon.json) |
| `2026-10-14-archipelago-42-claude-opus-5.5-vs-gpt-6-astra-2.json` | Claude Opus 5.5 (Goliath Armada) | GPT-6 Astra (Goliath Armada) | red wins at 4:41 | (played on this sim) | [replay](https://simonw.github.io/battledrones/?replay=battles/showcase/2026-10-14-archipelago-42-claude-opus-5.5-vs-gpt-6-astra-2.json) · [record](https://simonw.github.io/battledrones/record-viewer.html?replay=battles/showcase/2026-10-14-archipelago-42-claude-opus-5.5-vs-gpt-6-astra-2.json) |

The first three were played on the sim before `src/sim/fmath.ts` made it give the same
results in every browser engine, and brought up to date with
`npx vite-node tools/arena.ts upgrade battles/showcase/*.json`: the same
commands, re-simulated. The models chose those commands against the old
world, so the re-simulated battles drift a little; in two of them the final
assault lands later, on the standing orders. The viewer shows the ending as
played when it differs, and each record keeps it under `upgraded`.

The first was played before unit ids were written `"#97"` in the order
reference, so many of its orders were refused. The third was played with
`-o reasoning_effort low` for both seats. The fourth, on the Archipelago, was
played on the current sim at the default effort:

```bash
llm battledrones run --blue gpt-5.6-sol --red gpt-6.1-sol --map archipelago --seed 42
```

LLM 0.36 doesn't list `gpt-6.1-sol` yet, so it was added in LLM's
`extra-openai-models.yaml` with the same settings as `gpt-6-sol` (`responses:
true`, `reasoning: true`, `supports_tools: true`). The logs databases and tool
transcripts that went with these records stayed local (a few MB each; 21 MB
for the fourth).

The Astra–Argon battle used Riverlands, seed 42, default model options, and equal budgets of 10 model responses and 12 tool calls per five-second round. Astra chose Industry; Argon chose Blitz. Astra won by destroying Argon's HQ at 5:35, and all 33 replay hash checks match. A process-local adapter sent Gemini's original tool schemas through `parametersJsonSchema` because the installed Gemini plugin's `parameters` conversion rejected the orders tool's free-form dictionaries. The aborted setup attempt is excluded; the successful battle's database and tool transcript remain local in `battles/` with the `2026-10-14-riverlands-42-gpt-6-astra-vs-gemini-4-argon-2` stem.

The Opus–Argon battle used Archipelago, seed 42, with Industry assigned to both sides by the organizer before model play. Both used default model options and equal budgets of 10 model responses and 12 tool calls per five-second round, a 300-second timeout, no output-token cap, and a 20-minute game limit. Opus won by destroying Argon's HQ at 4:12, and all 25 replay hash checks match. The same process-local Gemini compatibility adapter sent the original tool schemas through `parametersJsonSchema`. The record preserves the organizer-set openers; the database and tool transcript remain local in `battles/`.

The Opus–Astra battle used Archipelago, seed 42, with Goliath Armada: four airborne Goliaths and eight Condors per side, no HQs, and no opener cards. Both used default model options and equal budgets of 10 model responses and 12 tool calls per five-second round, a 300-second timeout, no output-token cap, and a 20-minute game limit. Astra won by destroying Opus's last Goliath at 4:41.8 (tick 2818), and all 28 replay hash checks match. This was a fresh restart after `97a2708` added missing Goliath controls, observations, briefing, and wait alerts to the agent arena without changing simulator rules. The first attempt was aborted at 0:25 and is excluded; the completed record is copied unchanged, and its database and tool transcript remain local in `battles/`.
