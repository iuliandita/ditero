# Voice capture in quick add

Quick add can take dictation in the browser. The recognized text is shown for review
and reaches the task field only after **Use this text**. It is never submitted
automatically, and the normal quick-add parser then handles dates, `#labels` and `~lists`.

## Privacy

Ditero uses on-device speech recognition only. It requires the browser's local
recognition mode (`processLocally`) and a language pack installed on the device, and
it refuses to start otherwise. Audio is not sent to Ditero, and Ditero does not allow
the browser to fall back to a cloud service.

This is stricter than the default of some browsers. For example, Chrome's ordinary
Web Speech recognition sends audio to the vendor's speech service. Ditero does not use
that mode: where only cloud recognition exists, the control explains that voice input is
unavailable and you keep typing. The browser still controls microphone permission.

## When the control is unavailable

The control stays visible with a localized reason instead of failing silently:

- No Web Speech API (for example Firefox), or no on-device mode.
- Insecure context. Use HTTPS or localhost; plain HTTP origins have no microphone access.
- The interface language has no mapped speech language, or its on-device pack is not
  installed. A pack that is downloadable or downloading shows a quiet wait state;
  **Check again** re-probes.
- Microphone permission denied, no microphone, no speech heard, an engine error, or
  a result longer than 500 characters. Your typed text is left unchanged.
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
