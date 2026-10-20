# Existing data-over-sound / acoustic modem software usable in a browser (phone-to-phone, same room)

Researched 2026-10-15. Method: shallow clones of the main repos (ggwave, quiet, quiet-js, quiet-lwip, quiet's liquid-dsp fork, amodem, minimodem, AudioNetwork) with source constants read directly, plus web search/fetch for field reports, papers and commercial products. Where a number is **computed by me from source constants** rather than stated by the project, it says so. **Cable-only** numbers are labelled as such.

Reference point from the brief: Chirp Pong (our prototype) = differential 16-FSK, 2 bands, 50 ms symbols, 80 bps raw, 100 ms sync tone per frame, CRC-8, stop-and-wait, about 12 bps net per side at 1 s turns, effectively half duplex. Target: about 150 to 750 bps each way, ideally full duplex, about 150 ms one-way latency at 100 ms turns (up to about 1 s at 1 s turns).

---

## 1. Quiet.js / libquiet / quiet-lwip (liquid-dsp, Emscripten)

### Takeaway
Quiet is the only browser-capable library here with real high-rate profiles (GMSK, OFDM, BPSK, FSK, DSSS, all built on liquid-dsp) and a full-duplex over-the-air pair (`audible-7k-channel-0/1`, about 6.4 kbps peak on one laptop talking to itself). But it is unmaintained (core last commit 2019, JS 2021). Its JS build is an old asm.js-style blob that uses a 16384-sample ScriptProcessor for both TX and RX, which adds hundreds of ms of buffering per hop. It documents Safari as unable to receive, and no phone-to-phone over-the-air measurements are published.

### Cited Findings
- **What it is:** libquiet "uses liquid SDR to transmit data through sound," either over a 3.5 mm cable or speaker and mic. Profiles are defined in `quiet-profiles.json`. — [quiet/quiet README](https://github.com/quiet/quiet)
- **Maintenance (from git clone):** quiet/quiet last commit 2019-11-14 ("remove discord link"). quiet/quiet-js last commit 2021-05-19 ("update ultrasonic-fsk-fast"). quiet/quiet-lwip last commit 2019-11-14. quiet's liquid-dsp fork (`devel` branch, a required dependency) last commit 2019-02-16. — [quiet/quiet](https://github.com/quiet/quiet), [quiet/quiet-js](https://github.com/quiet/quiet-js), [quiet/quiet-lwip](https://github.com/quiet/quiet-lwip), [quiet/liquid-dsp devel](https://github.com/quiet/liquid-dsp/tree/devel)
- **License:** Quiet and Quiet-js are 3-clause BSD. The Emscripten output statically links liquid-dsp and jansson (both MIT). libfec (LGPL) is "strongly recommended": without it, quiet.js "will not be able to use any profiles which use convolutional codes or Reed-Solomon error correction" (so it cannot use most profiles). — [quiet-js README](https://github.com/quiet/quiet-js)
- **Build format:** quiet-js ships `quiet-emscripten.js` plus a memory initializer file `quiet-emscripten.js.mem`, loaded asynchronously. — [quiet-js README](https://github.com/quiet/quiet-js)
- **Browser compatibility, as documented:** Chrome receiver supported (HTTPS required). Chrome Android receiver "partially supported (GMSK profiles only)". Firefox receiver partial: it resamples input to 32 kHz, so nothing above 16 kHz and no ultrasonic profile. Safari and iOS Safari: transmit only, because "Safari does not support getUserMedia or microphone input in any capacity." — [quiet-js README](https://github.com/quiet/quiet-js); the demo page repeats "neither receiver will work in Safari." — [quiet.github.io/quiet-js](https://quiet.github.io/quiet-js/)
- **That Safari note is outdated in general:** an Apple developer forum thread reports getUserMedia working in iOS 11.3 Safari. — [Apple Developer Forums](https://developer.apple.com/forums/thread/92713). I found no report of quiet-js actually working in modern iOS Safari.
- **Audio plumbing (from source):** `quiet.js` sets `sampleBufferSize = 16384` and builds the transmitter as `createScriptProcessor(sampleBufferSize, 1, 2)` and each receiver as `createScriptProcessor(16384, 2, 1)`. It requests `echoCancellation: false`. — [quiet-js quiet.js](https://github.com/quiet/quiet-js/blob/master/quiet.js)
- **Base sample rate:** libquiet runs internally at `SAMPLE_RATE = 44100` and resamples other device rates. — [quiet include/quiet/common.h](https://github.com/quiet/quiet/blob/master/include/quiet/common.h)
- **Profiles in quiet-js `quiet-profiles.json` (16 profiles; core quiet has the first 8).** Columns are modulation, center frequency, samples/symbol (at 44.1 kHz), FEC (inner/outer), checksum and frame_length (bytes). — [quiet-js quiet-profiles.json](https://github.com/quiet/quiet-js/blob/master/quiet-profiles.json)
  - `audible`: GMSK, 4200 Hz, 10 sps, v27 / none, crc32, 25 B
  - `hello-world`: GMSK, 4400 Hz, 20 sps, v27, crc32, 25 B
  - `ultrasonic`: GMSK, 19000 Hz, 14 sps (rrcos), v27, crc32, 34 B
  - `ultrasonic-whisper`: GMSK, 19500 Hz, 30 sps, v27, crc32, 16 B
  - `audible-7k-channel-0`: **OFDM** 48 subcarriers (CP 8, taper 4), arb16opt (16-point constellation), center 9200 Hz, 6 sps, v29 + rs8, crc32, 600 B
  - `audible-7k-channel-1`: same OFDM as channel-0 but center **15500 Hz**
  - `ultrasonic-3600`: OFDM 64 subcarriers (CP 20), "V29" mod, center 18500 Hz, 7 sps, v27, crc8, 550 B
  - `cable-64k`: OFDM 128 subcarriers, QAM1024, center 10200 Hz, 2 sps, v27p23 + rs8, 7500 B (**cable only**)
  - quiet-js-only additions: `ultrasonic-experimental` (BPSK, 19000 Hz, 10 sps, rs8 + v29, 100 B); `wideband-dsss` (DSSS, 17000 Hz, 20 sps, no FEC, 8 B); `audible-fsk`/`-robust` (FSK8, 8000 Hz, 40 sps, v29); `audible-fsk-fast` (FSK8, rs8 + v29); `ultrasonic-fsk` (FSK16, 19000 Hz, 40 sps, v29); `ultrasonic-fsk-robust` (FSK8, 19000 Hz); `ultrasonic-fsk-fast` (FSK16, 18800 Hz, 20 sps, v29, crc8, 20 B).
- **Speed claims:** "For transmission via cable, quiet.js has profiles which offer speeds of at least 40 kbps" (cable). The ultrasonic profiles "encode data through a very low bitrate" (no number given). — [quiet-js README](https://github.com/quiet/quiet-js), [quiet README](https://github.com/quiet/quiet)
- **Per-frame framing (liquid-dsp source):** liquid's GMSK frame = 63-symbol p/n preamble + header + payload + 2·m tail symbols. Header = 5 decoded bytes + user header (quiet sets the user header length to 0) + CRC-32, Hamming(12,8)-coded. The OFDM flex frame header is 6 decoded bytes + CRC-32, Golay(24,12), BPSK. Quiet calls `*_set_header_len(…, 0)` on every frame type. — [liquid.internal.h](https://github.com/quiet/liquid-dsp/blob/devel/include/liquid.internal.h), [gmskframegen.c](https://github.com/quiet/liquid-dsp/blob/devel/src/framing/src/gmskframegen.c), [quiet encoder.c](https://github.com/quiet/quiet/blob/master/src/encoder.c)
- **Measured over-the-air throughput (laptop, not phones):** quiet-lwip ran TCP/IP over the air "using the same speaker and mic" on one laptop, with the **"full-duplex pair `audible-7k-channel-0/audible-7k-channel-1`"**. curl through a SOCKS proxy showed 11020 bytes in 28 s (average 388 B/s; "Current" 794 B/s), which the author summarises as "~6400bps". Switching to a **cable** and the half-duplex `cable-64k` profile gave 25509 bytes in 11 s (average 2255 B/s, current 3852 B/s). The author notes the "link itself is capable of sustaining speeds up to 64kbps" but half duplex plus TCP ACKs eat the throughput (cable). — [quiet-lwip README](https://github.com/quiet/quiet-lwip)
- **API for collision avoidance:** `quiet_decoder_frame_in_progress()` exists "to avoid collisions when two pairs of encoders/decoders share the same channel, e.g. in half-duplex." — [quiet.h](https://github.com/quiet/quiet/blob/master/include/quiet.h)
- **npm:** there is no official quiet-js npm package (it is distributed via GitHub). An unrelated or old `quiet-js@1.0.0` (ISC, 2016-03-03) exists. `libfec@1.1.0` (LGPL-2.1) was published 2016-02-25. — npm registry query of [quiet-js](https://registry.npmjs.org/quiet-js) and [libfec](https://registry.npmjs.org/libfec)

### Inferences
- **Nominal GMSK rates (my calculation from profile constants, before preamble overhead):** `audible` 44100/10 = 4410 baud, about 2.2 kbps after rate-1/2 v27. `ultrasonic` 3150 baud, about 1.6 kbps. `ultrasonic-whisper` 1470 baud, about 0.7 kbps.
- **Including liquid's 63-symbol preamble, about 112-symbol header, CRC-32 and tail (my estimate):**
  - `audible` frame (25 B) ≈ 663 symbols ≈ 150 ms, about 1.3 kbps net.
  - `ultrasonic` frame (34 B) ≈ 800 symbols ≈ 254 ms, about 1.07 kbps.
  - `ultrasonic-whisper` frame (16 B) ≈ 510 symbols ≈ 348 ms, about 370 bps.
  - Per-frame preamble and header alone ≈ 175 symbols (≈ 40 ms for `audible`, ≈ 120 ms for `whisper`).
  - These are paper rates. Real phone performance at 19 kHz is unknown (see the Putz et al. results in §7 on how phone frequency response varies above 15 kHz).
- **OFDM pair bandwidth (my estimate):** the `audible-7k` pair occupies about 44100/6 ≈ 7.35 kHz of baseband each (minus liquid's default guard and null subcarriers) around 9.2 kHz and 15.5 kHz. So channel-1 reaches about 18–19 kHz, which many phone mics and speakers handle poorly. It is designed as an FDD pair, which is exactly the duplex structure Battle Drones wants.
- **Latency:** a 16384-sample ScriptProcessor buffer is about 341–372 ms at 48/44.1 kHz. With one on TX and one on RX, quiet-js as shipped would probably add on the order of 0.5–0.8 s one-way before any frame airtime. That is incompatible with 100 ms turns unless rewritten on AudioWorklet with small blocks. The C core (liquid-dsp) is streaming-capable, so the bottleneck is the JS glue, not the modem.
- **Practical path if using Quiet:** recompile libquiet + liquid-dsp + libfec to modern WASM (Emscripten), drive it from an AudioWorklet, and use a GMSK or `audible-7k`-style profile shifted into the 1–8 kHz band where phone speakers are flat. This is non-trivial porting work on abandoned code, and libfec's LGPL needs care if statically linked.

### Gaps
- No published phone-to-phone over-the-air measurements for any Quiet profile, and no reports of current Chrome/Safari behaviour (2024–2026). GitHub issue search was not accessible from this environment.
- Exact OFDM payload rate of `audible-7k` (it depends on liquid's default subcarrier allocation and pilots). Not computed precisely.
- Whether quiet-js still runs at all in current browsers (ScriptProcessorNode is deprecated but still present in Chrome/Safari). Not tested.

---

## 2. ggwave (Georgi Gerganov)

### Takeaway
ggwave is the most mature, maintained-ish, MIT-licensed, WASM-ready option, and the only one with independent phone-to-phone validation: it was among the most robust of 8 schemes in a 2026 ACM study across 5 Android phones. It is multi-tone 16-FSK: 6 simultaneous tones per symbol (one per 4-bit nibble), 46.875 Hz spacing, Reed-Solomon ECC. "Fastest" is 375 bps raw, about 268 bps net, which sits inside the 150–750 bps target.

Its default variable-length mode costs about 683 ms of start and end markers per message. Its fixed-length mode has no markers and decodes on a sliding window, so a 4-byte message is about 192 ms of airtime. Frequencies are configurable per protocol, so two disjoint bands for full duplex are possible in principle, but nothing ships that does it.

### Cited Findings
- **Modulation:** "multi-frequency FSK". Data is split into 4-bit chunks, "at each moment of time, 3 bytes are transmitted using 6 tones – one tone for each 4-bit chunk", within "a 4.5kHz range divided in 96 equally-spaced frequencies". `dF = 46.875 Hz`; audible `F0 = 1875 Hz`, ultrasonic `F0 = 15000 Hz`. Data is Reed-Solomon encoded. Start and end "sound markers" frame each transmission. The README states "8-16 bytes/sec depending on the protocol parameters." — [ggwave README](https://github.com/ggerganov/ggwave)
- **Protocol table (from `ggwave.h`):** `{name, freqStart bin, framesPerTx, bytesPerTx, extra}`
  - `AUDIBLE_NORMAL/FAST/FASTEST` = bin 40, 9/6/3 frames, 3 bytes, extra 1
  - `ULTRASOUND_*` = bin 320, 9/6/3, 3 bytes
  - `DT_*` ("dual-tone") = bin 24, 9/6/3, 1 byte
  - `MT_*` ("mono-tone", extra 2) = bin 24, 9/6/3, 1 byte
  - plus 10 `CUSTOM_0..9` slots
  - Defaults: `kDefaultSampleRate = 48000`, `kDefaultSamplesPerFrame = 1024`, `kDefaultMarkerFrames = 16`, `kDefaultEncodedDataOffset = 3`, `kMaxDataSize = 256`, `kMaxLengthVariable = 140`, `kMaxLengthFixed = 64`.
  - [ggwave.h](https://github.com/ggerganov/ggwave/blob/master/include/ggwave/ggwave.h)
- **ECC sizing (source):** `getECCBytesForLength(len) = len < 4 ? 2 : max(4, 2*(len/5))`, so asymptotically 40% RS overhead. — [ggwave.cpp](https://github.com/ggerganov/ggwave/blob/master/src/ggwave.cpp)
- **Two framing modes (header comment):** if `payloadLength <= 0`, the payload is variable length and "sound markers are used to identify the start and end of the transmission." If `payloadLength > 0`, the payload is fixed length: "no sound markers are emitted and a slightly different decoding scheme is applied." In source, fixed mode sets `m_nMarkerFrames = 0` and `m_encodedDataOffset = 0`. `decode_fixed()` FFTs every frame into a spectrum history ring and, on each new frame, tries to decode the last `totalTxs*framesPerTx` frames as a complete message (RS-validated), so no preamble or sync is needed. — [ggwave.h](https://github.com/ggerganov/ggwave/blob/master/include/ggwave/ggwave.h), [ggwave.cpp](https://github.com/ggerganov/ggwave/blob/master/src/ggwave.cpp)
- **Configurable bands:** C API `ggwave_rxToggleProtocol`, `ggwave_txToggleProtocol`, and "Set freqStart for an Rx protocol" / "for a Tx protocol". — [ggwave.h](https://github.com/ggerganov/ggwave/blob/master/include/ggwave/ggwave.h)
- **v0.4.0 (2022-07-05) changes:** "Zero memory allocations during runtime", new low-frequency mono-tone (MT) protocols, "Bug fix in fixed-length payload decoding", "Support for Direct Sequence Spread (DSS)". v0.2.0 added variable- and fixed-length payloads, RS ECC and ultrasound. — [CHANGELOG](https://github.com/ggerganov/ggwave/blob/master/CHANGELOG.md)
- **Maintenance and packaging:**
  - Repo last commit 2026-04-16, "emscripten: Emscripten fixup (#177)".
  - The repo's `bindings/javascript/package.json` says version 0.4.3, but npm's latest `ggwave` is **0.4.0, published 2022-07-05** (MIT).
  - The JS binding is Emscripten with an optional `SINGLE_FILE=1` (WASM embedded in ggwave.js), `EXPORT_NAME='ggwave_factory'`.
  - Sources: git clone of [ggerganov/ggwave](https://github.com/ggerganov/ggwave); [npm registry](https://registry.npmjs.org/ggwave)
- **Browser demos:** waver.ggerganov.com, ggwave.ggerganov.com, ggwave-js.ggerganov.com. The ggwave-js example uses `new AudioContext({sampleRate: 48000})`, `getUserMedia` with `echoCancellation: false, autoGainControl: false, noiseSuppression: false`, and a ScriptProcessor with `bufferSize = 1024` (about 21 ms). — [ggwave README](https://github.com/ggerganov/ggwave), [examples/ggwave-js/index-tmpl.html](https://github.com/ggerganov/ggwave/blob/master/examples/ggwave-js/index-tmpl.html)
- **gg-transfer (Python tool on ggwave) lists nominal rates:**
  - top speed 33.52 B/s (protocol 2 "Fastest", 1875–6375 Hz audible; protocol 5, 15000–19500 Hz ultrasound)
  - slower modes 16.76 and 11.17 B/s
  - dual-tone modes 11.17 down to 3.72 B/s
  - Measured: a 16-byte string at protocol 2 reported "Speed: 12.30 B/s"; a 644-byte file about 27.8 B/s. Files are chunked into 140-byte blocks (132 B base64 + CRC32), the ggwave max.
  - [gg-transfer on PyPI](https://pypi.org/project/gg-transfer/) (via search summary; direct fetch was blocked by a bot challenge)
- **Independent phone-to-phone evaluation:** Putz et al., "Evaluating Acoustic Data Transmission Schemes for Ad-Hoc Communication Between Nearby Smart Devices", ACM Transactions on IoT 7(1) Art. 8, Feb 2026; arXiv 2602.02249.
  - They tested ggwave audible (MFSK 1.8–6.3 kHz) and inaudible (15–19.5 kHz) at a **268 bps** nominal rate, with over 11,000 smartphone transmissions.
  - Anechoic: both ggwave variants "nearly perfect" to 5 m.
  - Office: the inaudible variant worked to 20 m; the audible variant only to 1 m.
  - Five phone models (Pixel 4a, Pixel 6 Pro, Nexus 6P, Oppo Reno 6, Galaxy S20 Ultra) at 50 cm: both ggwave variants had "consistently very low error".
  - Under noise: the audible ggwave "became unusable under ambient noise", while the inaudible variant was robust to everything except pocketing.
  - Conclusion: the most robust schemes were Lee et al. (15 bps) and ggwave inaudible (268 bps).
  - [arXiv 2602.02249 (HTML)](https://arxiv.org/html/2602.02249)
- **PairSonic (TU Darmstadt, CSCW best paper)** used ggwave `AUDIBLE_FAST` (1875–6375 Hz, 96 FSK frequencies) between Android phones. They reported occasional acoustic failures in the lab study, then built a near-ultrasonic variant (15–19.5 kHz) for robustness. — [arXiv 2411.13693](https://arxiv.org/pdf/2411.13693), [arXiv 2411.13694](https://arxiv.org/pdf/2411.13694) (via search summary)
- **Other ggwave uses:**
  - Gibberlink (ElevenLabs London hackathon, 2025) switches two AI voice agents to ggwave over phone speakers and mics. — [Wikipedia: Gibberlink](https://en.wikipedia.org/wiki/Gibberlink)
  - One secondary source claims ggwave runs "at 1,200 baud … roughly 150 bytes per second"; this **conflicts** with the source constants (max ≈ 46.9 B/s raw) and should be disregarded.
  - A 2025 "Chirp" messaging tool on ggwave "stops listening while transmitting" and has no extra error correction; a 100-word message takes about 70 s. — [BleepingComputer](https://www.bleepingcomputer.com/news/software/new-chirp-tool-uses-audio-tones-to-send-messages-between-devices/)

### Inferences
- **Rates computed from source** (48 kHz, 1024-sample frames = 21.33 ms; "net" = after asymptotic 40% RS overhead):

  | ggwave protocol | Airtime per symbol group | Raw rate | Net rate |
  |---|---|---|---|
  | Normal (audible/ultrasound) | 192 ms per 3 bytes | 15.6 B/s (125 bps) | 11.2 B/s (89 bps) |
  | Fast | 128 ms per 3 bytes | 23.4 B/s (188 bps) | 16.7 B/s (134 bps) |
  | Fastest | 64 ms per 3 bytes | 46.9 B/s (375 bps) | 33.5 B/s (268 bps) |
  | DT fastest | 64 ms per byte | 15.6 B/s | 11.2 B/s |
  | DT normal | 192 ms per byte | 5.2 B/s | 3.7 B/s |
  | MT fastest | 128 ms per byte | 7.8 B/s | 5.6 B/s |

  These match gg-transfer's 33.52 / 16.76 / 11.17 / 3.72 B/s and Putz et al.'s 268 bps exactly, so the "33.5 B/s fastest" figure is **verified**.
- **Per-message airtime at Fastest (my calculation):**
  - **Variable mode:** add 32 marker frames (≈ 683 ms) plus a 3-byte length field. A 4-byte payload is 11 bytes → 12 frames → ≈ 256 ms + 683 ms ≈ **0.94 s**; a 10-byte payload ≈ **1.07 s**. That rules out per-turn messages at 100 ms turns and makes even 1 s turns marginal.
  - **Fixed mode:**

    | Payload | Airtime | Effective rate |
    |---|---|---|
    | 2 B | 128 ms | 125 bps |
    | 4 B | 192 ms | 167 bps |
    | 8 B | 256 ms | 250 bps |
    | 10 B | 320 ms | 250 bps |
    | 16 B | 512 ms | 250 bps |

    Decode latency ≈ airtime + one or two 21 ms frames + audio I/O buffering. That fits 0.25–1 s turns but not 100 ms turns. Back-to-back fixed-length frames in a continuous stream should work in principle (the sliding-window decoder looks for any RS-valid window), but I found no documentation or testing of continuous streaming.
- **Duplex:** ggwave has no built-in duplex. But you can set Tx freqStart on phone A and Rx freqStart on phone B to one band (e.g. 1.9–6.4 kHz), with the reverse direction on a disjoint band, using DT/MT or custom protocols. The 46.875 Hz grid and 4.5 kHz span per 3-byte protocol make two 3-byte bands fit in roughly 1.9–11 kHz. Self-interference (own speaker much louder than the peer at the own mic) is the open risk.
- ggwave's structure is very close to Chirp Pong, but with 3× more parallel tones per symbol (6 nibbles vs 2) and RS FEC. Its "Fastest" 64 ms symbol is about 4.7× Chirp Pong's raw rate.

### Gaps
- No published measurements of ggwave in **mobile Safari/iOS** via the WASM build. No report of fixed-length mode used as a continuous stream. No published end-to-end latency figures.
- PairSonic's actual success rates and timings were not retrieved.

---

## 3. amodem (Roman Zeyde, Python)

### Takeaway
amodem is a high-rate multi-carrier PSK/QAM modem (1 kbaud per carrier, carriers on 1 kHz spacing, up to 80 kbps) that is fundamentally a **cable** tool with a manual volume calibration step and about 2 s of training preamble. It is explicitly not full duplex and has no browser port. Its design (1 ms symbols, adaptive equalizer, per-carrier QAM) is small enough to port to JS/WASM, but its numbers do not transfer to phone speakers in a room.

### Cited Findings
- **README:** transmits files "using a simple headset, allowing true air-gapped communication (via a speaker and a microphone), or an audio cable (for higher transmission speed)." A "single manual calibration step" is required to find an output volume that "will not saturate the receiving microphone." — [amodem README](https://github.com/romanz/amodem)
- **Technical details:** "OFDM over an audio cable": Fs 8/16/32 kHz, "Baud rate: 1 kHz", BPSK, 4-PSK, 16/64/256-QAM, "Carriers: 2-11 kHz (up to ten carriers)", "may achieve 80kbps bitrate = 10 kB/s (for best SNR)" (**cable**). CRC-32 "on each 250 byte data frame". The default without `BITRATE` is "1 kbps settings (single frequency with BPSK modulation)". — [amodem README](https://github.com/romanz/amodem)
- **Config table (source):** bitrates 1, 2, 4, 8, 12 … 80 kbps.
  - 1 kbps = Fs 8 kHz, 2 points, carrier 2 kHz.
  - 8 kbps = 16-QAM on 1 and 2 kHz.
  - 80 kbps = 256-QAM on 2–11 kHz at Fs 32 kHz.
  - `Tsym = 0.001` s; carriers spaced at the baud rate (`np.arange(first, last + baud, baud)`).
  - [amodem/config.py](https://github.com/romanz/amodem/blob/master/amodem/config.py)
- **Training/preamble:** `equalizer_length = 200`, `silence_length = 50`, prefix = 200 symbols of carrier + 50 silent symbols, then equalizer training symbols. The example log shows "Sending 2.150 seconds of training audio" at 48 kbps. — [amodem/equalizer.py](https://github.com/romanz/amodem/blob/master/amodem/equalizer.py), [README](https://github.com/romanz/amodem)
- **No full duplex:** `audio.py` contains `assert read != write  # don't support full duplex`. — [amodem/audio.py](https://github.com/romanz/amodem/blob/master/amodem/audio.py)
- **License and maintenance:** `pyproject.toml` declares MIT. Last commit 2025-11-12 (git clone). — [amodem pyproject.toml](https://github.com/romanz/amodem/blob/master/pyproject.toml)

### Inferences
- Over-the-air phone use would realistically sit at the 1–8 kbps settings (BPSK/QPSK on 1–3 carriers) and would need the 2 s training sequence shortened, plus automatic gain handling. Porting numpy demod + LMS equalizer to an AudioWorklet is feasible (a few hundred lines), but it is effectively a new modem.
- Its burst structure (long training, file-oriented) is wrong for 100 ms lockstep turns as-is. A continuous-carrier version, where the equalizer trains once and then streams, would be the relevant adaptation.

### Gaps
- No published acoustic (speaker-to-mic) throughput numbers for amodem were retrieved. The HN thread (item 17333257) was not fetched.

---

## 4. minimodem (Kamal Mostafa)

### Takeaway
minimodem is a classic single-tone FSK modem (Bell 202 1200 bps, Bell 103 / V.21 300 bps, RTTY 45.45, SAME 520.83, etc.). It is GPL-3, C, native-only (no WASM port found), and last touched in 2021. Its rates bracket the target (300–1200 bps), and Bell 103 / V.21 are historically **frequency-division full duplex** designs, which makes it a useful design reference. But single-carrier binary FSK at 1200 baud is fragile in reverberant rooms.

### Cited Findings
- **Modes (man page):** any N → "Bell202-style at N bps"; `1200` Bell202 1200 bps; `300` Bell103 300 bps; `V.21` 300 bps "(V.21 mark/space frequencies)"; `rtty` 45.45 bps; `tdd` 45.45 bps; `same` 520.83 bps; `callerid` Bell202 1200 bps; `uic-train` 600 bps. — [minimodem.1.in](https://github.com/kamalmostafa/minimodem/blob/master/src/minimodem.1.in)
- **License and maintenance:** GPL v3 or later (COPYING). Last commit 2021-07-17 (git clone). — [minimodem repo](https://github.com/kamalmostafa/minimodem)
- A third-party docs mirror suggests ≤100 bps "for best results through air" and says 300 bps works only in ideal conditions. Another guide recommends 300 baud for acoustic links. These are not authoritative and not measured. — [Mintlify mirror: use cases](https://www.mintlify.com/kamalmostafa/minimodem/resources/use-cases)

### Inferences
- **Background, not verified this session:** Bell 103 uses separate originate and answer tone pairs, i.e. FDD full duplex. Copying that idea (one band per phone) is exactly what Battle Drones needs.
- cho45's WebAudio-Modem (§7) already implements Bell-103-originate-like 1070/1270 Hz FSK at 300 baud in an AudioWorklet.

### Gaps
- No measured over-the-air (phone or laptop) minimodem results found. No browser/WASM port found.

---

## 5. Commercial / proprietary: Chirp.io, LISNR, Cue Audio, Trillbit, Google Nearby / Copresence

### Takeaway
All commercial systems are low-rate (≈ 25–300 bps shipped, LISNR's 1–3 kbps only "beta"), one-way broadcast "token" systems. None is available as a browser library today: Chirp's SDKs died in 2020 after Sonos bought it, and Google's Nearby Messages audio tokens were retired at the end of 2023. They are useful only as evidence that near-ultrasonic phone-to-phone links run at about 100 bps when robustness is the priority.

### Cited Findings
- **Chirp.io:**
  - Sonos acquired Chirp's IP and assets on 2020-02-13, and Chirp's SDKs were "no longer publicly accessible after March 1, 2020". — [Wikipedia: Chirp (company)](https://en.wikipedia.org/wiki/Chirp_(company)), [Dealroom](https://app.dealroom.co/companies/chirp_1), [audioXpress](https://audioxpress.com/news/data-over-sound-pioneer-chirp-acquired-by-sonos)
  - A 2019 blog noted the SDKs disappeared and pointed to ggwave as the open-source replacement. — [newscrewdriver.com](https://newscrewdriver.com/2019/07/16/window-shopping-chirp-io-with-focus-on-esp32)
  - Chirp's "standard protocol" could "send up to 50 bits of data", and a custom version for a game publisher carried about 20× more (no per-second rate given). — [element14 interview](https://hk.element14.com/chirp-io-interview-internet-of-sound)
  - Chirp patents describe sending roughly 32–1024 bits as audio between co-located devices. — [USPTO 10025870](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/10025870)
- **LISNR:** commercial software "300bps", "beta tech … 1,000-3,000bps" (article date unknown; may be stale). — [Digital Trends](https://www.digitaltrends.com/?p=1182389). The Radius SDK is "one-to-many long-range ultrasonic data transfer … greater than 10ft". — [TrustRadius](https://www.trustradius.com/products/lisnr-radius)
- **Cue Audio:** its technical overview lists 26 payload bits/s; the FAQ cites "high-reliability transmissions of 25 bits per second"; band 17.5–19.5 kHz. (Via search summary; the PDF URL now 301-redirects to connectwithcue.com.) — [Cue technical overview](https://cueaudio.com/documents/16/cue-technical-overview.pdf), [Cue FAQ: acoustic modem](https://cueaudio.com/frequently-asked-questions/acoustic-modem)
- **Trillbit:** no published bitrate found; described as near-ultrasonic, encrypted data-over-sound. — [Analytics India Mag](https://analyticsindiamag.com/how-bengaluru-based-startup-trillbit-is-creating-the-internet-of-sound)
- **Google Nearby (audio tokens):**
  - Getreuer, Gnegy, Lyon, Saurous, "Ultrasonic Communication Using Consumer Hardware", IEEE Trans. Multimedia 2018. The 18.5–20 kHz band carries a raw rate of 94.5 b/s, using DSSS with a 127-chip pseudorandom code per data symbol. Phone-to-phone was "reliable at 2 m and often worked at 10 m"; it is a component of Google's Nearby platform. — [academia.edu copy](https://www.academia.edu/164596957/Ultrasonic_Communication_Using_Consumer_Hardware); also listed as "Smartphone to smartphone, 94.5 bps, 2 m" in [arXiv 2103.11261](https://ar5iv.labs.arxiv.org/html/2103.11261)
  - Putz et al. re-implemented "Nearby" as DSSS + MFSK, 18.5–20 kHz, 84 bps nominal: "reliable within 1 m but unreliable farther out" in an office, and robust to noise except pocketing. — [arXiv 2602.02249](https://arxiv.org/html/2602.02249)
  - Nearby Messages is deprecated: per Google's docs it "will stop functioning in December 2023"; migrate to Nearby Connections. — [Google Nearby Messages docs](https://developers.google.cn/nearby/messages/android/get-started?hl=en)
- **Academic near-ultrasonic, for scale:**
  - ChirpCast gives "robust room-specific broadcasting at data rates of 200 bits/second". — [arXiv 1508.07099](https://arxiv.org/pdf/1508.07099)
  - Laptop-to-laptop QPSK at a 19 kHz carrier, 2 kHz symbol rate, with a decision-feedback equalizer, achieved 4 kbps, error-free to 2 m (laptops only, not phones). Frame = Frank-code pilot + 0.3 s guard + 5120 data bits + CRC-32. — [arXiv 2103.11261](https://ar5iv.labs.arxiv.org/html/2103.11261)

### Inferences
- The proven phone-to-phone systems sit at about 15–270 bps when they prioritise robustness. Getting to 750 bps in each direction simultaneously is above anything with published phone-to-phone validation. 150–300 bps per direction is the realistic "known-good" zone.

### Gaps
- No public rate or latency data for Google "Copresence" beyond the Nearby paper. LISNR's current SDK rates and browser availability are unknown. Chirp's last SDK protocol parameters (tone count and duration) were not found in accessible sources.

---

## 6. codec2 / FreeDV data modes (datac0/1/3/4/13/14) and WASM availability

### Takeaway
codec2's OFDM data modes are well-engineered, LDPC-coded burst modems. DATAC0 carries 14 bytes in 0.44 s in 500 Hz (291 bps). DATAC1 carries 980 bps in 1.7 kHz but needs 4.18 s frames. They are designed for HF radio, are LGPL-2.1, have no WASM port that I could find, and have no reported speaker-to-mic use. Their small bandwidth makes FDD duplex easy on paper, but frame durations of 0.44–5 s miss the 100 ms latency target.

### Cited Findings
- **OFDM raw data modes table:**

  | Mode | Bandwidth | Payload rate | Bytes/frame | LDPC code | Frame duration |
  |---|---|---|---|---|---|
  | DATAC0 | 500 Hz | 291 bps | 14 B | (256,128) | 0.44 s |
  | DATAC1 | 1700 Hz | 980 bps | 510 B | (8192,4096) | 4.18 s |
  | DATAC3 | 500 Hz | 321 bps | 126 B | (2048,1024) | 3.19 s |
  | DATAC4 | 250 Hz | 87 bps | 54 B | (1472,448) | 5.17 s |
  | DATAC13 | 200 Hz | 64 bps | 14 B | (384,128) | 2.0 s |
  | DATAC14 | 250 Hz | 58 bps | 3 B | (112,56) | 0.69 s |

  - Payload excludes a 2-byte CRC. DATAC0/13/14 are intended for "Reverse link ACK packets".
  - The FSK_LDPC default is 100 bps 2FSK with (512,256) LDPC, giving a 44.1 bps payload rate in the example.
  - Bursts carry a preamble and postamble.
  - [codec2 README_data.md](https://github.com/drowe67/codec2/blob/main/README_data.md)
- **License:** codec2 is LGPL 2.1, C99, and several FreeDV voice modes are "no longer actively maintained" (data modes not named). — [codec2 mirror README](https://gitee.com/youysh/codec2)
- **No WASM/JS port of the FreeDV data modem** turned up in searches for "codec2 emscripten/wasm/freedv web". — search: [codec2 wasm query results](https://github.com/drowe67/codec2/blob/main/README_freedv.md)

### Inferences
- DATAC0 (14 B / 0.44 s, 500 Hz) is the closest fit. One DATAC0 burst per turn per direction in two non-overlapping 500 Hz slots would give about 112 bits per 0.44 s each way. That is OK for ≥ 0.5 s turns, but HF-tuned OFDM (cyclic prefix sized for ionospheric delay spread) may not match room acoustics with "delay spreads of tens of milliseconds" (Putz et al.).
- Compiling codec2's C to WASM is plausible (plain C99, no OS deps), but that is new work.

### Gaps
- No acoustic (speaker-to-mic) or phone reports found for datac modes. Exact preamble and postamble durations were not on the README page. No measured end-to-end latency.

---

## 7. Other browser / JS audio modems (AudioNetwork, sonicnet.js, WebAudio-Modem, BUM16, euphony.js, etc.) and academic schemes with phone data

### Takeaway
The JS-native modems are hobby-grade: low rate (single-tone FSK, often ≤ tens of bps), no published phone-to-phone numbers, and mostly abandoned. A few newer ones (cho45/WebAudio-Modem, BUM16 in 2026) use AudioWorklet, 300-baud FSK or 16-FSK with CRC and ARQ, i.e. the same class as Chirp Pong. The best phone-to-phone evidence comes from Putz et al. (2026), which shows that higher-rate audible schemes (OFDM 600 bps, MFSK 729 bps) degrade sharply indoors and across phone models.

### Cited Findings
- **AudioNetwork (Robert Rypuła):**
  - TypeScript/JS, MIT. It started with PSK + OFDM (with "Multiple channel support for parallel transmission without collisions"), but PSK "was not working reliable on mobile devices", so v1.2.0 (2017-12-28) rewrote the physical layer as FSK with a correlation-based sync.
  - v1.3.0 added a data link layer with "up to 7 bytes of data … inside frame with header and checksum (Fletcher-8)" and "TwoWaySync".
  - The last npm release is 1.3.2, 2018-05-16; the last commit is 2018-05-16.
  - FSK defaults in source: `fftSize 8192`, `unitTime 0.25` s, `samplePerSymbol 2`, `symbolRange = 256 + 2` (one byte per symbol + 2 sync symbols), `txSampleRate 44100`.
  - [AudioNetwork README](https://github.com/robertrypula/AudioNetwork), [CHANGELOG](https://github.com/robertrypula/AudioNetwork/blob/master/CHANGELOG.md), [physical-layer-builder.js](https://github.com/robertrypula/AudioNetwork/blob/master/src-still-es5/physical-layer/physical-layer-builder.js)
- **sonicnet.js (Boris Smus, 2013):**
  - "Single-tone multi-frequency signaling": one frequency band per character, AnalyserNode FFT receiver.
  - Tested Chrome-to-Chrome on MacBooks and Chrome Android (beta) to Chrome Mac. Phone mics "may not capture high frequencies", so links may be "one-way only".
  - No bit rate stated.
  - npm `sonicnet` 0.2.7 (2017-09-24, Apache-2.0).
  - [smus.com/ultrasonic-networking](https://smus.com/ultrasonic-networking), [npm registry](https://registry.npmjs.org/sonicnet)
- **cho45/WebAudio-Modem:** MIT, phase-continuous FSK with I/Q detection in an `AudioWorkletProcessor`. The example config is `baud: 300`, `markFreq: 1270`, `spaceFreq: 1070`, `sampleRate: 48000`, with an XModem-style transport (stop-and-wait ARQ, CRC-16, fragmentation). No over-the-air results published. — [github.com/cho45/WebAudio-Modem](https://github.com/cho45/WebAudio-Modem)
- **BUM16 ("Benn's Ultrasonic Modem using 16-FSK"):** browser-only, 16.5–19.0 kHz, CRC32 packets, preamble and sync-tone detection. Latest commit 2026-08-02. No rate, duplex or phone results stated; license not stated. — [zff.dev/ohmlab/BUM16](https://zff.dev/ohmlab/BUM16)
- **euphony.js:** "acoustic data telecommunication library for the web", Apache-2.0, 1 star. No modulation or rate documented on the README page. — [github.com/designe/euphony.js](https://github.com/designe/euphony.js)
- **ryunosinfx/webaudio-modem:** text transfer between devices via Web Audio; its buffered version uses Hamming(7,4) + parity. — [npm: webaudio-modem](https://npmjs.com/package/webaudio-modem) (via search summary)
- **Putz et al. 2026 phone-to-phone testbed (8 schemes):**

  | Scheme | Modulation and band | Nominal rate |
  |---|---|---|
  | Lee et al. | chirp BOK, 19.5–22 kHz | 15 bps |
  | Digital Voices | MFSK, 1–3 kHz | 80 bps |
  | Nearby | DSSS + MFSK, 18.5–20 kHz | 84 bps |
  | ggwave audible | MFSK, 1.8–6.3 kHz | 268 bps |
  | ggwave inaudible | MFSK, 15–19.5 kHz | 268 bps |
  | HRCSS | chirp-based, 18–22 kHz | 500 bps (dropped for "extremely high TER") |
  | Gonçalves et al. | OFDM + QPSK, 0.1–4 kHz | 600 bps |
  | PriWhisper | MFSK, 9–17 kHz | 729 bps |

  - Across 5 phone models at 50 cm in an office:
    - Gonçalves OFDM ranged from 5% to 32% total error rate.
    - PriWhisper worked only with a Pixel 6 Pro transmitter (3%) and "failed in other pairs".
    - Digital Voices reached about 12% on one pair.
    - Lee et al. and both ggwave variants were "consistently very low".
  - Findings: "up to 30 dB SPL spread between phones at the same volume setting", "most devices suffer from nonlinear distortions at volume settings above approximately 75%", and "Most acoustic links are unidirectional, so no feedback-based gain control is possible".
  - Recommendations: guard intervals for "delay spreads of tens of milliseconds", strong FEC plus time interleaving, and "Favor robustness and aggressive error control unless bi-directional link adaptation is feasible".
  - Code and dataset: [Zenodo 10.5281/zenodo.17661991](https://dx.doi.org/10.5281/zenodo.17661991).
  - Source: [arXiv 2602.02249](https://arxiv.org/html/2602.02249)

### Inferences
- None of the JS-native libraries beats ggwave on documented rate or robustness. cho45/WebAudio-Modem and BUM16 are architecturally similar to Chirp Pong and offer little new beyond AudioWorklet structure and ARQ framing.
- The Putz results suggest that, between arbitrary phones, about 270 bps MFSK with RS is the highest-rate scheme with demonstrated cross-device robustness. 600–730 bps audible schemes did not hold up. Reaching 750 bps each way full duplex would be beyond the state of practice; about 150–300 bps per direction is achievable with ggwave-class designs.
- JS8/FT8 (background, not verified this session) are far too slow (FT8 is about 77 bits per 15 s slot) and only matter as examples of extreme-robustness weak-signal design.

### Gaps
- Quietnet, Dolphin.js, TxRx and "webmodem" could not be located or verified in this session. No rates found for euphony.js or BUM16.
- I did not inspect the Putz Zenodo code for symbol timings of the re-implemented schemes.

---

## 8. Which support two simultaneous directions (FDD full duplex) vs one-way broadcast only? Overall comparison

### Takeaway
Only **quiet-lwip with the `audible-7k-channel-0/1` profile pair** has demonstrated simultaneous two-way over-the-air operation, and only on a single laptop, not phone to phone. ggwave (configurable Tx/Rx frequency bands), AudioNetwork's deprecated multi-channel PSK, and the Bell 103 / V.21 FDD concept (minimodem modes) make duplex possible by band splitting. Everything else (amodem, Chirp, LISNR, Cue, Nearby, FreeDV datac, sonicnet, BUM16, WebAudio-Modem) is one-way broadcast or half-duplex ARQ.

### Cited Findings
- **quiet-lwip:** "the full-duplex pair `audible-7k-channel-0/audible-7k-channel-1`" over the air; examples use encoder `audible-7k-channel-0` / decoder `audible-7k-channel-1` on the client, and the reverse on the server. — [quiet-lwip README](https://github.com/quiet/quiet-lwip), [discovery_client.c / kv_server.c](https://github.com/quiet/quiet-lwip/tree/master/examples/src)
- **ggwave:** per-protocol `freqStart` setters and Rx/Tx protocol toggles exist. — [ggwave.h](https://github.com/ggerganov/ggwave/blob/master/include/ggwave/ggwave.h). A ggwave-based messaging tool "stops listening while transmitting". — [BleepingComputer](https://www.bleepingcomputer.com/news/software/new-chirp-tool-uses-audio-tones-to-send-messages-between-devices/)
- **amodem:** "don't support full duplex" assertion. — [amodem/audio.py](https://github.com/romanz/amodem/blob/master/amodem/audio.py)
- **AudioNetwork (old PSK):** "Multiple channel support for parallel transmission without collisions". — [AudioNetwork README](https://github.com/robertrypula/AudioNetwork)
- **FreeDV datac:** separate "Reverse link ACK packets" modes (DATAC0/13/14), i.e. a half-duplex ARQ design. — [codec2 README_data.md](https://github.com/drowe67/codec2/blob/main/README_data.md)
- **Putz et al.:** "Most acoustic links are unidirectional". — [arXiv 2602.02249](https://arxiv.org/html/2602.02249)
- **Browser modems disable echo cancellation:** ggwave-js sets `echoCancellation:false, autoGainControl:false, noiseSuppression:false`; quiet-js sets `echoCancellation:false`. — [ggwave-js example](https://github.com/ggerganov/ggwave/blob/master/examples/ggwave-js/index-tmpl.html), [quiet.js](https://github.com/quiet/quiet-js/blob/master/quiet.js)

### Inferences

Comparison summary, ranked for the Battle Drones use case:

| System | Modulation / FEC | Rate over the air | Per-frame overhead / latency | Browser / WASM | Duplex | License | Status (Oct 2026) |
|---|---|---|---|---|---|---|---|
| **ggwave** | 6-tone parallel 16-FSK, 46.875 Hz grid, RS (~40%) | 268 bps net Fastest (phone-validated, Putz 2026); 134 Fast; 89 Normal | Variable mode +683 ms markers; fixed mode none (4 B ≈ 192 ms, 10 B ≈ 320 ms) | Yes: Emscripten WASM, npm `ggwave` 0.4.0 (2022) | Not built in; configurable bands make FDD feasible | MIT | Repo touched Apr 2026; npm stale since 2022 |
| **Quiet / quiet-js** | GMSK, OFDM (16-pt, 48 sc), BPSK, FSK8/16, DSSS; v27/v29 conv + RS8; CRC32 | Laptop full duplex ~3.1 kbps avg / ~6.4 kbps peak (same-laptop loop); phone figures unknown; ≥40 kbps cable only | 63-sym preamble + ~112-sym header per GMSK frame; quiet-js 16384-sample buffers add ~0.3–0.4 s per side | Yes, but old Emscripten (.mem), ScriptProcessor; libfec (LGPL) needed; Safari receive "not supported" (old note) | **Yes**: audible-7k-channel-0/1 FDD pair | BSD-3 + MIT (+LGPL libfec) | Abandoned (2019 / 2021) |
| amodem | 1 kbaud/carrier, BPSK–256QAM, CRC32 | 80 kbps **cable**; air unknown | ~2.15 s training per transmission | No (Python) | No (asserted) | MIT | Maintained (2025) |
| minimodem | Single-tone FSK (Bell 202/103, V.21, RTTY) | 1200 / 300 / 45 bps nominal; air unknown | Async start/stop bits | No | FDD in Bell 103 / V.21 concept, not implemented as duplex | GPL-3 | 2021 |
| FreeDV datac | OFDM + LDPC, burst | 291 bps (DATAC0, 500 Hz), 980 bps (DATAC1) on HF radio; acoustic unknown | 0.44–5.17 s frames | No port found | Half duplex ARQ | LGPL-2.1 | Active project, voice modes partly unmaintained |
| AudioNetwork | FSK (1 byte/symbol, FFT 8192) | ~2 B/s inferred from defaults | 7-byte frames, Fletcher-8 | Pure JS | Old PSK multi-channel only | MIT | Dead since 2018 |
| sonicnet.js | 1 tone per character | Not stated | Not stated | Pure JS | No | Apache-2.0 | 2017 |
| WebAudio-Modem (cho45) | 300-baud FSK, CRC-16, stop-and-wait ARQ | 300 baud nominal | XModem-style | AudioWorklet | No | MIT | Active (date unclear) |
| BUM16 | 16-FSK 16.5–19 kHz, CRC32 | Not stated | Preamble + sync tone | Browser | Not stated | ? | Aug 2026 |
| Chirp / LISNR / Cue / Nearby | FSK / DSSS near-ultrasonic tokens | 25–300 bps (LISNR "beta" 1–3 kbps); Nearby 94.5 bps raw | Token broadcast | No browser SDK (Chirp dead 2020, Nearby Messages retired 2023) | One-way | Proprietary | Mostly defunct |

- **Bottom line for the report writer:**
  - No off-the-shelf browser library delivers full-duplex, ≤ 150 ms, 150–750 bps phone-to-phone.
  - The closest building blocks are:
    - (a) ggwave's fixed-length mode (WASM, MIT, about 250 bps per band, phone-validated), run as two disjoint frequency bands. This would be roughly 10–20× Chirp Pong's 12 bps net, at 0.2–0.5 s per message.
    - (b) Quiet's GMSK/OFDM FDD-pair design ported to a modern WASM + AudioWorklet build, for higher rates but unproven on phones.
  - Sub-150 ms one-way latency at 100 ms turns probably requires a continuous-stream design (no per-frame preamble, sliding-window or continuous-sync decoding, small AudioWorklet blocks). None of the surveyed libraries provides that out of the box.

### Gaps
- No source measures **simultaneous** two-way acoustic links between **two phones** (self-interference and the AGC/AEC behaviour of phone browsers in that setting).
- No measured end-to-end (mic-to-decoded) latency for any browser modem.
- iOS Safari behaviour with the ggwave WASM build is undocumented.
