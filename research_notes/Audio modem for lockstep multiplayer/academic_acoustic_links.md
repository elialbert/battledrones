# Academic and industrial research on short-range phone-to-phone acoustic data links

Scope: speaker-to-microphone data links between smartphones (and comparable consumer devices) at roughly 0.1–1 m, in the audible (about 1–8 kHz) and near-ultrasonic (about 17–20 kHz) bands. This covers measured rates, error rates, ranges and latencies, which modulations worked and why, full duplex, and real-world impairments. Notes written October 2026. Unless marked otherwise, "OTA" means over-the-air (speaker, air, microphone), not a cable loopback.

Several sources were read in full (PDF text extracted): Putz et al. 2026, Dhwani 2013, Hush 2019, Tabak et al. 2021, BatComm 2020, AquaApp 2022, Shi et al. 2023, and part of Frigg et al. 2014. Others (A-NFC, Getreuer/Nearby, Dolphin, U-Wear) are known only from abstracts, search summaries, or as summarized inside Putz et al. Each finding is marked accordingly.

---

## Q1. Putz et al. 2026, "Evaluating Acoustic Data Transmission Schemes for Ad-Hoc Communication Between Nearby Smart Devices" (arXiv 2602.02249)

### Takeaway
This is the first independent, on-phone, black-box comparison of acoustic modems (11,900 recordings). Its result is sobering. Only the low-rate, robust schemes worked reliably at 50 cm across phone models, rooms and noise: chirp at 15 bps, Google Nearby at 84 bps, and ggwave MFSK at 268 bps. The higher-rate academic schemes (600–729 bps OFDM and MFSK) only worked at 10 cm or less, and failed with clapping noise and many device pairings. The paper reports reliability, not latency. Its design requirements are to survive tens of ms of delay spread, 30 dB of level variation across devices without calibration, nonlinear distortion, and impulsive noise.

### Cited Findings
**Publication**
- Authors: Florentin Putz, Philipp Fortmann, Jan Frank, Christoph Haugwitz, Mario Kupnik and Matthias Hollick (TU Darmstadt). arXiv v1 posted 2 Feb 2026. The version of record is ACM Transactions on Internet of Things 7(1), Article 8, Feb 2026, doi 10.1145/3779439. — [arXiv 2602.02249](https://arxiv.org/abs/2602.02249)

**Survey method and reproducibility**
- The authors reviewed 31 papers on acoustic data transmission for commercial off-the-shelf devices. None provided accessible source code. Of the authors they emailed, only 3 supplied working code (Digital Voices, HRCSS, Gonçalves et al.). The Hush code they received no longer ran on current Android. — [Putz et al. 2026](https://arxiv.org/pdf/2602.02249)
- The literature search used Web of Science on 18 May 2023 and covered papers from 2000–2022. Work published in 2023–2025 is therefore not in the survey table. — [Putz et al. 2026](https://arxiv.org/pdf/2602.02249)

**Commercial versus academic data rates**
- Commercial data-over-sound products typically achieve 10–100 bps, occasionally up to 200 bps, and prioritize robustness. Researchers report 500–10,000 bps or more. The paper asks whether those higher academic rates survive real use. — [Putz et al. 2026](https://arxiv.org/pdf/2602.02249)

**The 8 schemes tested (net rates after FEC)**

| Scheme | Modulation | Band | Net rate |
|---|---|---|---|
| Lee et al. 2015 | chirp binary orthogonal keying | 19.5–22 kHz | 15 bps |
| Digital Voices | MFSK | 1–3 kHz | 80 bps |
| Nearby (Getreuer et al.) | DSSS + MFSK | 18.5–20 kHz | 84 bps |
| ggwave audible | MFSK | 1.8–6.3 kHz | 268 bps |
| ggwave inaudible | MFSK | 15–19.5 kHz | 268 bps |
| HRCSS | orthogonal chirp spread spectrum | 18–22 kHz | 500 bps |
| Gonçalves et al. 2017 | OFDM + QPSK | 0.1–4 kHz | 600 bps |
| PriWhisper | MFSK | 9–17 kHz | 729 bps |

— [Putz et al. 2026, Table 2](https://arxiv.org/pdf/2602.02249)

**Rates claimed in the surveyed papers**
- Table 1 of the survey lists these claimed rates:
  - Dolphin: OFDM+ASK, 8–20 kHz, 500 bps.
  - PriWhisper: MFSK, 9–17 kHz, 1000 bps.
  - Digital Voices: 1–10 kHz, 1280 bps.
  - A-NFC: QPSK, 16–21 kHz, 2200 bps.
  - Dhwani: OFDM+PSK, 6–7 kHz, 2400 bps.
  - Hush: OFDM+QAM, 17.5–21 kHz, 4900 bps.
  - He et al.: AM/FSK, 0–22 kHz, 6000 bps.
  - Yamamoto et al.: 16-QAM, 32 kbps.
  - Nearby: DSSS+MFSK, 95 bps.
  - Sadeq: FSK, 18–19 kHz, 440 bps.
  - Bang: FSK, 18–22 kHz, 170 bps.

  — [Putz et al. 2026, Table 1](https://arxiv.org/pdf/2602.02249)

**Default test setup**
- Transmitter: Google Pixel 4a at volume index 19/25. Volumes of about 75% of maximum were chosen to limit amplifier and speaker nonlinearity.
- Receiver: Samsung Galaxy S20 Ultra, chosen for its low self-noise.
- Distance 50 cm, on-axis, in a quiet office. Measured background noise was 53.6 dB SPL in the office, 60.0 in the lecture room and 27.7 in the anechoic chamber.
- Recordings were 24-bit float at 44.1 kHz or higher. The Android MIC source was used, except UNPROCESSED on the Pixel 4a.
- Message lengths were set to give about 5 s transmissions, with 2 s silent gaps "to prevent reverberation from affecting subsequent transmissions".

— [Putz et al. 2026, §6.1 and App. A](https://arxiv.org/pdf/2602.02249)

**Metric**
- The Total Error Rate (TER) equals the BER, except that a failed decode (for example a sync failure) counts as 100%. The authors argue that BER alone hides undecodable packets, while PER treats 1 bit error the same as 1000. — [Putz et al. 2026, §6.1.1](https://arxiv.org/pdf/2602.02249)

**Studio-equipment baseline**
- Hardware: Neumann KH80 speaker to Earthworks M23R microphone at 50 cm.
- Lee, Digital Voices, Nearby, PriWhisper and both ggwave variants scored 0% TER. Gonçalves scored 0.8%.
- HRCSS failed. Code analysis traced the failure to a preamble-detection bug: supplying the correct start index "substantially improved the TER".

— [Putz et al. 2026, §6.2, §7.4.3](https://arxiv.org/pdf/2602.02249)

**Distance results (phones)**
- Anechoic chamber: most schemes were fine at short range.
  - Gonçalves stayed below 0.5% TER under 10 cm, rising to about 13% at longer distances.
  - Digital Voices and PriWhisper stayed below 1% close up, but "deteriorated notably beyond 20 cm".
- Office:
  - Up to 10 cm, all schemes except Digital Voices stayed below 0.5% TER.
  - Digital Voices, PriWhisper, Nearby and Gonçalves all degraded with distance.
  - Nearby was good within 1 m.
  - Audible ggwave worked up to 1 m and then failed to decode. Inaudible ggwave worked up to 20 m. Lee et al. worked up to 40 m.

— [Putz et al. 2026, §6.3](https://arxiv.org/pdf/2602.02249)

**Device-pair results (21 TX/RX combinations of 5 phones at 50 cm)**
- Phones: Pixel 4a, Pixel 6 Pro, Nexus 6P, Oppo Reno 6 and S20 Ultra.
- TER by scheme:
  - Lee et al.: 0–2%.
  - Both ggwave variants: about 0% (one 5% cell).
  - Nearby: 0–55%. It failed with the S20 as transmitter and on some Pixel 4a links.
  - Gonçalves OFDM: 5–32%.
  - PriWhisper: 3% at best, up to 100%. Failures were due to synchronization.
  - Digital Voices: 12–100%.
- The Pixel 6 Pro was consistently the best transmitter.

— [Putz et al. 2026, §6.4, Fig. 6](https://arxiv.org/pdf/2602.02249)

**Noise and handling results (50 cm)**
- Putting the receiver in a pocket broke every scheme.
- Nearby, inaudible ggwave and Lee et al. were robust to all other disturbances. These included café, train station and market recordings played 1 m from the receiver, clapping, moving or lifting the phone on the table, handheld use, and side-by-side or facing orientations.
- Audible ggwave (1.8–6.3 kHz) became "completely unusable" with ambient noise, "likely because the ambient noise interfered with the transmission bandwidth".
- Clapping "dramatically impaired" Digital Voices, PriWhisper and Gonçalves.
- Table movements had only a minor impact.
- Side-by-side placement hurt more than facing placement.

— [Putz et al. 2026, §6.5, Fig. 7](https://arxiv.org/pdf/2602.02249)

**Environment results (50 cm)**
- Lee, Nearby and both ggwave variants were perfect in small and large offices, a meeting room and a lecture room. This included people walking quietly through the lecture room.
- The other schemes did worst in offices.

— [Putz et al. 2026, §6.6](https://arxiv.org/pdf/2602.02249)

**Suitability verdicts (Table 4)**
- Medium range (10 cm to 1 m): only ggwave (both variants) is suitable, plus Nearby "with further error correction".
- Near range (10 cm or less): Gonçalves (600 bps) and PriWhisper (729 bps), both needing further FEC.
- "Schemes designed for higher data rates generally struggled to perform reliably across varied indoor environments."

— [Putz et al. 2026, §7.2, Table 4](https://arxiv.org/pdf/2602.02249)

**Design requirements the paper derives**
- **Multipath.** Operate correctly with delay spreads up to tens of milliseconds (for example by using guard intervals). Reliability varied with device position and orientation even within the same room.
- **Device heterogeneity.** The authors measured "up to 30 dB SPL spread between phones at the same volume setting". "Most devices suffer from nonlinear distortions at volume settings above approximately 75%". "Most acoustic links are unidirectional, so no feedback-based gain control is possible". Schemes must withstand at least 30 dB SNR fluctuation without closed-loop calibration.
- **Inaudibility.** Inaudible operation leaves less than 4 kHz of usable bandwidth, and the hardware is highly frequency-selective in that band.
- **Noise.** Use strong FEC plus time interleaving against both continuous and impulsive noise.
- **Rate versus reliability.** Favor robustness unless bidirectional link adaptation (HRCSS-style probing) is possible.

— [Putz et al. 2026, §7.3](https://arxiv.org/pdf/2602.02249)

**Latency**
- The paper says audibility and latency "do not have to be experimentally determined as they follow directly from the system's design". It notes processing latency matters for time-critical applications. No latency measurements are given.
- Transmission durations in the burst-noise test were: Gonçalves 0.4 s, Lee et al. 1.1 s, others about 5 s.

— [Putz et al. 2026, §7.5.2, §7.6.3](https://arxiv.org/pdf/2602.02249)

**Recommended pattern**
- The paper recommends treating the acoustic channel as "a low-bandwidth trigger" that bootstraps Wi-Fi or cellular. This pattern is not applicable to Battle Drones, where audio is the only link. — [Putz et al. 2026, §7.2](https://arxiv.org/pdf/2602.02249)

**Reimplementation details**
- PriWhisper: 8-FSK with 2 ms symbols (1500 bps raw), BCH (255,131), giving 771 bps gross and 729 bps net. Before demodulation, a sync symbol that sums all tones is used to calibrate per-tone gains against the mic's frequency response.
- Nearby: 94.5 bps gross and 84 bps net with the token structure. The original processes audio in 100 ms blocks. Getreuer et al. added error correction by repeating each transmission 3 times.

— [Putz et al. 2026, App. B, §7.4.5](https://arxiv.org/pdf/2602.02249)

**Artifacts**
- MATLAB reimplementations of Lee, Nearby and PriWhisper, plus 11,900 real phone recordings with BER CSVs, are released at doi 10.5281/zenodo.17661991. — [Putz et al. 2026](https://arxiv.org/abs/2602.02249)

### Inferences
- The tested rates fall on both sides of the target. Battle Drones' requirement (150–750 bps each way at 0.1–1 m) sits right where the evaluation shows the cliff. ggwave-style MFSK at about 268 bps was reliable at 50 cm across phones. Nothing tested at 600–729 bps was reliable at 50 cm. However, the 600–729 bps schemes were tuned for 10 cm or less (2 ms FSK symbols and short-range OFDM), not designed for 1 m.
- The audible-ggwave failure under café, station and market noise matters directly for the current prototype, which uses 1.4–5 kHz. A similar band (1.8–6.3 kHz) was "completely unusable" under ambient noise, while the 15–19.5 kHz variant with the same modem was unaffected. Talking players will be a near-continuous noise source in exactly the speech band.
- Every test was a one-shot burst preceded by silence. None of the 8 schemes was evaluated as a continuous stream, in full duplex, or for latency. The paper's reliability numbers are the best available proxy, but they do not answer the lockstep latency question.
- All test devices were Android. No iPhone or browser (Web Audio) path was tested.

### Gaps
- Raw per-condition BER CSVs and recordings exist (Zenodo) but were not analysed here.
- The paper gives no per-scheme numbers on synchronization or preamble time, and no latency.
- No iOS devices or browser audio stacks were tested.

---

## Q2. Dhwani (Microsoft Research India, SIGCOMM 2013): acoustic NFC with OFDM and self-jamming

### Takeaway
Dhwani is the canonical phone OFDM modem. It used only 1 kHz (6–7 kHz) of carrier-less OFDM with 5.8 ms symbols and a 4 ms cyclic prefix. With no FEC it achieved 800 bps (BPSK, 100% packet success), 1.6 kbps (QPSK, about 95%) and 2.4 kbps (8-PSK, about 80%). Range was deliberately limited to about 10 cm and fell to 0 by about 20 cm. Its JamSecure scheme is an early example of a phone transmitting and receiving at the same time: the receiver plays a jamming signal while recording and cancels its own signal. That cancellation reached about 20 dB when trained in the same room, but only 6–7 dB elsewhere.

### Cited Findings
**Publication and test hardware**
- Authors: Nandakumar, Chintalapudi, Padmanabhan and Venkatesan. Published in ACM SIGCOMM CCR 43(4), Aug 2013. Tested between a Samsung Galaxy S2 and an HP Mini netbook. — [Dhwani paper PDF](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/Paper325Dhwani.pdf)

**Ambient noise measurements**
- Venues measured on a Galaxy S2: a mall payment counter and a busy café.
- Ambient noise was well above the phone's noise floor below 1.5 kHz, and could be about 10 dB above it at 5 kHz. Beyond 6 kHz it falls off and "becomes negligible after 8 kHz".
- Dhwani therefore applies a filter below 6 kHz and treats "6 kHz [as] a lower limit for the operation of Dhwani".

— [Dhwani](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/Paper325Dhwani.pdf)

**Frequency response**
- The speaker-to-microphone response measured at less than 10 cm shows "significant degradation at higher frequencies, especially after 12 kHz", plus notches. The design avoids frequencies above 12 kHz. — [Dhwani](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/Paper325Dhwani.pdf)

**Reverberation**
- A 5 ms, 6 kHz tone sent between devices a few cm apart rang for more than 25 ms after it ended, and took about 2 ms to build up.
- Reverberation energy decays by more than 10 dB after about 4 ms. That is why a 4 ms cyclic prefix "worked well in practice in all environments we tested" for BPSK and QPSK.

— [Dhwani](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/Paper325Dhwani.pdf)

**OFDM design**
- Carrier-less OFDM spans 0–22 kHz with unused subcarriers nulled. 256 subcarriers at 44 kHz give a symbol of about 5.8 ms.
- The operating band is 1 kHz at 6–7 kHz, "a conservative choice that works well across all the platforms we tested".
- The paper notes that better error-correcting codes could allow wider bandwidths and higher-order modulation (16/64-QAM).

— [Dhwani](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/Paper325Dhwani.pdf)

**Preamble**
- An up-then-down chirp from 6 to 16 kHz to 6 kHz, each half T = 5.81 ms (256 samples). It was chosen for low peak-to-average power ratio (PAPR), and the up/down shape gave more accurate synchronization.
- Because the preamble is louder than the OFDM symbols, a 3 ms cyclic prefix did not protect the training symbols after it. About 4 ms of silence was added after the preamble.

— [Dhwani](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/Paper325Dhwani.pdf)

**Data rates and latency**
- Rates: 2.4 kbps with 8-PSK at about 80% packet success rate (PSR); about 95% PSR for QPSK at 1.6 kbps; 100% for BPSK at 800 bps; "without any error correction".
- "For a short transfer of say 100 bytes ... Dhwani would take under a second."
- Packets are checked with a 24-bit CRC.

— [Dhwani](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/Paper325Dhwani.pdf)

**Range**
- Received SNR follows the 6 dB-per-doubling rule with distance. Volume was configured so interference fell to the noise floor at 1.5 m.
- For 100 packets between the S2 and the HP Mini, PSR "sharply falls to 0 at a distance of about 20 cm, even in the absence of any jamming".
- Volume settings must be preconfigured per device model.

— [Dhwani §4.3, §9.1](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/Paper325Dhwani.pdf)

**Self-interference cancellation (JamSecure)**
- The receiver plays a pseudo-noise jamming signal while recording, and subtracts an estimate of its own signal.
- The self-interference channel (own speaker to own microphone) is mostly static because it is dominated by the device's electro-mechanical response. Dhwani therefore pre-records a library of pseudo-noise (PN) sequences during training. It then corrects sampling offset and sub-sample timing, and fits a short FIR filter from 512 samples to capture the room's multipath.
- Cancellation was about 20 dB (18–24 dB) when training and test locations matched, but 6–7 dB at different locations.
- The authors explain why this is hard. Reverberation lasting tens of ms needs a filter of "a few thousand samples", and estimating that accurately "limits the performance". RF-style analog cancellation is not applicable.

— [Dhwani §6, §9.2, Table 1](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/Paper325Dhwani.pdf)

**Packet success with jamming (256-bit packets)**
- Without jamming: BPSK 100%, QPSK about 95%.
- With jamming and cancellation at the training location: BPSK 100%, QPSK about 80%.
- At other locations: BPSK about 90%, QPSK 60–70%.
- With jamming but no cancellation (the eavesdropper's view): 0 of 100 packets.

— [Dhwani §9.3](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/Paper325Dhwani.pdf)

**Clock offset**
- A sampling offset of Δt causes a phase error of 2πfΔt. Dhwani corrects it in the frequency domain, choosing among precomputed sub-sample-shifted versions. — [Dhwani §4, §6.2](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/Paper325Dhwani.pdf)

### Inferences
- **Rate per kHz.** Dhwani's results show that at 10 cm or less, uncoded OFDM-BPSK delivers about 0.8 kbps per kHz of bandwidth. Two 1.6 kHz bands would give on the order of 1.3 kbps uncoded BPSK per band at very short range. Rate-1/2 FEC brings that to about 650 bps. This is an extrapolation and is unverified at 0.5–1 m.
- **Cyclic prefix.** Dhwani's 4 ms prefix is a 41% overhead on a 5.8 ms symbol. At 0.5–1 m the direct path is weaker relative to reflections than at less than 10 cm, so a longer symbol (around 20 ms, as in AquaApp below) with a 3–5 ms prefix is a more sensible ratio.
- **Full duplex.** Dhwani proves a phone can play and record simultaneously and still decode another device's signal while its own signal is about 20 dB louder in the recording. But in-band cancellation was only reliable after per-location training. For Battle Drones, frequency separation is much more practical than in-band cancellation.

### Gaps
- Dhwani reports no figures for 0.5–1 m operation (range was deliberately limited) and no latency measurements beyond "under a second for 100 bytes".

---

## Q3. Other key papers (chirp, Nearby, Hush, A-NFC, Dolphin, PriWhisper, U-Wear, BatComm, AquaApp, Tabak et al., Shi et al.)

### Takeaway
High rates (2–47 kbps) on consumer hardware have been shown only in narrow conditions. They needed less than 20 cm of range (Hush, Dhwani), laptops with adaptive equalizers (Tabak), or an external ultrasonic transmitter (BatComm). Robust deployed systems (Nearby, chirp schemes, ggwave) run at about 15–270 bps. The most transferable smartphone modem design is AquaApp's OFDM: 20 ms symbols, differential BPSK across symbols, a rate-2/3 K=7 convolutional code, interleaving and per-band SNR adaptation. It reached 100 bps to 1.8 kbps between phones underwater. A-NFC is the only paper found that claims full-duplex phone-to-phone operation (two independent inaudible channels, up to 2.2 kbps).

### Cited Findings
**Chirp, Lee et al. (INFOCOM 2015)**
- Each frame is a long chirp preamble plus 16 chirps in 19.5–22 kHz. That gives 16 bps gross and 14.55 bps net, at about 1.1 s per frame.
- Packet success was above 97% at 10 m and 25 m in the original paper. Putz et al. measured above 98% at 10, 20 and 40 m.

— [Putz et al. 2026, §5.3, App. B.1, §7.4.4](https://arxiv.org/pdf/2602.02249)

**Other chirp systems (as summarized by Shi et al. 2023)**
- Chirp spread spectrum in [Lee 2015] reached near error-free operation at 25 m and 16 bps.
- An "improved robust chirp spread spectrum" (HRCSS, Cai et al.) reached error-free operation at 20 m and 125 bps. This conflicts with the 500 bps that Putz et al. list for HRCSS; the two figures probably refer to different configurations.
- Frigg et al. reached 26.4 bps at 35 m with BER about 10%.

— [Shi et al. 2023](https://personalpages.surrey.ac.uk/w.wang/papers/Shi%20et%20al_PhysicalCommunication_2023.pdf)

**Shi et al. 2023 (Physical Communication)**
- Chirp spread spectrum with fractional-Fourier-transform denoising, on Android phones (Huawei Honor 30 Lite and V30). Error-free at 70 m and 20 bps.
- Measured RMS delay spreads in a corridor were 9–17 ms, with maximum excess delays of 50–94 ms at 25–70 m. Two further test cases had about 16–19 ms RMS and about 90 ms maximum.

— [Shi et al. 2023](https://personalpages.surrey.ac.uk/w.wang/papers/Shi%20et%20al_PhysicalCommunication_2023.pdf)

**HRCSS, Cai et al. (IEEE TMC 2022)**
- Orthogonal chirp spread spectrum at 18–22 kHz, claimed 500 bps, with bidirectional probing for link adaptation.
- The code supplied to Putz et al. lacked probing and failed because of a sync bug.
- Its paper argues that dynamic aerial channels weaken OFDM orthogonality, and that standard Doppler and sync compensation is heavy for phones.

— [Putz et al. 2026](https://arxiv.org/pdf/2602.02249); [Cai et al. via ResearchGate](https://www.researchgate.net/publication/348498420_Boosting_Chirp_Signal_Based_Aerial_Acoustic_Communication_under_Dynamic_Channel_Conditions)

**Google Nearby, Getreuer et al. (IEEE Trans. Multimedia 2018)**
- Near-ultrasonic 18.5–20 kHz, direct-sequence spread spectrum with MFSK (and single-sideband modulation), 94.5 bps raw.
- "Reliable at 2 m distance and often works at 10 m" between mobile devices indoors. Original tests used a Nexus 6 transmitter and Nexus 5/5X receivers, with packet success above 94% up to 2 m.

— [Getreuer et al. abstract (Academia.edu mirror)](https://www.academia.edu/164596957/Ultrasonic_Communication_Using_Consumer_Hardware); [Putz et al. 2026, §7.4.5](https://arxiv.org/pdf/2602.02249)

**Hush, Novak, Tang and Li (IEEE IoT Journal 2019)**
- Signal design:
  - 78 subcarriers from 17.528 to 20.930 kHz, with amplitude and phase keying per subcarrier, at 44.1 kHz sampling.
  - Frames are 1024-sample FFT blocks extended to 1044 samples with a 20-sample Hann taper, about 23.7 ms each.
  - Each packet starts with a 300-sample (about 6.8 ms) linear chirp "hail" from 18 to 19 kHz, followed by up to 3 frames.
  - Two pilot subcarriers are used for phase calibration. Hamming FEC is applied.
- Synchronization: RMS energy detection over 100-sample windows, then cross-correlation over the first 1024 samples, then a Hilbert transform for sub-sample timing.
- Performance: "4900 bits per second at an ideal distance of 5–20 cm" on Nexus 5X phones. The authors state the modem "is very sensitive to orientation, distance, and sender volume".

— [Hush PDF](https://www.cs.wm.edu/~liqun/paper/iotj19.pdf)

**A-NFC, Lin, Huang and Chiueh (IISA 2015)**
- "Implements full-duplex two-way communication by designing two independent channels in the inaudible frequency band." Claimed to be the first inaudible two-way acoustic system on Android and iOS, with up to 2.2 kbps.
- Putz et al. list it as QPSK in 16–21 kHz.
- The split between the two channels, the range and the error rates were not available from the abstract.

— [NTU repository abstract](https://scholars.lib.ntu.edu.tw/entities/publication/9696e544-9d94-4daa-8032-aacb903dc46b); [Putz et al. Table 1](https://arxiv.org/pdf/2602.02249)

**Dolphin, Wang et al. (MobiCom 2016; IEEE TMC 2019)**
- Data is hidden in played audio and captured by phones. Average rates up to 500 bps with a decoding rate above 95% at 1 m. Capture works up to 8 m and ±90°.
- The TMC journal version reports 240 bps average goodput at 2 m.
- This is loudspeaker-to-phone (data embedded in sound tracks), not phone-to-phone.

— [MobiCom 2016 PDF](https://cse.buffalo.edu/~lusu/papers/MobiCom2016.pdf); [IEEE TMC 2019](https://ieeexplore.ieee.org/document/8370653) (figures from abstracts via search; not read in full)

**PriWhisper, Zhang et al. (IEEE IoT Journal 2014)**
- MFSK at 9–17 kHz with friendly jamming. Original evaluation on a Galaxy S3 and Nexus S gave 0.5% packet error rate.
- Putz's reimplementation: about 0.5% BER at near range, but failures beyond 20 cm and synchronization failures on many device pairs at 50 cm.

— [Putz et al. 2026, §7.4.1](https://arxiv.org/pdf/2602.02249)

**Gonçalves et al. (LATINCOM 2017)**
- OFDM with QPSK at 0.1–4 kHz, a short chirp for synchronization, and least-squares channel estimation, at 600 bps.
- Originally tested between laptops: BER about 3% at 10 cm and 25% at 100 cm.

— [Putz et al. 2026, §7.4.2](https://arxiv.org/pdf/2602.02249)

**Tabak, Lin and Singer (arXiv 2103.11261, 2021; UIUC and Intel)**
- Laptops (HP EliteBook 830 and Lenovo T460p), not phones.
- Single carrier at 19 kHz, 2 kbaud QPSK (4 kbps), root-raised-cosine filter with 0.3 roll-off.
- Phase-coherent decision-feedback equalizer borrowed from underwater acoustics: 8 non-causal and 20 causal feed-forward taps, 80 feedback taps. 30% of symbols are used for training.
- Packet: pilot, then a 0.3 s guard interval, then 5120 data bits plus CRC-32.
- Results: BER below 2e-4 at 0.5–2 m in both directions, 0.08–0.1 at 3–5 m at 65% volume, and below 2e-4 to 0.01 at 5 m at 100% volume. Equalizer output SNR of 28 dB at 0.5 m suggests 1024-QAM (20 kbps) would be possible.
- The authors note that the delay spread for devices 5 m apart "could span 70 ms".

— [Tabak et al. 2021](https://arxiv.org/abs/2103.11261)

**BatComm, Bai et al. (SenSys 2020)**
- 47.49 kbps at 4.3% BER and 25.37 kbps at 0.5% BER at centimetre range, and 17.76 kbps at 0.9% BER up to 2.3 m.
- The transmitter is an ultrasound speaker (above 40 kHz) that exploits microphone preamplifier nonlinearity to down-convert into the phone's recorded band. It is not phone-to-phone.

— [BatComm PDF](https://www.winlab.rutgers.edu/~yychen/papers/BatComm%20Enabling%20Inaudible%20Acoustic%20Communication%20with%20High-throughput%20for%20Mobile%20Devices.pdf)

**AquaApp, Chen, Chan and Gollakota (SIGCOMM 2022)**
- Phone-to-phone and watch, underwater. Bit rates "adapt[] ... to achieve bit rates of 100 bps–1.8 kbps at distances up to 30 m".
- Modem design:
  - OFDM in 1–4 kHz with 960-sample (20 ms) symbols at 48 kHz, 50 Hz subcarrier spacing and about 60 subcarriers.
  - 67-sample cyclic prefix (6.9% overhead), made possible by a time-domain MMSE equalizer with 480 taps trained on a known symbol.
  - Rate-2/3 K=7 convolutional code with Viterbi decoding, interleaving across subcarriers, and differential BPSK across consecutive OFDM symbols to handle channel change from motion.
- Preamble: 8 OFDM symbols with CAZAC and PN codes, used for detection and per-subcarrier SNR estimation.
- Protocol: after the preamble, the receiver sends a single OFDM symbol of feedback naming the start and end bins to use.
- Carrier sense by energy detection every 80 ms.
- Open-source Android code is available.

— [AquaApp PDF](https://underwatermessaging.cs.washington.edu/underwater_comms.pdf)

**AquaApp channel reciprocity in air**
- In air at 2 m between two phones of the same model, forward and backward chirp frequency responses were similar. Underwater they differed significantly, which is why the receiver must feed back its preferred band. — [AquaApp §2.1](https://underwatermessaging.cs.washington.edu/underwater_comms.pdf)

**Frigg, Corbellini, Mangold and Gross (Disney Research and ETH, WONS 2014)**
- Data is hidden in sound tracks, in the MCLT domain at 6–10 kHz, using differential BPSK with spreading across 4 neighbouring subbands.
- The paper motivates DBPSK over BPSK by the phase shifts introduced by D/A and A/D conversion, which BPSK would have to estimate and compensate.
- Several phones combine their correlation outputs to improve robustness.

— [Frigg et al. 2014](https://la.disneyresearch.com/wp-content/uploads/IeeeWons2014_Audiocom1.pdf)

**U-Wear, Santagati and Melodia (MobiSys 2015)**
- A software-defined near-ultrasonic networking stack for wearables and phones (about 15–22 kHz, commercial speakers and microphones) with reconfigurable PHY, MAC and network layers. — [US patent 11020001](https://patents.google.com/patent/US11020001)
- Data rates could not be verified (see Gaps).

### Inferences
- **What carries over.** The only demonstrations above 1 kbps that worked at 0.5–2 m on built-in hardware used coherent modulation plus serious equalization: Tabak's decision-feedback equalizer and AquaApp's MMSE equalizer with differential encoding. Simple non-coherent FSK with short symbols (PriWhisper's 2 ms) collapses beyond about 20 cm.
- **Symbol length.** In-room delay spreads are 10–20 ms RMS with tails up to 50–90 ms. A symbol of about 20 ms with a few ms of prefix, plus an equalizer or differential coding, is the sweet spot. The current 50 ms symbol is robust to that delay spread but spectrally wasteful.
- **AquaApp as a template.** AquaApp is the closest proven design for a 0.5–2 kbps phone modem. It ran in real time on Android and its code is open. Its channel (underwater, 1–4 kHz) is harsher than an in-room 0.1–1 m link. Its parameters (60 subcarriers × about 48 symbols/s × 2/3 rate ≈ 1.9 kbps at full band) are consistent with its reported 1.8 kbps peak.

### Gaps
- U-Wear's measured data rates and bit error rates: the full MobiSys or ToN paper could not be retrieved.
- A-NFC full text: the frequency plan for its two channels, isolation figures, range and error rates are unknown.
- Getreuer et al. full text was not retrieved. Its symbol length, Doppler search range and audibility findings are known only via Putz's appendix and the abstract.
- The Dolphin figures come from abstracts only.
- BackDoor (MobiSys 2017) and the Ka et al. TV second-screen work (MobiCom 2016, 15 bps per Putz Table 1) were not read. They are near-ultrasonic, low-rate or special-hardware systems of limited relevance.

---

## Q4. Realistic throughput at 10 cm to 1 m: audible versus near-ultrasonic (tabulated)

### Takeaway
Independent phone testing (Putz 2026) supports about 250–270 bps as reliably achievable at 50 cm to 1 m across phone models, in both the audible (quiet rooms only) and near-ultrasonic bands. Rates of 0.6–5 kbps have been shown on phones only at 20 cm or less. Rates of 4 kbps at 0.5–2 m have been shown on laptops with adaptive equalization. The near-ultrasonic band is far more robust to ambient noise and talking, but has under 4 kHz of usable bandwidth and highly device-specific frequency response. The audible band below about 6 kHz collides with speech and room noise.

### Cited Findings

| Paper (year) | Scheme | Band | Rate (net unless noted) | Error / reliability | Range | Hardware | Test type |
|---|---|---|---|---|---|---|---|
| Putz eval. of ggwave inaudible (2026) | MFSK | 15–19.5 kHz | 268 bps | about 0% TER across 21 phone pairs; robust to ambient noise | reliable to 20 m | 5 Android phones | OTA, indoor + anechoic ([src](https://arxiv.org/pdf/2602.02249)) |
| Putz eval. of ggwave audible (2026) | MFSK | 1.8–6.3 kHz | 268 bps | 0% in quiet; "completely unusable" with café/station/market noise | to 1 m in office | phones | OTA ([src](https://arxiv.org/pdf/2602.02249)) |
| Putz eval. of Nearby (2026) / Getreuer (2018) | DSSS+MFSK | 18.5–20 kHz | 84 bps (94.5 raw) | median 0% at medium range; 0–55% TER by device pair | reliable at 2 m, often 10 m (orig.) | Nexus 6/5/5X (orig.); 5 phones (Putz) | OTA ([src](https://arxiv.org/pdf/2602.02249)) |
| Lee et al. (2015), Putz eval. | chirp BOK | 19.5–22 kHz | 15 bps | about 0–2% TER; above 98% success at 10–40 m | to 40 m | phones | OTA ([src](https://arxiv.org/pdf/2602.02249)) |
| Gonçalves et al. (2017), Putz eval. | OFDM+QPSK | 0.1–4 kHz | 600 bps | below 0.5% at 10 cm or less; 5–32% TER at 50 cm across pairs; orig. BER 3% at 10 cm, 25% at 1 m | ≤10 cm | laptops (orig.), phones (Putz) | OTA ([src](https://arxiv.org/pdf/2602.02249)) |
| PriWhisper (2014), Putz eval. | 8-FSK, 2 ms symbols, BCH | 9–17 kHz | 729 bps (orig. claim about 1 kbps) | about 0.5% BER near; 3–100% TER at 50 cm | ≤20 cm | Galaxy S3/Nexus S (orig.) | OTA ([src](https://arxiv.org/pdf/2602.02249)) |
| Dhwani (2013) | OFDM BPSK / QPSK / 8-PSK, no FEC | 6–7 kHz | 0.8 / 1.6 / 2.4 kbps | PSR 100% / about 95% / about 80% | PSR 0 by about 20 cm (by design) | Galaxy S2 + HP Mini | OTA ([src](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/Paper325Dhwani.pdf)) |
| A-NFC (2015) | QPSK, two independent channels (full duplex) | 16–21 kHz | up to 2.2 kbps | not available | NFC-like (short) | Android + iOS phones | OTA (abstract only) ([src](https://scholars.lib.ntu.edu.tw/entities/publication/9696e544-9d94-4daa-8032-aacb903dc46b)) |
| Hush (2019) | 78-subcarrier OFDM, amplitude + phase, Hamming | 17.5–20.9 kHz | 4.9 kbps effective | sensitive to orientation, distance and volume | 5–20 cm ideal | Nexus 5X | OTA ([src](https://www.cs.wm.edu/~liqun/paper/iotj19.pdf)) |
| Dolphin (2016/2019) | OFDM+ASK hidden in audio | 8–20 kHz | 500 bps at 1 m; 240 bps at 2 m | above 95% decode at 1 m | to 8 m capture | loudspeaker → phone | OTA ([src](https://cse.buffalo.edu/~lusu/papers/MobiCom2016.pdf)) |
| Tabak et al. (2021) | single-carrier QPSK + decision-feedback equalizer | 18–20 kHz | 4 kbps | BER below 2e-4 at 0.5–2 m; 0.08–0.1 at 3–5 m | to 5 m | 2 laptops | OTA ([src](https://arxiv.org/abs/2103.11261)) |
| AquaApp (2022) | OFDM DBPSK + conv. r = 2/3 | 1–4 kHz | 100 bps–1.8 kbps (adaptive) | adaptive to target packet error rate | to 30 m underwater | Android phones, watches | OTA underwater ([src](https://underwatermessaging.cs.washington.edu/underwater_comms.pdf)) |
| BatComm (2020) | OFDM/DPSK via mic nonlinearity | above 40 kHz carrier | 25–47 kbps (cm); 17.8 kbps (2.3 m) | 0.5–4.3% BER; 0.9% at 2.3 m | cm to 2.3 m | ultrasound speaker → phone | OTA, special TX ([src](https://www.winlab.rutgers.edu/~yychen/papers/BatComm%20Enabling%20Inaudible%20Acoustic%20Communication%20with%20High-throughput%20for%20Mobile%20Devices.pdf)) |
| Shi et al. (2023) | CSS + fractional Fourier transform | near-ultrasonic | 20 bps | error-free | 70 m | Huawei Honor phones | OTA corridor ([src](https://personalpages.surrey.ac.uk/w.wang/papers/Shi%20et%20al_PhysicalCommunication_2023.pdf)) |

- Commercial data-over-sound products typically achieve 10–100 bps, occasionally 200 bps. — [Putz et al. 2026](https://arxiv.org/pdf/2602.02249)
- Inaudible bandwidth is under 4 kHz, and phone hardware is "highly frequency selective in this band". — [Putz et al. 2026, §7.3.3](https://arxiv.org/pdf/2602.02249)
- In mall and café recordings, ambient noise rises well above the phone noise floor below 1.5 kHz, is up to about 10 dB above it at 5 kHz, and is negligible above 6–8 kHz. — [Dhwani](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/Paper325Dhwani.pdf)
- Phone speaker-to-microphone response degrades sharply above about 12 kHz, with notches. — [Dhwani](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/Paper325Dhwani.pdf)
- Android phones mostly run at 48 kHz and iOS at 44.1 kHz, which limits bandwidth to below about 22 kHz. — [Shi et al. 2023](https://personalpages.surrey.ac.uk/w.wang/papers/Shi%20et%20al_PhysicalCommunication_2023.pdf)

### Inferences
- **Realistic targets at 0.1–1 m with phones, per direction, in a moderately noisy room with talking players:**
  - Near-ultrasonic MFSK: about 250–300 bps net, demonstrated by ggwave.
  - Near-ultrasonic OFDM or DPSK with FEC: about 0.5–1.5 kbps is plausible but not independently demonstrated on phones at 0.5–1 m.
  - Audible 1–5 kHz: similar or higher raw capacity, but vulnerable to speech and noise.
  - Audible 6–12 kHz: quieter ambient noise per Dhwani, and better phone response than 17–20 kHz. A good compromise if audibility is acceptable for a game.
- **The current band is in the worst place for talking players.** The prototype uses 1.4–5 kHz, which is exactly where audible ggwave failed under ambient noise and where speech energy sits. Moving up to 6–12 kHz, or to 17–20 kHz with per-device calibration, should be evaluated.
- **The current rate is near the robust lower bound.** The prototype nets about 12 bps per side, and its raw rate is 80 bps. Even robust published schemes do better (ggwave 268 bps net in 4.5 kHz). The bottleneck is largely the half-duplex protocol, not the physics.

### Gaps
- There is no independent measurement of any OFDM or PSK phone modem at 0.5–1 m across multiple phone models. The Putz evaluation's OFDM scheme (Gonçalves) was tuned for 10 cm or less.
- No study compared iPhone and Android near-ultrasonic response for this use case. Hromadová et al. 2022 (ELEKTRO, cited by Putz) measured smartphone frequency response at 17–22 kHz but was not retrieved.

---

## Q5. Full duplex: simultaneous bidirectional acoustic links between phones

### Takeaway
There is very little published work. A-NFC (2015) is the only phone-to-phone system found that explicitly claims full duplex, using two independent frequency channels (frequency-division duplex, FDD) in the inaudible band at up to 2.2 kbps. Dhwani shows a phone can transmit and receive at the same time with in-band self-interference cancellation. That cancellation reached about 20 dB only after training at the same location, and 6–7 dB elsewhere. AquaApp and HRCSS use half-duplex turn-taking (feedback after the preamble, or probing). Putz notes that most acoustic links are one-way, so closed-loop gain control is rarely possible. The practical limits are speaker nonlinearity, own-speaker leakage into the microphone, and long reverberation.

### Cited Findings
- A-NFC "implements full-duplex two-way communication by designing two independent channels in the inaudible frequency band", at up to 2.2 kbps on Android and iOS. — [A-NFC abstract](https://scholars.lib.ntu.edu.tw/entities/publication/9696e544-9d94-4daa-8032-aacb903dc46b)
- **Dhwani simultaneous playback and recording.** The receiver plays a jamming signal and records at the same time. Self-interference cancellation reached 18–24 dB when trained in the same room and 6–7 dB in a different room, because reverberation lasting tens of ms requires a cancellation filter of thousands of taps. RF analog cancellation techniques are not applicable without hardware changes. — [Dhwani §6, §9.2](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/Paper325Dhwani.pdf)
- **Dhwani's view of the self-interference channel.** The own speaker-to-microphone channel is dominated by the device's static electro-mechanical response, so it can be pre-trained per device. Multipath is a smaller but significant part. — [Dhwani §6.2](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/Paper325Dhwani.pdf)
- **Nonlinear distortion.** "Most devices suffer from nonlinear distortions at volume settings above approximately 75%". Devices differ by up to 30 dB SPL at the same volume index. — [Putz et al. 2026, §7.3.2](https://arxiv.org/pdf/2602.02249)
- **No feedback in one-way links.** "Most acoustic links are unidirectional, so no feedback-based gain control is possible." Bidirectional link adaptation (HRCSS-style probing) is recommended where feasible. — [Putz et al. 2026, §7.3.2, §7.3.5](https://arxiv.org/pdf/2602.02249)
- **AquaApp's half-duplex adaptation protocol.**
  - The transmitter sends the preamble and receiver ID, then stays silent while keeping its OFDM symbol clock running.
  - The receiver estimates per-bin SNR and returns a single OFDM symbol with all power in two bins that name the start and end of the usable band.
  - ACKs are a single 1 kHz bin.
  - Carrier sense runs every 80 ms.

  — [AquaApp §2.2–2.4](https://underwatermessaging.cs.washington.edu/underwater_comms.pdf)
- **Channel reciprocity in air.** At 2 m between two phones of the same model, forward and backward frequency responses were similar. — [AquaApp §2.1](https://underwatermessaging.cs.washington.edu/underwater_comms.pdf)
- **Audible leakage and nonlinearity.** BatComm operates at low transmission power because driving a speaker hard causes nonlinear effects that make audible leakage. It also shows that phone microphone preamplifiers are nonlinear: they create quadratic terms, so strong out-of-band ultrasound appears inside the recorded band. — [BatComm §2](https://www.winlab.rutgers.edu/~yychen/papers/BatComm%20Enabling%20Inaudible%20Acoustic%20Communication%20with%20High-throughput%20for%20Mobile%20Devices.pdf)
- **Clicks from discontinuities.** Abrupt waveform changes make the speaker click and spray broadband energy. Hush windows its frames with Hann tapers to suppress this. — [Hush, signal quieting section](https://www.cs.wm.edu/~liqun/paper/iotj19.pdf)
- **Underwater full duplex.** The underwater literature treats in-band full duplex as requiring digital self-interference cancellation that also models power-amplifier nonlinearity. That is a heavier approach than FDD. — [Qiao et al. 2018, Sensors (PMC)](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC6021861/)

### Inferences
- **FDD is the realistic route; in-band cancellation is not.** Dhwani's 6–7 dB untrained cancellation would be far too little in a full-duplex game.
- **Near-far problem.** A phone's own speaker is centimetres from its own microphone, while the peer is 10–100 cm away. At 6 dB per doubling of distance, the self signal can easily be 20–40 dB stronger than the peer's signal.
- **Consequences of the near-far problem:**
  - (a) Harmonics and intermodulation from one's own transmitter can land in the receive band. Third-order products dominate for symmetric clipping.
  - (b) The microphone or ADC may approach clipping, and any automatic gain control will be driven by the phone's own transmission rather than the peer's.
  - (c) The receive band's filter skirts must reject one's own band by about 40+ dB.
- **Recommended FDD practices:**
  - Keep TX volume at or below about 75%.
  - Use low-PAPR waveforms on transmit. Constant-envelope MFSK or chirps are much better than OFDM here; if using OFDM, apply clipping and filtering or tone reservation.
  - Add guard bands.
  - Choose bands so that 2× and 3× the TX band edges avoid the RX band.
- **The current band plan has a harmonic problem.** If one phone transmits at 1.4–3.0 kHz, its 2nd harmonic (2.8–6.0 kHz) overlaps the other band (about 3.4–5 kHz). That phone's own harmonics then land in its own receive band. The phone transmitting in the upper band does not have this problem, so the two directions are asymmetric. One mitigation is to give each phone TX bands whose harmonics fall outside its RX band. Another is to separate the bands by more than an octave, for example about 2–3.5 kHz and about 8–10 kHz, or one audible band and one near-ultrasonic band.
- **Browser echo cancellation is relevant.** getUserMedia's acoustic echo cancellation is designed to remove the device's own playback, which in principle could help full duplex. But AEC, noise suppression and AGC are tuned for speech and can distort or suppress data tones. This is an inference from general principles; no paper tested it.
- **Reciprocity is not needed for FDD.** The two directions use different bands anyway. But reciprocity (shown in air for same-model phones) means each phone can estimate the useful band from what it receives.

### Gaps
- No paper was found that measures full-duplex FDD isolation, harmonic leakage or bit error rate between two phones (the A-NFC full text was unavailable).
- No measurements were found of how mobile-browser getUserMedia processing (AEC, AGC, noise suppression on or off) affects data tones while the same device is playing.

---

## Q6. Latency: preamble and sync lengths, frame durations, low-latency work

### Takeaway
No academic work was found on low-latency or interactive (game) acoustic data links. Published systems use bursty packets with a preamble and silence, and their per-packet airtime ranges from about 20 ms frames (Hush, AquaApp symbols) to 0.4–5 s per message. The paper with the most realistic phone testing (Putz) does not measure latency. Design numbers suggest a continuous stream with 20 ms symbols could achieve about 50–150 ms one-way. That figure assumes an occasional preamble rather than one per frame, and excludes audio I/O buffering, which is outside this literature.

### Cited Findings
- **Dhwani.**
  - Chirp preamble of 2 × 5.81 ms, plus about 4 ms of silence, plus training symbols.
  - OFDM symbols of 5.8 ms plus a 4 ms cyclic prefix (about 9.8 ms each).
  - About 100 bytes in under a second.

  — [Dhwani](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/Paper325Dhwani.pdf)
- **Hush.**
  - A 300-sample (about 6.8 ms at 44.1 kHz) chirp "hail", then up to 3 frames of 1044 samples (about 23.7 ms each). One packet is therefore about 78 ms of airtime.
  - Detection runs on 100-sample RMS windows, then cross-correlation, then sub-sample Hilbert alignment. The authors call it "fast enough to run on smart mobile devices".

  — [Hush](https://www.cs.wm.edu/~liqun/paper/iotj19.pdf)
- **AquaApp.**
  - Preamble of 8 OFDM symbols at about 21.4 ms each, so roughly 170 ms. Data symbols are 20 ms plus a 1.4 ms prefix.
  - A feedback round-trip is inserted after the preamble.
  - Energy-detect carrier sense every 80 ms.

  — [AquaApp](https://underwatermessaging.cs.washington.edu/underwater_comms.pdf)
- **Tabak et al.** Pilot, then a 0.3 s guard interval, then 5152 bits at 4 kbps (about 1.3 s). 30% of symbols are equalizer training. — [Tabak et al.](https://arxiv.org/abs/2103.11261)
- **Nearby.** The original implementation processes audio in 100 ms blocks. It used three-fold repetition for error correction. — [Putz et al. App. B.2.2, §7.4.5](https://arxiv.org/pdf/2602.02249)
- **Lee et al. chirp.** About 1.1 s per transmission. Gonçalves OFDM takes about 0.4 s. Most other schemes in Putz's test took about 5 s. — [Putz et al. §7.6.3](https://arxiv.org/pdf/2602.02249)
- **Putz on latency.** Audibility and latency "follow directly from the system's design"; processing latency matters "in time-critical applications". No measurements are given. — [Putz et al. §7.5.2](https://arxiv.org/pdf/2602.02249)
- **Reverberation timescales.** A Dhwani tone rang for more than 25 ms. Indoor RMS delay spreads were 9–19 ms, with tails of 50–94 ms (Shi). Tabak et al. note delay spread "could span 70 ms" at 5 m. — [Dhwani](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/Paper325Dhwani.pdf); [Shi et al.](https://personalpages.surrey.ac.uk/w.wang/papers/Shi%20et%20al_PhysicalCommunication_2023.pdf); [Tabak et al.](https://arxiv.org/abs/2103.11261)
- **Propagation time** is negligible: about 3 ms at 1 m, since sound travels at 343 m/s. — [Putz et al. §7.3.1](https://arxiv.org/pdf/2602.02249)

### Inferences
- **Latency budget for a 100 ms frame.** Assuming a continuously running modem, one-way latency is roughly:
  - TX output buffer, plus
  - frame airtime (about 100 ms if a whole frame is one codeword), plus
  - about 3 ms of flight, plus
  - reverberation tail or cyclic prefix, plus
  - the RX input buffer, plus
  - decode time (a few ms for an FFT and Viterbi on a frame of a few hundred bits).
- **Meeting the target.**
  - To get under 150 ms one-way with 100 ms turns, each turn's data must be sent in a frame shorter than the turn, for example two or three 20 ms OFDM symbols per turn, as a continuous symbol stream.
  - Alternatively, accept 1–2 turns of fixed input delay, which deterministic lockstep normally does anyway.
- **Sync strategy.** Per-frame preambles like AquaApp's (about 170 ms) or Tabak's (0.3 s guard) are incompatible with 100 ms turns. A continuous stream should acquire sync once with a chirp or CAZAC preamble, then track timing and drift using pilot subcarriers or the cyclic prefix, as Hush does with per-frame pilot-phase realignment.
- **Interleaving versus latency.** Interleaving deep enough to ride out claps or bumps (Putz recommends time interleaving) directly adds latency. With 100 ms turns, the interleaving span is bounded by the acceptable input delay, for example 200–300 ms. A design could combine a short-latency code within a turn with redundancy across turns (lockstep inputs can be repeated in the next frames).

### Gaps
- No peer-reviewed work was found on using speaker-to-microphone links for real-time game or lockstep synchronization, or that reports end-to-end latency for phone acoustic modems.
- No paper measured phone audio I/O round-trip latency as part of a modem. That is outside this literature and likely covered by the browser and phone platform research.

---

## Q7. Real-world impairments (multipath, Doppler, clock drift, frequency response, noise, talking)

### Takeaway
The literature consistently identifies the dominant impairments as multipath with delay spreads of tens of ms, and device heterogeneity (up to 30 dB level spread, notches, poor response above 12 kHz, near-ultrasonic variability). Impulsive and ambient noise is next, especially in the audible band. Doppler and clock offset are second-order at 0.1–1 m but must be tracked in a continuous stream. Differential encoding across time, cyclic prefixes or guard intervals, pilot or sync-symbol calibration of per-tone gain, FEC with interleaving, and moderate volume are the recurring fixes.

### Cited Findings
- **Multipath.** Reverberation produces long delay spreads that depend on environment and geometry. Reliability varied significantly with device position and orientation even within one room. — [Putz et al. §7.3.1](https://arxiv.org/pdf/2602.02249)
- **Multipath and cancellation.** In Dhwani, multipath is "not the significant reason for frequency selectivity" (the transducers are), but it "does have significant impact" on self-interference cancellation. — [Dhwani §9.2](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/Paper325Dhwani.pdf)
- **Frequency response and gain calibration.** Mic frequency selectivity can make the wrong FSK tone win. PriWhisper's reimplementation calibrates per-tone gains from a sync symbol that contains all tones, assuming the channel stays constant during the transmission. — [Putz et al. App. B.3.2](https://arxiv.org/pdf/2602.02249)
- **Device heterogeneity.** Up to 30 dB SPL spread at the same volume index, nonlinear distortion above about 75% volume, and the transmitter or receiver model alone can flip a scheme from 0% to 100% TER. — [Putz et al. §6.4, §7.3.2](https://arxiv.org/pdf/2602.02249)
- **Doppler and motion.**
  - AquaApp uses differential coding across consecutive OFDM symbols "as long as the coherence time is larger than one OFDM symbol". It reasons that Doppler of about 5 Hz is small relative to 50 Hz subcarrier spacing (underwater, c = 1500 m/s, 2 m/s relative speed). — [AquaApp §2.3](https://underwatermessaging.cs.washington.edu/underwater_comms.pdf)
  - HRCSS argues OFDM orthogonality is weakened in dynamic aerial channels. — [Cai et al. 2022 via ResearchGate](https://www.researchgate.net/publication/348498420_Boosting_Chirp_Signal_Based_Aerial_Acoustic_Communication_under_Dynamic_Channel_Conditions)
  - Nearby normalizes its acquisition scores to compensate for Doppler. — [Putz App. B.2.1](https://arxiv.org/pdf/2602.02249)
- **Handling.** Handheld use, moving the phone on the table and lifting it had minor effects on the robust schemes. Pocketing broke all of them. People walking in the room had no measurable effect. — [Putz et al. §6.5–6.6](https://arxiv.org/pdf/2602.02249)
- **Clock and sampling offset.**
  - Dhwani: a sampling offset Δt causes a 2πfΔt phase error, corrected with sub-sample shifts. — [Dhwani](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/Paper325Dhwani.pdf)
  - Hush: there are sub-sample differences because devices do not sample at exactly 44.1 kHz. It uses Hilbert-transform sub-sample alignment and re-searches each frame's phase against the pilots rather than assuming exact 1044-sample offsets. — [Hush, receiver section](https://www.cs.wm.edu/~liqun/paper/iotj19.pdf)
  - Frigg et al.: DBPSK avoids having to estimate the phase shifts introduced by D/A and A/D conversion. — [Frigg et al. 2014](https://la.disneyresearch.com/wp-content/uploads/IeeeWons2014_Audiocom1.pdf)
- **Ambient noise.**
  - Noise is significant below 1.5 kHz and up to about 10 dB above the floor at 5 kHz, negligible above 6–8 kHz (mall and café). — [Dhwani](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/Paper325Dhwani.pdf)
  - The audible ggwave band (1.8–6.3 kHz) was unusable with ambient recordings; claps broke short-symbol FSK and OFDM schemes. — [Putz et al. §6.5](https://arxiv.org/pdf/2602.02249)
  - Speech, traffic, machinery and handling noise occupy "a significant share of the available spectrum", with both burst and stationary components. — [Putz et al. §7.3.4](https://arxiv.org/pdf/2602.02249)

### Inferences
- **Doppler arithmetic in air (c = 343 m/s).** Hand motion of 0.5 m/s is a 0.15% time scaling. That is about 7 Hz at 5 kHz but about 28 Hz at 19 kHz.
  - With 50 Hz OFDM spacing (20 ms symbols), audible-band OFDM is barely affected.
  - Near-ultrasonic OFDM needs wider spacing, Doppler tracking, or non-coherent or differential detection.
  - Phones lying on a table (the likely game setup) are close to static.
- **Clock drift.** Typical consumer audio crystal tolerances are tens of ppm (not directly measured in these sources). That is negligible within one 20 ms symbol, but it accumulates to milliseconds per minute in a continuous stream. Timing must be tracked using pilots or cyclic-prefix correlation, or resampled.
- **Device calibration.** Because device heterogeneity dominates, a game-start calibration exchange (sweep or chirp in each direction, then pick the bands and bit loading) would address the biggest real-world failure mode the literature identifies. This is analogous to AquaApp's feedback and HRCSS probing.

### Gaps
- No primary measurement of phone-to-phone sampling-rate offset in ppm was retrieved. A TU Delft thesis measuring Android sampling-rate offset was found but its numbers could not be extracted.
- No phone study isolates the effect of nearby people talking (as opposed to recorded ambient noise) on modem error rates.

---

## Q8. Recommended modulation for about 0.5–2 kbps robust in-room links: tradeoffs

### Takeaway
The evidence favors multicarrier differential PSK (OFDM with DBPSK or DQPSK across time per subcarrier) at about 20 ms symbols with a 2–5 ms cyclic prefix, plus a K=7 convolutional code (rate 1/2 to 2/3) with interleaving and a CRC per frame. Adaptive band or bit loading from a startup probe should be added. This is AquaApp's proven phone design, and Dhwani's at shorter range. MFSK with FEC (ggwave-like) is the robust fallback, proven at about 270 bps. Chirp spread spectrum is the most robust option but tops out at tens to low hundreds of bps. Single-carrier with a decision-feedback equalizer reaches 4 kbps but needs long training, which is ill-suited to 100 ms frames.

### Cited Findings
- **OFDM evidence on phones.**
  - Dhwani: 0.8–2.4 kbps in 1 kHz at 10 cm or less, uncoded. — [Dhwani](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/Paper325Dhwani.pdf)
  - AquaApp: 0.1–1.8 kbps in 1–4 kHz phone-to-phone underwater, using DBPSK across symbols, r = 2/3 K=7 convolutional code, interleaving and MMSE equalization. — [AquaApp](https://underwatermessaging.cs.washington.edu/underwater_comms.pdf)
  - Hush: 4.9 kbps at 5–20 cm. — [Hush](https://www.cs.wm.edu/~liqun/paper/iotj19.pdf)
  - Gonçalves: 600 bps OFDM-QPSK, unreliable at 50 cm (5–32% TER). — [Putz et al.](https://arxiv.org/pdf/2602.02249)
- **MFSK evidence.**
  - ggwave: 268 bps, reliable at 50 cm across 21 phone pairs and in all rooms tested.
  - PriWhisper (8-FSK, 2 ms symbols): fails beyond 20 cm.
  - Digital Voices: unreliable across devices.

  — [Putz et al.](https://arxiv.org/pdf/2602.02249)
- **Chirp and spread-spectrum evidence.**
  - Lee et al.: 15 bps, reliable to 40 m and across all devices.
  - Nearby (DSSS+MFSK): 84 bps.
  - HRCSS (500 bps) could not be validated.

  — [Putz et al.](https://arxiv.org/pdf/2602.02249)
  - Shi et al. CSS: 20 bps to 70 m. — [Shi et al.](https://personalpages.surrey.ac.uk/w.wang/papers/Shi%20et%20al_PhysicalCommunication_2023.pdf)
- **Single carrier with DFE.** 4 kbps at 0.5–2 m with BER below 2e-4, but 30% training overhead and a 0.3 s guard; laptops only. — [Tabak et al.](https://arxiv.org/abs/2103.11261)
- **PAPR and preambles.** A chirp has very low PAPR, which "makes it easier to detect compared to a standard OFDM-based preamble that ha[s] a higher PAPR". — [Dhwani §5.2](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/Paper325Dhwani.pdf)
- **Putz design rules.** Guard intervals for tens of ms of delay spread, robustness to 30 dB level variation, strong FEC with time interleaving, and robustness over rate unless bidirectional adaptation is possible. — [Putz et al. §7.3](https://arxiv.org/pdf/2602.02249)

### Inferences
**Option A: OFDM with differential PSK (recommended primary).** Example parameters per direction in a 1.6 kHz band:
- 50 Hz spacing, giving about 32 subcarriers.
- 20 ms symbol plus a 3–5 ms cyclic prefix (about 41–43 symbols/s).
- DBPSK, giving about 1.3 kbps raw; DQPSK gives about 2.6 kbps raw.
- Rate-1/2 convolutional code, giving about 650 bps (DBPSK) to about 1.3 kbps (DQPSK) net, before framing and pilot overhead.
- Two 20 ms symbols per 100 ms turn plus a pilot would carry about 50–100 bits per turn per direction.

Pros:
- Spectrally efficient.
- Differential encoding across time avoids per-packet channel estimation and tolerates slow phase and clock drift.
- The cyclic prefix handles room reverb.
- Bad subcarriers (device notches) can simply be dropped.

Cons:
- High PAPR, which means more speaker nonlinearity and harmonics. This matters for full duplex, so clipping and filtering are needed.
- Requires symbol-timing tracking.
- Less robust to claps than long-symbol FSK.
- Not independently validated on phones at 0.5–1 m.

**Option B: MFSK or DFSK with FEC (the current approach, improved).**
- Constant envelope, so it is FDD-friendly and robust to level variation, frequency response and gain errors. It is proven on phones (ggwave at 268 bps).
- Shortening symbols from 50 ms to about 20–25 ms with a short guard time would roughly double the raw rate.
- Using several tones at once (multi-tone FSK, one tone per sub-band) can raise the rate further.
- A realistic ceiling is about 300–600 bps net per direction.

**Option C: chirp or DSSS spread spectrum.**
- The most robust option against noise, Doppler and multipath, and good for the sync preamble.
- Rates of about 15–125 bps per direction in published work are too low for the data payload. Best used as the acquisition and resync preamble rather than for payload.

**Option D: single carrier with a decision-feedback equalizer.**
- Highest demonstrated rate (4 kbps at 2 m).
- Requires long training, 30% overhead and an adaptive equalizer per packet. Better suited to long bursts than to a continuous 100 ms-turn stream. WASM could make it feasible computationally.

**Layering for lockstep.**
- Use a per-turn CRC.
- Use input redundancy across turns: repeat the last N turns' inputs in each frame. This acts as time-diversity FEC against claps and lets a lost frame be recovered from the next one without a retransmission round-trip.

### Gaps
- No head-to-head comparison of OFDM-DPSK and MFSK at 0.5–1 m on multiple phones was found. Battle Drones would need to measure this itself; Putz's Zenodo dataset and methodology provide a test harness template.
- No published LDPC-on-phone acoustic modem was found. The published phone modems use convolutional, BCH, Hamming or repetition codes.
