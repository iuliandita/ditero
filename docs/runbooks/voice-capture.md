# Voice capture in quick add

Quick add can take dictation in the browser, on-device where the browser supports it. The recognized text is shown for review
and reaches the task field only after **Use this text**. It is never submitted
automatically, and the normal quick-add parser then handles dates, `#labels` and `~lists`.

## Privacy

Ditero never receives the audio. What happens to it depends on the browser, and the
control tells you which case applies:

- **On-device.** Browsers that expose both `SpeechRecognition.available()` and
  `processLocally` (for example current Chrome) are asked to recognize locally. Ditero
  sets `processLocally`, checks that it stuck, and requires the language pack to be
  installed on the device. Audio stays on the device. If the pack is missing, voice
  input stays off; Ditero does not fall back to a cloud service.
- **Browser vendor's service.** Browsers that only offer the standard Web Speech API
  without those two features may send the audio to the browser vendor's speech
  service. Ditero cannot see or control that. Before the mic button works, quick add
  shows a notice saying so and the button stays disabled, with the reason, until you
  choose **Accept and turn on**. The notice stays visible while dictation is
  available, and review labels the text as heard by the browser's speech service.
  Acceptance is remembered per user on this device (browser storage, not synced); if
  storage is blocked it lasts for the page session. Clearing site data asks again.
- **Not available.** No Web Speech API, or an insecure context (see below).

Detection uses these APIs, not browser names, so a browser that gains on-device support
moves to the first case without a change here. The browser still controls microphone
permission. An engine that does not report itself as on-device is treated as the vendor
service case.

## When the control is unavailable

The control stays visible with a localized reason instead of failing silently:

- No Web Speech API (for example Firefox).
- Insecure context. Use HTTPS or localhost; plain HTTP origins have no microphone access.
- The interface language has no mapped speech language, or its on-device pack is not
  installed. A pack that is downloadable or downloading shows a quiet wait state;
  **Check again** re-probes.
- Microphone permission denied, no microphone, no speech heard, an engine error, or
  the browser's speech service being unreachable, or a result longer than 500 characters. Your typed text is left unchanged.
- The Android and desktop apps. Their webviews do not provide a qualified local
  recognizer and there is no native speech plugin, so quick add shows an explanation
  instead of the control; type instead.

## Languages

The active app language selects the recognition language: English `en-US`, German
`de-DE`, Spanish `es-ES`, French `fr-FR`, Romanian `ro-RO` and Arabic `ar-SA`.
Unknown languages are not mapped to English. Right-to-left layout is supported.

## Behavior

Listening stops, and any pending result is discarded, when you cancel, press Escape,
close quick add, or change account, workspace, target list or language. Dictation is
capped at 20 seconds. Up to three alternatives are offered as radio choices. Keyboard
focus follows each phase, listening and errors are announced, and touch controls are at
least 44 px.

## Qualification

Browser behavior is exercised against a mocked recognizer and, for the availability
probe, a real Chromium build. Real microphone input across engines, devices and
installed language packs has not been qualified.
