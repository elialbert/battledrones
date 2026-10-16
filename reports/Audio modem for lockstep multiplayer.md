# Half-Second Turns Make Acoustic Lockstep Playable

Battle Drones can run 1v1 deterministic lockstep between two phones using only their speakers and microphones, but only as a deliberately slow "radio" mode. That mode uses **500 ms communication turns with a fixed two-turn input delay, so each order lands 1.0–1.5 s after the tap (about 1.25 s on average). It needs a link that carries roughly 200–450 bit/s of net payload in each direction at the same time.** That target sits right at the edge of what has been shown between real phones. The only independent multi-phone evaluation found ggwave-style multi-tone FSK reliable at about **268 bit/s, one way, at 50 cm**, and every faster scheme it tested (600–729 bit/s) failed beyond 10–20 cm ([Putz et al. 2026](https://arxiv.org/abs/2602.02249)). Swapping in an existing library will not reach the target. The project needs:

- a continuous, spectrally efficient multicarrier modem (OFDM with differential PSK, soft-decision convolutional FEC and a CRC-16);
- a frequency plan that keeps each phone's own harmonics out of the band it listens on, so both phones can transmit at once;
- phones kept within about 30 cm of each other;
- a lockstep layer that sends one frame per 5 ticks, repeats unacknowledged orders and compresses bursts.

**iOS Safari is the make-or-break platform.** Opening the microphone forces a play-and-record audio session. With echo cancellation on, audio plays through the loudspeaker but passes through Apple's voice-processing path, which crackles on iOS 27. With echo cancellation off, playback is clean but goes to the quiet earpiece ([WebKit bug 326286](https://bugs.webkit.org/show_bug.cgi?id=326286)). The 0.3 s delay that 100 ms turns would give needs 450–750 bit/s each way with under 150 ms one-way latency. Nothing published comes close, so treat it as research rather than plan. The first thing to build is not a modem. It is a measurement page run on real iPhones and Android phones, built alongside the determinism work and a simulated link that lets the game-feel work go ahead without audio. If the probe shows 10–15 dB of SNR per band at table distance, expect about 20× the 12 bit/s of the current Chirp Pong prototype.

## Orders need 200–450 bit/s each way for a 1.25-second delay

The requirement comes from the Battle Drones code itself. These are first-party measurements from earlier in this work: 16 headless matches on Riverlands, Dune Sea, Frostbite and Archipelago, 12 AI-vs-AI at normal difficulty and 4 of the repo's scripted "decent" phone player against the AI. Orders were encoded in a compact binary format: a 5-bit command type, unit selections as an index or bitmask over the sender's own units, a 1-bit "same units as my last order" flag, and positions at half-tile precision. In that format:

- **The AI commanders issued 92 orders per minute per side at about 30 bits each, an average of only 45 bit/s.** 57% of one-second windows were empty, but the 99th percentile second carried 317 bits and the worst carried 930.
- **The scripted player issued 28 orders per minute at about 25 bits, or 12 bit/s.**
- The same orders as JSON would cost about 83 bytes each (about 1,018 bit/s), so **the binary codec is already a 20× saving before any modem work starts.**

The averages are tiny. The difficulty is in two other places: the per-turn frame that lockstep sends even when it carries no orders, and the bursts that arrive during fights.

The framing cost dominates at short turns. A lockstep frame of about 24 bits (turn counter, order count, CRC-16) sent every turn costs **240 bit/s at 100 ms turns, 48 bit/s at 500 ms and 24 bit/s at 1 s**. Bursts are the other cost. In a first-party queueing simulation of a first-in-first-out channel, the AI's orders backed up by more than 30 s at 100 bit/s of capacity. Extra delay at the 99th percentile was about 3 s at 200 bit/s, 1–1.4 s at 300 bit/s and 0.5–0.8 s at 500 bit/s. The calmer scripted player saw about 0.5 s of extra delay at 100 bit/s and 0.2 s at 200 bit/s. Putting the two costs together gives the requirement per direction, with both phones transmitting at once:

| Comm turn | Fixed input delay D | Tap-to-execution delay | Net rate needed each way (calm player → AI-level) | What players report at that delay |
|---|---|---|---|---|
| 100 ms (as MULTIPLAYER.md plans for internet play) | 3 turns | 0.3–0.4 s | 450–750 bit/s | 250–500 ms "very playable" in Age of Empires testing |
| **500 ms (recommended)** | **2 turns** | **1.0–1.5 s, mean 1.25 s** | **200–450 bit/s** | 500–1000 ms perceptible but "relatively easy to estimate"; above 1 s "perceptibly difficult" |
| 1 s (fallback) | 2 turns | 2.0–3.0 s, mean 2.5 s | 130–430 bit/s | Outcomes barely change up to 3.5 s, but the delay is clearly felt |

The delay column follows from lockstep arithmetic. An order tapped during turn *k* waits on average half a turn for the turn to close, then D turns, so the mean delay is T/2 + D·T. In a continuous stream each frame takes about one turn of airtime. On top of that comes perhaps 40–100 ms of browser audio input/output (an estimate; see the platform section). A frame sent at the start of turn *k* is therefore decoded about 0.1 s after turn *k*+1 begins. With 500 ms turns, D = 2 leaves about 0.4 s of slack. And because every frame repeats any orders the peer has not yet acknowledged, a single lost frame is recovered from the next frame with a stall of only about 0.1 s. That is well under the 500 ms that [MULTIPLAYER.md](https://github.com/simonw/battledrones/blob/main/MULTIPLAYER.md) already treats as invisible ("units hold their last interpolated pose").

The tolerance evidence supports a slow, steady mode over a fast, jittery one. Age of Empires' developers found 250 ms of command latency "was not even noticed", 250–500 ms "very playable", and beyond 500 ms "noticeable". Crucially, a steady 500 ms was playable while latency swinging between 80 and 500 ms felt "jerky" ([1500 Archers](https://web.cs.wpi.edu/~claypool/courses/4513-B03/papers/games/aoe.pdf)). WPI's studies of Warcraft III, Age of Mythology and C&C Generals found **latencies up to 3.5 s had little effect on the outcomes of building, exploration and most combat**. Play "was not perceptibly difficult until induced latencies were above 1000 ms", and above 500 ms players stopped flanking and kept their army in one or two groups ([Claypool, WPI-CS-TR-03-32](https://ftp.cs.wpi.edu/pub/techreports/pdf/03-32.pdf)). Shipped games already sit near this range: 0 A.D. multiplayer runs 200 ms turns with a 4-turn command delay, so orders land 600–800 ms after issue ([0 A.D. TurnManager.h](https://github.com/0ad/0ad/blob/master/source/simulation2/system/TurnManager.h)). A 1.25 s radio mode is therefore a real but modest step past what RTS players already accept, provided the delay never wanders.

The AI is the pessimistic end of the requirement, not the expected one. Age of Empires players averaged one command every 1.5–2 s, with spikes of 3–4 per second in heated battles ([1500 Archers](https://web.cs.wpi.edu/~claypool/courses/4513-B03/papers/games/aoe.pdf)). At 25–30 bits per order, those spikes are only about 75–120 bit/s, which a 250 bit/s link absorbs with no queueing. The AI's 92 orders/min is closer to Gold–Platinum StarCraft II APM, and that APM figure also counts selections and hotkeys ([SkillCraft dataset](https://archive.ics.uci.edu/dataset/272/skillcraft1+master+table+dataset)). The table also shows why 100 ms turns are a poor fit for sound. Half of their 450 bit/s floor is frame headers rather than orders. A 250 ms turn (about 0.6 s of delay) is the natural later upgrade. Its rate requirement was not measured; interpolating between the measured rows suggests roughly 300–550 bit/s.

## Published phone links top out near 270 bit/s at arm's length

The strongest evidence is Putz et al.'s 2026 evaluation, which replayed eight published acoustic modems across 11,900 recordings on five Android phones ([Putz et al. 2026](https://arxiv.org/abs/2602.02249)):

- **At 50 cm, across 21 transmitter/receiver pairs, only the low-rate schemes were consistently reliable.** These were a 15 bit/s chirp scheme, Google Nearby at 84 bit/s, and ggwave at 268 bit/s, which scored about 0% total error rate in every pair but one.
- **The faster schemes broke down.** OFDM-QPSK at 600 bit/s ranged from 5% to 32% error, PriWhisper at 729 bit/s from 3% to 100%, and Digital Voices from 12% to 100%. They worked only at 10–20 cm.
- **Band mattered as much as rate.** Audible ggwave (1.8–6.3 kHz) became "completely unusable" with café, station or market noise and failed beyond 1 m. The same modem at 15–19.5 kHz shrugged off noise and reached 20 m.

The study has hard limits for this use case. All phones were Android running native apps. Every test was a one-way burst followed by 2 s of silence. There was no iPhone, no browser audio stack, no full duplex and no latency measurement.

| System | Modulation and band | Demonstrated rate | Conditions | Relevance |
|---|---|---|---|---|
| ggwave, inaudible ([Putz](https://arxiv.org/abs/2602.02249)) | 6-tone MFSK, 15–19.5 kHz, Reed-Solomon | 268 bit/s net | Reliable to 20 m; 5 Android phones; robust to noise | Proven robust rate; one-way only |
| ggwave, audible ([Putz](https://arxiv.org/abs/2602.02249)) | Same, 1.8–6.3 kHz | 268 bit/s | Fails with ambient noise and beyond 1 m | Warns against the speech band |
| Dhwani ([MSR 2013](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/Paper325Dhwani.pdf)) | OFDM BPSK/QPSK/8-PSK, 6–7 kHz, no FEC | 0.8 / 1.6 / 2.4 kbit/s at 100% / ~95% / ~80% packet success | ≤10 cm by design; falls to 0 at ~20 cm | Shows OFDM efficiency at close range |
| AquaApp ([SIGCOMM 2022](https://underwatermessaging.cs.washington.edu/underwater_comms.pdf)) | OFDM DBPSK, 1–4 kHz, rate-2/3 K=7 convolutional code | 100 bit/s–1.8 kbit/s, adaptive | Phone to phone, underwater, to 30 m | Closest proven template for a phone OFDM modem |
| Tabak et al. ([arXiv 2103.11261](https://arxiv.org/abs/2103.11261)) | Single-carrier QPSK at 19 kHz + decision-feedback equalizer | 4 kbit/s, BER <2e-4 | Laptops, 0.5–2 m; 0.3 s guard and 30% training per packet | High rate, but burst structure is wrong for turns |
| A-NFC ([NTU abstract](https://scholars.lib.ntu.edu.tw/entities/publication/9696e544-9d94-4daa-8032-aacb903dc46b)) | QPSK, two inaudible channels | Up to 2.2 kbit/s, full duplex | Android and iOS; range and error rates unknown | Only phone full-duplex claim found |
| quiet-lwip ([README](https://github.com/quiet/quiet-lwip)) | OFDM pair centred at 9.2 / 15.5 kHz | ~3.1 kbit/s average (11,020 B in 28 s) | One laptop talking to itself, full duplex | Only demonstrated duplex audio-band pair |
| Commercial (Chirp, LISNR, Cue, Nearby) | FSK / DSSS tokens | 25–300 bit/s | One-way broadcast; SDKs mostly defunct | Robust products stay slow |

None of the existing libraries can be dropped in.

- **ggwave** is the best of them: MIT-licensed, about 61 KB gzipped as WASM, phone-validated, with configurable bands. But its default framing spends about 683 ms on start and end markers per message, and it has no duplex mode ([ggwave](https://github.com/ggerganov/ggwave)). Its fixed-length mode drops the markers and sends 4 bytes in about 192 ms, which makes it a useful reference signal and pairing channel.
- **Quiet** has the right ideas: GMSK and OFDM profiles, and a full-duplex OFDM profile pair. But it was abandoned in 2019–2021. It ships as an asm.js-era build that runs on ScriptProcessorNodes of 16,384 samples, about 0.34 s of buffering at each end. Its convolutional and Reed-Solomon codes depend on the LGPL libfec ([quiet-js](https://github.com/quiet/quiet-js)).
- **amodem** is a cable-oriented Python tool that explicitly refuses full duplex ([amodem](https://github.com/romanz/amodem)).
- **codec2's** data modes use frames of 0.44–5 s and have no WASM port ([codec2 README_data](https://github.com/drowe67/codec2/blob/main/README_data.md)).

The deeper problem is spectral efficiency, and it explains why full duplex changes the modem choice. ggwave's 268 bit/s occupies 4.5 kHz, about **0.06 bit/s per Hz**. To transmit simultaneously, two phones must split the usable spectrum. At ggwave's efficiency, a 1–1.5 kHz band per direction yields only 60–90 bit/s, which is Chirp Pong territory. Multicarrier differential PSK does far better:

- Dhwani reached **0.8 bit/s per Hz uncoded** with BPSK in 1 kHz.
- AquaApp reached about **0.6 bit/s per Hz after coding**, using 20 ms OFDM symbols, differential BPSK across consecutive symbols, interleaving and a K=7 convolutional code ([AquaApp](https://underwatermessaging.cs.washington.edu/underwater_comms.pdf)).

A modem at around 0.25–0.5 bit/s per Hz in a 1 kHz band per direction would meet the 500 ms requirement. That efficiency has been demonstrated on phones, but not between phones in air at 0.5 m.

Distance is the cheapest lever, because room reverberation, not loudness, limits audible-band links beyond about half a metre. For a typical furnished living room (about 60 m³, RT60 about 0.5 s), the critical distance works out to about 0.62 m ([Burgess, IOA](https://www.ioa.org.uk/system/files/publications/M%20BURGESS%20THE%20EFFECTS%20OF%20CURRENT%20REVERBERATION%20TIMES%20IN%20BRITISH%20LIVING%20ROOMS.pdf); [formula, US 12136432](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/12136432)). That puts the peer's direct sound about **+16 dB above the room's reverberant field at 0.1 m, +6 dB at 0.3 m, +2 dB at 0.5 m and −4 dB at 1 m**. The reverberant tail of earlier symbols lasts far longer than any practical cyclic prefix, so it behaves like self-generated noise at roughly that ratio. This is an inference, but it fits the data: audible ggwave died beyond 1 m in a quiet office, while the 15–19.5 kHz variant, where soft furnishings absorb more energy, reached 20 m, and the fast schemes held up only within 10–20 cm. **Designing for phones lying on a table 20–30 cm apart, bottom edges facing, buys several decibels and shortens every guard interval.**

## iOS Safari, not the signal processing, decides whether this ships

Opening the microphone forces Safari into the play-and-record session. Native iOS apps escape the earpiece in that mode with the `defaultToSpeaker` option, which the web cannot set ([Apple: defaultToSpeaker](https://developer.apple.com/documentation/avfaudio/avaudiosession/categoryoptions-swift.struct/defaulttospeaker)). `navigator.audioSession.type` (Safari 16.4+) can pick the category but cannot force the loudspeaker. Setting it to `play-and-record` before calling getUserMedia avoids a mid-session category flip and keeps the silent switch from muting output. Apple documents that play-and-record audio "continues with the Silent switch set to silent", whereas Web Audio's default session is muted by it ([W3C Audio Session](https://w3c.github.io/audio-session/); [Apple: playAndRecord](https://developer.apple.com/documentation/avfaudio/avaudiosession/category-swift.struct/playandrecord); [WebKit bug 237322](https://bugs.webkit.org/show_bug.cgi?id=237322)). Current behaviour leaves two options, and both are bad:

- **Echo cancellation on (the default):** audio goes to the loudspeaker through the voice-processing path. On iOS 27 that path **crackles** for Web Audio and `<audio>` alike, a regression filed on 4 October 2026 that the reporter traces to the echo-cancellation path. A native app on the same phone using `.playAndRecord` with `.defaultToSpeaker` and no voice processing played cleanly ([WebKit bug 326286](https://bugs.webkit.org/show_bug.cgi?id=326286)).
- **Echo cancellation off:** playback is clean but "routes to the earpiece at much lower volume" ([326286](https://bugs.webkit.org/show_bug.cgi?id=326286)).

Separately, on iOS 26 playback after getUserMedia starts shows a **"reduced sample rate" and stereo collapsing to mono, with or without `echoCancellation: false`**. The bug is unresolved and does not say how far the rate drops ([WebKit bug 311451](https://bugs.webkit.org/show_bug.cgi?id=311451)). Echo cancellation also "appears to be the only constraint Safari uses". And with it off, a mono microphone arrives as a stereo track with only the left channel populated ([WebKit bug 281978](https://bugs.webkit.org/show_bug.cgi?id=281978)).

| Platform and capture setting | Output route | Processing on the microphone | Known problems (October 2026) | Verdict |
|---|---|---|---|---|
| iOS Safari, echoCancellation true | Loudspeaker | Apple voice processing (echo cancellation, voice EQ, dynamics) | Crackle on iOS 27; reduced rate and mono on iOS 26; volume drop history ([218012](https://bugs.webkit.org/show_bug.cgi?id=218012)) | Test first; may limit transmit bandwidth |
| iOS Safari, echoCancellation false | Earpiece, much quieter | Minimal | Left-channel-only capture; reduced rate on iOS 26 | Viable only at short range, top edge toward the peer |
| Android Chrome, echo cancellation, noise suppression and AGC all false | Loudspeaker, media volume, normal audio mode | Mostly off; may vary by OEM | Constraint surprises (stereo, 44.1 kHz), so verify with `getSettings()` | Workable |
| Android Chrome, defaults | Speakerphone, call volume, `MODE_IN_COMMUNICATION` | Platform echo cancellation, noise suppression, AGC | Noise suppression attenuates steady tones; AGC pumps with own transmissions | Avoid |

These rows raise four questions that only an iPhone can answer:

- Does the voice-processing path pass modem tones intact? Noise suppressors treat steady narrowband energy as noise, and automatic gain control rides up and down with the phone's own transmissions.
- How far does the reduced output rate cut the top of the spectrum? A drop to a 16 or 24 kHz voice rate would kill near-ultrasonic transmission from iPhones and could even clip a 6–7 kHz band.
- Is the earpiece loud enough at 10–30 cm?
- How bad is the iOS 27 crackle for a data signal, as opposed to music?

A 2026 field report describes loudspeaker output in play-and-record mode on iOS 17–18 ([Sam Eddy](https://samueleddy.com/writing/ios-safari-audio-sessions/)), so behaviour clearly shifts between iOS versions. iOS 26 and 27 must both be tested.

Android Chrome is friendlier. When all three processing constraints are off, Chrome deliberately avoids switching Android into `MODE_IN_COMMUNICATION` ([Chromium audio_manager_android.cc](https://chromium.googlesource.com/chromium/src/media/+/master/audio/android/audio_manager_android.cc)). Playback then stays on the loudspeaker at media volume. With processing on, Chrome picks the speakerphone and follows call volume ([CommunicationDeviceSelector.java](https://chromium.googlesource.com/chromium/src/+/main/media/base/android/java/src/org/chromium/media/CommunicationDeviceSelector.java)). Android's own spec promises a roughly flat (±10 dB) unprocessed microphone response only from 100 Hz to 7 kHz ([Android CDD 5.11](https://android.googlesource.com/platform/compatibility/cdd/+/refs/heads/nougat-dev/5_multimedia/5_11_unprocessed-audio.md)). Across phones, Putz measured **up to 30 dB of output-level spread at the same volume setting, and nonlinear distortion above about 75% volume** on most devices. The near-ultrasonic band offers "less than 4 kHz" of usable bandwidth and is "highly frequency selective" ([Putz et al.](https://arxiv.org/abs/2602.02249)).

The browser plumbing is not the obstacle:

- **AudioWorklet** runs on Safari 14.1+ and Chrome 66+.
- **WASM SIMD** runs on Safari 16.4+ and Chrome 91+ ([MDN compat data](https://github.com/mdn/browser-compat-data/blob/main/api/AudioWorklet.json)).
- **SharedArrayBuffer** needs cross-origin isolation headers, which GitHub Pages cannot send. The coi-serviceworker workaround failed on iOS for Zoom's developers ([Zoom forum](https://devforum.zoom.us/t/session-failing-when-using-sharedarraybuffer-on-ios/122170)) and would fight the game's own service worker. A modem does not need it.

**Latency is unmeasured on phones.** No authoritative 2024–2026 phone-browser figures were found, and the best estimate is 40–100 ms each way through the audio stack. Chrome on Android buffers 1,024 input frames (about 21 ms) by default ([Chromium](https://chromium.googlesource.com/chromium/src/media/+/master/audio/android/audio_manager_android.cc)). On a desktop, Chrome's end-to-end latency fell from about 67 ms to 19 ms with processing off and a minimal latency hint ([Kaufman](https://www.jefftk.com/p/browser-audio-latency)). `outputLatency` exists only from Safari 18.4, so the game should measure round-trip time itself with a loopback chirp at pairing.

**Lifecycle events will interrupt matches.** iOS ends microphone tracks after backgrounding ([204681](https://bugs.webkit.org/show_bug.cgi?id=204681)). A failure after an iOS 26 audio daemon reset needed a full reload ([319706](https://bugs.webkit.org/show_bug.cgi?id=319706)). The Wake Lock API reached installed iOS web apps only in iOS 18.4 ([MDN WakeLock](https://github.com/mdn/browser-compat-data/blob/main/api/WakeLock.json)).

**Phone audio clocks differ.** Android audio clocks deviate by about 1–80 ppm each ([arXiv 2307.11263](https://arxiv.org/pdf/2307.11263)), so two phones can differ by about 160 ppm. That is about 10 ms of symbol-timing drift per minute, which the modem must track continuously.

**The game's own sound is a jammer.** This is an inference the notes do not cover, but it follows directly. Music, explosions and voice lines play through the same speakers into both microphones, and Putz found claps "dramatically impaired" short-symbol modems. The game's audio mix must be filtered out of the modem bands. That costs nothing audible in a near-ultrasonic plan (low-pass at about 15 kHz). In an audible 4–7 kHz plan it audibly dulls the sound effects.

## Full duplex works only with a harmonic-aware band plan

Chirp Pong is half duplex because of physics, not code. Its low band (1.4–3.0 kHz) has a second harmonic at 2.8–6.0 kHz, which covers the whole high band (3.4–5.0 kHz) ([Chirp Pong](https://github.com/simonw/tools/tree/chirp-pong)). A phone's own speaker sits millimetres to centimetres from its own bottom microphone, so its own signal arrives **roughly 15–40 dB louder than a peer 10–100 cm away**. That estimate comes from spreading loss alone and has not been measured. At that level gap, own harmonics even 30 dB down land at about the peer's level. The failure is also asymmetric: the phone sending in the high band causes no trouble, because harmonics only go up.

That asymmetry gives the core design rules for frequency-division duplex (FDD), where each phone transmits in its own band:

- **Keep the lower band's harmonics out of the upper band.** For a lower band [f1, f2] and an upper band [f3, f4], either f4 < 2·f1 (both bands fit within one octave), or put both bands high enough that the harmonics fall above what the microphones capture.
- **Leave room for intermodulation.** Any band carrying several simultaneous tones, such as OFDM or ggwave's six tones, spreads third-order intermodulation products one bandwidth to either side of itself. The guard band must therefore be at least as wide as the wider multitone band. This applies to the upper band too: its products spill downward toward the lower band.
- **Watch the microphone's own nonlinearity.** BatComm showed that phone microphone preamplifiers produce quadratic products, so strong out-of-band signals reappear inside the recorded band ([BatComm](https://www.winlab.rutgers.edu/~yychen/papers/BatComm%20Enabling%20Inaudible%20Acoustic%20Communication%20with%20High-throughput%20for%20Mobile%20Devices.pdf)). A phone's own multitone transmission of width W can therefore create products at 0–W Hz at its own microphone, and the lower band must sit above W.
- **Constant-envelope signals avoid intermodulation entirely.** Sending one tone at a time, as Chirp Pong's FSK does, removes the intermodulation problem, but it is spectrally inefficient.

| Band plan | Phone L transmits | Phone H transmits | Harmonic and intermodulation check | Notes |
|---|---|---|---|---|
| Chirp Pong today | 1.4–3.0 kHz | 3.4–5.0 kHz | Fails: L's 2nd harmonic covers H | Also sits in the speech band |
| **Near-ultrasonic FDD (preferred)** | ~16.5–17.5 kHz | ~18.5–19.5 kHz | Harmonics above the microphone band; 1 kHz guard covers intermodulation either way; microphone difference products at 0–1 kHz | Inaudible to most adults and robust to talking; iOS output viability unknown; edges set per pair by the probe |
| Audible FDD below 8 kHz (fallback) | 4.0–5.0 kHz | 6.0–7.0 kHz | L's 2nd harmonic (8–10 kHz) clears H; intermodulation from either band just touches the other's edge | Fits under the 8 kHz limit if iOS resamples output to 16 kHz, though 7 kHz is near the filter edge; audible; game audio must be notched |
| Scheduled TDD (fallback) | Full band, first half of each turn | Same band, second half | No self-interference while listening | Guard time depends on distance (below) |

The band edges above are this report's construction from the rules in the research notes. They are starting points for the probe, not measured optima.

Time-division duplex (TDD), where the phones take turns on the same band, avoids self-interference but pays in guard time. The phone must wait for its own transmission's room tail to decay below the peer's direct signal. With RT60 = 0.5 s, getting that tail 10–20 dB down takes **almost no time at 0.1 m, about 100–180 ms at 0.5 m, and about 120–200 ms at 1 m**. That figure was computed in the research notes from the critical-distance figures above.

Counting overheads shows that FDD and TDD give similar capacity per side when the phones are close. FDD gives up half the spectrum plus a guard band. TDD gives up half the time plus two guard intervals. Take a 3 kHz band at 0.3 m with 500 ms turns. The same tail arithmetic gives guards of about 30–120 ms, so TDD gets roughly 130–220 ms of airtime per side per turn across the whole band. That is in the same range as the throughput FDD gets from 1 kHz for the full turn. At 0.5 m the TDD guards eat most of a 500 ms turn, so TDD only works with close phones or 1 s turns.

FDD wins on three counts: latency, independence from distance, and simplicity. Each phone free-runs its own stream, so no slot schedule has to be synchronised across two drifting clocks. TDD wins on immunity to harmonics and on never overlapping the peer's signal with the phone's own playback. That second point plausibly suits iOS voice processing, whose echo canceller treats simultaneous sound from both ends ("double talk") as the hard case. The modem should be built as a single time-frequency grid, so that "which subcarriers" and "which symbol slots" are configuration chosen at pairing.

Cancelling the phone's own known signal is an enhancement, not a foundation. Dhwani cancelled its own jamming signal by **18–24 dB when trained in the same room, but only 6–7 dB elsewhere**, because reverberation tails need filters thousands of taps long ([Dhwani](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/Paper325Dhwani.pdf)). The browser's own echo canceller is the wrong tool:

- WebRTC's AEC3 applies only a broadband suppression gain above 8 kHz, not true cancellation ([AEC3 suppression_gain.cc](https://chromium.googlesource.com/external/webrtc/+/lkgr/modules/audio_processing/aec3/suppression_gain.cc)).
- Chrome reportedly does not use Web Audio output as its echo reference ([forum report](https://forum.babylonjs.com/t/browser-audio-cancellation-doesnt-work-using-babylons-sound-component/16759)).
- Its speech-tuned suppressor would attenuate the peer's tones during double talk.

In OFDM, by contrast, the phone's own signal in each frequency bin is just a complex gain times a symbol it already knows. Estimating and subtracting it per bin is cheap, and it could later shrink guard bands and TDD gaps. The only published prior art for phone full duplex is FDD: A-NFC's two inaudible channels ([A-NFC](https://scholars.lib.ntu.edu.tw/entities/publication/9696e544-9d94-4daa-8032-aacb903dc46b)) and Quiet's paired profiles.

## A small TypeScript OFDM modem beats porting Quiet or ggwave

The architecture should be one AudioWorkletProcessor that both transmits and receives, written in TypeScript, exchanging only decoded frames and outgoing payloads with the game over its MessagePort. This has three advantages:

- Transmit symbols are generated sample-accurately at turn boundaries, immune to stutters in the game loop.
- The phone's own transmitted samples sit in the same processor, ready for later cancellation.
- No SharedArrayBuffer is needed.

The arithmetic load is small. Google's AudioWorklet guidance gives a 128-frame render quantum (about 2.7 ms) as the budget ([Chrome: Audio Worklet design pattern](https://developer.chrome.com/blog/audio-worklet-design-pattern)). A plain-JS FFT such as [fft.js](https://www.npmjs.com/package/fft.js) (22 KB) took single-digit microseconds per 1,024-point transform in a local server benchmark. The only expensive operations are long time-domain correlations and adaptive filters, which belong in the frequency domain.

WASM therefore matters for reusing mature C code and getting predictable timing, not for speed. Candidates are libcorrect, a BSD-licensed Viterbi and Reed-Solomon library intended to replace LGPL libfec ([libcorrect](https://github.com/quiet/libcorrect)), and parts of liquid-dsp (MIT). Speech tools should be avoided. The WebRTC AEC3 port is about 80 KB of gzipped WASM plus 113 KB of glue and carries a speech-tuned nonlinear suppressor ([webrtcaec3.js](https://www.npmjs.com/package/@ennuicastr/webrtcaec3.js)). RNNoise is trained to remove exactly the steady tonal sound a modem makes.

A concrete numerology makes the expected rate checkable:

- **Symbol length.** At 48 kHz, a 1,024-point FFT gives 46.875 Hz subcarrier spacing, the same tone grid Chirp Pong already uses. Each symbol is 21.3 ms plus a 5.3 ms cyclic prefix, 26.7 ms in all. The prefix is generous against reverberation; Dhwani found 4 ms enough at short range.
- **Symbols per turn.** A 500 ms turn holds 18 symbols, one reference and 17 data, with 20 ms of slack for drift.
- **Subcarriers.** A 1 kHz band holds about 18 data subcarriers after edge guards and pilots.
- **Bits per turn with DBPSK.** That gives 306 coded bits. A rate-½ tail-biting code halves them to 153 information bits, and after a CRC-16 and a 12-bit header **about 125 bits of orders per turn remain, roughly 250 bit/s of payload (about 300 bit/s of net capacity in the requirement's terms)**.
- **With DQPSK.** Differential QPSK doubles that to about 550 bit/s of payload.

So FDD with DBPSK covers the 500 ms requirement for calm and typical human play, and DQPSK covers AI-level bursts. The same arithmetic rules out 100 ms turns. Three symbols per turn would leave about 12–30 bits of orders after the CRC and header, against a requirement of 21–51 payload bits per turn. Reaching it would take roughly twice the bandwidth per direction.

In the near-ultrasonic band, a 512-point FFT (93.75 Hz spacing) gives the same rate with more tolerance for Doppler shift: hand motion at 0.5 m/s shifts 19 kHz by about 28 Hz. Rough engineering estimates of the signal-to-noise ratio needed per subcarrier, including the phone's own interference, are **about 8–10 dB for DBPSK and about 15 dB for DQPSK** with the code below. Differential detection across time removes per-frame channel estimation, at a cost of about 3 dB that short range can afford.

The error-correction choice is clear for 24–200-bit frames. liquid-dsp's table gives the Eb/N0 needed for a 1e-5 bit error rate ([liquid FEC](https://liquidsdr.org/doc/fec/)):

| Code | Eb/N0 for BER 1e-5 |
|---|---|
| Uncoded | 9.59 dB |
| Hamming(7,4) | 7.79 dB |
| Golay(24,12) | 7.46 dB |
| RS(255,223) | 6.04 dB |
| K=7 rate-½ convolutional, hard decisions | 6.44 dB |
| K=7 rate-½ convolutional, soft decisions | 4.29 dB |

**A tail-biting K=7 rate-½ convolutional code with soft Viterbi decoding is about 5 dB better than uncoded.** Tail-biting saves the 6 tail bits, which would otherwise be a 10–25% overhead on frames this short. A CRC-aided polar code with list decoding gains another 1–2 dB at about 64 bits ([Coşkun et al.](https://arxiv.org/abs/1812.08562)), but no mature JS implementation exists, so it is a later option. Retransmission (ARQ) costs a full round trip. FEC tuned for a frame error rate of about 1%, plus repeating orders across turns, gives time diversity without one.

The CRC deserves attention because in lockstep **an undetected corrupt frame is a desync**. Assume 5% of frames arrive corrupted at 2 frames/s per direction. Chirp Pong's CRC-8 passes about 1 in 256 corrupted frames, so across both directions one corrupt order would slip through **roughly every 21 minutes, about a 37% chance of desync per 10-minute match**. A CRC-16 stretches that to about once per 90 hours of play. (These figures are this report's arithmetic.)

Synchronisation should be acquired once and then tracked, not paid for in every frame. Burst modems spend heavily on preambles: AquaApp about 170 ms of preamble, Tabak's design a 0.3 s guard, ggwave's variable-length mode about 683 ms of markers. A 20 ms chirp or Zadoff–Chu (ZC) sequence gives processing gain of 10·log10(bandwidth × duration): **about 13 dB across 1 kHz and up to about 19 dB across 3.6 kHz**. That is ample at table range. A preamble built from two repeated halves (Schmidl–Cox style, like liquid-dsp's repeated S0 symbol) allows cheap autocorrelation detection, followed by one FFT-based cross-correlation for fine timing ([liquid ofdmflexframe](https://liquidsdr.org/doc/ofdmflexframe/)). After acquisition, each turn's reference symbol and a couple of pilot subcarriers track timing and the up-to-160 ppm clock difference, about 4 samples per turn, well inside the 256-sample prefix.

ggwave still has two uses. As a known-good reference signal on the probe page, it shows whether a given phone pair matches Putz's 268 bit/s. Its fixed-length mode is also a candidate for the slow, robust pairing channel.

## Lockstep must batch, repeat and compress to fit the link

The first adaptation is to separate the communication turn from the simulation tick, as Age of Empires (200 ms turns), 0 A.D. and OpenRA all do. OpenRA's server can even ask clients to batch several frames per packet "at the expense of input latency" ([OpenRA OrderManager.cs](https://github.com/OpenRA/OpenRA/blob/bleed/OpenRA.Game/Network/OrderManager.cs)). In radio mode a turn is 5 ticks. Orders tapped during turn *k* execute on the first tick of turn *k*+D. The 10 Hz simulation itself is unchanged.

D is set once at pairing from the measured loopback latency and frame airtime, then held fixed. Age of Empires' lesson is that steady delay beats low delay. If adaptation is added later, it should follow Age of Empires' asymmetry: the turn length "would quickly rise" on trouble and "slowly settle back down" ([1500 Archers](https://web.cs.wpi.edu/~claypool/courses/4513-B03/papers/games/aoe.pdf)), and changes take effect only at agreed turn boundaries.

Each frame should carry:

- a short turn counter (for example modulo 16);
- an acknowledgement of the peer's latest contiguous turn;
- the turn's orders, plus every order the peer has not yet acknowledged;
- a CRC-16.

Gaffer's redundant-input lockstep demo stayed playable at "2 seconds latency and 25% packet loss" this way, because a lost packet costs nothing if the next one arrives in time ([Gaffer On Games](https://gafferongames.com/post/deterministic_lockstep/)).

Desync checks need a far smaller budget than MULTIPLAYER.md's internet plan. That plan's 32-bit hash every 10 ticks costs 32 bit/s, as much as an AI's entire order stream. **A 16-bit hash every 5 s costs 3.2 bit/s.** A desync is permanent and grows, so the chance it escapes two consecutive 16-bit checks is about 2×10⁻¹⁰. A full hash in the end-of-match message closes the gap. The response stays MULTIPLAYER.md's "no contest", since there is no server to resynchronise from.

The order stream should be compacted before it reaches the modem:

- **Make selection deterministic per-player state.** The codec's "same units as last order" flag already does part of this. The rest is numbered group slots and add/remove deltas, mirroring Brood War's Select/SelectAdd commands ([screp](https://github.com/icza/screp/blob/master/rep/repcmd/types.go)) and Spring's separate select message ([Spring BaseNetProtocol.h](https://github.com/spring/spring/blob/develop/rts/Net/Protocol/BaseNetProtocol.h)).
- **Coalesce superseded orders.** A move or attack order replaced before its frame leaves should never be sent. Age of Empires found that "a simple filter to discard repeat commands at the same location drastically reduced the impact" of frantic clicking ([1500 Archers](https://web.cs.wpi.edu/~claypool/courses/4513-B03/papers/games/aoe.pdf)).
- **Prioritise by type, and spill the rest.** Non-repeatable orders (production, building, calldowns, resign) are never coalesced and always go first. Refreshable orders fill what is left, and the remainder waits for the next turn. That trades a little latency on a few orders for a steady turn cadence.
- **Validate commands when they execute, not when they are issued**, because they now execute seconds after the tap ([Game Developer reprint](https://www.gamedeveloper.com/programming/1500-archers-on-a-28-8-network-programming-in-age-of-empires-and-beyond)).

Two further changes keep the two phones aligned:

- **Clocks:** turn boundaries should come from the AudioWorklet's sample counter, since transmit frames must align to it anyway. MULTIPLAYER.md's jitter buffer (run 2% slow when stalling, catch up with extra ticks) absorbs the remaining drift of up to 160 ppm between phones.
- **Pairing:** the handshake must exchange a build or simulation hash alongside the seed, map and opener picks. Otherwise a cached old version on one phone guarantees a desync.

Cross-engine determinism is a hard prerequisite, independent of audio. iPhones run JavaScriptCore and Android phones run V8, and `src/sim/fmath.ts` exists precisely because the two disagree on `Math.sin`, `cos`, `atan2` and `hypot`. MULTIPLAYER.md's Phase 0 ban test and Playwright replay across Chromium and WebKit are the gate.

Game design does the rest:

- Instant local feedback is already planned: the waypoint ring, the voice line, and build buttons that show "placing…" at once.
- A visible countdown ring to execution, framed as a fixed "uplink" time, makes the constant delay legible.
- High-level orders replace streams of micro-orders: attack-move, queued waypoints, rally points, repeat-build.
- Simulation-side auto-retaliation means units do not wait 1.25 s to defend themselves.

Rollback, which only one RTS has announced ([Stormgate press release](https://www.cosmocover.com/newsroom/frost-giant-studios-unveils-stormgates-infernal-host-at-gamescom-2023/)), is a poor fit. At 1.25 s each late order would rewrite about 12 ticks of visible history.

## Build the probe page first, then a robust modem, then speed

The recommendation is to build a **"Radio Duel" mode**:

- 500 ms turns with a fixed D of 2, giving 1.0–1.5 s order delay;
- an OFDM-DPSK modem in a single TypeScript AudioWorklet;
- near-ultrasonic FDD where both phones pass a pairing probe, with audible FDD below 8 kHz or close-range scheduled TDD as fallbacks;
- a K=7 tail-biting convolutional code with soft Viterbi decoding and a CRC-16;
- continuous streaming with one-time acquisition;
- a lockstep layer that batches, repeats unacknowledged orders and compacts bursts.

Nothing in the stack needs WASM or SharedArrayBuffer to start. The order of work matters more than the details. Phone measurements and determinism are cheap and decide everything after them, while the modem is the expensive part and should be designed against measured channels.

| Phase | What to build | Exit criterion / decision | Expected net rate per direction | Expected order delay |
|---|---|---|---|---|
| 0. Desk work, no audio | Finish MULTIPLAYER.md Phase 0 (fmath ban test, cross-engine replay in Chromium and WebKit, `checksum.ts`, playing as red); separate comm turns from ticks; bit-packed order codec with selection state, coalescing, priorities and spill; frames with acks and redundancy; a **link simulator** (rate cap, frame loss, fixed delay) driving two simulations in one process; playtests at 0.6, 1.25 and 2.5 s delay | Identical hash trails on V8 and JavaScriptCore; 99th-percentile queueing delay ≤ 1 turn at 250 bit/s for the scripted player; playtesters accept 1.25 s | Simulated 100–600 bit/s | Simulated 0.6 / 1.25 / 2.5 s |
| 1. Probe page (static, on GitHub Pages) | A two-phone measurement tool covering every capture setting (iOS echo cancellation on and off, Android all-off); 1–20 kHz sweeps in each direction at 10, 30 and 60 cm and two orientations; own-transmit harmonic and intermodulation spectrum at 50% and 75% volume; noise with people talking; chirp impulse responses (reverberation tail); loopback latency and jitter; worklet timing; background and lock recovery; ggwave fixed-length and OFDM DBPSK/DQPSK test bursts as reference signals; raw WAV and JSON export for offline modem work | Per-pair SNR maps by band and distance; choice of band plan, duplex mode and distance guidance; **go/no-go for iPhones** and for near-ultrasonic | Measured | — |
| 2. Robust modem | One AudioWorkletProcessor (transmit and receive) in TypeScript; DBPSK OFDM numerology; chirp acquisition plus a per-turn reference symbol and pilots; tail-biting K=7 code with soft Viterbi; CRC-16; ggwave-class MFSK for pairing and as the slow fallback; FDD or scheduled TDD as the probe dictates; offline tests against recorded probe audio | Frame error rate ≤1–2% at the chosen distance across a 10-minute stream with conversation | ~150–300 bit/s (MFSK fallback ~60–90) | 2.5 s at 1 s turns, then 1.25 s at 500 ms turns |
| 3. Radio Duel ships | Pairing handshake (probe sweep, band and role choice, loopback latency, seed and build hash); fixed D; stall chip and "signal lost" pause; desync "no contest"; wake lock and tap-to-reconnect; game audio filtered out of modem bands; countdown ring and high-level orders | Full matches on iPhone↔Android, Android↔Android and iPhone↔iPhone pairs | ~300 bit/s (≈250 bit/s of orders) | ~1.25 s (1.0–1.5 s) |
| 4. Faster link | DQPSK and per-subcarrier loading from the probe; per-bin cancellation of the phone's own signal to shrink guards; 250 ms turns; WASM (libcorrect, liquid-dsp subset) only if profiling demands it | Pairs measuring ≥15 dB per subcarrier get fast mode automatically | ~550–600 bit/s | ~0.6 s (0.5–0.75 s) |
| Not planned | 100 ms turns | Needs 450–750 bit/s with under 150 ms one-way latency, which nothing published shows | — | ~0.35 s |

Against today's baseline (Chirp Pong at about 12 bit/s per side, half duplex, stop-and-wait), Phase 3 would be roughly a **20–25× improvement**. The gain comes from four places: transmitting continuously in both directions instead of taking turns, multicarrier modulation instead of one tone at a time, soft FEC with cross-turn redundancy instead of stop-and-wait retransmission, and one-time synchronisation instead of a 100 ms sync tone per frame.

### Risks that could sink the mode

| Risk | Likelihood / impact | Early warning | Mitigation |
|---|---|---|---|
| iOS output path (voice processing, reduced rate, earpiece) caps iPhone bandwidth or excludes it | High / high | Probe sweeps from an iPhone in both echo-cancellation modes | Audible plan below 8 kHz; earpiece orientation guidance; TDD for the voice-processing path; ship Android-only if needed |
| Own-speaker harmonics, intermodulation or level overload make FDD fail on some pairs | Medium / high | Probe's own-transmit spectrum | Band rules above; volume ≤75%; constant-envelope low band; TDD fallback; per-bin cancellation |
| Real rate at real distances and noise falls short of 300 bit/s | Medium / medium | Probe DBPSK burst error rates at 30–60 cm | Tell players to keep phones ≤30 cm apart; fall back to 1 s turns; coalescing and spill |
| JavaScriptCore vs V8 desync | Known / fatal | Phase 0 cross-engine replay | fmath, ban test, WebKit replay in CI before any audio work |
| Undetected corrupt frames | Medium / fatal | Hash mismatches in long soak tests | CRC-16 minimum; 16-bit periodic hash; "no contest" |
| Interruptions (backgrounding, calls, Siri, daemon resets) | High / medium | Probe lifecycle tests | Wake lock; tap-to-reconnect; stall-safe protocol that resumes from logs |
| Game audio and explosions jam the link | High / medium | Probe noise test with game audio playing | Filter game mix out of modem bands; duck sound effects |
| Bluetooth output adds 100+ ms and shifts latency | Medium / low | `outputLatency` and loopback | Detect and refuse at pairing |
| Annoyance or privacy concerns (audible tones, children or pets hearing 17–20 kHz, "app listening") | Medium / low | Playtests | Near-ultrasonic default; volume control; clear microphone UI ([ultrasonic beacon backlash](https://www.schneier.com/blog/archives/2017/05/using_ultrasoni.html)) |

### Questions only phones can answer

| Open question | Why it matters | How to answer it |
|---|---|---|
| On iOS 26 and 27, where does output go, and what bandwidth survives, with echo cancellation on vs off? Does voice processing pass steady tones? | Decides whether iPhones can join, and in which band | Probe: iPhone transmits a 1–20 kHz sweep in each mode while an Android phone records |
| What SNR per band do real pairs (including iPhone↔Android) achieve at 10, 30 and 60 cm with people talking? | Sets the band plan, constellation, rate and distance guidance | Probe sweeps and noise captures |
| How strong are a phone's own harmonics and intermodulation at its own microphone at 50–75% volume? | Decides whether FDD is feasible and how wide guards must be | Probe: transmit multitone and FSK while recording yourself |
| How long is the reverberation tail at table distance in real homes? | Sets the cyclic prefix and TDD guard | Probe chirp impulse responses |
| What is the round-trip audio latency, and how much does it jitter, inside an AudioWorklet on each platform? | Sets D and the stall margin | Probe loopback chirp |
| Does a continuous 10-minute stream survive OS ducking, notifications, heat and microphone muting? | The lockstep layer assumes a mostly-up link | Soak test on the probe page |
| What frame error rate do DBPSK and DQPSK actually achieve against MFSK at target distance, handheld vs on a table? | The real per-direction rate | Probe reference bursts, then offline analysis of the WAVs |
| Do players accept 1.25 s, and does the countdown ring help? | Whether the mode is fun at all | Phase 0 link simulator playtests, with no audio needed |

## Conclusion

The binding constraint is not computation, browser APIs or error-correction theory. It is **usable spectrum per direction multiplied by SNR at the distance players actually sit**, filtered through whatever iOS does to audio once the microphone opens. That changes what to optimise. The two cheapest gains are not in the modem. One is a product decision: phones flat on a table 20–30 cm apart, bottom edges facing, which helps every impairment at once. The other is lockstep's latency tolerance: moving from 100 ms to 500 ms turns cuts per-frame overhead from 240 to 48 bit/s and turns an unsolved research problem into one that published phone results only just support. Full duplex, often treated as a nice-to-have, is what lets the slow, robust signal classes reach the rate a playable game needs. It works only if the band plan respects that harmonics go up and intermodulation spreads one bandwidth either way, which is exactly the rule Chirp Pong's current bands break.

The plan is also built so that each step pays off even if a later one fails. Determinism work fixes replays and the Daily Op regardless. The link simulator lets the slow-mode game design be playtested before a single tone is played. The probe page turns every "unknown" in this report into a measurement within one build cycle, and its recordings become the modem's offline test set. If iPhones turn out to be unworkable, an Android-only Radio Duel at about 1.25 s is still a credible, novel feature. If the probe shows clean near-ultrasonic channels, the same architecture scales to about 0.6 s without being redesigned.
