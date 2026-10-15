# WASM/JS signal-processing building blocks and full-duplex design options for a browser acoustic modem (two phones, 0.1–1 m)

Scope: libraries (WASM/JS DSP, FFT, FEC, echo cancellers), synchronization for short frames, full-duplex options, adaptive rate, prior art, and browser constraints (iOS Safari and Android Chrome, static GitHub Pages with no COOP/COEP headers). Research date: 2026-10-15.

Baseline for comparison: the current Battle Drones prototype uses differential 16-FSK with 50 ms symbols (80 bps raw), two 1.6 kHz bands between 1.4 and 5 kHz, a 100 ms sync tone, CRC-8, stop-and-wait ARQ, and Goertzel detectors in plain JS. It is effectively half-duplex because the low-band phone's harmonics land in the high band.

Local measurements in these notes came from npm tarballs and GitHub raw files downloaded to a scratch directory, and from a small Node 22 benchmark on a 2.8 GHz Xeon server. They are labelled "local measurement". Server timings are not phone timings, and any phone-speed scaling below is an estimate.

## Q1. WASM DSP libraries (liquid-dsp/Quiet, FFT libraries) and real-time feasibility at 48 kHz on phones

### Takeaway
liquid-dsp, via Quiet.js, is the only ready-made OFDM-plus-FEC modem stack for the browser. The shipped quiet-js build is dated: it is an asm.js-era Emscripten build of about 672 KB (184 KB gzipped) plus a 46 KB `.mem` file, it runs on a deprecated ScriptProcessorNode, and its convolutional and Reed-Solomon codes depend on LGPL libfec. It would need rebuilding to WASM, with only the needed modules and libcorrect in place of libfec, and wrapping in an AudioWorklet. The raw DSP load is small. A real FFT of 512–2048 points costs microseconds in plain JS, so plain-JS FFT (fft.js, about 22 KB) or a small WASM FFT (PFFFT, KissFFT, RustFFT) all fit an AudioWorklet's 2.67 ms render quantum with plenty of headroom. The real cost drivers are long time-domain correlations and adaptive filters, not FFTs.

### Cited Findings
**liquid-dsp, Quiet and quiet-js**
- quiet-js is libquiet compiled with Emscripten plus a JS binding. It statically includes liquid DSP and libjansson (both MIT). "It is strongly recommended to also include libfec.js": without it, profiles using convolutional or Reed-Solomon codes won't work. Quiet and quiet-js are BSD-3-Clause, and libfec is LGPL. — [quiet-js README](https://github.com/quiet/quiet-js)
- The quiet-js README (dated) lists these browser limits: Safari receivers unsupported, Chrome and Firefox on Android receivers "partially supported, GMSK profiles only", and Firefox resampling input to 32 kHz, which kills ultrasonic profiles. Cable profiles reach ≥40 kbps. — [quiet-js README](https://github.com/quiet/quiet-js)
- Local measurement of quiet-js master files:
  - `quiet-emscripten.js` is 672,029 bytes (183,586 gzip -9).
  - `quiet-emscripten.js.mem` is 46,188 bytes (19,568 gzip). A `.mem` file indicates an asm.js-style Emscripten build rather than WASM.
  - `quiet.js` is 37 KB.
  - `libfec.js` is not in the repo (404).
  - [quiet-emscripten.js](https://raw.githubusercontent.com/quiet/quiet-js/master/quiet-emscripten.js); [quiet.js](https://raw.githubusercontent.com/quiet/quiet-js/master/quiet.js)
- quiet.js creates its transmitter and receiver with `createScriptProcessor` (ScriptProcessorNode). Its getUserMedia constraints set `echoCancellation: false` plus the legacy `goog*` AGC, NS and high-pass flags to false. — [quiet.js source](https://raw.githubusercontent.com/quiet/quiet-js/master/quiet.js)
- Quiet profile examples (local inspection of `quiet-profiles.json`):
  - `audible`: GMSK at 4.2 kHz center with v27 inner FEC.
  - `ultrasonic-3600`: OFDM, 64 subcarriers, CP 20, v27, at 18.5 kHz.
  - `audible-7k-channel-0` and `audible-7k-channel-1`: identical OFDM profiles (48 subcarriers, CP 8, taper 4, `arb16opt` modulation, v29 inner plus rs8 outer, CRC-32), centered at 9.2 kHz and 15.5 kHz respectively.
  - `audible-fsk`, `audible-fsk-robust` and `audible-fsk-fast`: 8-FSK at 8 kHz.
  - `wideband-dsss`.
  - [quiet-profiles.json](https://raw.githubusercontent.com/quiet/quiet-js/master/quiet-profiles.json)
- liquid-dsp `ofdmflexframe` preamble and header:
  - The preamble is two S0 symbols (no cyclic prefix; coarse CFO and timing) plus one S1 symbol (fine timing, initial equalizer).
  - The header carries 14 bytes (6 internal, 8 user) and is FEC-encoded onto the first OFDM symbols.
  - Payload uses separate inner and outer FEC (`fec0`/`fec1`) and a configurable CRC.
  - Each subcarrier can be set to NULL, PILOT or DATA. At least 2 pilots and 1 data carrier are required.
  - Pilots are pseudo-random BPSK and track residual phase, frequency and timing.
  - [liquid ofdmflexframe docs](https://liquidsdr.org/doc/ofdmflexframe/)
- liquid-dsp `ofdmflexframe` performance and guidance (M = 64, default allocation):
  - 90% frame detection at about −0.4 dB SNR, and 90% detection plus header decode at about 2.6 dB SNR.
  - Synchronization works best with ≥32 active subcarriers.
  - A 4-sample CP suits short-range links.
  - Amplifiers need back-off for linearity with many subcarriers.
  - [liquid ofdmflexframe docs](https://liquidsdr.org/doc/ofdmflexframe/)
- libcorrect is a BSD-3-Clause C library providing convolutional codes (Viterbi decoding) and Reed-Solomon. It is "the error-correction component for libquiet" and intended as a drop-in BSD substitute for libfec, with a `make shim` compatibility layer. Its optional SSE build needs SSE4 (not applicable to WASM, so the portable C path would be used). — [libcorrect](https://github.com/quiet/libcorrect)

**FFT options**
- Google's AudioWorklet design-pattern article describes the timing budget: the render quantum is 128 frames ("only 3ms at 44.1 kHz"), and missing it causes glitches. — [Chrome: Audio Worklet design pattern](https://developer.chrome.com/blog/audio-worklet-design-pattern)
- It recommends WASM partly because it avoids JIT and GC overhead in the audio path. — [Chrome: Audio Worklet design pattern](https://developer.chrome.com/blog/audio-worklet-design-pattern)
- pffft.wasm (PFFFT compiled to WASM, 2022 post):
  - The SIMD build is "much faster" than the non-SIMD build.
  - FFT.js on Chrome is about 2× faster than on Firefox.
  - The WASM builds perform nearly identically in Chrome and Firefox.
  - Safari, which lacked WASM SIMD at the time, failed to run the SIMD benchmark.
  - No numeric figures appear in the text.
  - [0110.be pffft.wasm post](https://0110.be/posts/pffft.wasm%3A_an_FFT_library_for_the_web)
- WebFFT is a meta-library that bundles several JS and WASM FFT backends and profiles them at runtime (`fft.profile()`) to pick the fastest. — [webfft on npm](https://www.npmjs.com/package/webfft)
- PulseFFT (KissFFT compiled to WASM) reports WASM is consistently faster than asm.js at larger sizes. — [PulseFFT](https://github.com/AWSM-WASM/PulseFFT)
- RustFFT has an opt-in `wasm_simd` feature and an `FftPlannerWasmSimd` planner. A SIMD binary traps on runtimes without fixed-width SIMD, so a non-SIMD fallback build is needed. — [RustFFT docs](https://docs.rs/rustfft/latest/rustfft/)
- WASM SIMD is supported from Chrome 91, Firefox 89 and Safari 16.4 (March 2023). — [Emscripten SIMD docs](https://emscripten.org/docs/porting/simd.html)
- Package sizes (local measurement of npm tarballs):
  - `fft.js` 4.0.4: about 22 KB unpacked, MIT ([npm](https://www.npmjs.com/package/fft.js)).
  - `pretty-fast-fft` 1.1.0 (pffft.wasm wrapper): `pffft.simd.js` is 120 KB raw / 59 KB gzip, with the wasm embedded ([pretty-fast-fft](https://github.com/stagas/pretty-fast-fft)).
  - `webfft` 1.0.3: bundle 116 KB / 46 KB gzip ([npm](https://www.npmjs.com/package/webfft)).
- `ggwave` npm 0.4.0 (Emscripten build, wasm embedded in JS) is 154 KB raw / 61 KB gzip by local measurement. ggwave's own throughput is only 8–16 bytes/s. — [ggwave](https://github.com/ggerganov/ggwave); [ggwave npm](https://www.npmjs.com/package/ggwave)

**Other WASM modem stacks**
- `@packet-net/soundmodem` 0.92.0 (published 2026-10-15, AGPL-3.0) is the pdn-soundmodem DSP core compiled to WASM with a Web Audio graph. Its modes include AFSK, BPSK, QPSK, FSK and IL2P, plus "the MIL-STD-188-110D and FreeDV families". — [npm @packet-net/soundmodem](https://www.npmjs.com/package/@packet-net/soundmodem)
- It is a .NET build. By local measurement, `dotnet.native.wasm` alone is 7.27 MB (2.36 MB gzip), and the separate OFDM module (47 KB) and LDPC module (340 KB) are small. — [npm @packet-net/soundmodem](https://www.npmjs.com/package/@packet-net/soundmodem)

### Inferences
- **Local benchmark (fft.js, Node 22, 2.8 GHz Xeon):**

  | Operation | Time per call | Share of real time |
  |---|---|---|
  | `realTransform` N=256 | 1.6 µs | about 0.06–0.1% at 50% overlap (all sizes) |
  | `realTransform` N=512 | 4.2 µs | ↑ |
  | `realTransform` N=1024 | 7.8 µs | ↑ |
  | `realTransform` N=2048 | 22 µs | ↑ |
  | `realTransform` N=4096 | 43 µs | ↑ |
  | 32-bin Goertzel bank, one 50 ms window (2400 samples) | 304 µs | about 0.6% |
  | Direct-form 960-tap (20 ms) correlation over one 128-sample quantum | 167 µs | about 6% of the 2.67 ms quantum |
  | 512-tap time-domain NLMS over one quantum | 163 µs | about 6% |

  Even if a mid-range phone is 5–10× slower, an assumption not benchmarked here, FFT-based OFDM demodulation stays at a few percent of one core. Long direct-form correlations and long time-domain adaptive filters could reach 30–60% of the quantum on a phone. Those should run in the frequency domain (overlap-save correlation, partitioned-block frequency-domain adaptive filtering) or on decimated baseband.
- **WASM is not needed for raw speed.** For the receiver's FFT work, plain TypeScript with fft.js is adequate. WASM matters mainly for reusing mature C code (liquid-dsp sync/equalizer/FEC, libcorrect Viterbi, AEC3) and for predictable, GC-free timing inside the AudioWorklet.
- **A cleaner path than shipping quiet-js:**
  - Compile a subset of liquid-dsp to WASM with modern Emscripten: `ofdmflexframegen`/`ofdmflexframesync`, or lower-level `ofdmframe` with your own framing, plus the `fec` module.
  - Use libcorrect (BSD) instead of libfec (LGPL).
  - Expect a few hundred KB uncompressed, which is an estimate; quiet's asm.js build including jansson and the profile parser is 672 KB.
  - Note that liquid's default OFDM framing (3-symbol preamble plus a 14-byte FEC'd header) is heavy relative to 24–200-bit payloads. A custom lighter header is probably warranted (see Q3).
- **Quiet's two `audible-7k-channel-0/1` profiles** have identical parameters at different centers (9.2 and 15.5 kHz). That suggests the authors intended two simultaneous FDD channels. This is an inference; the README does not say so. Both are high-frequency and wide (about 7 kHz each), not suited to the 1.4–5 kHz region the prototype uses.

### Gaps
- No published numeric phone benchmarks (iOS Safari or Android Chrome) for fft.js, pffft.wasm or KissFFT-wasm in an AudioWorklet were found. The pffft.wasm post shows numbers only as screenshots.
- No current size figure for a modern WASM (not asm.js) build of liquid-dsp. No maintained npm package of liquid-dsp-wasm exists (npm search found none).
- liquid-dsp's interleaver module and `flexframe` (single-carrier) parameters were not verified from primary docs in this pass.
- FFTW-wasm, the dsp.js library and realfft were not evaluated. dsp.js is old and unmaintained to my knowledge, which is unverified.
- Whether quiet-js's README limitations (Safari receive unsupported, Android GMSK-only) still apply on 2026 browsers is unknown. They are likely obsolete, since Safari has had getUserMedia and AudioWorklet for years, but this was not tested.

## Q2. FEC for short frames (24–200 bits): which codes give the most gain, and what exists in WASM/JS

### Takeaway
For 24–200-bit frames, the best practical choices are:
- A tail-biting convolutional code with soft Viterbi decoding, e.g. K=7 rate-1/2 "v27". It is cheap, readily available in liquid-dsp and libcorrect, and about 4.3 dB Eb/N0 at BER 1e-5 soft (liquid's table), versus 9.6 dB uncoded.
- A CRC-aided polar code with list decoding (L=8–32), which approaches the finite-length bound at k≈64.
- A short LDPC such as FreeDV's (112,56), (256,128) or (384,128) codes, used for signalling frames of 3–14 bytes.

Reed-Solomon (255,223) and Hamming or Golay codes are clearly weaker at these lengths for random errors. The bigger win over the current CRC-8 plus stop-and-wait scheme is soft-decision decoding, plus either a CRC-16 or 2–3 frames of redundancy.

### Cited Findings
**liquid-dsp FEC table** (BPSK over AWGN, Eb/N0 for BER 1e-5, hard/soft) — [liquid FEC docs](https://liquidsdr.org/doc/fec/)
- Uncoded: 9.59 dB.
- Hamming(7,4): 9.15/7.79 dB.
- Hamming(12,8): 8.82/8.13 dB.
- Golay(24,12): 7.46 dB (hard only).
- SEC-DED(22,16)/(39,32)/(72,64): 8.84/8.29/8.05 dB.
- V27 (K=7, r=1/2): 6.44/4.29 dB.
- V29 (K=9, r=1/2): 5.79/3.78 dB.
- V39 (r=1/3): 5.41/3.59 dB.
- V615 (K=15, r=1/6): 3.81/2.00 dB.
- Punctured V27P34 (r=3/4): 7.33/5.29 dB.
- RS(255,223): 6.04 dB (hard only).
- Soft decoding generally gains about 1.5 dB. Golay, SEC-DED and RS do not support soft decoding.
- In liquid, all convolutional and RS codes require libfec.

**Short-blocklength comparison at (n=128, k=64)** — [Coşkun et al., "Efficient Error-Correcting Codes in the Short Blocklength Regime", arXiv 1812.08562](https://arxiv.org/abs/1812.08562)
- The finite-length bounds put the minimum Eb/N0 at about 3.5–3.7 dB for CER 1e-6.
- A tail-biting convolutional code with memory 14 comes within about 0.07 dB of the normal approximation at CER 1e-4. It is the best of the three codes at this length, but its decoding complexity is high.
- A memory-8 TBCC loses about 1 dB versus the best but still beats binary LDPC and turbo codes over the simulated range.
- A (128,64) polar code with list size L=8 is already close to the ML bound. A (128,71) polar code with CRC-7 at L=32 is "remarkably close" to the RCU bound and outperforms iterative codes.
- Binary LDPC and turbo codes are the least complex iterative options but are outperformed at this length. 5G NR BG2 LDPC is decent, while BG1 is severely degraded.
- Extended BCH with OSD order 4 comes within about 0.1 dB of the normal approximation, but OSD complexity grows quickly.
- SCL complexity grows linearly with list size.

**Polar vs TBCC for very short messages**
- For 32-bit messages, TBCCs and CRC-aided polar codes reach similar performance, with the polar codes showing an error floor at high Eb/N0. — [CRC-aided list decoding of convolutional and polar codes for short messages in 5G, arXiv 2201.07843](https://arxiv.org/pdf/2201.07843)
- A 5G IoT survey finds TBCC outperforms other codes at very short block lengths, but its performance degrades at lower code rates. — [IoT survey, arXiv 2107.03059](https://arxiv.org/pdf/2107.03059)
- A URLLC study reports polar codes outperforming other classes at about 256 bits. — [Short block-length codes for URLLC, arXiv 1802.09166](https://arxiv.org/pdf/1802.09166)

**FreeDV OFDM data modes**
- Each mode reserves 16 CRC bits per frame. — [codec2 README_data.md](https://github.com/drowe67/codec2/blob/main/README_data.md)

  | Mode | Payload per frame | Frame time | Payload rate | LDPC code | Bandwidth | Operating SNR |
  |---|---|---|---|---|---|---|
  | DATAC0 | 14 bytes | 0.44 s | 291 bps | (256,128) | 500 Hz | 0 dB |
  | DATAC13 | 14 bytes | 2.0 s | 64 bps | (384,128) | 200 Hz | −4 dB |
  | DATAC14 | 3 bytes | 0.69 s | 58 bps | (112,56) | 250 Hz | −2 dB |
  | DATAC1 | 510 bytes | not recorded | 980 bps | (8192,4096) | not recorded | not recorded |

- The signalling modes have a long packet-error tail on fading channels because they are short relative to the fading period. — [codec2 README_data.md](https://github.com/drowe67/codec2/blob/main/README_data.md)
- FreeDV's FSK_LDPC mode uses a 32-bit unique word per frame, a (512,256) LDPC example and a 16-bit CRC. — [codec2 README_data.md](https://github.com/drowe67/codec2/blob/main/README_data.md)
- FreeDV voice mode 700E uses LDPC (112,56) at 1500 bit/s raw. Modes B and C use shorter 90 ms frames for lower latency and faster sync at the cost of a few dB SNR. — [codec2 README_freedv.md](https://github.com/drowe67/codec2/blob/main/README_freedv.md)

**JS/WASM packages**
- libcorrect: BSD; convolutional codes with Viterbi decoding plus Reed-Solomon. — [libcorrect](https://github.com/quiet/libcorrect)
- ggwave: Reed-Solomon, with ECC length depending on payload length. — [ggwave](https://github.com/ggerganov/ggwave)
- npm Reed-Solomon packages are mostly erasure-coding (storage) oriented, e.g. `wasm-reed-solomon-erasure` and `@digitaldefiance/reed-solomon-erasure.wasm`. — npm registry search, e.g. [wasm-reed-solomon-erasure](https://www.npmjs.com/package/wasm-reed-solomon-erasure)
- Small `5g-ldpc` and `5g-polar` npm packages exist (2020, version 0.0.x). — [5g-polar on npm](https://www.npmjs.com/package/5g-polar)

### Inferences
- **Payload size matters.** For a lockstep input frame of about 24–64 bits, the frame is so short that the CRC and tail overhead matter as much as the code.
- **A practical recipe:**
  - Payload plus CRC-16 (cuts undetected errors versus CRC-8, which passes about 1/256 of corrupted frames).
  - A tail-biting K=7 rate-1/2 convolutional code (no tail bits), with soft-decision Viterbi or WAVA.
  - Bit-interleaving across OFDM subcarriers and symbols.
  - Expected gain: roughly 5 dB of soft coding gain over uncoded, by the liquid table (9.59 versus 4.29 dB at 1e-5, for terminated codes).
  - Tail-biting avoids the 6 tail bits, which would be a 10–25% overhead at these sizes.
- **A step up: polar.** A CRC-aided polar code (e.g. 5G-style with an 11-bit CRC, L=8) gives roughly another 1–2 dB at k≈64. The cost is more code (no mature small JS/WASM polar library was found) and SCL decoding, which is still trivial at about 10 frames/s.
- **LDPC.** FreeDV's (112,56) and (256,128) codes are proven in an audio-band OFDM modem. codec2 is believed to be LGPL-2.1 (licence not verified here). The parity-check matrices could be reimplemented in TS with a min-sum decoder.
- **Avoid for this use.** RS(255,223) shortened to short frames is a poor fit for AWGN-like soft channels: it is hard-decision only and byte-oriented. It is better suited to burst erasures. The same applies to Hamming and Golay, which are 2–4 dB worse than soft V27.
- **Latency vs ARQ.** In lockstep, retransmission costs a round trip (≥100–200 ms). Spending rate on FEC so that frame error rate is about 1% or less is likely better than ARQ-heavy designs. Repeating each frame's inputs in the next frame (redundant "last N ticks" payloads) is an application-layer alternative to ARQ.

### Gaps
- No benchmarked JS/WASM soft-Viterbi, polar SCL or LDPC decoder timings for phones were found. Decoding cost at about 10 frames/s is almost certainly negligible, but this is not measured.
- aff3ct (a C++ FEC toolbox) was not evaluated for WASM size or feasibility.
- codec2's licence and the extractability of its LDPC code tables were not verified in this pass.
- No paper was found comparing these codes specifically on in-air acoustic channels between phones.

## Q3. Synchronization for short, low-latency frames: preamble length, continuous streaming with pilots, clock drift

### Takeaway
At 0.1–1 m the link SNR is high, so a 10–20 ms wideband chirp or Zadoff–Chu (ZC) preamble detected by matched-filter cross-correlation is ample.
- Processing gain is about 10·log10(B·T): roughly 12 dB for 20 ms × 800 Hz, and up to 18–19 dB for 20 ms × 3.6 kHz. The preamble needs to fill as much bandwidth as the band allows.
- liquid's 3-symbol OFDM preamble detects at about −0.4 dB SNR.
- For lowest latency, run a continuous stream (always transmitting OFDM symbols) with scattered pilots and a periodic short sync symbol, rather than per-frame long preambles. This also simplifies full duplex, because each side's interference is stationary.

### Cited Findings
- liquid `ofdmflexframesync` uses two S0 symbols (no CP; coarse CFO and timing) and one S1 (fine timing and equalizer). It reaches 90% detection at about −0.4 dB SNR with M=64 subcarriers. — [liquid ofdmflexframe](https://liquidsdr.org/doc/ofdmflexframe/)
- Its pseudo-random BPSK pilots track slowly varying residual phase, frequency and timing errors, and RSSI and CFO can be read out. — [liquid ofdmflexframe](https://liquidsdr.org/doc/ofdmflexframe/)
- Acoustic OFDM systems on commodity devices typically put a chirp-type preamble before the packet to make detection easy. Chirp spread spectrum is described as more reliable than OFDM or FSK for long-range and mobile use. — [Ubiquitous acoustic sensing survey, arXiv 1901.03450](https://arxiv.org/pdf/1901.03450)
- A smartphone underwater acoustic ranging system reports that Zadoff–Chu-modulated OFDM preamble symbols perform "much better" than chirps, detected via cross-correlation against the known preamble, with cyclic prefixes against ISI. — [Underwater acoustic ranging between smartphones, arXiv 2209.01780](https://arxiv.org/pdf/2209.01780)
- Indoor smartphone chirp links address multipath delay spread; one reports error-free 70 m indoors at 20 bps. — [Shi et al., Physical Communication 2023](https://personalpages.surrey.ac.uk/w.wang/papers/Shi%20et%20al_PhysicalCommunication_2023.pdf)
- Frame combining helps mitigate multipath fading and noise on smartphones. — [IEEE Access 2020](https://doaj.org/article/d2a653edf02a47a0b3a61e5b4048c468)
- FreeDV's burst data modes use both a preamble and a postamble per burst to raise detection probability. In their example, P(miss) falls from 0.1 to 0.01 when both must be missed. — [codec2 README_data.md](https://github.com/drowe67/codec2/blob/main/README_data.md)
- FreeDV modes B and C use 90 ms frames for "lower latency and faster sync". — [codec2 README_freedv.md](https://github.com/drowe67/codec2/blob/main/README_freedv.md)
- Furnished living rooms typically have RT60 of about 0.5 s (100–3150 Hz). — [Burgess, IOA paper on British living-room reverberation times](https://www.ioa.org.uk/system/files/publications/M%20BURGESS%20THE%20EFFECTS%20OF%20CURRENT%20REVERBERATION%20TIMES%20IN%20BRITISH%20LIVING%20ROOMS.pdf)
- Critical distance is Dc ≈ 0.057·√(Q·V/T), and a typical living-room volume is about 60 m³. — [US patent 12136432](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/12136432)

### Inferences
- **Numerology example at 48 kHz:**
  - FFT N=512 gives Δf = 93.75 Hz and a useful symbol of 10.67 ms.
  - A 2 ms (96-sample) cyclic prefix covers the direct path plus early reflections at 0.1–1 m. Propagation at 1 m is about 2.9 ms, but that is a bulk delay; the CP only has to cover the spread.
  - Total symbol time is 12.67 ms, or about 79 symbols/s.
- **Rate in an 800 Hz band** (about 8 subcarriers, 2 of them pilots): DQPSK on 6 data carriers gives about 950 bps raw, or about 475 bps after rate-1/2 FEC. That is about 6× the current 80 bps in half the bandwidth.
- **A 24-bit lockstep frame** plus CRC-16 at rate 1/2 is 80 coded bits, which takes 7 symbols, or about 89 ms. A 10 ms sync symbol brings that to about 100 ms per frame.
- **Preamble length.** Processing gain of a chirp or ZC is about B·T:
  - 10 ms × 800 Hz ≈ 9 dB
  - 20 ms × 800 Hz ≈ 12 dB
  - 10 ms × 3.6 kHz ≈ 15.6 dB
  - 20 ms × 3.6 kHz ≈ 18.6 dB

  At 0.1–1 m with in-band SNR likely above 20 dB in a quiet room (not measured), a 10–20 ms preamble is enough for detection. False-alarm control (a CFAR threshold on normalized correlation) matters more than length. A preamble that is periodic in two halves (Schmidl–Cox style, like liquid's repeated S0) allows cheap autocorrelation detection with CFO and drift estimation, followed by one FFT-based cross-correlation for fine timing.
- **Continuous streaming option.**
  - Each phone transmits OFDM symbols continuously in its band, with idle symbols carrying pilots only.
  - A known sync symbol is inserted every K symbols (e.g. every 8th, about 100 ms).
  - The receiver stays locked: it tracks timing and sample-rate offset from the pilot phase slope across subcarriers, and the per-carrier channel from pilots.
  - Benefits: frame latency drops to symbol granularity (about 13 ms) instead of preamble-plus-acquisition, and the self-interference for full duplex becomes a stationary, predictable signal.
- **Clock drift.** Assume phone audio clocks differ by up to about ±100 ppm. This figure is an assumption, not sourced.
  - At 48 kHz that is about 4.8 samples/s, or 0.48 samples over a 100 ms frame.
  - For a 3 kHz subcarrier, 0.48 samples (10 µs) is about 11° of phase rotation across the frame: tolerable for DQPSK within a frame, but it must be tracked in continuous streaming.
  - It is estimated from the linear phase slope of pilots versus subcarrier index, or from successive sync-symbol correlation peaks, and corrected with a fractional resampler (Farrow or polyphase; liquid has resamplers) or by adjusting the FFT window and phase per symbol.
- **Avoid long direct-form correlations in the worklet.** The local benchmark showed about 6% of a quantum on a server for a 960-tap correlator. Do the correlation via FFT (overlap-save), or only after the cheap autocorrelation detector triggers.

### Gaps
- No measured detection-probability or false-alarm curves for 10–20 ms chirp or ZC preambles in rooms between phones were found.
- No measured smartphone audio clock offsets (ppm) or sample-rate drift between iOS and Android Web Audio contexts were found.
- Measured delay spread and RT60 for phone-to-phone links on a table at 0.1–1 m were not found. The living-room RT60 is a general figure.

## Q4. Full-duplex design options (FDD, known-signal self-cancellation, TDD, browser echoCancellation) and dynamic-range issues

### Takeaway
The most robust browser design is FDD with a harmonic-aware band plan, constant-envelope or low-PAPR modulation on the lower band, and an optional in-app linear canceller of the phone's own known transmit signal. Harmonics only go up, so:
- The upper-band transmitter cannot pollute the lower band with harmonics.
- The lower-band transmitter's 2nd and 3rd harmonics, and multitone IM3 products, are what must avoid the upper band.
- Hence both bands should fit within one octave: the upper band must end below twice the lower band's bottom edge, with guard bands at least as wide as any IM3 spread.

The other options all fall short:
- Pure TDD needs guard times on the order of the room reverberation tail (tens to over 100 ms) unless the own-signal tail is cancelled. That conflicts with 100 ms frames.
- The browser's built-in echoCancellation is unreliable as a canceller for Web Audio output (Chrome historically does not use Web Audio playback as the AEC reference, and iOS voice processing degrades audio).
- The acoustic full-duplex literature is small. Dhwani shows acoustic self-cancellation is hard because of multipath ringing, and A-NFC used two separate bands.

### Cited Findings
**Full duplex in the literature**
- Microsoft's Dhwani (acoustic NFC on phones) uses SecureJam self-jamming in which the receiver cancels its own known jamming signal. The authors note self-interference cancellation is "especially difficult in the acoustic domain due to multipath and frequency selectivity", and that acoustic ringing (reverberation) made RF cancellation techniques inadequate. Dhwani reaches up to 2.4 kbps. — [Microsoft Research Dhwani project](https://www.microsoft.com/en-us/research/project/dhwani/)
- A-NFC (Lin and Huang, 2015) implements full-duplex two-way communication between phones by designing two independent channels in the inaudible band, reporting up to 2.2 kbps across devices. — [A-NFC record, NTU Scholars](https://scholars.lib.ntu.edu.tw/entities/publication/9696e544-9d94-4daa-8032-aacb903dc46b)
- Underwater-acoustic full duplex: self-interference can be about 100 dB above the receiver noise floor, and a digital RLS-DCD adaptive canceller achieved about 69 dB cancellation in a water tank. — [University of York SIC project](https://www.york.ac.uk/electronic-engineering/research/communication-technologies/projects/self-interference-cancellation-underwater-acoustic/)
- Cancellation gain drops as carrier frequency rises, due to higher channel variability. — [Guo et al., NSF PAR preprint](https://par.nsf.gov/servlets/purl/10163353)
- Analog isolation alone is insufficient, so digital suppression of the residual is required. — [Towliat dissertation, U. Delaware 2023](https://udspace.udel.edu/items/49f606b5-0e00-4306-a083-a725672b5379/full)

**Speaker nonlinearity**
- Mobile-phone microspeaker THD is affected by uneven magnetic distribution and diaphragm nonlinearity. — [KoreaScience microspeaker THD study](https://www.koreascience.or.kr/article/JAKO200818259609994.page)
- Harmonic results depend on the stimulus, and intermodulation components may matter more than harmonics. — [Klippel: harmonic distortion](https://klippel.de/know-how/measurements/nonlinear-distortion/harmonic-distortion.html)
- For high-frequency test tones, harmonics fall out of analyzer range and IMD measurement is recommended. — [NTi Audio: THD](https://www.nti-audio.com/en/know-how/distortion-thd)

**Browser echoCancellation**
- Chrome reportedly does not cancel Web Audio output with its getUserMedia echo canceller (Chromium issue 687574). Mozilla Hubs worked around this by routing Web Audio output through two local RTCPeerConnections into an audio element. This is a forum report and may be dated. — [Babylon.js forum thread](https://forum.babylonjs.com/t/browser-audio-cancellation-doesnt-work-using-babylons-sound-component/16759)
- Chrome's documentation describes its echo canceller as trying to remove any sound played out on the speakers from the microphone signal. — [Chrome: disabling hardware noise suppression](https://developer.chrome.com/blog/disabling-hardware-noise-suppression/)
- iOS Safari, WebKit bug 311451 (filed 2026-04-03, iOS 26.4, still NEW as of 2026-10-08): after getUserMedia starts capture, playback audio loses sample rate and collapses to mono, with or without `echoCancellation: false`. A comment says that on iOS 27 it has become crackling. — [WebKit bug 311451](https://bugs.webkit.org/show_bug.cgi?id=311451)
- iOS Safari, WebKit bug 281978 (2024, iOS 17.6.1 / Safari 18, still NEW): with `echoCancellation: false`, a mono mic returns a stereo track with only the left channel populated, and `channelCount` has no effect. — [WebKit bug 281978](https://bugs.webkit.org/show_bug.cgi?id=281978)

**Room acoustics (for TDD guard time)**
- Typical living-room RT60 is about 0.5 s. — [Burgess, IOA](https://www.ioa.org.uk/system/files/publications/M%20BURGESS%20THE%20EFFECTS%20OF%20CURRENT%20REVERBERATION%20TIMES%20IN%20BRITISH%20LIVING%20ROOMS.pdf)
- Critical distance is Dc ≈ 0.057·√(QV/T), with about 60 m³ as a typical living-room volume. — [US patent 12136432](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/12136432)

### Inferences
**(a) FDD band plan**

- **Why the current plan fails.** With bands at roughly 1.4–3.0 and 3.4–5.0 kHz, the low band's 2nd harmonic (2.8–6.0 kHz) covers the whole high band, which matches the observed failure.
- **Rule.** Let the low band be [f1, f2] and the high band [f3, f4].
  - Harmonics: f4 < 2·f1 keeps the low band's 2nd and 3rd harmonics out of the high band.
  - IM3: if the low band is multitone (OFDM), its 3rd-order intermod spans [2f1−f2, 2f2−f1]. Requiring f3 > 2f2−f1 means the guard band must be at least the low band's width.
- **Examples.**
  - With OFDM on both bands: low 2.0–2.6 kHz (IM3 reaches 3.2 kHz), high 3.25–3.95 kHz (< 4.0 = 2×2.0). That is about 600–700 Hz per direction, or about 6–7 subcarriers at 93.75 Hz spacing, still about 300–450 bps coded with DQPSK.
  - With a constant-envelope low band (one tone at a time, as the current 16-FSK already is, or CPFSK/GMSK), IM3 vanishes and only harmonics matter. The low band can then extend up to about the high band's lower edge minus a filter guard, e.g. low 2.0–3.0 kHz, high 3.3–3.95 kHz.
  - Raising f1 widens the usable octave: e.g. 3–6 kHz, if phone speakers and mics are flat there, which is not measured here.
  - The high-band transmitter's harmonics land above the high band and never hurt the low band, so this phone can use OFDM freely.
- **Asymmetry.** The pair is asymmetric. Assign roles at pairing time, e.g. by the higher player ID, or by probing which assignment gives better bidirectional SNR.
- **Receive filtering.** Each phone should band-pass (or simply use only its FFT bins for) the other's band. With OFDM, out-of-band rejection is inherent once the own transmit is orthogonal or absent in those bins. Own-transmit spectral leakage (sidelobes) into the other band must be suppressed with windowing or tapering, as liquid's taper does, plus guard subcarriers.

**(b) Known-signal self-interference cancellation**

- **What it cancels.** Each phone knows its exact digital transmit samples. A linear adaptive FIR from transmit to mic (NLMS, or frequency-domain block NLMS for long tails) can remove the linear part of the own signal, including room echoes of it.
- **What it misses.** It cannot remove speaker harmonics and IMD (nonlinear) unless a nonlinear model (e.g. a Hammerstein model with polynomial basis on the transmit signal) is added. The underwater literature shows that about 60–70 dB is possible with excellent hardware. On phones, the unknown and drifting output latency, Bluetooth, and clock offset between the output and input paths make tens of dB the likely ceiling. This is an estimate, not measured.
- **Main practical value.** It removes the own signal's room-reverberation tail. That allows tighter FDD guards, TDD with short guards, or even a partially overlapping band plan.
- **Cost.** Time-domain NLMS with 512 taps (10.7 ms of echo path) cost 163 µs per 128-sample quantum on a server. That is too expensive to scale to 100–300 ms tails on phones in the time domain, so use frequency-domain partitioned-block filters, or operate per OFDM subcarrier. In OFDM, self-interference per subcarrier is just a complex gain times the known symbol, so it can be estimated and subtracted per bin, which is cheap.

**(c) TDD**

- **Guard time.** Guard = propagation (≤3 ms at 1 m) + output/input latency jitter + the time for the own transmission's room tail to decay below the peer's level.
- **Why the tail dominates.** Computed from the patent formula with V=60 m³ and T=0.5 s, Dc ≈ 0.62 m for Q=1 and about 0.88 m for Q=2. The search tool's summary stated about 1.2 m, which appears to be an arithmetic error. At peer distances of 0.1–1 m, the peer's direct sound is only about 0–15 dB above the room's reverberant field. The own transmission's reverberant tail starts at that same reverberant-field level.
- **Resulting guard.** With RT60 = 0.5 s (120 dB/s decay), getting the own tail 10–20 dB below the peer takes about 80–170 ms.
- **Conclusion.** Pure same-band TDD therefore wastes most of a 100 ms frame unless the tail is cancelled per (b), or the slots also alternate bands (TDD plus FDD hybrid).
- **Latency itself is not a guard problem.** Both phones' output and input latencies are fixed offsets that can be calibrated once by loopback. It only becomes a problem if it jitters. Bluetooth output adds 100+ ms and should be detected and refused.

**(d) Browser echoCancellation as a free canceller**

- It is likely counterproductive:
  - Chrome reportedly does not use Web Audio playback as the AEC reference unless it is routed through a loopback RTCPeerConnection.
  - AEC pipelines include nonlinear residual-echo suppression and noise suppression, which will attenuate or warp the peer's modem tones during "double talk" (both transmitting).
  - On iOS, voice processing changes sample rate and channel layout and degrades output.
- Recommendation: request `{echoCancellation: false, noiseSuppression: false, autoGainControl: false}` and do any cancellation in-app on the known signal.

**Dynamic range**

- **The gap.** A phone's own speaker is a few cm from its own mic, while the peer is 10–100 cm away. Inverse-square alone puts the own signal about 6–26 dB louder at the mic (e.g. 5 cm vs 1 m is 26 dB), before directivity and enclosure coupling, which could add more. This is unmeasured.
- **Consequences:**
  - Transmit level must be modest (as Quiet's very low gains of 0.01–0.15 suggest) to keep the own signal below mic and ADC clipping and AGC pumping.
  - AGC must be disabled.
  - The peer's band must sit where the own harmonics are at least 20–30 dB below it.
  - With an own-signal-to-peer gap of 20–30 dB, own harmonics at −30 dBc would land at about 0 dB SIR in the peer band. That is why the harmonic-aware plan matters more than filtering.
- **Mic nonlinearity.** Strong own signals can also create harmonics in the mic and preamp, not only the speaker. The same "harmonics go up" rule applies.
- **ADC headroom.** Float capture in Web Audio (typically 16- or 24-bit converters) gives about 90+ dB, which is enough if nothing clips. This is an estimate.

### Gaps
- No measured harmonic or IMD levels (dBc) for phone speakers at moderate levels in 1–6 kHz were found. Measure on target devices with a sweep.
- No measured mic overload or AGC behaviour of iOS and Android when the phone's own speaker plays loudly.
- No source quantifies achievable self-interference cancellation (dB) for in-air phone speaker-to-mic paths in a browser.
- The current status of Chromium issue 687574 (Web Audio not used as AEC reference) was not verified.
- Whether Android Chrome's `echoCancellation: false` fully bypasses platform or hardware AEC on all devices is unknown.

## Q5. Open-source WASM ports of Speex AEC, WebRTC APM/AEC3 and RNNoise: sizes, latency and CPU

### Takeaway
- A ready-made WebRTC AEC3 WASM port exists: `@ennuicastr/webrtcaec3.js` 0.3.0 (BSD-3). It is about 170 KB wasm (80 KB gzip) plus JS glue, works best at 48 kHz, and offers `analyze()` (render) and `process()` (capture) on 10 ms frames.
- No maintained npm WASM build of the Speex echo canceller was found. `@sapphi-red/speex-preprocess-wasm` exposes only the preprocessor (NS/AGC/VAD/residual-echo hooks). A speexdsp-based Rust `aec` crate lists wasm32 support.
- RNNoise WASM ports are plentiful, at about 110–155 KB wasm, but RNNoise is a speech denoiser and would damage modem signals.
- None of these publish phone CPU or latency numbers. For a modem, a custom linear canceller on the known signal (Q4b) is more appropriate than a speech AEC with nonlinear suppression.

### Cited Findings
**WebRTC AEC3**
- `@ennuicastr/webrtcaec3.js` 0.3.0 (published 2024-01-02, BSD-3-Clause) is a port of WebRTC's AEC3 to WebAssembly and JavaScript "so that echo cancellation can be performed on any audio, rather than trusting whatever echo cancellation getUserMedia wishes to do". — [npm @ennuicastr/webrtcaec3.js](https://www.npmjs.com/package/@ennuicastr/webrtcaec3.js); [repo](https://github.com/ennuicastr/webrtcaec3.js)
- API: `new AEC3(sampleRate, outputChannels, inputChannels)`; `analyze(outputData)`; `processSize()` / `process(outBuf, inputData)`. "Not all sample rates will work… Basically, use 48000." The library is synchronous ("use it in a WebWorker"). — [npm @ennuicastr/webrtcaec3.js](https://www.npmjs.com/package/@ennuicastr/webrtcaec3.js)
- Local measurement: `webrtcaec3-0.3.0.wasm` is 170,421 bytes (80 KB gzip), `webrtcaec3-0.3.0.js` glue is 261 KB (113 KB gzip), and an alternative `.wasm.js` build is 340 KB (111 KB gzip). — [npm @ennuicastr/webrtcaec3.js](https://www.npmjs.com/package/@ennuicastr/webrtcaec3.js)
- AEC3 combines an adaptive linear filter with a nonlinear residual-echo suppressor and is the default echo remover in Chrome-based calls. — [Forasoft AEC3 glossary](https://www.forasoft.com/learn/audio-for-video/glossary/terms-audio/aec3)
- A Rust port, crate `aec3`, takes 10 ms frames of f32 audio at 16–48 kHz, with 44.1 kHz resampled internally to 48 kHz. — [docs.rs aec3 0.1.8](https://docs.rs/crate/aec3/0.1.8)

**Speex**
- The `aec` Rust crate describes itself as acoustic echo cancellation based on speexdsp and lists wasm32 as a supported platform. — [tleyden/aec](https://github.com/tleyden/aec)
- A related `aec-rs` crate also exists. — [aec-rs on lib.rs](https://lib.rs/crates/aec-rs)
- The Speex echo canceller lives in libspeexdsp, separate from the codec, and is tuned for acoustic echo. — [Speex-dev mailing list](https://lists.xiph.org/pipermail/speex-dev/2008-October/006898.html)
- `@sapphi-red/speex-preprocess-wasm` 0.4.0 (MIT) is a WASM build of the SpeexDSP preprocessor. Its typings expose `echoSuppress` and `echoSuppressActive` for residual echo, which depends on a separate echo canceller, but no echo-canceller API. `speex.wasm` is 56 KB (31 KB gzip) by local measurement. — [npm @sapphi-red/speex-preprocess-wasm](https://www.npmjs.com/package/@sapphi-red/speex-preprocess-wasm)

**RNNoise**
- `@jitsi/rnnoise-wasm` 0.2.1: `rnnoise.wasm` is 112 KB (100 KB gzip), and the sync build with embedded wasm is 1.9 MB JS. — [npm @jitsi/rnnoise-wasm](https://www.npmjs.com/package/@jitsi/rnnoise-wasm)
- `simple-rnnoise-wasm` 1.1.0 (MIT): "Tiny Web Audio RNNoise wrapper… with an AudioWorklet node"; wasm 125 KB. — [npm simple-rnnoise-wasm](https://www.npmjs.com/package/simple-rnnoise-wasm)
- `@sapphi-red/web-noise-suppressor` 0.4.1 provides AudioWorklet nodes for RNNoise (153 KB wasm, plus a SIMD variant of 157 KB), Speex (56 KB) and GTCRN (197 KB). — [npm @sapphi-red/web-noise-suppressor](https://www.npmjs.com/package/@sapphi-red/web-noise-suppressor)
- `@shiguredo/rnnoise-wasm` 2025.1.5 (Apache-2.0) is about 4.8 MB unpacked. — [npm @shiguredo/rnnoise-wasm](https://www.npmjs.com/package/@shiguredo/rnnoise-wasm)

### Inferences
- **AEC3 is usable but mismatched.**
  - Its 10 ms frame processing adds at least about 10 ms of algorithmic latency.
  - Its delay estimator and linear filter could cancel the phone's own modem signal.
  - Its residual-echo suppressor and comfort-noise logic are tuned for speech and would gate or attenuate the peer's signal in bins where own-echo energy is present. Disabling the suppressor would need changing the C++ config and rebuilding.
  - It is synchronous and sized for a Worker. Running it in an AudioWorklet thread is plausible, given an 80 KB gzip wasm and 10 ms blocks over a 128-frame ring buffer, but untested.
- **Speex MDF via Rust `aec`** is a simpler linear canceller option. It would still need building to WASM (wasm-pack) by the project.
- **RNNoise is not useful.** It is trained to keep speech and remove stationary tonal noise, which is what a modem signal looks like.

### Gaps
- No published CPU or latency measurements of webrtcaec3.js, Speex AEC or RNNoise WASM on iOS or Android phones were found.
- Whether webrtcaec3.js exposes AEC3 config to disable nonlinear suppression was not verified; only the README was read.
- No WebRTC APM (full audio-processing module) WASM port beyond AEC3 was found.

## Q6. Bit-loading and adaptive rate: probing the channel at pairing time

### Takeaway
No published work was found on adaptive bit-loading for in-air acoustic OFDM between smartphones. However, adaptive OFDM bit loading is standard (DSL/Wi-Fi), has been applied to ultrasonic through-metal acoustic links, and liquid-dsp's OFDM framing supports arbitrary per-subcarrier NULL, PILOT or DATA masks, so per-pair allocations are directly implementable. A pairing-time probe should measure per-subcarrier SNR in both directions with both phones transmitting, so that it captures each phone's own harmonics and leakage. It should then choose the band split, active subcarriers and constellation from a small ladder, with a robust fallback (e.g. DBPSK on the best few carriers, or the existing FSK).

### Cited Findings
- liquid `ofdmflexframe` allows each subcarrier to be NULL (guard or notch), PILOT or DATA. It requires ≥2 pilots and ≥1 data carrier and works best with ≥32 active subcarriers for sync. — [liquid ofdmflexframe](https://liquidsdr.org/doc/ofdmflexframe/)
- Adaptive OFDM bit loading has been applied to ultrasonic through-metal acoustic communication, where echoes cause frequency selectivity (GLOBECOM 2011). — [Drexel DWSL: adaptive OFDM bit loading through metal](https://research.coe.drexel.edu/ece/dwsl/?p=264)
- Reduced-complexity bit loading exploits channel correlation to limit which subcarriers enter the allocation step. It reaches about 14% of conventional processing time at 20 dB SNR with about 13% throughput loss. — [Khalifa University: adaptive bit loading with reduced complexity](https://khazna.ku.ac.ae/en/publications/adaptive-bit-loading-with-reduced-computational-time-and-complexi/)
- In adaptive loading, low-order modulation goes on subcarriers near deep fades and higher-order modulation where fading is mild. — [US patent 8488691, adaptive loading for OFDM](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/8488691)
- Quiet ships a fixed catalogue of profiles (GMSK, FSK, OFDM, DSSS) at different centers and rates, selected by name rather than adapted. — [quiet-profiles.json](https://raw.githubusercontent.com/quiet/quiet-js/master/quiet-profiles.json); [quiet README](https://github.com/quiet/quiet)

### Inferences
**Pairing procedure** (about 1–2 s, done once)
1. Each phone in turn plays a known multitone or chirp sweep covering about 1–8 kHz. The other records it, giving the per-bin channel gain and noise.
2. Both phones play simultaneously at the intended levels. Each measures the noise-plus-self-interference floor in every bin while transmitting, which captures its own harmonics, IMD and leakage.
3. Exchange the measurements using the most robust mode (the current FSK or DBPSK on a few carriers).
4. Choose:
   - The band split (which phone gets the lower band, sized to satisfy the harmonic rule in Q4).
   - The subcarriers to activate (drop those within X dB of the floor).
   - The constellation: DBPSK, DQPSK, or 8-DPSK only if SNR is above about 20 dB.
   - The FEC rate.

**Keep the ladder small.** A ladder of 3–4 rate modes is enough. Gross mismatches (one phone's speaker rolling off above 4 kHz, a notch from table reflections) matter more than fine-grained loading.

**Fallbacks**
- Re-probe on rising frame error rate.
- Drop to the robust mode, and finally to half-duplex TDD if full duplex fails on a device pair.
- Detect Bluetooth or high-latency output and refuse it.

**Differential modulation** (DBPSK/DQPSK across time on each carrier) avoids needing per-frame channel estimates. It costs about 3 dB versus coherent detection, which is acceptable at the high SNR expected at short range.

### Gaps
- No smartphone in-air acoustic bit-loading study was found, nor measured per-device frequency responses (e.g. typical speaker roll-off frequencies) to set default band plans.
- No data on how stable a probed channel is over a game session (people moving, hands covering speakers).

## Q7. Existing projects that achieved full-duplex acoustic data links (browser or otherwise)

### Takeaway
No browser project demonstrating simultaneous bidirectional acoustic data between two phones was found. The closest prior art:
- Quiet's paired `audible-7k-channel-0/1` profiles and quiet-lwip (TCP and UDP over sound, native).
- A-NFC (native phone app, full duplex via two inaudible bands, 2.2 kbps).
- Dhwani (native, self-jamming with self-interference cancellation, 2.4 kbps).

Browser data-over-sound libraries (ggwave, quiet-js) are half-duplex, burst-oriented and slow (ggwave 8–16 B/s).

### Cited Findings
- Quiet-lwip binds libquiet to lwIP to create TCP and UDP connections over audio (over the air or wired), with a PortAudio backend. Its examples run client and server on the same laptop, over the air through the same speaker and mic. — [quiet-lwip README](https://github.com/quiet/quiet-lwip)
- Quiet profiles include two identically parameterized OFDM profiles named `audible-7k-channel-0` (9.2 kHz center) and `audible-7k-channel-1` (15.5 kHz center). — [quiet-profiles.json](https://raw.githubusercontent.com/quiet/quiet-js/master/quiet-profiles.json)
- A-NFC achieves full-duplex two-way communication with two independent inaudible-band channels at up to 2.2 kbps on phones. — [A-NFC record](https://scholars.lib.ntu.edu.tw/entities/publication/9696e544-9d94-4daa-8032-aacb903dc46b)
- Dhwani: acoustic NFC on phones with self-jamming and self-interference cancellation, up to 2.4 kbps (concluded MSR India project, 2013). — [Microsoft Research Dhwani](https://www.microsoft.com/en-us/research/project/dhwani/)
- ggwave: multi-frequency FSK with 6 tones of 96 frequencies at 46.875 Hz spacing, F0 = 1875 Hz audible or 15 kHz ultrasonic, Reed-Solomon FEC, 8–16 bytes/s, start and end markers around each transmission. Builds exist for Emscripten/browser, Node, Python and iOS. — [ggwave](https://github.com/ggerganov/ggwave)
- `ggwave-js` 0.4.3 (2026-08-22) is a pure-JS port claiming compatibility with the C/C++ implementation. — [npm ggwave-js](https://www.npmjs.com/package/ggwave-js)
- `@packet-net/soundmodem` (2026) runs AX.25 packet modes and FreeDV and MIL-STD families in the browser via WASM, but it is designed for radio with PTT, which is half-duplex by nature. — [npm @packet-net/soundmodem](https://www.npmjs.com/package/@packet-net/soundmodem)

### Inferences
- Two-band FDD (A-NFC, Quiet's channel pair) is the only full-duplex approach with demonstrated prior art on phones. Self-cancellation (Dhwani) is demonstrated but described by its authors as hard. This supports FDD-first with cancellation as an enhancement.
- A-NFC used inaudible bands (around 18–20 kHz), where phone speaker and mic responses vary widely. Quiet's own README warns that Firefox resamples to 32 kHz, cutting everything above 16 kHz. An audible-band FDD plan within one octave (Q4) is the safer browser choice, at the cost of audibility.

### Gaps
- The A-NFC paper's full text (band plan, devices, error rates) was not retrieved.
- No measurements of quiet-lwip throughput or latency over the air were found.
- No 2024–2026 browser full-duplex acoustic demos were found. GitHub search was unavailable in this environment, so a repository survey was limited to npm and known repos.

## Q8. Browser runtime constraints: AudioWorklet + WASM, SharedArrayBuffer without COOP/COEP, iOS Safari / Android Chrome specifics

### Takeaway
Everything needed can run inside an AudioWorklet without SharedArrayBuffer:
- Compile WASM synchronously in the worklet (Emscripten `SINGLE_FILE` with sync compilation), or compile on the main thread and pass the module in.
- Do the DSP in-worklet, since the measured costs are small.
- Exchange decoded frames and transmit payloads with the game via MessagePort `postMessage`. At 1–10 frames/s its latency and jitter are fine.

SharedArrayBuffer (for the Worker ring-buffer pattern or Atomics wake-ups) requires cross-origin isolation, which GitHub Pages cannot provide via headers. coi-serviceworker can emulate it, at the cost of a forced reload on first visit and same-origin and resource constraints.

WASM SIMD is available on Safari ≥16.4 and Chrome ≥91, but SIMD builds trap on older engines, so ship a scalar fallback.

On iOS, expect quirks once the mic is open: output sample-rate and mono degradation, and a left-channel-only capture with `echoCancellation: false`. Test early.

### Cited Findings
**WASM in the AudioWorklet**
- Pattern A loads the Emscripten glue into AudioWorkletGlobalScope with `BINARYEN_ASYNC_COMPILATION=0`, `SINGLE_FILE=1` and `--post-js`, so it compiles synchronously there. — [Chrome: Audio Worklet design pattern](https://developer.chrome.com/blog/audio-worklet-design-pattern)
- Pattern B fetches and compiles on the main thread and passes the module through the AudioWorkletNode constructor. — [Chrome: Audio Worklet design pattern](https://developer.chrome.com/blog/audio-worklet-design-pattern)
- The same article describes a `HeapAudioBuffer` helper for copying between the WASM heap and JS arrays, and ring buffers that adapt the 128-frame quantum to other block sizes (e.g. 512). — [Chrome: Audio Worklet design pattern](https://developer.chrome.com/blog/audio-worklet-design-pattern)
- The heavier Worker plus SharedArrayBuffer pattern uses Atomics so the Worker sleeps until signalled. The processor never blocks, so audio may occasionally drop or duplicate. — [Chrome: Audio Worklet design pattern](https://developer.chrome.com/blog/audio-worklet-design-pattern)

**SharedArrayBuffer and cross-origin isolation**
- SharedArrayBuffer requires a secure context and cross-origin isolation, checked via `crossOriginIsolated`. Without the COOP/COEP headers, `postMessage()` throws for SharedArrayBuffer objects and the global constructor is hidden. `Atomics` is always available. — [MDN SharedArrayBuffer](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer)
- coi-serviceworker enables cross-origin isolation via a service worker on hosts like GitHub Pages where headers can't be set. Its constraints:
  - It reloads the page on first visit.
  - It must be a separate file served from your own origin (not bundled, not from a CDN), over HTTPS or localhost.
  - It defaults to `coepCredentialless`, falling back to `require-corp` (`coepDegrade`).
  - It is MIT-licensed.
  - Its README does not state Safari support.
  - [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker)

**WASM SIMD**
- Safari 16.4 (March 2023) is the first Safari with WASM SIMD, alongside Chrome 91 and Firefox 89. — [Emscripten SIMD docs](https://emscripten.org/docs/porting/simd.html)
- RustFFT's SIMD code traps on runtimes without SIMD. — [RustFFT docs](https://docs.rs/rustfft/latest/rustfft/)

**Latency reporting**
- `AudioContext.outputLatency` is supported in Chrome and Chrome Android 102 and Safari iOS 18.4. It measures one-way output latency, which varies by platform and hardware. — [MDN outputLatency (mirror)](https://www-igm.univ-mlv.fr/~forax/MDN/developer.mozilla.org/en-US/docs/Web/API/AudioContext/outputLatency.html)
- outputLatency reflects hardware such as Bluetooth earbuds. — [web.dev audio output latency](https://web.dev/articles/audio-output-latency)
- Chrome 97 on iPhone was reported to sometimes impose up to about 1.5 s AudioContext latency (an anomaly; Safari was unaffected). — [Apple Developer Forums 699192](https://developer.apple.com/forums/thread/699192)

**iOS capture and playback quirks**
- WebKit bug 311451: output degradation (lower sample rate, mono) after mic capture starts on iOS 26.x, with or without `echoCancellation: false`. It was unresolved as of October 2026. — [WebKit bug 311451](https://bugs.webkit.org/show_bug.cgi?id=311451)
- WebKit bug 281978: with `echoCancellation: false`, a mono mic returns a stereo track with only the left channel populated, and `channelCount` is ignored. — [WebKit bug 281978](https://bugs.webkit.org/show_bug.cgi?id=281978)
- quiet.js notes that "mobile safari wants it [the audio node] to be [started] in response to a user action". — [quiet.js source](https://raw.githubusercontent.com/quiet/quiet-js/master/quiet.js)

### Inferences
- **Recommended architecture for a static GitHub Pages site (no SharedArrayBuffer):**
  - One AudioWorkletProcessor handling both transmit and receive.
  - TX: generate OFDM symbols from a payload queue received via `port.onmessage`.
  - RX: ring-buffer the mic into FFT blocks, sync and decode, and post decoded frames.
  - Own-TX samples are available in the same processor, so known-signal cancellation needs no cross-thread sharing. That is a strong argument for a single combined node.
  - Either load the WASM (liquid subset or libcorrect) with Pattern A or B, or stay in plain TypeScript.
- **Reserve SharedArrayBuffer and coi-serviceworker** for a later need such as a Worker-hosted AEC3. The first-load reload and COEP side effects could break cross-origin assets (fonts, analytics) on the game site.
- **Read channel 0 only.** Always read channel 0 of the input (iOS bug 281978) and resample-check `sampleRate` at runtime.
- **Measure round-trip latency.** Use a loopback chirp at pairing, rather than trusting `outputLatency`, which is only available on iOS 18.4+ and is one-way.
- **Start inside a user gesture.** Create and resume the AudioContext and call getUserMedia inside a user gesture on iOS.

### Gaps
- Whether coi-serviceworker's credentialless COEP works on iOS Safari (October 2026) was not verified.
- No current measured Web Audio round-trip latency figures for iOS Safari or Android Chrome were found.
- Whether bug 311451's playback degradation also affects the 1–6 kHz band, or only fidelity above about 8–12 kHz (e.g. a switch to a 16 or 24 kHz voice-processing rate), is not stated. If playback drops to a 16 kHz rate, transmit content above about 8 kHz would be lost on iOS while the mic is open, which argues for keeping the modem band below about 7 kHz.
- `AudioWorkletNode` support details on older iOS versions were not re-verified in this pass.
