# Browser and phone platform constraints on a speaker/microphone data link (iOS Safari and Android Chrome, as of October 2026)

Research date: 2026-10-15. Each finding gives its source date where it matters. Many of the most relevant WebKit reports were filed in 2025–2026 against iOS 26 and iOS 27. Older findings are labelled with their year.

Bottom line (synthesised from the sections below): **Android Chrome is workable.** Open the mic with all processing off, and Chrome stays in normal media mode and plays through the loudspeaker. **iOS Safari is the make-or-break platform**, because opening the mic forces the play-and-record audio session. With echo cancellation ON, output goes to the loudspeaker. But iOS 26/27 reports describe degraded playback in that mode (reduced sample rate, mono, and on iOS 27 crackling). With echo cancellation OFF, playback is clean but goes to the quiet earpiece/receiver. No web API can request `defaultToSpeaker`. The design must be tested on real iPhones running iOS 26 and 27 before committing to near-ultrasonic or full-duplex operation.

## iOS Safari: output routing, volume/ducking and `navigator.audioSession` while the microphone is open

### Takeaway
Calling getUserMedia on iOS moves Safari's audio session to play-and-record. Native iOS routes that category to the quiet receiver (earpiece) unless `defaultToSpeaker` is set, and Safari exposes no way to set it. In practice, current iOS (26/27) gives you a forced choice. With echo cancellation ON, output goes to the loudspeaker through the voice-processing path, which on iOS 27 crackles and on iOS 26 is reduced in sample rate and mono. With echo cancellation OFF, output is clean but goes to the earpiece at much lower volume. `navigator.audioSession.type` (Safari 16.4+) controls the category, but it cannot force the loudspeaker.

### Cited Findings
- **Native mechanism (Apple docs):** The `playAndRecord` category is for "recording (input) and playback (output) of audio, such as for a VoIP app." In this category, "Your audio continues with the Silent switch set to silent and with the screen locked." It is non-mixable by default. — [Apple: AVAudioSession.Category.playAndRecord](https://developer.apple.com/documentation/avfaudio/avaudiosession/category-swift.struct/playandrecord)
- `defaultToSpeaker` is "An option that determines whether audio from the session defaults to the built-in speaker instead of the receiver." It applies only to playAndRecord. Its use case is "to route audio to the speaker instead of the receiver in cases where the audio normally goes to the receiver." — [Apple: defaultToSpeaker](https://developer.apple.com/documentation/avfaudio/avaudiosession/categoryoptions-swift.struct/defaulttospeaker)
- `videoChat` mode "causes the system to automatically apply the allowBluetoothHFP and defaultToSpeaker category options" and "optimizes the device's tonal equalization for voice". `voiceChat` mode applies only allowBluetoothHFP, not defaultToSpeaker. For chat modes without the voice-processing I/O unit, the system "doesn't apply voice-specific processing, like echo cancellation and automatic gain correction, and disables dynamic processing on input and output, which results in a lower playback level." — [Apple: videoChat mode](https://developer.apple.com/documentation/avfaudio/avaudiosession/mode-swift.struct/videochat); [Apple: voiceChat mode](https://developer.apple.com/documentation/avfaudio/avaudiosession/mode-swift.struct/voicechat)
- `measurement` mode minimises system signal processing, "uses the primary microphone", and "disables some dynamics processing on input and output signals, resulting in a lower-output playback level." — [Apple: measurement mode](https://developer.apple.com/documentation/avfaudio/avaudiosession/mode-swift.struct/measurement)
- **iOS 27 regression (WebKit bug 326286, filed 2026-10-04, status NEW):** "Audio output crackles while getUserMedia mic capture with echo cancellation is active." It affects Web Audio (AudioBufferSourceNode, and a 440 Hz AudioWorklet tone in a confirming comment on an iPhone 16 Pro running iOS 27.0.1) and `<audio>` elements. The reporter states: "With echo cancellation off, playback is clean but routes to the earpiece at much lower volume." Other reported results:
  - It was clean on iOS 18.7 and iOS 26.2.
  - latencyHint 'playback', a shared context, creating the context after the mic, and routing through MediaStreamAudioDestinationNode into `<audio>` did not help.
  - A native app using `.playAndRecord` + `.defaultToSpeaker` without voice processing plays cleanly on the same device. The reporter concludes this "suggests the issue is in the voice-processing path WebKit uses for echo cancellation."
  - Audio session state seems to persist after the mic is released, even across reloads.
  — [WebKit bug 326286](https://bugs.webkit.org/show_bug.cgi?id=326286)
- **iOS 26 degradation (WebKit bug 311451, filed 2026-04-03, NEW, unassigned):** After getUserMedia starts, playback suffers "Reduced sample rate" and "Stereo audio converted to mono." This happens "With or without the echoCancellation: false constraint". It was seen on iOS 26.4 (iPhone 15 Pro) and called "a longstanding issue". A comment reports it persisting on iOS 27 public beta, and another says it "has become audible crackling" on iOS 27. The reporter notes echoCancellation "appears to be the only constraint Safari uses." — [WebKit bug 311451](https://bugs.webkit.org/show_bug.cgi?id=311451)
- **Long-running volume drop (WebKit bug 218012, 2020–2026):** "Audio Volume reduces considerably on accepting the mic permissions."
  - Reproduced on iOS 13.5 through 18.6.
  - WebKit's youenn fablet (2020): "When starting capturing, we are changing of audio category which might explain the issue." He suggested suspend/resume of the AudioContext, which was inconsistent across devices. In 2022 he suggested routing WebAudio through a MediaStreamAudioDestinationNode.
  - Bryce Aebi (Mar 2023): set `navigator.audioSession.type = 'play-and-record'` before capture and `'playback'` afterwards. It worked on iOS 16.4 beta 2 but was later reported unreliable.
  - Jan 2025: disabling AGC/EC/NS fixed it on an iPad running iOS 17. Mar 2026: the same constraint change did not help on iOS 18.6.
  - ch.chiang (Mar 2026) reports that setting `play-and-record` "routes playback to the receiver until capture starts". He asked WebKit to route to the default speaker under play-and-record.
  - Status: RESOLVED/CONFIGURATION CHANGED, last modified 2026-05-20.
  — [WebKit bug 218012](https://bugs.webkit.org/show_bug.cgi?id=218012)
- **Older (2021, iOS 15):** WebRTC audio went to the earpiece instead of the bottom speaker, and low volume persisted after 15.1. — [WebKit bug 230902](https://bugs.webkit.org/show_bug.cgi?id=230902)
- **Developer field report (May 2026, iOS 17.x–18.x):** "AudioContext alone gives you playback, getUserMedia flips you to play-and-record". With both, you get play-and-record "with no defaultToSpeaker equivalent". The same report says "Even in play-and-record mode, AudioContext output goes to the speaker", while SpeechSynthesis/TTS gets demoted to the earpiece. After closing mic tracks, the session "clung to play-and-record for several hundred milliseconds". AudioContexts "suspend themselves between user gestures", so check `state === 'suspended'` and call `resume()`. Safari's VoIP-tuned AEC "picks up real speaker bleed". — [Sam Eddy, "iOS Safari audio sessions"](https://samueleddy.com/writing/ios-safari-audio-sessions/)
- **W3C Audio Session spec (Editor's Draft, 13 Nov 2024; editors from Apple and Mozilla):**
  - Types: `auto` (default), `playback`, `transient`, `transient-solo`, `ambient`, `play-and-record`.
  - With `auto`, an active microphone track yields play-and-record. Mic-track update steps apply only when the type is auto or play-and-record.
  - The spec does not address the mute switch or output routing.
  — [W3C Audio Session](https://w3c.github.io/audio-session/)
- **Support:** `navigator.audioSession` and `AudioSession.type` arrived in Safari 16.4 (iOS mirrors desktop). `AudioSession.state` and `statechange` are not implemented in Safari. There is no support in Chrome. — [MDN browser-compat-data: AudioSession](https://github.com/mdn/browser-compat-data/blob/main/api/AudioSession.json). It was undefined on iOS 16.2/16.3 — [WebKit bug 218012](https://bugs.webkit.org/show_bug.cgi?id=218012).
- **Silent/ring switch:** By default Web Audio's session type is "ambient", so it is muted when the phone is muted, while `<audio>`/`<video>` elements are not. A commenter (2024-09-25) said: "Since iOS 17, you can set the audio session type to 'playback'". — [WebKit bug 237322](https://bugs.webkit.org/show_bug.cgi?id=237322). Apple's ambient category: "Screen locking and the Silent switch ... silence your audio." — [Apple: ambient](https://developer.apple.com/documentation/avfaudio/avaudiosession/category-swift.struct/ambient)
- **Silent-file hack:** The older workaround of playing a silent `<audio>` loop puts lock-screen media controls up, and a later Safari release broke the trick at one point. — [unmute.js](https://github.com/swevans/unmute); [Jeremy Keith, "Web Audio API update on iOS"](https://adactio.com/journal/19929)
- **AirPods/Bluetooth (iOS 15.5, 2022):** getUserMedia with AirPods connected caused stuttering and slowed AudioContext playback. — [WebKit bug 221334](https://bugs.webkit.org/show_bug.cgi?id=221334)

### Inferences
- Safari's echoCancellation=true capture almost certainly runs through Apple's voice-processing I/O unit. That would account for loudspeaker routing (the defaultToSpeaker behaviour of the chat modes) plus voice EQ and dynamics. echoCancellation=false most likely gives plain playAndRecord without defaultToSpeaker, which explains the receiver routing (bug 326286). This matches Apple's documented mode behaviour, but WebKit's exact AVAudioSession mode is not stated in any source.
- Practical iOS options to test on iOS 26.x and 27.x:
  - **(a)** Keep `echoCancellation: true` to get the loudspeaker, and accept voice processing on both TX and RX. This risks iOS 27 crackle, reduced output sample rate (which may kill 17–20 kHz output), and AEC suppressing the peer's signal.
  - **(b)** Use `echoCancellation: false` and accept earpiece output. At 0.1–0.3 m, with the phones' top edges facing each other, earpiece output may actually suffice for a short-range link.
- Set `navigator.audioSession.type = 'play-and-record'` once, before getUserMedia, inside the user gesture. Do not toggle it mid-session. This avoids the category flip and keeps the silent switch from muting output. With a mic open, the play-and-record category is documented to continue with the silent switch on.
- Before the mic opens (lobby/menus), use `'playback'` or accept that the ring switch mutes Web Audio.
- Expect to need recovery code: check `AudioContext.state` and resume on user gesture, and watch for track `ended`/`mute`.

### Gaps
- No source states which AVAudioSession mode WebKit uses for echoCancellation true versus false on iOS 26/27, or whether `navigator.audioSession.type` changes that.
- No measured numbers for how much quieter earpiece output is than loudspeaker output from Safari.
- Bug 311451's "reduced sample rate" gives no figure, for example whether output drops to 24 kHz or 16 kHz, so its effect on >12 kHz content is unknown.
- I found no confirmed iOS 26/27 behaviour for `type = 'playback'` while a mic track is live. The 2023 workaround in bug 218012 is ambiguous about when to switch back.

## getUserMedia processing constraints (echoCancellation, noiseSuppression, autoGainControl), voice processing, and using the browser AEC to cancel self-interference

### Takeaway
On Android Chrome, all three constraints are honoured, and turning all of them off has the important side effect of keeping Android out of "in-communication" mode. On iOS Safari only `echoCancellation` effectively does anything. It switches between the voice-processing path (loudspeaker, but processed) and an unprocessed path (earpiece). Browser AECs are built for speech. In WebRTC AEC3 the bands above 8 kHz get only a scalar suppression gain tied to the sub-8 kHz gain, not true linear cancellation. Using the browser AEC as a full-duplex self-interference canceller is untested in public, and is likely to suppress the peer's signal during your own transmission.

### Cited Findings
- **Chrome Android source (audio_manager_android.cc, current main):**
  - Code comment: "By default, the audio manager for Android creates streams intended for real-time VoIP sessions and therefore sets the audio mode to MODE_IN_COMMUNICATION... However, the user might have asked for a special mode where all audio input processing is disabled, and if that is the case we avoid changing the mode."
  - The switch happens only when `params.effects() != AudioParameters::NO_EFFECTS`.
  - Default effects come from `AcousticEchoCancelerIsAvailable()` (the platform AEC).
  - Input goes through AAudio or OpenSL ES. AAudio input is disabled on some Unisoc devices "due to missing/broken echo cancellation".
  — [Chromium audio_manager_android.cc](https://chromium.googlesource.com/chromium/src/media/+/master/audio/android/audio_manager_android.cc)
- **Old Chromium change (2013/2014):** Enabled the Android platform echo cancellation through AudioRecord, gated on `isPlatformAECSupported`. — [Chromium code review 99033003](https://codereview.chromium.org/99033003)
- **Chrome guidance (older):** To disable processing, set `echoCancellation: false` and do not explicitly enable the goog* constraints. — [discuss-webrtc: audio processing moved to getUserMedia](https://groups.google.com/g/discuss-webrtc/c/m6Rory-FjAg)
- **Constraint behaviour can surprise you:**
  - A 2023 report says Chrome with echoCancellation false forced channelCount 2 and 44100 Hz despite requesting 1 and 48000. — [W3C webrtc-logs 2023-04](https://lists.w3.org/Archives/Public/public-webrtc-logs/2023Apr/0082.html)
  - Safari 26 on macOS gave stereo capture with EC false even with channelCount 1. — [Apple Developer Forums 804765](https://developer.apple.com/forums/thread/804765)
  - Use `getSettings()` to verify. `getSupportedConstraints()` "returns too many false positives" (2017 tests). — [addpipe: getUserMedia audio constraints](https://blog.addpipe.com/getusermedia-audio-constraints/)
- **Safari history:**
  - 2017 (Safari 11): `echoCancellation: false` did not turn EC off. The workaround was `applyConstraints` on the track after capture. — [WebKit bug 179411](https://bugs.webkit.org/show_bug.cgi?id=179411)
  - Safari 11 had no noiseSuppression/autoGainControl support and fixed sampleRate at 44100 (2017). — [addpipe](https://blog.addpipe.com/getusermedia-audio-constraints/)
  - 2026: echoCancellation "appears to be the only constraint Safari uses". — [WebKit bug 311451](https://bugs.webkit.org/show_bug.cgi?id=311451)
  - iOS 27: `getSettings().echoCancellation === true` by default, and turning it off changes routing to the earpiece. — [WebKit bug 326286](https://bugs.webkit.org/show_bug.cgi?id=326286)
- **WebRTC AEC3 internals** (code comments in suppression_gain.cc, as summarised by search):
  - There is a separate function that "Computes the gain to apply for the bands beyond the first band".
  - The upper-band gain is the minimum of the sub-8 kHz gain, an anti-howling gain and a bound during echo activity.
  - When echo saturation is detected, upper bands get min(0.001, low-band gain), which is about −60 dB.
  - A "conservative" mode caps gain at high bands because the adaptive filter has not converged there.
  — [WebRTC AEC3 suppression_gain.cc](https://chromium.googlesource.com/external/webrtc/+/lkgr/modules/audio_processing/aec3/suppression_gain.cc)
- AEC3 uses an adaptive linear filter plus a per-band residual echo suppressor. The suppressor can leave "unnaturally silent gaps". — [Switchboard: How WebRTC AEC3 works](https://switchboard.audio/hub/acoustic-echo-cancellation-how-webrtc-aec3-works/)
- **Echo-cancellation scope proposal (2025):** A proposed `echoCancellation` enum lets apps remove only remote peer-connection audio, all system audio, or let the UA decide. The TAG closed its review as satisfied on 2025-07-10, with "positive feedback from all major browsers". — [W3C TAG review #1107](https://tag-github-bot.w3.org/gh/w3ctag/design-reviews-private-brainstorming/163)
- **iOS voice processing:** VPIO prefers 48 kHz and a 20 ms IO buffer (one project's notes, not Apple docs). — [pp-browser PR #227](https://github.com/people-post/pp-browser/pull/227). Apple: chat modes "optimize the device's tonal equalization for voice". — [Apple: voiceChat](https://developer.apple.com/documentation/avfaudio/avaudiosession/mode-swift.struct/voicechat)
- **Real-world AEC leakage:** Safari's AEC "picks up real speaker bleed and reports it to the application as if the user is talking". The workaround was ignoring speech shorter than about 300 ms. — [Sam Eddy](https://samueleddy.com/writing/ios-safari-audio-sessions/)

### Inferences
- **Recommended capture constraints for Android Chrome:** `{echoCancellation:false, noiseSuppression:false, autoGainControl:false, channelCount:1}`. Then verify with `track.getSettings()`. This avoids MODE_IN_COMMUNICATION, platform AEC/NS (which treats stationary tones as noise) and AGC (which pumps the level when your own transmitter starts and stops).
- NS algorithms classify stationary narrowband energy, such as continuous tones and pilot carriers, as noise and attenuate it. AGC will ride gain up and down with your own transmissions. Both argue for turning processing off where possible and using short bursty symbols with per-frame level normalisation if it cannot be turned off (iOS speaker path).
- **Using the browser AEC as a self-interference canceller is theoretically attractive.** The AEC reference contains exactly what this phone played, and the peer's signal is not in it. But several factors make it a poor bet:
  - In AEC3, above 8 kHz there is no per-frequency linear cancellation, just a broadband gain coupled to the 0–8 kHz echo state. During your own transmission the peer's 17–20 kHz signal would likely be gated down too.
  - Within 0–8 kHz the residual suppressor attenuates per band. Frequency-division duplex, with different bands per direction, might survive better than same-band duplex.
  - Double-talk is exactly what AECs are tuned to tolerate for speech, not for continuous modem signals.
  - On iOS the AEC path currently brings crackle and degraded output (iOS 26/27).
  - It would be an experiment, not a design foundation.
- **A safer full-duplex design:** Choose frequency-division duplex, with each phone transmitting in a separate band. Disable browser AEC/NS/AGC (Android). Do your own band-pass filtering in the AudioWorklet. Optionally implement your own known-signal cancellation, since you know exactly what you transmitted, in WASM. Alternatively choose time-division (half-duplex with fast turnaround), which sidesteps self-interference entirely.

### Gaps
- I found no public report of anyone using a browser's built-in AEC to enable full-duplex data-over-sound. ggwave and Quiet.js issue trackers could not be searched from this environment because GitHub search API access was blocked.
- I could not confirm whether the AEC3 linear filter itself runs only on the lower band. The code comments imply upper bands get only suppression gain.
- It is unknown whether Chrome Android with EC on uses the platform (hardware) AEC or software AEC3 today. The code shows the platform AEC availability check drives the effects flag.
- iOS VPIO frequency response, and whether it low-passes capture or output, is undocumented.

## Android Chrome: audio mode, routing and volume while recording

### Takeaway
With any input processing enabled (the default), Chrome on Android switches the OS to MODE_IN_COMMUNICATION and picks the loudspeaker as default output, never the earpiece, when no headset is attached. Volume then follows the call-volume stream. With all processing disabled, Chrome leaves the audio mode alone (normal media playback). Android is therefore much friendlier than iOS for this use.

### Cited Findings
- **Default device selection in communication mode:** "The 'most unique' device will be selected; Wired headset first, then USB audio device, then Bluetooth and last the speaker phone." `selectDefaultDevice` returns `ID_SPEAKERPHONE` when nothing else is attached. The earpiece is never chosen by default. — [Chromium CommunicationDeviceSelector.java](https://chromium.googlesource.com/chromium/src/+/main/media/base/android/java/src/org/chromium/media/CommunicationDeviceSelector.java)
- **`setCommunicationAudioModeOn(true)`:**
  - Saves the speakerphone and mute state, then calls `setMode(MODE_IN_COMMUNICATION)`, and restores MODE_NORMAL afterwards.
  - It observes `STREAM_VOICE_CALL` volume, and mutes if the call volume is zero, because "It is only possible to pull down the volume slider to about 20%".
  - Native output sample rate comes from `PROPERTY_OUTPUT_SAMPLE_RATE`, falling back to 44100.
  - Low-latency buffer size comes from `PROPERTY_OUTPUT_FRAMES_PER_BUFFER` when `FEATURE_AUDIO_LOW_LATENCY` is present.
  — [Chromium AudioManagerAndroid.java](https://chromium.googlesource.com/chromium/src/media/+/master/base/android/java/src/org/chromium/media/AudioManagerAndroid.java)
- **Mode switch condition:** Communication mode is entered only for the first input stream with effects. It is not entered when "all audio input processing is disabled". — [Chromium audio_manager_android.cc](https://chromium.googlesource.com/chromium/src/media/+/master/audio/android/audio_manager_android.cc)
- **Volume (2019 user report):** On Chrome for Android, media-element volume normally follows the "media" volume. "once gUM has been called (and accepted) the 'call' volume setting is used." — [W3C public-webrtc-logs 2019-09](https://lists.w3.org/Archives/Public/public-webrtc-logs/2019Sep/0251.html)
- **Buffer defaults in Chromium's Android audio manager:**
  - `kDefaultInputBufferSize = 1024` frames
  - `kDefaultLowLatencyOutputBufferSize = 256`
  - `kDefaultOutputBufferSize = 2048` when low latency is unsupported
  - `kDefaultTargetSampleRate = 48000` for input rate selection
  — [Chromium audio_manager_android.cc](https://chromium.googlesource.com/chromium/src/media/+/master/audio/android/audio_manager_android.cc)
- **Android VOICE_COMMUNICATION input source:** "tuned for voice communications such as VoIP. It will for instance take advantage of echo cancellation or automatic gain control if available". UNPROCESSED is "raw" if available. — [Android MediaRecorder.AudioSource](https://developer.android.com/reference/android/media/MediaRecorder.AudioSource)

### Inferences
- On Android, disable all three processing constraints. You should then get MODE_NORMAL, media volume, loudspeaker output and a less processed mic path. Instruct users to turn up *media* volume.
- If processing stays on, the user must raise *call* volume. Some OEM HALs also apply voice-call EQ/limiting in communication mode, which is plausible but unsourced.
- Which Android input source Chrome requests (MIC, VOICE_RECOGNITION, VOICE_COMMUNICATION) when processing is off was not visible in the C++ file I read. Expect OEM-specific pre-processing to remain on some devices.

### Gaps
- No source confirms which AAudio input preset Chrome uses with processing disabled.
- No measured output SPL or frequency response for Chrome on Android in MODE_NORMAL versus MODE_IN_COMMUNICATION.

## Sample rates, resampling and near-ultrasonic (17–20 kHz) viability

### Takeaway
Current iPhones report 48 kHz for both AudioContext and mic. Chrome on Android targets 48 kHz but uses the device's native output rate. Phones can generally emit and capture 18.5–20 kHz natively, as Google Nearby showed and ggwave's inaudible mode is used for. But frequency response above about 16–17 kHz varies widely by model. On iOS, with the mic open, playback may be sample-rate-reduced (iOS 26 bug 311451), which would destroy near-ultrasonic output. Near-ultrasonic on iOS Safari is therefore unproven. An audible-band fallback is essential.

### Cited Findings
- **iOS 27 rates:** On iPhone 16 (iOS 27), "Both AudioContexts and the mic report 48000 Hz." — [WebKit bug 326286](https://bugs.webkit.org/show_bug.cgi?id=326286)
- **iOS 26 playback degradation:** With the mic open, playback shows "Reduced sample rate" and mono conversion, with or without EC false. — [WebKit bug 311451](https://bugs.webkit.org/show_bug.cgi?id=311451)
- **Older iOS rate switching:** The hardware rate switched between 44.1 and 48 kHz and caused distortion (old, resolved). — [WebKit bug 154538](https://bugs.webkit.org/show_bug.cgi?id=154538). There were 44.1 kHz asset crackles on iOS 12 (old). — [howler.js #1141](https://github.com/goldfire/howler.js/issues/1141)
- **Chrome Android input rate:** Chosen to be closest to 48000, otherwise the native output rate. — [Chromium audio_manager_android.cc](https://chromium.googlesource.com/chromium/src/media/+/master/audio/android/audio_manager_android.cc)
- **AudioContext `sampleRate` option:** Supported since Safari 14.1 and Chrome 74. — [MDN BCD: AudioContext](https://github.com/mdn/browser-compat-data/blob/main/api/AudioContext.json)
- **Google Nearby:** Its protocol used 18.5–20 kHz on commodity phone speakers/mics (IEEE TMM 2018) at 94.5 b/s, reliable at about 2 m. — [Getreuer et al., "Ultrasonic Communication Using Consumer Hardware"](https://www.researchgate.net/publication/320575022_Ultrasonic_Communication_Using_Consumer_Hardware)
- **One Android study (2020):** A stable response up to about 16.8 kHz, with transmission working up to 19.7 kHz on one device. It concluded that one tested device was "not suitable for higher frequencies due to the limitation of the built-in microphone." — [IIT, "Near-Ultrasonic Communications for IoT Applications using Android Smartphone"](https://ecasp.ece.iit.edu/publications/2012-present/2020-10.pdf)
- **Putz et al., ACM TIoT, Feb 2026** (5 Android phones: Pixel 4a, Pixel 6 Pro, Nexus 6P, Oppo Reno 6, Galaxy S20 Ultra; over 11,000 transmissions; native apps):
  - "Each device has a different frequency response, particularly at near-ultrasonic frequencies."
  - For inaudible transmission the usable bandwidth is "less than 4 kHz", and hardware is "highly frequency selective" there.
  - "up to 30 dB SPL spread between phones at the same volume setting".
  - Nonlinear distortion appears above about 75% volume on most devices.
  - Inaudible ggwave "remained effective up to 20 m" in an office, while audible ggwave "only worked up to 1 m".
  - Net rates: ggwave 268 bps, PriWhisper 729 bps, Gonçalves et al. 600 bps, Nearby 84 bps.
  - At 50 cm across device pairs, Gonçalves et al. ranged from 5% to 32% total error.
  - The MIC source was used except on the Pixel 4a (UNPROCESSED), "to bypass Android's post-processing".
  — [Putz et al., arXiv 2602.02249](https://arxiv.org/html/2602.02249)
- **Android CDD UNPROCESSED requirements:** Approximately flat ±10 dB only from 100 Hz to 7 kHz, with only amplitude limits from 7 to 22 kHz. Many devices don't support UNPROCESSED; for example, a Samsung S8 reports false. — [Android CDD 5.11 Unprocessed audio](https://android.googlesource.com/platform/compatibility/cdd/+/refs/heads/nougat-dev/5_multimedia/5_11_unprocessed-audio.md); [oboe issue #95](https://github.com/google/oboe/issues/95)
- **Quiet.js (old README, pre-Safari 11):**
  - The iOS Safari receiver was unsupported because Safari then lacked getUserMedia. That limitation is long obsolete.
  - The ultrasonic profile "cannot be used for Firefox receivers because of how Firefox resamples audio input."
  - Chrome requires HTTPS for mic input.
  — [quiet-js](https://github.com/quiet/quiet-js)

### Inferences
- At 48 kHz the Nyquist limit is 24 kHz, so 17–20 kHz is representable. The risks are (a) hardware rolloff, (b) OS/VPIO processing and resampling, and (c) the iOS 26 reduced-sample-rate playback with mic open.
- Recommended design: probe at session start. Send a short chirp or multi-tone sweep 14–20 kHz both ways and measure SNR per band, then pick the band.
- Keep an audible-band fallback, for example 2–7 kHz, which is inside every phone's ±10 dB region and below the AEC3 8 kHz split.
- Short distances (0.1–1 m) favour near-ultrasonic, since the 20 m office results show plenty of link margin.
- Explicitly request `new AudioContext({sampleRate: 48000})` to match the mic and avoid resampling inside the graph. Log `ctx.sampleRate` and `track.getSettings().sampleRate`.

### Gaps
- No measured iPhone speaker/mic response above 15 kHz through Safari's capture path, either with or without echo cancellation.
- Whether iOS VPIO band-limits capture (for example to 16 or 24 kHz internal rates) is undocumented.
- The magnitude of bug 311451's "reduced sample rate" is unknown.

## Latency (output, input and round trip)

### Takeaway
There are no authoritative 2024–2026 phone-browser round-trip measurements. Expect roughly 20–80 ms one-way speaker-to-demodulator latency in the browser. Acoustic flight time at 1 m is only about 3 ms. The budget below 150 ms one-way is achievable with `latencyHint: 'interactive'` (the default) and processing disabled. Framing and demodulation windows will dominate, so measure on target devices with an in-app loopback test.

### Cited Findings
- **Native Android round trip (2016, old):** Nexus 9 at 15 ms (128-frame buffer) and Nexus 6P at 18 ms (192 frames). The same Nexus 9 measured 42 ms on Android 5.1.1 versus 14 ms on 6.0.1. Built-in mic-array noise cancelling adds about 13 ms. — [Superpowered latency](https://superpowered.com/latency); [Superpowered: Android Marshmallow latency](https://superpowered.com/android-marshmallow-latency)
- **Browser on desktop (Feb 2021, 2016 MacBook, not phones):** About 67 ms end-to-end in Chrome and about 55 ms in Firefox with defaults. About 19 ms in Chrome and 14 ms in Firefox with `latencyHint: 0` and EC/NS/AGC off. Chrome's `MediaTrackSettings.latency` "always returns 0.01". — [Jeff Kaufman, "Browser Audio Latency"](https://www.jefftk.com/p/browser-audio-latency)
- **Unverified blog figures:** 35–80 ms for Android Chrome and 30–60 ms for iOS Safari. — [audiolab.tools](https://audiolab.tools/insights/realtime-audio-in-the-browser)
- **Measurement method:** An open-source MLS cross-correlation round-trip test for browsers exists. — [gilpanal/weblatencytest](https://github.com/gilpanal/weblatencytest)
- **Support:**
  - `latencyHint` and `baseLatency`: Safari 14.1, Chrome 58.
  - `outputLatency`: Safari 18.4, Chrome 102.
  - `setSinkId`: not in Safari.
  — [MDN BCD: AudioContext](https://github.com/mdn/browser-compat-data/blob/main/api/AudioContext.json)
- **Chrome Android buffers:** Default input buffer is 1024 frames (about 21 ms at 48 kHz). Low-latency output is 256 frames, or the device's `PROPERTY_OUTPUT_FRAMES_PER_BUFFER`. — [Chromium audio_manager_android.cc](https://chromium.googlesource.com/chromium/src/media/+/master/audio/android/audio_manager_android.cc)
- **iOS VPIO:** Prefers a 20 ms IO buffer (one project's notes). — [pp-browser PR #227](https://github.com/people-post/pp-browser/pull/227)
- **Render quantum:** Web Audio renders in 128-frame quanta, about 2.67 ms at 48 kHz. — [W3C Web Audio API 1.1](https://www.w3.org/TR/webaudio-1.1/)

### Inferences
- **One-way budget estimate:**
  - Output path 10–40 ms
  - Acoustic flight 0.3–3 ms
  - Input path 20–40 ms (Chrome's 1024-frame input buffer alone is about 21 ms)
  - Demodulation window (symbol length plus frame-sync)
  - That is roughly 40–100 ms before the symbol/frame duration. 150 ms one-way is feasible only if frames are short, around 50 ms or less on air, and decoding is incremental. 100 ms frame cadence with sub-150 ms latency is tight but plausible on Android. On iOS it is uncertain.
- Keep `latencyHint: 'interactive'`. Do not use 'playback', which raises baseLatency; Kaufman's large improvement came from latencyHint 0 plus processing off. Report `baseLatency` and `outputLatency` in a debug overlay.
- For lockstep, measure the actual round-trip with a timestamped ping frame in-app rather than trusting `outputLatency`. Kaufman found `outputLatency` "implausibly low" in Firefox.

### Gaps
- No current (2024–2026) measured getUserMedia-to-AudioWorklet input latency on iPhones or recent Android phones.
- The Superpowered database pages for recent devices were not retrieved.

## AudioWorklet, WASM SIMD, SharedArrayBuffer and cross-origin isolation on GitHub Pages

### Takeaway
AudioWorklet is supported (Safari 14.1+, Chrome 66+), as is WASM fixed-width SIMD (Safari 16.4+, Chrome 91+). SharedArrayBuffer needs cross-origin isolation. GitHub Pages can only get that via the coi-serviceworker hack, which has had iOS failures. An audio modem does not need SharedArrayBuffer: run the demodulator inside the AudioWorklet, or batch blocks to the main thread with transferable postMessage.

### Cited Findings
- **AudioWorklet:** Safari 14.1 and Chrome 66 (iOS and Android mirror desktop). — [MDN BCD: AudioWorklet](https://github.com/mdn/browser-compat-data/blob/main/api/AudioWorklet.json)
- **WebAssembly fixed-width SIMD:** Safari 16.4 (March 2023), Chrome 91. — [MDN BCD: fixed-width-SIMD](https://github.com/mdn/browser-compat-data/blob/main/webassembly/fixed-width-SIMD.json); [Emscripten SIMD docs](https://emscripten.org/docs/porting/simd.html)
- **SharedArrayBuffer:** Safari 15.2 and Chrome Android 89, both gated on cross-origin isolation. — [MDN BCD: SharedArrayBuffer](https://github.com/mdn/browser-compat-data/blob/main/javascript/builtins/SharedArrayBuffer.json)
- **coi-serviceworker** injects COOP/COEP headers from a service worker for hosts like GitHub Pages. A third-party note says iOS Safari only gained COEP `credentialless` in 17.5 (May 2024), and that older iOS silently stays non-isolated. — [gist on coi-serviceworker](https://gist.github.com/BLamy/0025ded94834009729c57775707cd822)
- **Zoom developers** reported SharedArrayBuffer/coi-serviceworker session failures on iOS 16.7, and skipped coi-serviceworker on iOS. — [Zoom dev forum](https://devforum.zoom.us/t/session-failing-when-using-sharedarraybuffer-on-ios/122170)
- **Posting a SharedArrayBuffer to an AudioWorkletProcessor** failed in Safari (bug since RESOLVED FIXED; version not stated). — [WebKit bug 237144](https://bugs.webkit.org/show_bug.cgi?id=237144)

### Inferences
- **The data rates are tiny.** At 48 kHz mono float32 the stream is 192 kB/s. Posting one transferable Float32Array per 8 render quanta (1024 frames, about 21 ms) is about 47 messages/s, which is trivial. Better still, demodulate inside the AudioWorkletProcessor: compile WASM on the main thread and post the `WebAssembly.Module` to the worklet port. Then only decoded bytes (150–750 bit/s) cross threads.
- **Avoid coi-serviceworker.** Cross-origin isolation would also force COEP on every resource the RTS loads, and service-worker reload tricks interact badly with the PWA's own service worker.
- **Do modulation in the worklet too**, generating tones sample-accurately, rather than scheduling OscillatorNodes from the main thread. That gives sample-accurate symbol timing that is immune to main-thread jank from the game loop.

### Gaps
- I did not verify Safari support for instantiating a WASM module inside AudioWorkletGlobalScope via a posted `WebAssembly.Module`. It is commonly done, but not confirmed here for iOS 26/27.
- Which Safari version fixed bug 237144 is unknown.

## Background, screen lock and auto-lock (Wake Lock)

### Takeaway
Treat the link as foreground-only. iOS mutes or ends capture when the page is backgrounded or the device locks, especially in installed home-screen web apps, and recovery may require calling getUserMedia again. Use the Screen Wake Lock API (iOS Safari 16.4+, and in installed PWAs only from iOS 18.4) to stop auto-lock during play. Re-acquire it on `visibilitychange`.

### Cited Findings
- **Screen Wake Lock:**
  - Chrome 84 (Android mirrors).
  - Safari 16.4 on desktop and iOS, with the iOS note "Does not work in standalone Home Screen Web Apps" for 16.4–18.3.
  - Full iOS support from 18.4.
  — [MDN BCD: WakeLock](https://github.com/mdn/browser-compat-data/blob/main/api/WakeLock.json); [WebKit bug 254545](https://bugs.webkit.org/show_bug.cgi?id=254545)
- The PWA wake-lock bug was "fixed by Apple in iOS 18.4". Wrap `navigator.wakeLock.request()` in try/catch. — [Progressier: Screen Wake Lock](https://progressier.com/pwa-capabilities/screen-wake-lock)
- **iOS track ended after backgrounding:** An audio track's readyState became "ended" after a few seconds on the home screen. Calling getUserMedia again restored it, using the Page Visibility API as the trigger. — [WebKit bug 204681](https://bugs.webkit.org/show_bug.cgi?id=204681)
- **iOS 15.5 (2022):** The mic went silent on auto-lock while playback continued. It was not reproducible on 15.6 beta 3. — [WebKit bug 241400](https://bugs.webkit.org/show_bug.cgi?id=241400)
- **Home-screen web apps (2023 comment):** These lose the mic when backgrounded or locked, while the same page in Safari keeps it. — [WebKit bug 239602](https://bugs.webkit.org/show_bug.cgi?id=239602)
- **Only one capture at a time on iOS:** A new getUserMedia call elsewhere mutes the earlier stream. — [WebKit bug 179964](https://bugs.webkit.org/show_bug.cgi?id=179964)
- **After a phone call interruption,** getUserMedia succeeded but delivered silence until the tab was reopened. — [WebKit bug 208209](https://bugs.webkit.org/show_bug.cgi?id=208209)
- **iOS 26 (2026):** After the audio daemon resets, getUserMedia fails permanently with NotAllowedError until a full reload. The bug is marked resolved. — [WebKit bug 319706](https://bugs.webkit.org/show_bug.cgi?id=319706)
- **iOS 26.1 beta 1 (Sept 2025):** Safari mic capture broke with "No AVAudioSessionCaptureDevice device". Users reported it fixed in 26.1 beta 2. — [Apple Developer Forums 802555](https://developer.apple.com/forums/thread/802555)

### Inferences
- **Required game logic:**
  - Acquire the wake lock at match start.
  - On `visibilitychange` back to visible, re-request the wake lock, check `track.readyState`/`muted` and `AudioContext.state`, and re-call getUserMedia and `resume()` if needed. Both need a user gesture on iOS, so show a "tap to reconnect" overlay.
  - The lockstep protocol must tolerate a link outage, for example by pausing the simulation.
- Phone calls, Siri and other audio apps will interrupt the session. Design for resumption.

### Gaps
- No authoritative source found for Android Chrome's behaviour when the tab is backgrounded or the screen turns off during getUserMedia capture.

## Clock drift between two phones

### Takeaway
Phone audio sample clocks deviate from nominal by roughly 1–80 ppm, and some phones even use different clocks for speaker and mic. With two phones the relative offset can reach on the order of 100+ ppm. That is negligible within one short frame, but it accumulates to several milliseconds per minute on a continuous stream. Re-synchronise timing on every frame (preamble/sync word) rather than relying on a free-running symbol clock.

### Cited Findings
- **2023 smartphone underwater positioning paper:** The gap between actual and nominal sampling rate is the dominant error source, "around 1-80 ppm" for Android devices. The speaker-versus-mic clock difference is "usually quite small in most Android phone". — [arXiv 2307.11263](https://arxiv.org/pdf/2307.11263)
- **Chen, Chan and Gollakota (2022):** Mic and speaker buffers are filled independently, and "some of these phones can use a different clock for the two buffers resulting in slightly different sampling rates". They keep streams open so the offset stays constant, and calibrate once. — [arXiv 2209.01780](https://arxiv.org/pdf/2209.01780)
- **BeepBeep (SenSys 2007):** Counting samples between two beeps cancels clock offsets in two-way ranging. — [BeepBeep paper](https://www.cs.purdue.edu/homes/chunyi/pubs/sensys106-beepbeep.pdf)

### Inferences
- **Worst case:** 80 ppm on each phone gives a relative offset of up to about 160 ppm.
  - At 48 kHz that is about 7.7 samples/s of drift.
  - Within a 100 ms frame, under 1 sample, which is irrelevant.
  - Over a 60 s unsynchronised stream, about 460 samples (about 9.6 ms). That is enough to break symbol timing if symbols are 10 ms or shorter.
  - Carrier frequency error at 19 kHz is about 3 Hz, which is negligible for FSK/OFDM tone spacing of 20 Hz or more.
- **Mitigation:**
  - Use a preamble or chirp per frame for timing recovery.
  - Optionally track drift and use it to estimate the peer's clock.
  - This is also useful for lockstep: the measured drift tells you how the peer's audio clock relates to yours, though game-tick timing should come from `performance.now()`.

### Gaps
- No iPhone-specific ppm figures were found.

## Loudness, hearing safety and annoyance (audible tones versus near-ultrasonic)

### Takeaway
Browsers expose no specific output-level cap beyond the OS volume. Output level varies by up to 30 dB between phones at the same setting, and most distort above about 75% volume. Near-ultrasonic (above 18 kHz) is inaudible to most adults but audible to some young people. Animal effects are poorly studied. At 0.1–1 m, moderate volume suffices, so there is no reason to run loud.

### Cited Findings
- **Output level variation:** "up to 30 dB SPL spread between phones at the same volume setting". Most devices show nonlinear distortion above about 75% volume. — [Putz et al. 2026](https://arxiv.org/html/2602.02249)
- **Upper limit of hearing:** Commonly 18–20 kHz, varying with individual and age (patent background text, weak source). — [US patent 9709655](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/9709655)
- **The "Mosquito" teen deterrent** relies on young people hearing high frequencies. The manufacturer claims small children and dogs were not bothered (vendor claim). — [American City & County](https://www.americancityandcounty.com/?p=22031)
- **Dogs:** A 2010 study found two ultrasonic devices were noticed by dogs but had no adverse effect on behaviour. — [Int. J. of Orientation & Mobility 2010](https://reference-global.com/article/10.21307/ijom-2010-003)
- **Privacy backlash:** Ultrasonic tracking beacons were found in 234 Android apps listening in the background (Arp et al., 2017). This is relevant to user perception of "inaudible" mic-listening apps. — [Schneier on ultrasonic beacons](https://www.schneier.com/blog/archives/2017/05/using_ultrasoni.html)
- **Audible vs inaudible robustness:** The audible ggwave variant was "completely unusable" under ambient noise in one test, while inaudible ggwave reached 20 m. — [Putz et al. 2026](https://arxiv.org/html/2602.02249)

### Inferences
- Default to near-ultrasonic (18–20 kHz) at moderate volume. Expose a volume control and an "audible mode" fallback. Warn in the UI that some people and pets may hear high tones.
- Avoid hard on/off tone keying. Use raised-cosine ramps on symbol boundaries, because abrupt switching of an 18–20 kHz carrier produces audible clicks (spectral splatter into the audible band), which is a common annoyance source.
- Keep Web Audio output below 0 dBFS. Above about 75% hardware volume, speaker nonlinearity creates audible intermodulation products from multi-tone near-ultrasonic signals.

### Gaps
- No source found for any browser-imposed output limit.
- No peer-reviewed study found on annoyance from 18–20 kHz phone emissions for children or pets.
- iOS "Reduce Loud Audio" behaviour for the built-in speaker was not researched.

## Hardware placement (speakers versus microphones) and self-interference

### Takeaway
On iPhones the main loudspeaker and the primary mic(s) share the bottom edge, millimetres to centimetres apart, with additional mics near the top/earpiece and rear camera. A phone's own transmission therefore reaches its own bottom mic far louder than the peer's signal at 10–100 cm. Same-band full duplex is very hard. Frequency-division duplex plus orientation (bottom edges facing each other) and digital filtering is the realistic route.

### Cited Findings
- **iPhone XS and later:** Four mics: one rear, one at the front top near the camera, and two at the bottom next to the speaker grilles. — [BGR](https://bgr.com/2105577/iphone-camera-dot-purpose-microphone/)
- **Bottom grilles:** "The holes on the left of the port are for one microphone, while the holes to the right are for both the other mic and one of the iPhone's speakers." — [SlashGear](https://www.slashgear.com/1646043/iphone-microphones-location/)
- **Older iPhone 4 layout:** A bottom mic beside the dock connector, a top mic for noise cancellation, and speakerphone output from the bottom speaker. — [TidBITS, 2012](https://tidbits.com/2012/03/21/where-to-speak-on-your-iphone-4/)
- **Apple measurement mode** uses "the primary microphone" on multi-mic devices. — [Apple: measurement mode](https://developer.apple.com/documentation/avfaudio/avaudiosession/mode-swift.struct/measurement)
- **Position and orientation matter:** Even in the same room, device position and orientation significantly affected reliability. Indoor multipath produces delay spreads of tens of ms. — [Putz et al. 2026](https://arxiv.org/html/2602.02249)

### Inferences
- **Spreading loss alone:** A self-path of about 1–2 cm versus a peer path of 10–100 cm gives the own signal roughly 14–40 dB more level at the mic, before speaker directivity. With AGC on, your own transmission will also pump the gain.
- **Implications:**
  - Use frequency-division duplex with a guard band and steep digital band-pass filters in the worklet.
  - Keep the TX level just high enough, and use link adaptation from measured SNR.
  - Consider subtracting a delayed, filtered copy of your own known TX signal in WASM.
  - Put the phones bottom-to-bottom (loudspeaker toward the peer's bottom mic) when on the loudspeaker path. Put them top-to-top when iOS forces earpiece output and the top mic is in use.
- Guard intervals of 10 ms or more are needed in reverberant rooms even at short range, because reflections arrive tens of ms later. Alternatively use symbol lengths much longer than the delay spread.
- **Which iOS mic Safari uses:** On iOS, which of the four mics Safari's capture uses (VPIO beamforming versus primary) is not controllable from the web.

### Gaps
- No Android-specific mic/speaker layout survey was found. Layouts vary by OEM, and many Android phones also use the earpiece as a second speaker.
- No measurements of self-interference level (own speaker to own mic) on phones were found.
