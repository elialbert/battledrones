# RTS lockstep under low bandwidth and high latency: player tolerance, turn/delay control, command-stream bandwidth, desync checks, alternatives, and design patterns

Scope note: these notes cover published RTS latency studies, shipped and open-source lockstep engines, and lockstep networking articles. Battle Drones figures used for comparison come from the brief (AI ~92 orders/min/side, scripted "decent" player ~28/min, 25–30 bits/order, 12–45 bit/s average, 300–900 bit bursts in fights) and from the repo's `MULTIPLAYER.md` (one turn = one 100 ms tick, D = 2–6 ticks, checksum every 10 ticks, stalls under 500 ms show nothing). Primary sources were read directly where possible: the 1500 Archers article PDF, the Claypool WPI tech report, 0 A.D./OpenRA/Spring source, Brood War replay command tables, and the SkillCraft dataset (APM computed here from the raw CSV).

## 1. How much command latency do RTS players tolerate?

### Takeaway
Across Age of Empires' internal testing (1996–2001) and the WPI studies (2003–2005), RTS command latency under ~250 ms goes unnoticed, 250–500 ms is "very playable", 500–1000 ms is noticeable but players adapt, and above ~1000 ms play feels difficult. Even so, latencies up to 3.5 s barely changed match outcomes in controlled tests. Players also tolerate a steady delay much better than a varying one. A 1–3 s acoustic delay would be clearly felt, but the evidence says it can stay playable if it is constant and the game is paced for it.

### Cited Findings
- **Age of Empires internal testing (Bettner & Terrano, GDC 2001, published on Gamasutra 22 March 2001).** "For RTS games, 250 milliseconds of command latency was not even noticed -- between 250 and 500 msec was very playable, and beyond 500 it started to be noticeable." — [1500 Archers on a 28.8 (PDF of Gamasutra article)](https://web.cs.wpi.edu/~claypool/courses/4513-B03/papers/games/aoe.pdf); [Game Developer reprint](https://www.gamedeveloper.com/programming/1500-archers-on-a-28-8-network-programming-in-age-of-empires-and-beyond)
- **Consistency beats speed (same source).** Players "developed a 'game pace' and a mental expectation of the lag between when they clicked and when their unit responded." A steady 500 ms "was playable", while latency swinging between 80 and 500 ms "was considered 'jerky' and hard to use." The team concluded "it was better to pick a longer turn length and be certain that everything stayed smooth and consistent than to run as quickly as possible with occasional slow-downs." — [1500 Archers PDF](https://web.cs.wpi.edu/~claypool/courses/4513-B03/papers/games/aoe.pdf)
- **AoE's design target and conditions.** AoE targeted a 16 MB Pentium 90 with a 28.8 modem, 8 players, and 15 fps. The netcode had to survive "Internet ... latency swings of 20 to 1,000 milliseconds." — [1500 Archers PDF](https://web.cs.wpi.edu/~claypool/courses/4513-B03/papers/games/aoe.pdf)
- **Warcraft III study (Sheldon, Girard, Borg, Claypool, Agu; ACM NetGames, May 2003; best paper award).** Exploration showed modest correlation with latency, building and combat very weak correlation. "The effect of even very high latency, while noticeable to users, has a negligible effect on the outcome of the game." — [WPI project page](https://web.cs.wpi.edu/~claypool/papers/war3); [ISR summary](https://isr.uci.edu/node/1299.html)
- **Extended study across three RTS games (Claypool, WPI-CS-TR-03-32, 2003; journal version in *Computer Networks* 49(1), 2005).** Games: Warcraft III, Age of Mythology, and Command & Conquer: Generals. Latency was induced with NIST Net on one player, "ranging from 0 to 3500 ms", with most data points below 1000 ms. Finding: "latencies up to several seconds have little effect on the final outcomes of building, exploration, and most combat." — [Claypool tech report PDF](https://ftp.cs.wpi.edu/pub/techreports/pdf/03-32.pdf); [bib entry, Computer Networks 2005](https://ftp.math.utah.edu/pub/tex/bib/idx/compnetamsterdam2000/49/1/52_70.html)
  - Warcraft III building: up to 3.5 s of latency added at most 14 s to an ~8-minute tech-tree build (<1%), R² = 0.05. — [same PDF](https://ftp.cs.wpi.edu/pub/techreports/pdf/03-32.pdf)
  - Warcraft III exploration: about +6 s of exploration time per 100 ms of latency, called "insignificant in a real game." AoM: about +2 s per 100 ms (R² 0.79). C&C Generals: R² 0.09. — [same PDF](https://ftp.cs.wpi.edu/pub/techreports/pdf/03-32.pdf)
  - Warcraft III combat: R² of score difference vs latency "an extremely low 0.01". Going from 0 to 1 s of latency cost "only about one unit". — [same PDF](https://ftp.cs.wpi.edu/pub/techreports/pdf/03-32.pdf)
  - Warcraft III perception: delays became perceptible approaching 500 ms but were "relatively easy to estimate ... and react accordingly". Above 800 ms "the game appeared erratic". The point of perceived degradation "was between 500 ms and 800 ms but varied from person to person", and players who micro-managed combat were more sensitive than those who micro-managed building. — [same PDF](https://ftp.cs.wpi.edu/pub/techreports/pdf/03-32.pdf)
  - AoM and C&C Generals perception: under 500 ms "not noticeable". From 500 to about 1000 ms delays were "perceptible, although it was relatively easy to estimate this delay and react accordingly". Play "was not perceptibly difficult until induced latencies were above 1000 ms." — [same PDF](https://ftp.cs.wpi.edu/pub/techreports/pdf/03-32.pdf)
  - Behaviour change: above 500 ms, players stopped splitting armies into flanking groups and "kept their army in at most two or often even one group." — [same PDF](https://ftp.cs.wpi.edu/pub/techreports/pdf/03-32.pdf)
  - Conclusion: "Since RTS user strategies take seconds or even minutes to carry out, the effects of typical network latencies (less than a second) do not impact the overall outcome." — [same PDF](https://ftp.cs.wpi.edu/pub/techreports/pdf/03-32.pdf)
- **Genre thresholds (Claypool & Claypool, "Latency Can Kill: Precision and Deadline in Online Games", ACM MMSys 2010).** RTS falls in the "Omnipresent" interaction model. The paper summarises prior thresholds: 500 ms gives measurable degradation for third-person avatar games, and "A latency of 1000 milliseconds is considered quite high for most games and provides noticeable degradation to third person avatar games and even to omnipresent games." Actions with loose deadlines and low precision, such as RTS troop selection, are "resilient to even high Internet latencies." — [Latency Can Kill PDF](https://sites.cs.ucsb.edu/~almeroth/classes/W10.290F/papers/claypool-10.pdf)
- **Shipped RTS command-delay settings.**
  - 0 A.D.'s current source uses `DEFAULT_TURN_LENGTH = 200` ms and `COMMAND_DELAY_MP = 4` turns, so a multiplayer command lands 3–4 turns (about 600–800 ms) after issue. Single-player uses `COMMAND_DELAY_SP = 1`. — [0 A.D. TurnManager.h](https://github.com/0ad/0ad/blob/master/source/simulation2/system/TurnManager.h)
  - Brood War latency settings, in game frames per BWAPI: SinglePlayer 2, LanLow 5, LanMedium 7, LanHigh 9, BattlenetLow 14, BattlenetMedium 19, BattlenetHigh 24. — [BWAPI Latency.h](https://pages.cs.wisc.edu/~starr/bwapi-read-only/html/BWAPI_2Source_2BW_2Latency_8h_source.html); [BWAPI-Lua docs](https://bwapi-lua.readthedocs.io/en/latest/api/BWAPI/data/Latency.html)
  - In Brood War, latency means "the maximum delay between the frame a command gets issued and the frame that command gets executed". Commands issued anywhere in a multi-frame "turn" all execute together. — [TL.net, imp42, 7 March 2017](https://tl.net/blogs/519872-towards-a-good-sc-bot-p56-latency)

### Inferences
- A practical scale for the acoustic link: ≤500 ms feels normal; 500–1000 ms is noticeable but fine; 1–1.5 s is a "slow-paced mode" that needs design support; 2–3 s is still outcome-neutral by the WPI data but clearly felt, and it will push players into one-blob armies with little micro.
- Shipped online RTS games already ran at 0.6–1 s command delay. 0 A.D. multiplayer runs at 600–800 ms. Brood War's Battle.net presets are 14–24 frames, which would be roughly 0.6–1 s if a frame on "Fastest" is about 42 ms; that frame duration is unverified (see Gaps). Battle Drones' D = 2–6 ticks (200–600 ms) is at the tight end, so an acoustic mode at 1 s or more is a real step down but still within the range the studies call playable.
- The strongest design rule is to pick a fixed, conservative delay and hold it. Players adapt to a steady 1 s far better than to a delay that wanders between 0.3 and 1.5 s as acoustic frames get lost and retried.

### Gaps
- I did not retrieve the full text of Claypool & Claypool, "Latency and Player Actions in Online Games", *Communications of the ACM* 49(11), November 2006. Its per-genre thresholds (often summarised as FPS ~100 ms, third-person ~500 ms, RTS/omnipresent ~1000 ms) are cited here only through the 2010 MMSys paper's summary.
- I found no study of RTS latency tolerance above ~3.5 s, none on touch-screen or phone RTS, and none on players who can see that the link is slow (for example a visible "radio" metaphor), which might change perceived tolerance.
- I could not find a primary source for the length of a Brood War frame at "Fastest" (often quoted as ~42 ms), so the frame-to-millisecond conversion above is unverified.

## 2. Adaptive turn length, input delay, and stall handling

### Takeaway
AoE adapted its turn length every turn from measured round-trip time and the slowest machine's frame rate. The turn length rose quickly on latency spikes and came back down only a few milliseconds per turn. Open-source engines mostly use a fixed command delay: 0 A.D. uses 4 turns of 200 ms, and OpenRA uses an OrderLatency that it scales with game speed. All of them stall the simulation when a peer's turn has not arrived. OpenRA can batch several simulation frames into one network packet "at the expense of input latency", which is exactly the lever a low-rate link needs.

### Cited Findings
- **AoE "communications turns".** Commands issued during turn 1000 execute in turn 1002. Turns "were typically 200 msec in length". Communication turns were separate from rendering and simulation frames. — [1500 Archers PDF](https://web.cs.wpi.edu/~claypool/courses/4513-B03/papers/games/aoe.pdf)
- **AoE "Speed Control".**
  - Each client averaged its processing time to estimate a sustainable frame rate. It also measured ping to every peer and reported the longest average with each "Turn Done" message, using a "Total of 2 bytes ... for speed control."
  - The host set a new frame rate and turn length each turn. The turn length "was roughly the round-trip ping time for a message", divided into as many sim frames as the slowest machine could manage.
  - It "was weighted so it would quickly rise to handle Internet latency changes, and slowly settle back down", adjusting "only a few milliseconds per turn."
  — [1500 Archers PDF](https://web.cs.wpi.edu/~claypool/courses/4513-B03/papers/games/aoe.pdf)
- **Two causes of AoE stalls.** One machine's frame rate drops and the others "end up waiting for the next turn -- even tiny stops are immediately noticeable". Or "Internet latency and lost data packets" leave players waiting for data to complete the turn. — [1500 Archers PDF](https://web.cs.wpi.edu/~claypool/courses/4513-B03/papers/games/aoe.pdf)
- **AoE transport.** UDP with its own ordering and resends. Each message carried "a couple of bytes to identify the turn that execution was scheduled and the sequence number". Messages for past turns were discarded. "When in doubt, assume it dropped": receivers sent resend requests as soon as they saw a gap, and senders resent proactively when an ack was later than predicted. — [1500 Archers PDF](https://web.cs.wpi.edu/~claypool/courses/4513-B03/papers/games/aoe.pdf)
- **0 A.D. (current source).**
  - Clients "can only compute turn N if all clients have finished sending commands for it". "If a client reaches turn CURRENT_TURN + COMMAND_DELAY - 1, it'll freeze while waiting for commands."
  - The delay is fixed at 4. A TODO notes "this command-delay could vary based on server-client pings."
  - The catch-up logic stops "fast forwarding after 2 turn lengths" to keep the game playable. Another TODO reads "send feedback to the server to increase the turn length."
  — [TurnManager.h](https://github.com/0ad/0ad/blob/master/source/simulation2/system/TurnManager.h); [TurnManager.cpp](https://github.com/0ad/0ad/blob/master/source/simulation2/system/TurnManager.cpp)
- **OpenRA game speeds (`mods/ra/mod.yaml`, bleed branch).** Timestep / OrderLatency pairs: slowest 80 ms / 2, slower 50 / 3, default 40 / 3, fast 35 / 4, faster 30 / 4, fastest 20 / 6. — [OpenRA mod.yaml](https://github.com/OpenRA/OpenRA/blob/bleed/mods/ra/mod.yaml)
- **OpenRA OrderManager.**
  - The client ticks only when every client's packet for the net frame has arrived (`IsReadyForNextFrame => ... pendingOrders.All(p => p.Value.Count > 0)`).
  - "We expect every frame to have a queued order packet, even if it contains no orders."
  - "The server may request clients to batch multiple frames worth of orders into a single packet to improve robustness against network jitter at the expense of input latency" (`IsNetFrame => LocalFrameNumber % NetFrameInterval == 0`).
  — [OpenRA OrderManager.cs](https://github.com/OpenRA/OpenRA/blob/bleed/OpenRA.Game/Network/OrderManager.cs)
- **Brood War turns.** Commands issued during any frame of a turn all execute together at the turn boundary. For example, with latency 6 and turn size 2, commands from frames 0 and 1 both execute on frame 6. — [TL.net, 2017](https://tl.net/blogs/519872-towards-a-good-sc-bot-p56-latency)
- **Playout (jitter) buffer.** Gaffer On Games' lockstep demo (Glenn Fiedler, 29 November 2014) records the local receive time of the first input and plays each frame's input at that time + 100 ms. If an input is missing, the simulation waits. If inputs bunch up, it runs at most 4 sim frames per render frame "to avoid the spiral of death." Fiedler notes that a real implementation needs clock-drift handling and adaptivity. — [Gaffer On Games: Deterministic Lockstep](https://gafferongames.com/post/deterministic_lockstep/)

### Inferences
- Communication turn and simulation tick should be separate concepts, as in AoE, 0 A.D. and OpenRA's NetFrameInterval. Battle Drones can keep its 10 Hz sim but use a comm turn of N ticks; for example N = 5 gives a 500 ms comm turn and 2 frames/s per side.
  - Commands issued during comm turn T execute at the first tick of turn T + k. The sim then needs only one frame per comm turn, not one per tick.
  - This removes the "one frame every 100 ms even when empty" overhead, which on an acoustic link probably costs more than the orders themselves.
- Size the acoustic input delay from measured frame airtime plus decode time plus a retry margin, then hold it fixed for the match. Follow AoE's asymmetry: raise the delay immediately when frames are late, and lower it only very slowly, a few ms per turn or only at agreed turn boundaries.
- On a half-duplex speaker/mic link, "stall until the peer's turn arrives" will be the main failure mode. OpenRA's "batch frames at the cost of latency" and Gaffer's playout buffer both show that a deliberate extra buffer is the standard answer to jitter.

### Gaps
- I found no published turn-length or RTT telemetry from AoE2 or later Ensemble games beyond the 2001 article.
- From the yaml alone I could not confirm whether OpenRA's OrderLatency counts net frames or sim ticks. The products Timestep × OrderLatency stay within 120–160 ms across speeds, which suggests the wall-clock delay is held roughly constant, scaled by NetFrameInterval.

## 3. Reducing command-stream bandwidth, and published per-player bandwidth figures

### Takeaway
Classic RTS lockstep used single-digit kbps per player: Warcraft III ~4 kbps on Battle.net, StarCraft ~5 kbps for 2 players, AoM ~10–12 kbps, C&C Generals ~4.5–10 kbps, all including IP headers. Most of that is per-packet overhead, not commands. When latency rose, Warcraft III packed more commands into fewer packets and its bitrate fell about 4× while the command payload stayed the same. Engines cut command size by sending the selection separately from the order (Brood War, Spring) and by filtering repeat clicks (AoE). Human command rates are low: AoE players averaged one command every 1.5–2 s, with spikes of 3–4/s.

### Cited Findings
- **Warcraft III traffic (Claypool TR-03-32, 2003; bitrates include IP headers, 500 ms bins).**
  - Mean bitrate: LAN 1v1 6.8 kbps, Battle.net 1v1 3.8 kbps, Battle.net 2v2 4.0 kbps.
  - Median payload "only 9 bytes", with 6 and 9 bytes the most common sizes and under 1% above 40 bytes. Packets were most often 46 or 49 bytes including headers.
  - Mean inter-packet time: ~104 ms on LAN; ~201 ms incoming and ~160–165 ms outgoing on Battle.net.
  - "StarCraft ... has a bitrate of about 5 Kbps for a 2 player game" with typical packets of 122 and 132 bytes.
  — [Claypool TR PDF](https://ftp.cs.wpi.edu/pub/techreports/pdf/03-32.pdf)
- **Latency causes aggregation (Warcraft III combat traces at 0 / 500 / 1000 ms added latency).**
  - Packet counts were 1886 / 550 / 255, so 500 ms and 1000 ms latency sent "only about 1/3rd and 1/8th as many packets".
  - Bitrate was 7.2 / 2.3 / 2.1 kbps, about 1/4 at 500 ms and above.
  - Median payload grew from 9 to 30 to 60 bytes.
  - The sum of command payloads was 45.2 / 46.3 / 45.0 KB after subtracting an assumed 6-byte per-packet application overhead. "The commands issued by users are very similar, regardless of the network latency."
  — [Claypool TR PDF](https://ftp.cs.wpi.edu/pub/techreports/pdf/03-32.pdf)
- **Age of Mythology and C&C Generals traffic.**
  - AoM: 11.7 kbps at no added latency, 11.9 kbps at 500 ms, 10.2 kbps at 1000 ms. Median payload ~18 bytes, independent of latency.
  - C&C Generals: 9.7 kbps at no added latency, 5.0 at 500 ms, 4.5 at 1000 ms. Payloads were 30–40 bytes, 5% over 100 bytes, and grew with latency "most likely due to command aggregation at the application level."
  — [Claypool TR PDF](https://ftp.cs.wpi.edu/pub/techreports/pdf/03-32.pdf)
- **AoE command rates and the repeat-click filter.**
  - Players issued commands "averaging about every 1.5 to 2 seconds, with occasional spikes of 3 to 4 commands per second during heated battles". The heaviest load came mid and late game.
  - Excited repeat-clicking ("clik-lik-lik-lik-lik -- go go go") caused huge command spikes, and large network spikes when a big group was being pathed. "A simple filter to discard repeat commands at the same location drastically reduced the impact."
  — [1500 Archers PDF](https://web.cs.wpi.edu/~claypool/courses/4513-B03/papers/games/aoe.pdf)
- **Why AoE sends commands, not state.** Synchronising per-unit state would have capped the game at about 250 moving units on the target modem, which is why AoE chose lockstep "send commands" networking. — [Game Developer reprint](https://www.gamedeveloper.com/programming/1500-archers-on-a-28-8-network-programming-in-age-of-empires-and-beyond)
- **Brood War command set: selection is its own command.** Replay/network command types include `Select` (0x09), `SelectAdd` (0x0a), `SelectRemove` (0x0b), `Hotkey` (0x13), `RightClick` (0x14), `TargetedOrder` (0x15), `Train` (0x1f), `Stop` (0x1a), `HoldPosition` (0x2b), `KeepAlive` (0x05) and `Sync` (0x37). — [icza/screp repcmd/types.go](https://github.com/icza/screp/blob/master/rep/repcmd/types.go)
- **Spring RTS protocol: selection is also separate.**
  - `SendSelect(playerNum, std::vector<int16_t> selectedUnitIDs)` sends `NETMSG_SELECT`, 2 bytes per unit id.
  - `SendCommand(playerNum, commandID, timeout, options, numParams, const float* params)` sends `NETMSG_COMMAND` (int32 id, int32 timeout, uint8 options, float32 params).
  - AI commands use separate `NETMSG_AICOMMAND`/`NETMSG_AICOMMANDS` messages.
  - `NETMSG_NEWFRAME` is 1 byte and `NETMSG_KEYFRAME` is 5 bytes. The server marks "every n'th frame" as a keyframe with n = 16, and `GAME_SPEED = 30` sim frames/s.
  — [Spring BaseNetProtocol.h](https://github.com/spring/spring/blob/develop/rts/Net/Protocol/BaseNetProtocol.h); [BaseNetProtocol.cpp](https://github.com/spring/spring/blob/develop/rts/Net/Protocol/BaseNetProtocol.cpp); [GameServer.cpp](https://github.com/spring/spring/blob/develop/rts/Net/GameServer.cpp); [GlobalConstants.h](https://github.com/spring/spring/blob/develop/rts/Sim/Misc/GlobalConstants.h)
- **Human action rates (StarCraft II, SkillCraft dataset).** The SkillCraft1 dataset (Thompson, Blair, Chen & Henrey, *PLoS ONE* 2013; 3,395 replays) gives these mean (median) APM by league, computed here from the raw CSV: Bronze 60 (54), Silver 75 (72), Gold 90 (86), Platinum 106 (104), Diamond 132 (126), Master 159 (152), GrandMaster 190 (185), Professional 267 (274). — [UCI SkillCraft1 dataset](https://archive.ics.uci.edu/dataset/272/skillcraft1+master+table+dataset). The dataset also records hotkey selects and assigns as separate features, so APM includes selection and hotkey actions, not only orders. — [same dataset](https://archive.ics.uci.edu/dataset/272/skillcraft1+master+table+dataset); [TL.net SkillCraft data thread](https://tl.net/forum/starcraft-2/437594-skillcraft-project-data-is-available)
- **Compact input encoding with redundancy (Gaffer On Games, 2014).**
  - Each input is 6 bits. Every packet carries all unacked inputs: a sequence number, the oldest input, a count, then 1 bit per input that equals the previous one and 7 bits per input that differs.
  - The worst case of 120 unacked inputs is 720 bits ("only 90 bytes").
  — [Gaffer On Games](https://gafferongames.com/post/deterministic_lockstep/)

### Inferences
- **Battle Drones' command volume is in line with real play, not unusually high.** The 28/min "decent player" matches AoE's average of one command per 1.5–2 s (30–40/min). The AI's 92/min resembles Gold-to-Platinum SC2 APM, though SC2 APM also counts selections and camera hotkeys. At 25–30 bits/order the averages (12–45 bit/s) are tiny, so the hard problems are bursts and per-frame overhead.
- **Splitting selection from orders cuts unit-id lists to roughly one occurrence per selection change.** Battle Drones orders currently embed unit id lists. Brood War and Spring both send the selection once and reference it from each order. A deterministic "current selection" or numbered group on the receiver, kept in lockstep because it is updated by the same command stream, would do the same.
  - Variants: "same selection as last order" (1 bit), "group slot g" (2–3 bits for up to 4–8 control groups), and "add/remove these ids" deltas, mirroring Brood War's SelectAdd/SelectRemove.
  - The selection state must be part of the deterministic per-player state, otherwise it can desync.
- **Coalesce superseded orders at the sender before transmitting.** If a move for the same selection is issued again before the frame leaves, only the last one matters. This generalises AoE's repeat-click filter and is likely the biggest lever on the 300–900 bit bursts during fights, which are mostly re-issued move and attack orders.
  - Also drop orders the sim would treat as no-ops: same target, already executing, or position within a small radius of the last one.
  - Quantise positions to a coarse grid, for example 6–8 bits per axis instead of full x/y.
- **Fewer, larger frames work best on a high-overhead channel.** Warcraft III's latency-driven aggregation (≈4× less bitrate for the same command payload) is the internet version of what an acoustic link needs, where every frame pays preamble, sync and FEC overhead.
  - Use one frame per multi-tick comm turn, and an extremely short "empty, through turn N" frame when idle.
- **Priority and rate limiting under bursts.** When the queue exceeds the frame budget, send at most M orders per comm turn. Prioritise production, building and calldown, which are not idempotent and must not be lost, over refreshed move/attack orders, which can be coalesced. Spill the rest into the next turn, which raises those orders' latency but keeps the lockstep cadence.

### Gaps
- I did not find published per-player bandwidth figures for AoE2 (1999 or DE), StarCraft II, 0 A.D., or OpenRA. Commonly quoted "1–4 kbps" style figures for AoE2 could not be verified from a primary source.
- The Claypool StarCraft figure (~5 kbps, 122/132-byte packets) is itself cited from an earlier paper ([8] in the TR), which I did not retrieve.
- I did not measure the actual byte sizes of 0 A.D. command serialisation (JS objects) or OpenRA's order packets.

## 4. Cost of desync detection

### Takeaway
Engines typically send a 32-bit checksum quite often. OpenRA sends one every net frame; Spring sends a 10-byte sync-response message containing a 32-bit checksum. 0 A.D. computes a cheap hash every turn and a full-state hash every 20 turns. On a starved link, a 16–32-bit hash every few seconds is enough to detect a desync, because a desync persists and diverges, so it will not escape many checks in a row.

### Cited Findings
- **OpenRA.** Each processed net frame calls `Connection.SendSync(NetFrameNumber, World.SyncHash(), defeatState)`. `SyncHash` is an `int` (32 bits) and `defeatState` a `ulong` bitmask. A mismatch for the same frame triggers `OutOfSync(frame)` and a sync report dump. — [OpenRA OrderManager.cs](https://github.com/OpenRA/OpenRA/blob/bleed/OpenRA.Game/Network/OrderManager.cs)
- **Spring.** `NETMSG_SYNCRESPONSE` is a fixed 10-byte message (type, playerNum, int32 frameNum, uint32 checksum). The server uses `SYNCCHECK_TIMEOUT = 300` frames (10 s at 30 fps) before treating a missing response as a problem, and `SYNCCHECK_MSG_TIMEOUT = 400` frames between warnings. — [BaseNetProtocol.cpp](https://github.com/spring/spring/blob/develop/rts/Net/Protocol/BaseNetProtocol.cpp); [GameServer.cpp](https://github.com/spring/spring/blob/develop/rts/Net/GameServer.cpp)
- **0 A.D.** `TurnNeedsFullHash` returns true on turn 1 ("Check immediately for errors caused by e.g. inconsistent game versions") and then when `turn % 20 == 0`, described as "check the full state every ~10 seconds in multiplayer games". Other turns use "a quick less-complete hash". A TODO suggests removing the full hash once the game is stable "since the full hash is still pretty slow." — [TurnManager.cpp](https://github.com/0ad/0ad/blob/master/source/simulation2/system/TurnManager.cpp); [TurnManager.h](https://github.com/0ad/0ad/blob/master/source/simulation2/system/TurnManager.h)
- **AoE.** AoE "check-summed the world, the objects, the pathfinding, targeting and every other system". Any divergent simulation was tagged out of sync "and the game stopped". Small causes (a deer placed slightly differently) surfaced minutes later as different food totals, and tracing them took 50 MB message traces. — [1500 Archers PDF](https://web.cs.wpi.edu/~claypool/courses/4513-B03/papers/games/aoe.pdf)
- **Brood War.** The command stream includes a `Sync` command type (0x37). — [screp types.go](https://github.com/icza/screp/blob/master/rep/repcmd/types.go)

### Inferences
- **Battle Drones' current plan costs too much for the acoustic link.** A 32-bit hash every 10 ticks is 32 bit/s per side, which is as large as or larger than the whole average order payload (12–45 bit/s).
  - Option 1: a 16-bit hash every 50 ticks (5 s) costs 3.2 bit/s.
  - Option 2: an 8-bit hash every 20 ticks costs 4 bit/s.
- **Why short hashes are enough.** A desync is permanent, and the states diverge further over time. The probability that a b-bit hash misses k consecutive checks is about 2^(−b·k): for 16 bits that is ~1.5×10⁻⁵ for one check and ~2×10⁻¹⁰ for two. Detection latency is what grows, not the miss rate.
- **Piggyback and stagger.** Only send the checksum inside frames already being sent, as Spring and OpenRA do. Stagger which tick each side hashes so each frame carries at most one hash.
- **Use a cheap and a full hash.** Copy 0 A.D.'s two-tier scheme: a cheap rolling hash (unit count, positions, HP) often, and a full-state hash rarely (for example every 30–60 s) or only at match end. The match-end `over { winner, tick, checksum }` already in MULTIPLAYER.md fits this.
- **Recovery without a server.** Over an acoustic link there is no server to resync from. In practice desync handling will be "detect and declare no contest", so detection latency of tens of seconds is acceptable.

### Gaps
- I did not find any published analysis of the minimum checksum size or interval for RTS lockstep. The values above are engineering inference.
- I could not confirm from source how often Spring clients send `SYNCRESPONSE` (every frame or every keyframe), or what hash algorithm and size 0 A.D. uses in its sync messages.

## 5. Alternatives to strict per-tick lockstep for very low bandwidth

### Takeaway
The proven low-bandwidth pattern is still lockstep, with three changes: longer communication turns that batch many sim ticks (AoE 200 ms turns, 0 A.D. 200 ms, OpenRA NetFrameInterval), redundant resend of unacked turns (Gaffer), and frames that carry only changes. Rollback has reached one commercial RTS (Stormgate, announced August 2023, 64 Hz), but it needs cheap re-simulation and hides latency only visually. With 1–3 s link latency it would mean re-simulating 10–30 ticks per correction and visibly snapping units, so it looks a poor fit here.

### Cited Findings
- **Lockstep needs no per-unit traffic.** AoE's lockstep keeps network traffic independent of unit count, allowing "1500 archers on a 28.8". The alternative of per-unit state would cap the game near 250 moving units. — [Game Developer reprint](https://www.gamedeveloper.com/programming/1500-archers-on-a-28-8-network-programming-in-age-of-empires-and-beyond); [1500 Archers PDF](https://web.cs.wpi.edu/~claypool/courses/4513-B03/papers/games/aoe.pdf)
- **Batching ticks per packet.** OpenRA's server can ask clients to batch several frames of orders per packet "to improve robustness against network jitter at the expense of input latency." Every net frame still requires a packet, even an empty one. — [OpenRA OrderManager.cs](https://github.com/OpenRA/OpenRA/blob/bleed/OpenRA.Game/Network/OrderManager.cs)
- **Redundant inputs instead of request/resend.**
  - Sending all unacked inputs in every packet kept a lockstep demo playable at "2 seconds latency and 25% packet loss".
  - TCP at 100 ms / 1% loss showed hitches every few seconds, because each loss costs about 2× RTT to retransmit.
  - Round-trip time was assumed to be 30–250 ms, with 2–15 frames of input per packet on average.
  — [Gaffer On Games, 2014](https://gafferongames.com/post/deterministic_lockstep/)
- **Rollback in an RTS (Stormgate / Frost Giant, SnowPlay engine).** Press release, Cologne, 23 August 2023: "Stormgate runs 64 Hz tick servers, able to recognize player inputs approximately three times as often as StarCraft II" and "Stormgate will also be the first real-time strategy game to feature rollback netcode." No input-latency figures were given. — [Frost Giant press release (Cosmocover)](https://www.cosmocover.com/newsroom/frost-giant-studios-unveils-stormgates-infernal-host-at-gamescom-2023/). Coverage describes the client predicting remote input and correcting when it is wrong. The article's author notes "We don't know the extent of Stormgate's rollback netcode depth" and that rollback mainly helps bad connections rather than baseline lag. — [Out of Games](https://outof.games/news/6617-stormgate-becomes-first-rts-to-implement-rollback-netcode/)
- **Time-warp in 0 A.D.** 0 A.D.'s TurnManager has `EnableTimeWarpRecording(numTurns)`, a state-snapshot facility. Its source comments do not say it is used for network rollback. — [TurnManager.cpp](https://github.com/0ad/0ad/blob/master/source/simulation2/system/TurnManager.cpp)

### Inferences
- **"Empty through turn N" heartbeats.** Instead of one empty frame per turn, a side can send one short frame saying "no orders from me through turn T+K" and commit to K empty turns ahead. The peer can then advance K turns without hearing anything.
  - The cost is that the sender cannot issue an order that executes before T+K, which is input delay by another name, so K is effectively the input delay while idle.
  - A good scheme is adaptive: when idle, promise long empty spans (for example 2–3 s), which saves airtime. When an order is pending, send it at the next frame slot for the earliest uncommitted turn.
  - This is consistent with how AoE, OpenRA and 0 A.D. bind commands to future turns, but I found no shipped RTS that documents variable-length empty promises.
- **Redundancy over the acoustic link.** Gaffer-style redundancy suits the link well: each frame repeats any unacked orders and piggybacks an ack of the peer's latest turn. A lost frame then costs nothing if the next one arrives within the delay budget, rather than a full RTT for a resend request.
- **Why rollback fits poorly here.** Battle Drones' deterministic 10 Hz sim makes rollback technically possible, but with 1–3 s one-way latency each late order rewrites 10–30 ticks of visible history: units teleport, and deaths or explosions get undone. Fighting-game rollback works because corrections are a few frames. Unless re-simulating 30 ticks is cheap on phones and the visual snaps are acceptable, lockstep with a generous fixed delay is the safer choice.
- **Split authority (each side authoritative for its own units, sending state) is unlikely to suit audio.** State traffic grows with unit count, which is exactly what AoE's lockstep avoided at 28.8 kbps. It cannot fit in tens of bits per second.

### Gaps
- I found no technical write-up (GDC talk, blog, or source) of how Stormgate's RTS rollback bounds rollback depth or CPU cost.
- I found no prior art on lockstep over acoustic or other sub-100 bit/s links, and no shipped game documenting variable-length "empty through turn N" promises.
- I did not research Factorio's "latency hiding" (a lockstep game with local prediction of the player's own character) within this budget.

## 6. Design patterns that make 1–3 s order delay acceptable

### Takeaway
The evidence suggests making the delay predictable and constant, giving instant local feedback, and steering play toward strategy over micro. Players already adapt at 500–1000 ms by estimating the delay and simplifying tactics. Higher-level and queued orders reduce both the number of messages and the cost of each delay. A diegetic "order travel time" (couriers, radio) is an established wargame precedent, though the evidence for it is thin.

### Cited Findings
- **Players adapt to steady delay.** Players form a "game pace" and an expectation of the click-to-response lag, and a consistent slower response beats a variable one. — [1500 Archers PDF](https://web.cs.wpi.edu/~claypool/courses/4513-B03/papers/games/aoe.pdf)
- **Players estimate the delay and simplify.** At 500–1000 ms it was "relatively easy to estimate this delay and react accordingly". Above 500 ms players merged armies into one or two groups instead of flanking. Micro-managing combat was more latency-sensitive than micro-managing building. — [Claypool TR PDF](https://ftp.cs.wpi.edu/pub/techreports/pdf/03-32.pdf)
- **Long-deadline actions tolerate latency.** RTS actions with loose deadlines and low precision are "resilient to even high Internet latencies". — [Latency Can Kill PDF](https://sites.cs.ucsb.edu/~almeroth/classes/W10.290F/papers/claypool-10.pdf)
- **Validate commands at execution time.** Because commands may execute seconds after being issued, AoE developers learned that commands must be validated when executed, not only when issued. — [Game Developer reprint](https://www.gamedeveloper.com/programming/1500-archers-on-a-28-8-network-programming-in-age-of-empires-and-beyond)
- **Battle Drones' existing local feedback.** MULTIPLAYER.md already plans immediate local feedback: "Only the unit moving waits for the turn," build buttons show pending state, and stalls under 500 ms show nothing. — `MULTIPLAYER.md` in this repo (lines ~262–320)
- **Courier-delay precedents (weak sources).**
  - In *Kriegsspiel: 7 Years War*, orders and reports travel by courier, which induces "lag" in operations, makes the game slower than other RTS, and prevents micro-management. — [ModDB page](https://www.moddb.com/games/kriegsspiel-7-years-war/videos)
  - A Spring RTS forum discussion proposed commander-distance-based order delay. A reply argued that invisible, randomly lost messages are unfun and that a physical, interactable message carrier works better. — [Spring forum](https://springrts.com/phpbb/viewtopic.php?p=392677)

### Inferences
- **Instant local acknowledgement on tap.** Show a move marker, a "pending" ghost path, a unit voice or "radio click" sound, and a countdown ring to execution. This is cosmetic only and must never touch sim state. The simulation keeps animating during the delay, as in AoE.
- **Make the delay part of the fiction and constant.** A "drone uplink" or "radio relay" with a visible fixed transmission time, such as a 1.5 s bar, turns lag into a rule players can plan around. AoE's evidence says constant beats variable, and the Spring forum says visible beats invisible.
- **Favour orders that need fewer messages and tolerate delay.**
  - Attack-move, patrol, guard or escort, "hold area", rally points, and queued waypoints (shift-queue style).
  - Standing behaviours ("retreat at 30% HP", "auto-target priority") that the deterministic sim runs every tick without messages.
  - Production queues and repeat-build instead of one-unit-at-a-time production.
  - Each of these replaces many micro orders with one, and lowers both bandwidth and the cost of delay.
- **A "slow-paced acoustic mode" with slower game speed.** Slower unit speeds, longer attack windups, and calldowns with a telegraph longer than the link delay keep the delay small relative to combat timescales. The WPI result that RTS strategies take "seconds or even minutes" is the justification. OpenRA's choice to keep wall-clock order latency roughly constant across speeds shows the related idea of tying latency to game pace.
- **Fail-safes that need no messages.** Sim-side auto-retaliation and auto-acquire, so units under fire do not wait 2 s for an order to defend themselves.

### Gaps
- I found no controlled study of "diegetic delay" (courier or radio) RTS modes, or of how visible pending-order feedback changes tolerance. Evidence here is design precedent and forum opinion only.
- I found no published data on how much queued or higher-level orders reduce APM or message counts in real RTS play.
