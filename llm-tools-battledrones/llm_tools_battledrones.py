"""Battle Drones agent battles for LLM (AGENT-BATTLES.md "Using LLM: a tools plugin").

The BattleDrones toolbox commands one side of a battle served by
`npx vite-node tools/arena.ts serve`; `llm battledrones run` starts that
server itself and plays every round as a fresh chain for each seat, both at
once, with the same budget for both.
"""

from __future__ import annotations

import asyncio
import importlib.metadata
import json
import os
import pathlib
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable

import click
import llm


class BattleDrones(llm.Toolbox):
    """Command one side of a Battle Drones match served by tools/arena.ts.

    Usage: BattleDrones("http://127.0.0.1:8790/seat/<token>")
    """

    def __init__(self, seat: str, pause_at_round_end: bool = False):
        self.seat = seat.rstrip("/")
        self.pause_at_round_end = pause_at_round_end
        if pause_at_round_end:
            # llm battledrones puts the briefing in the system prompt: don't offer the tool too
            self._blocked = (*llm.Toolbox._blocked, "briefing")

    def _post(self, tool: str, **args) -> str:
        request = urllib.request.Request(
            f"{self.seat}/{tool}",
            data=json.dumps(args).encode(),
            headers={"Content-Type": "application/json"},
        )
        try:
            # end_round can wait a while for the other seat to finish its round
            with urllib.request.urlopen(request, timeout=900) as response:
                return response.read().decode()
        except urllib.error.HTTPError as e:
            return f"Error from the arena ({e.code}): {e.read().decode(errors='replace')}"

    def briefing(self) -> str:
        """Rules, the order reference, the unit and building tables, the map
        and the three opener cards. Call this once, first."""
        return self._post("briefing")

    def observe(self) -> str:
        """What your side can see now: scrap, buildings, units, enemies in
        sight, enemy buildings as last seen, Uplinks, calldowns, what happened
        since your last turn, and your notes."""
        return self._post("observe")

    def look(self, x: int, y: int, r: int = 6) -> str:
        """A close-up text map around x, y (in your own coordinates) with the
        units you can see on it. r is the radius in tiles (2-12)."""
        return self._post("look", x=x, y=y, r=r)

    def orders(self, orders: list[dict]) -> str:
        """Give orders, for example [{"attack": [97, 83], "target": 23},
        {"build": "sam-site"}, {"produce": "stinger", "count": 2}].
        Returns ok, or the reason, for each one."""
        return self._post("orders", orders=orders)

    def end_round(self, notes: str, radio: str = "") -> str:
        """End your turn. notes (up to 2000 characters) come back to you next
        round: they are your memory. radio (up to 120 characters) is heard by
        spectators only."""
        if self.pause_at_round_end:
            # llm battledrones runs one chain per round: submit and stop here
            self._post("end_round", notes=notes, radio=radio, wait=False)
            raise llm.PauseChain("round over")
        # anywhere else: wait for the round to run, then carry on playing
        return self._post("end_round", notes=notes, radio=radio, wait=True)

    def wait(self, rounds: int) -> str:
        """End your turn and skip the next rounds - 1, unless something
        urgent happens first (your HQ attacked, an enemy strike called,
        enemies near your base)."""
        if self.pause_at_round_end:
            self._post("wait", rounds=rounds, wait=False)
            raise llm.PauseChain("round over")
        return self._post("wait", rounds=rounds)


@llm.hookimpl
def register_tools(register):
    register(BattleDrones)


# --------------------------------------------------------------------- arena ---

ROUND_TOOLS = ("BattleDrones_end_round", "BattleDrones_wait")

SYSTEM = """You are an AI commander in Battle Drones, a real-time strategy game, playing the {side} side against another AI commander. You play only through the BattleDrones tools.

The battle runs in rounds of {round_secs:g} seconds of game time. At the start of each round you are handed your observation. Then:
1. Read the situation and your notes (your notes from last round are at the bottom of the observation: they are your only memory).
2. If you need detail, call BattleDrones_look on an area.
3. Give your orders with BattleDrones_orders: put all of them in one list where you can, and read the results (each one says ok, or why it was refused). Unit lists take your own units' ids as the observation shows them ("#97") or selectors like "army"; tiles are [x, y] and only go in "to" or "at"; an attack's "target" is the enemy's id.
4. Finish with BattleDrones_end_round(notes, radio), on its own, after your orders' results have come back. Notes should carry your plan, build order progress, what you know about the enemy and what to do next. radio is an optional short line for the spectators (the enemy never hears it). In a quiet stretch you can call BattleDrones_wait(rounds) instead.
You have at most {tool_calls} tool calls a round; if you run out, the round ends with the orders you already gave. Units keep following their last orders between rounds, so you don't need to repeat standing orders. Never wait for permission: every round, decide and act.

Your briefing follows. It never changes during the battle.

{briefing}"""

ROUND_PROMPT = "{observation}\n\nRound {round}: your move. Give your orders, then call BattleDrones_end_round."


@dataclass
class Budget:
    """The same per-round limits for both seats (AGENT-BATTLES.md "Limits")."""

    chain_limit: int = 10
    tool_calls: int = 12
    output_tokens: int | None = None
    timeout: float = 300.0
    retries: int = 5


@dataclass
class SeatPlayer:
    side: str
    model: Any
    options: dict
    seat: BattleDrones
    system: str = ""
    usage: dict = field(default_factory=lambda: {"input": 0, "cached": 0, "output": 0, "responses": 0, "toolCalls": 0})


def _cached(details: Any) -> int:
    """Cached input tokens, wherever a provider puts them in usage details."""
    if isinstance(details, dict):
        return sum(
            (v if isinstance(v, int) and "cache" in k and "write" not in k and "creation" not in k else _cached(v))
            for k, v in details.items()
        )
    return 0


def _provider(model) -> str:
    mod = type(model).__module__
    if mod.startswith("llm.default_plugins.openai"):
        return "openai"
    return mod.split(".")[0].removeprefix("llm_").replace("_", "-")


def find_repo(start: pathlib.Path | None = None) -> pathlib.Path:
    """The battledrones checkout: next to this plugin (llm install -e), or up from the current directory."""
    here = pathlib.Path(__file__).resolve().parent.parent
    if (here / "tools" / "arena.ts").exists():
        return here
    p = (start or pathlib.Path.cwd()).resolve()
    for d in [p, *p.parents]:
        if (d / "tools" / "arena.ts").exists():
            return d
    raise click.ClickException("Can't find the battledrones repo (tools/arena.ts): pass --repo")


def http(url: str, body: dict | None = None, timeout: float = 30) -> Any:
    req = urllib.request.Request(
        url,
        data=json.dumps(body or {}).encode() if body is not None else None,
        headers={"Content-Type": "application/json"},
        method="POST" if body is not None else "GET",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read().decode()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return raw


class Battle:
    """One battle: the arena subprocess, two seats, and the round loop."""

    def __init__(
        self,
        *,
        repo: pathlib.Path,
        blue: str,
        red: str,
        options: dict[str, dict],
        map: str = "riverlands",
        seed: int = 42,
        mutators: str = "",
        round_secs: float = 5,
        max_minutes: float = 20,
        out: str = "battles",
        budget: Budget | None = None,
        echo: Callable[[str], None] = click.echo,
        verbose: bool = False,
        models: dict[str, Any] | None = None,
    ):
        self.repo = repo
        self.spec = {"blue": blue, "red": red}
        self.options = options
        self.map, self.seed, self.mutators = map, seed, mutators
        self.round_secs, self.max_minutes = round_secs, max_minutes
        self.out = out
        self.budget = budget or Budget()
        self.echo = echo
        self.verbose = verbose
        self.proc: subprocess.Popen | None = None
        self.players: dict[str, SeatPlayer] = {}
        self.urls: dict = {}
        self.record_path: pathlib.Path | None = None
        self.db = None
        self.transcript = None
        self._models = models or {}
        self._radio_seen = 0

    @staticmethod
    def is_builtin(spec: str) -> bool:
        return spec.startswith("ai:") or spec == "ai" or spec.startswith("scripted")

    def start(self) -> None:
        seat_arg = {s: (v if self.is_builtin(v) else f"seat:{v}") for s, v in self.spec.items()}
        cmd = [
            "npx", "vite-node", "tools/arena.ts", "serve", "--json", "--keep", "--quiet",
            "--port", "0", "--map", self.map, "--seed", str(self.seed),
            "--blue", seat_arg["blue"], "--red", seat_arg["red"],
            "--round", str(self.round_secs), "--max-minutes", str(self.max_minutes),
            # (the default "battles" is the repo's gitignored folder; any other path is from where you ran llm)
            "--out", self.out if self.out == "battles" else str(pathlib.Path(self.out).resolve()),
        ]
        if self.mutators:
            cmd += ["--mutators", self.mutators]
        # (vite-node directly when installed: npx would leave the server running if it were killed;
        # and a session of its own, so close() can stop the whole process group)
        local = self.repo / "node_modules" / ".bin" / "vite-node"
        if local.exists():
            cmd = [str(local), *cmd[2:]]
        self.proc = subprocess.Popen(cmd, cwd=self.repo, stdout=subprocess.PIPE, stderr=sys.stderr, text=True, start_new_session=True)
        line = self.proc.stdout.readline() if self.proc.stdout else ""
        if not line.strip():
            raise click.ClickException("The arena didn't start (see the errors above)")
        self.urls = json.loads(line)
        self.record_path = pathlib.Path(self.urls["record"])
        stem = str(self.record_path)[: -len(".json")]
        import sqlite_utils
        from llm.migrations import migrate

        self.db = sqlite_utils.Database(f"{stem}.logs.db")
        migrate(self.db)
        self.transcript = open(f"{stem}.tools.jsonl", "a", encoding="utf-8")
        for side, spec in self.spec.items():
            if self.is_builtin(spec):
                continue
            model = self._models.get(side) or llm.get_async_model(spec)
            opts = self.options.get(side, {})
            model.Options(**opts)  # (fail early on a bad -o)
            seat = BattleDrones(self.urls[side], pause_at_round_end=True)
            player = SeatPlayer(side=side, model=model, options=opts, seat=seat)
            player.system = SYSTEM.format(
                side=side,
                round_secs=self.round_secs,
                tool_calls=self.budget.tool_calls,
                briefing=seat.briefing(),
            )
            self.players[side] = player
            http(f"{self.urls['control']}/seat_info", {
                "side": side,
                "player": f"{_provider(model)}:{model.model_id}",
                "settings": {
                    "options": opts,
                    "budget": {k: v for k, v in vars(self.budget).items()},
                    "llm": _version("llm"),
                    "plugins": {p["name"]: p.get("version") for p in llm.get_plugins()},
                    "context": "fresh each round",
                },
            })

    def close(self) -> None:
        if self.transcript:
            self.transcript.close()
        if self.proc and self.proc.poll() is None:
            import signal

            try:
                os.killpg(self.proc.pid, signal.SIGTERM)
                self.proc.wait(10)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                try:
                    os.killpg(self.proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass

    def state(self) -> dict:
        return http(f"{self.urls['control']}/state")

    def log_tool(self, side: str, round_: int, tool, call, result) -> None:
        entry = {
            "t": round(time.time(), 3), "side": side, "round": round_,
            "tool": call.name, "arguments": call.arguments, "output": result.output,
        }
        if self.transcript:
            self.transcript.write(json.dumps(entry) + "\n")
            self.transcript.flush()
        if self.verbose:
            args = json.dumps(call.arguments)
            self.echo(f"  [{side}] {call.name.removeprefix('BattleDrones_')} {args[:300]}")
            out = result.output if isinstance(result.output, str) else json.dumps(result.output)
            for line in out.splitlines()[:12]:
                self.echo(f"  [{side}]   {line[:200]}")

    async def play_round(self, p: SeatPlayer, round_: int) -> str:
        """One seat's turn: a fresh chain from the observation to end_round. Returns how it ended."""
        b = self.budget
        calls = 0

        def before_call(tool, call):
            nonlocal calls
            if call.name in ROUND_TOOLS:
                # (a paused call never reaches after_call: log it here)
                self.log_tool(p.side, round_, tool, call, llm.ToolResult(name=call.name, output="(round submitted)"))
                return
            calls += 1
            if calls > b.tool_calls:
                why = f"Budget: you have used your {b.tool_calls} tool calls this round. Call BattleDrones_end_round now."
                self.log_tool(p.side, round_, tool, call, llm.ToolResult(name=call.name, output=f"Cancelled: {why}"))
                raise llm.CancelToolCall(why)

        def after_call(tool, call, result):
            p.usage["toolCalls"] += 1
            self.log_tool(p.side, round_, tool, call, result)

        usage = {"input": 0, "cached": 0, "output": 0, "responses": 0, "toolCalls": 0}
        before_calls = p.usage["toolCalls"]
        ended = "budget"
        for attempt in range(b.retries + 1):
            observation = await asyncio.to_thread(p.seat.observe)
            chain = p.model.conversation().chain(
                ROUND_PROMPT.format(observation=observation, round=round_),
                system=p.system,
                tools=[p.seat],
                chain_limit=b.chain_limit,
                before_call=before_call,
                after_call=after_call,
                options=p.options,
            )
            try:
                async for response in chain.responses():
                    await response.text()
                    u = await response.usage()
                    usage["input"] += u.input or 0
                    usage["output"] += u.output or 0
                    usage["cached"] += _cached(u.details)
                    usage["responses"] += 1
                    try:
                        response.log_to_db(self.db)  # battles/<id>.logs.db: `llm logs -d` and Datasette read it
                    except Exception as e:  # noqa: BLE001 (a log failure must not cost the round)
                        self.echo(f"  [{p.side}] couldn't log a response: {e}")
                    if b.output_tokens and usage["output"] >= b.output_tokens:
                        ended = "output budget"
                        break
                else:
                    ended = "stopped"  # the model answered without a tool call
                break
            except llm.PauseChain:
                ended = "end_round"
                break
            except ValueError as e:
                if "Chain limit" in str(e):
                    ended = "chain limit"
                    break
                raise
            except llm.CancelToolCall:
                ended = "budget"
                break
            except Exception as e:  # noqa: BLE001 (provider errors: retry with backoff, the round isn't lost)
                if isinstance(e, getattr(llm, "NeedsKeyException", ())) or attempt == b.retries:
                    self.echo(f"  [{p.side}] round {round_}: giving up after {attempt + 1} tries: {e!r}")
                    ended = "error"
                    break
                delay = 2 ** (attempt + 1)
                self.echo(f"  [{p.side}] round {round_}: {type(e).__name__}: {e}; retrying in {delay}s")
                await asyncio.sleep(delay)
        usage["toolCalls"] = p.usage["toolCalls"] - before_calls
        for k in ("input", "cached", "output", "responses"):
            p.usage[k] += usage[k]
        await asyncio.to_thread(http, f"{self.urls['control']}/usage", {"side": p.side, "round": round_, **usage})
        return ended

    async def turn(self, p: SeatPlayer, round_: int) -> tuple[str, float, dict]:
        t0 = time.monotonic()
        before = dict(p.usage)
        try:
            ended = await asyncio.wait_for(self.play_round(p, round_), self.budget.timeout)
        except asyncio.TimeoutError:
            ended = "timeout"
        st = await asyncio.to_thread(http, f"{p.seat.seat}/status", {})
        if st.get("turnOpen") and st.get("round") == round_:
            # out of budget, an error or a timeout: the seat plays the orders it gave
            await asyncio.to_thread(http, f"{p.seat.seat}/end_round", {"wait": False, "how": ended})
        spent = {k: p.usage[k] - before[k] for k in p.usage}
        return ended, time.monotonic() - t0, spent

    async def play(self) -> dict:
        """Play to the end; returns the final record."""
        if not self.players:
            # two built-in seats: the arena plays it all by itself
            while not self.state()["over"]:
                await asyncio.sleep(0.5)
        while True:
            st = await asyncio.to_thread(self.state)
            if st["over"]:
                break
            open_sides = [s for s in self.players if st[s]["turnOpen"]]
            if not open_sides:
                await asyncio.sleep(0.2)
                continue
            round_ = st["round"]
            results = await asyncio.gather(*(self.turn(self.players[s], round_) for s in open_sides))
            bits = []
            for side, (ended, secs, spent) in zip(open_sides, results):
                bits.append(f"{side} {ended} {spent['toolCalls']} calls {spent['output']} out {secs:.0f}s")
            self.echo(f"round {round_} ({st['blue']['time']}): " + "; ".join(bits))
            rec = await asyncio.to_thread(http, f"{self.urls['control']}/record")
            radio = rec.get("radio", [])
            for _tick, side, line in radio[self._radio_seen :]:
                self.echo(f"  📻 {side}: {line}")
            self._radio_seen = len(radio)
        rec = await asyncio.to_thread(http, f"{self.urls['control']}/record")
        return rec


def _version(name: str) -> str | None:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


def describe_end(rec: dict) -> str:
    end = rec.get("end") or {}
    t = end.get("tick", 0) // 10
    when = f"{t // 60}:{t % 60:02d}"
    w = end.get("winner")
    if not end:
        return "unfinished"
    if w:
        return f"{w} ({rec['seats'][w]['player']}) wins at {when}" + ("" if end.get("reason") == "hq" else f" ({end['reason']})")
    return f"{'aborted' if end.get('reason') == 'aborted' else 'draw'} at {when}"


def run_battle(**kw) -> dict:
    battle = Battle(**kw)
    try:
        battle.start()
        battle.echo(f"Battle: {battle.map} seed {battle.seed}: blue {battle.spec['blue']} vs red {battle.spec['red']}")
        battle.echo(f"  record: {battle.record_path}")
        rec = asyncio.run(battle.play())
        battle.echo(f"Result: {describe_end(rec)}")
        for side in ("blue", "red"):
            u = rec.get("usage", {}).get(side)
            if u:
                battle.echo(f"  {side} tokens: {u['input']} in ({u['cached']} cached), {u['output']} out, {u.get('toolCalls', 0)} tool calls")
        return rec
    except KeyboardInterrupt:
        try:
            http(f"{battle.urls['control']}/abort", {})
        except Exception:  # noqa: BLE001
            pass
        raise
    finally:
        battle.close()


def _opts(pairs) -> dict:
    return {k: v for k, v in pairs}


def battle_options(f):
    for opt in reversed([
        click.option("--map", "map_", default="riverlands", show_default=True, help="Map id (riverlands, proving-grounds, dune-sea, frostbite, ashlands, archipelago)"),
        click.option("--mutators", default="", help="Comma-separated mutators"),
        click.option("--round", "round_secs", type=float, default=5, show_default=True, help="Seconds of game time per round"),
        click.option("--max-minutes", type=float, default=20, show_default=True, help="Game minutes before the battle is a draw"),
        click.option("--chain-limit", type=int, default=10, show_default=True, help="Model responses per seat per round"),
        click.option("--tool-calls", type=int, default=12, show_default=True, help="Tool calls per seat per round (end_round and wait are free)"),
        click.option("--output-tokens", type=int, default=None, help="Output tokens per seat per round"),
        click.option("--timeout", type=float, default=300, show_default=True, help="Wall-clock seconds per seat per round (catches a hung request)"),
        click.option("--out", default="battles", show_default=True, help="Folder for the record, the logs database and the tool transcript"),
        click.option("--repo", type=click.Path(file_okay=False, path_type=pathlib.Path), default=None, help="The battledrones checkout"),
        click.option("-o", "--option", "both_options", type=(str, str), multiple=True, help="Model option for both seats, e.g. -o reasoning_effort low"),
        click.option("-v", "--verbose", is_flag=True, help="Print every tool call and its result"),
    ]):
        f = opt(f)
    return f


@llm.hookimpl
def register_commands(cli):
    @cli.group()
    def battledrones():
        """Agent battles in Battle Drones: models play each other through tools/arena.ts."""

    @battledrones.command()
    @click.option("--blue", required=True, help="A model id, or ai:<personality>:<difficulty>, or scripted")
    @click.option("--red", required=True, help="A model id, or ai:<personality>:<difficulty>, or scripted")
    @click.option("--blue-option", "blue_options", type=(str, str), multiple=True, help="Model option for blue")
    @click.option("--red-option", "red_options", type=(str, str), multiple=True, help="Model option for red")
    @click.option("--seed", type=int, default=42, show_default=True)
    @battle_options
    def run(blue, red, blue_options, red_options, seed, map_, mutators, round_secs, max_minutes, chain_limit, tool_calls, output_tokens, timeout, out, repo, both_options, verbose):
        """Play one battle: every round a fresh chain for each seat, both at once.

        \b
        llm battledrones run --blue gpt-6-luna --red gpt-6-luna --seed 42
        llm battledrones run --blue claude-opus-5-5 --red ai:rush:hard -o reasoning_effort low
        """
        base = _opts(both_options)
        run_battle(
            repo=repo or find_repo(), blue=blue, red=red,
            options={"blue": {**base, **_opts(blue_options)}, "red": {**base, **_opts(red_options)}},
            map=map_, seed=seed, mutators=mutators, round_secs=round_secs, max_minutes=max_minutes, out=out,
            budget=Budget(chain_limit=chain_limit, tool_calls=tool_calls, output_tokens=output_tokens, timeout=timeout),
            verbose=verbose,
        )

    @battledrones.command()
    @click.option("--a", "a", required=True, help="First player: a model id or a built-in seat")
    @click.option("--b", "b", required=True, help="Second player")
    @click.option("--a-option", "a_options", type=(str, str), multiple=True)
    @click.option("--b-option", "b_options", type=(str, str), multiple=True)
    @click.option("--maps", default="riverlands", show_default=True, help="Comma-separated map ids, or all")
    @click.option("--seeds", type=int, default=3, show_default=True, help="Seeds per map; each is played twice, sides swapped")
    @click.option("--first-seed", type=int, default=1, show_default=True)
    @battle_options
    def series(a, b, a_options, b_options, maps, seeds, first_seed, map_, mutators, round_secs, max_minutes, chain_limit, tool_calls, output_tokens, timeout, out, repo, both_options, verbose):
        """Mirror pairs: each seed on each map twice, with the sides swapped."""
        all_maps = ["proving-grounds", "riverlands", "dune-sea", "frostbite", "ashlands", "archipelago"]
        map_list = all_maps if maps == "all" else maps.split(",")
        base = _opts(both_options)
        opts = {a: {**base, **_opts(a_options)}, b: {**base, **_opts(b_options)}}
        tally = {a: 0, b: 0, "draw": 0}
        for m in map_list:
            for seed in range(first_seed, first_seed + seeds):
                for blue, red in ((a, b), (b, a)):
                    rec = run_battle(
                        repo=repo or find_repo(), blue=blue, red=red,
                        options={"blue": opts[blue], "red": opts[red]},
                        map=m, seed=seed, mutators=mutators, round_secs=round_secs, max_minutes=max_minutes, out=out,
                        budget=Budget(chain_limit=chain_limit, tool_calls=tool_calls, output_tokens=output_tokens, timeout=timeout),
                        verbose=verbose,
                    )
                    w = (rec.get("end") or {}).get("winner")
                    tally[(blue if w == "blue" else red) if w else "draw"] += 1
        click.echo(f"\n{a}: {tally[a]} wins, {b}: {tally[b]} wins, {tally['draw']} draws")

    @battledrones.command(context_settings={"ignore_unknown_options": True})
    @click.argument("args", nargs=-1, type=click.UNPROCESSED)
    @click.option("--repo", type=click.Path(file_okay=False, path_type=pathlib.Path), default=None)
    def stats(args, repo):
        """Results by model, side, map and opener, and tokens per game (tools/arena.ts stats)."""
        root = repo or find_repo()
        files = [str(pathlib.Path(a).resolve()) if not a.startswith("--") else a for a in args]
        raise SystemExit(subprocess.call(["npx", "vite-node", "tools/arena.ts", "stats", *files], cwd=root))
