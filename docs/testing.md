# Testing

Run `npm.cmd test` on Windows (`npm test` elsewhere) for the retained automated
suite. The runner isolates local configuration, credentials, and runtime data.
Run a focused suite with `npm.cmd test -- server/tests/<name>.test.js`.

Retained coverage includes chat and streaming speech, playback interruption,
provider requests and credential handling, settings storage and API protection,
memory and embeddings, image generation and installation, capture ownership,
critical browser/desktop interactions, and privacy checks.
Audio readiness after reconnect is retained in
`server/tests/conversationReadinessIntegration.test.js`.

## Removed suites

The cleanup deliberately removes secondary UI, motion-authoring, auxiliary
dashboard, and developer-tool coverage. These files are deleted in full; their
features remain available. The removed suites are not all duplicates.

| Category | Deleted file |
| --- | --- |
| Motion authoring | `server/tests/bodyMotion.test.js` |
| Motion authoring | `server/tests/idleMotion.test.js` |
| Rig detail | `server/tests/live2dCapabilities.test.js` |
| Motion authoring | `server/tests/speechMotion.test.js` |
| Expression/comic authoring | `server/tests/emotionBanks.test.js` |
| Optional local Cubism checks | `server/tests/witchMotion.test.js` |
| Visual speech metadata detail | `server/tests/nativeVisualEmotion.test.js` |
| Client state/default details | `server/tests/conversationClient.test.js` |
| Secondary settings forms | `server/tests/conversationGui.test.js` |
| Selector helper details | `server/tests/fishEmotionGui.test.js` |
| Motion tuning details | `server/tests/tuningConfig.test.js` |
| Speech styling details | `server/tests/speechStyle.test.js` |
| Sentence tone/register details | `server/tests/sentenceTones.test.js` |
| Selfie diagnostic CLI | `server/tests/selfieTestCli.test.js` |
| Experiment logs/comparison | `server/tests/selfieExperiments.test.js` |
| Voice diagnostic CLI | `server/tests/ttsTry.test.js` |
| Telemetry history details | `server/tests/etaMemoryPeaks.test.js` |
| Log formatting | `server/tests/logging.test.js` |
| Setup diagnostics | `server/tests/setupDoctor.test.js` |
| Setup helper diagnostics | `server/tests/setupTools.test.js` |
| Auxiliary dashboard | `server/tests/visionMonitor.test.js` |
| Auxiliary dashboard connections | `server/tests/visionMonitorConnection.test.js` |
| Removed tuning-panel entry | `server/tests/tuningPanelEntry.test.js` |

The standalone manual diagnostic `desktop-companion/test-shortcut.cjs` is also
deleted. It was not part of `npm test`.

## Manual checks

After changing motion or expression authoring, check speech, idle transitions,
tone changes, cancellation, and Witch reloads in the browser or Electron app.
After changing secondary forms, check draft/save/cancel behavior and translated
labels. Exercise diagnostic commands and the auxiliary dashboard directly when
changing those features. Core automated tests do not replace these manual checks.
