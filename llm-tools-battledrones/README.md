# llm-tools-battledrones

Battle Drones agent battles for [LLM](https://llm.datasette.io/): a toolbox
that commands one side of a battle served by `tools/arena.ts`, and an
`llm battledrones` command that pits two models against each other, round by
round, each seeing only what its side could see. The design is in
[AGENT-BATTLES.md](../AGENT-BATTLES.md).

It lives in the battledrones repo because it changes with the arena's
protocol. Install it from a checkout (after `npm ci`):

```bash
llm install -e llm-tools-battledrones
llm keys set openai          # or anthropic with llm-anthropic, etc.
```

## Proper matches: `llm battledrones`

```bash
llm battledrones run --blue gpt-6-luna --red gpt-6-luna --map riverlands --seed 42
llm battledrones run --blue claude-opus-5-5 --red ai:rush:hard -o reasoning_effort low
llm battledrones series --a gpt-6-luna --b gpt-6-sol --maps all --seeds 3   # mirror pairs
llm battledrones stats battles/*.json
```

`run` starts `npx vite-node tools/arena.ts serve` itself, and plays every
round as a fresh chain for each seat, both at once: the system prompt (rules,
tool guide and briefing, the same for both) and that round's observation,
then a short tool loop that ends with `end_round`. Either side can be a model
id or a built-in seat (`ai:<personality>:<difficulty>`, `scripted`).

Budgets per seat per round, the same for both: `--chain-limit` model
responses (10), `--tool-calls` (12; `end_round` and `wait` are free),
`--output-tokens` (off) and a wall-clock `--timeout` (300 s) that only catches
a hung request. A seat that runs out plays the round with the orders it gave.
Provider errors are retried with backoff and don't cost the round. Model
options go with `-o` (both seats), `--blue-option` and `--red-option`.

Everything lands next to each other in `battles/`:

- `<id>.json`: the battle record (setup, every command, a hash trail, each
  side's orders, results, notes and radio per round, token use). Replay it
  with `npx vite-node tools/arena.ts replay`, watch it in 3D with
  `npx vite-node tools/arena.ts watch`.
- `<id>.logs.db`: LLM's log of every prompt and response:
  `llm logs -d battles/<id>.logs.db --tool BattleDrones_orders`, or
  `datasette battles/<id>.logs.db`.
- `<id>.tools.jsonl`: every tool call and result, including the `end_round`
  calls the log can't show (a chain pauses there).

## The toolbox

```bash
npx vite-node tools/arena.ts serve --map riverlands --blue seat --red ai:balanced:easy
llm chat -m gpt-6-luna -T 'BattleDrones("http://127.0.0.1:8790/seat/7f3a91…")' --cl 0 --td
> You're blue. Read the briefing, open with Blitz and go for their harvesters.
```

`BattleDrones(seat)` has six tools: `briefing`, `observe`, `look`, `orders`,
`end_round` and `wait`. Outside `llm battledrones`, `end_round` waits for the
round to play and returns the next observation, so a model (or two, in two
terminals) can play a whole match in one conversation.

## Tests

No tokens spent: the toolbox plays against a real arena with a scripted
opponent, and `llm battledrones` is driven by a stand-in model that makes
scripted tool calls.

```bash
cd llm-tools-battledrones
uv run --with pytest --with-editable . pytest
```
