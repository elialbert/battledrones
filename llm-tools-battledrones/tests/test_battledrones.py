"""Tests for llm-tools-battledrones, with no tokens spent.

The toolbox plays against a real `tools/arena.ts serve` arena (so these need
the repo's node_modules), and `llm battledrones` is driven by a stand-in model
that replays scripted tool calls. Run from llm-tools-battledrones/:

    uv run --with pytest --with-editable . pytest
"""

import json
import pathlib
import subprocess
import sys

import llm
import pytest
import sqlite_utils

import llm_tools_battledrones as bd

REPO = pathlib.Path(__file__).resolve().parents[2]
VITE_NODE = REPO / "node_modules" / ".bin" / "vite-node"

pytestmark = pytest.mark.skipif(not VITE_NODE.exists(), reason="needs the repo's node_modules (npm ci)")


@pytest.fixture
def served(tmp_path):
    """An arena with blue as an outside seat and red scripted: (urls, process)."""
    proc = subprocess.Popen(
        [str(VITE_NODE), "tools/arena.ts", "serve", "--json", "--keep", "--quiet", "--port", "0",
         "--map", "riverlands", "--seed", "3", "--blue", "seat:test", "--red", "scripted",
         "--max-minutes", "0.5", "--out", str(tmp_path)],
        cwd=REPO, stdout=subprocess.PIPE, text=True,
    )
    urls = json.loads(proc.stdout.readline())
    yield urls
    proc.terminate()
    proc.wait(10)


def test_tools_listed():
    names = sorted(t.name for t in bd.BattleDrones("http://127.0.0.1:1/seat/x").tools())
    assert names == [
        "BattleDrones_briefing", "BattleDrones_end_round", "BattleDrones_look",
        "BattleDrones_observe", "BattleDrones_orders", "BattleDrones_wait",
    ]
    orders = next(t for t in bd.BattleDrones("http://x").tools() if t.name == "BattleDrones_orders")
    assert orders.input_schema["properties"]["orders"]["type"] == "array"
    # the arena driver puts the briefing in the system prompt instead
    assert "BattleDrones_briefing" not in [t.name for t in bd.BattleDrones("http://x", pause_at_round_end=True).tools()]


def test_toolbox_plays_a_seat(served):
    seat = bd.BattleDrones(served["blue"])
    assert "briefing for the BLUE commander" in seat.briefing()
    assert "ROUND 0: CHOOSE YOUR OPENER" in seat.observe()
    assert seat.orders([{"opener": "blitz"}]) == "1. ok: opener blitz"
    # end_round waits for the round to play, then returns the next observation
    nxt = seat.end_round("blitz, then raid their harvesters", "Stingers rolling")
    assert "ROUND 1/6" in nxt and "stinger ×3" in nxt
    assert "refused" in seat.orders([{"produce": "mortar"}])
    assert "LOOK around" in seat.look(8, 46, 4)
    out = seat.wait(2)
    assert "Waiting 2 rounds" in out and "ROUND 3/6" in out
    while "THE BATTLE IS OVER" not in out:
        out = seat.end_round("")
    assert "DRAW" in out


def test_pause_at_round_end(served):
    seat = bd.BattleDrones(served["blue"], pause_at_round_end=True)
    seat.orders([{"opener": "airwing"}])
    with pytest.raises(llm.PauseChain):
        seat.end_round("notes")
    status = bd.http(f"{served['blue']}/sync", {})
    assert status["round"] == 1 and status["turnOpen"]


class StandIn(llm.AsyncModel):
    """A stand-in model: plays a scripted turn each round, through real tool calls."""

    model_id = "stand-in"
    can_stream = True
    supports_tools = True

    def __init__(self, turn=None, end=True):
        self.turn = turn or (lambda prompt: [{"attack_move": "army", "to": "enemy-hq"}])
        self.end = end
        self.prompts = []

    async def execute(self, prompt, stream, response, conversation):
        self.prompts.append(prompt)
        results = prompt.tool_results or []
        response.set_usage(input=1000, output=50, details={"input_tokens_details": {"cached_tokens": 800}})
        if not results:
            text = prompt.prompt or ""
            orders = [{"opener": "airwing"}] if "CHOOSE YOUR OPENER" in text else self.turn(text)
            response.add_tool_call(llm.ToolCall(name="BattleDrones_orders", arguments={"orders": orders}))
            yield "Giving orders."
        elif self.end:
            response.add_tool_call(llm.ToolCall(name="BattleDrones_end_round", arguments={"notes": "stand-in notes", "radio": "Beep."}))
            yield "Ending the round."
        else:
            response.add_tool_call(llm.ToolCall(name="BattleDrones_observe", arguments={}))
            yield "Looking again."


def battle(tmp_path, blue, red, **kw):
    lines = []
    rec = bd.run_battle(
        repo=REPO, blue="stand-in", red="stand-in" if isinstance(red, StandIn) else red,
        options={}, map="riverlands", seed=5, max_minutes=0.5, out=str(tmp_path),
        budget=bd.Budget(**kw), echo=lines.append,
        models={"blue": blue, **({"red": red} if isinstance(red, StandIn) else {})},
    )
    return rec, lines


def test_llm_battledrones_plays_a_battle(tmp_path):
    blue, red = StandIn(), StandIn()
    rec, lines = battle(tmp_path, blue, red)
    assert rec["end"] == {"tick": 300, "winner": None, "reason": "time"}
    assert rec["openers"] == {"blue": "airwing", "red": "airwing"}
    assert rec["seats"]["blue"]["player"].endswith(":stand-in")
    assert rec["seats"]["blue"]["settings"]["context"] == "fresh each round"
    # every round: orders then end_round, two responses, usage counted
    blue_log = [l for l in rec["log"] if l["side"] == "blue"]
    assert [l["round"] for l in blue_log] == [0, 1, 2, 3, 4, 5, 6]
    assert all(l["ended"] == "end_round" and l["notes"] == "stand-in notes" for l in blue_log)
    assert blue_log[1]["orders"] == [{"attack_move": "army", "to": "enemy-hq"}]
    assert rec["usage"]["blue"] == {"input": 14000, "cached": 11200, "output": 700, "responses": 14, "toolCalls": 7}
    assert rec["radio"][0][2] == "Beep."
    # a fresh context each round: the same system prompt, the round's observation as the prompt
    assert all(p.system == blue.prompts[0].system for p in blue.prompts)
    assert "briefing for the BLUE commander" in blue.prompts[0].system
    assert "ROUND 3/6" in blue.prompts[6].prompt
    # the logs database and the tool transcript
    stem = rec_path(tmp_path)
    db = sqlite_utils.Database(f"{stem}.logs.db")
    logged = subprocess.run([sys.executable, "-m", "llm", "logs", "-d", f"{stem}.logs.db", "-n", "0", "--json"], capture_output=True, text=True)
    assert len(json.loads(logged.stdout)) == 28
    assert db["turns"].count >= 14
    tools = [json.loads(l) for l in open(f"{stem}.tools.jsonl")]
    assert {t["tool"] for t in tools} == {"BattleDrones_orders", "BattleDrones_end_round"}
    assert any("Result: draw at 0:30" in l for l in lines)


def test_a_seat_out_of_budget_plays_what_it_ordered(tmp_path):
    # never ends its round: keeps calling observe until the chain limit
    looper = StandIn(end=False)
    rec, lines = battle(tmp_path, looper, "ai:balanced:easy", chain_limit=3, tool_calls=12)
    assert rec["end"]["reason"] == "time"
    blue_log = [l for l in rec["log"] if l["side"] == "blue"]
    assert all(l["ended"] == "chain limit" for l in blue_log)
    assert blue_log[2]["results"][0].startswith("1. ok:") and "attack-move to 50,6" in blue_log[2]["results"][0]
    assert rec["usage"]["blue"]["responses"] == 7 * 3


def test_tool_call_budget(tmp_path):
    looper = StandIn(end=False)
    rec, _ = battle(tmp_path, looper, "scripted", chain_limit=6, tool_calls=2)
    tools = [json.loads(l) for l in open(f"{rec_path(tmp_path)}.tools.jsonl")]
    assert any(t["output"].startswith("Cancelled: Budget") for t in tools)


def rec_path(tmp_path):
    rec = next(p for p in tmp_path.glob("*.json"))
    return str(rec)[: -len(".json")]
