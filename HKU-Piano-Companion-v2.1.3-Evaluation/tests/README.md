# Developer checks

No test tools are needed to install/use the extension.

```sh
node --test tests/test_helpers.cjs tests/test_typing.cjs tests/test_v120.cjs
python tests/test_browser_v120.py
```

The browser script needs Python, Playwright and a Chromium executable (or a
Playwright-installed browser). Set CHROMIUM_PATH if needed. It blocks real network
traffic and uses inert HKU-like forms with mocked browser-extension APIs.
Input.dispatchKeyEvent is forwarded to real Chromium CDP; it is not .value assignment.
The focused browser test checks saved consent, timetable interactions, timing,
native typing order, manual CAPTCHA warnings, and result/duplicate handling.

Reminder tests execute the background worker against mocked alarm/storage/
notification APIs. They verify scheduling, restart reconstruction, deduplication,
notification click routing and removal, not actual Windows/macOS delivery.

The former hard-deadline timing test is deliberately not part of v1.2.0.
Current recorded results are in docs/validation.

## Focused v1.2.1 timing rehearsal

Set `HKU_FOCUSED_ORDER_TEST=1` and run `python3 tests/test_browser_v120.py` to test the critical field-typing receipt, CAPTCHA and Create ordering without running the full historical browser suite. The fixture uses mocked HKU pages and never sends a real reservation.

## Targeted v1.2.2 offset-alignment checks

```sh
node --test tests/test_v122.cjs
```

These cover fixed 60-second form opening, unchanged CAPTCHA time, 1-ms Create offsets, and accepting old saved data containing an unused `early` key.

### v2.1.1 focused checks

`node --test tests/test_v211.cjs tests/test_v211_background.cjs` checks calculation, alarms, run ownership, duplicate suppression and result notifications. `python tests/test_v211_ui.py` checks the new opt-in UI and separate-window manual dispatch. `python tests/test_v211_runner.py` and `HKU_RUNNER_TIMED=1 python tests/test_v211_runner.py` exercise native typing and single Create against simulated pages. None contact HKU.
