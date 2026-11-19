# Validation report - v2.1.1

This is a **simulated-browser development build**, not a verified live booking solution.

## Tests performed

- JavaScript syntax checked on all extension scripts.
- Existing helper tests: 53 passed.
- New automatic-schedule helper checks: 7 passed.
- Background worker simulations: 3 passed (separate manual window; one-time claim/attempt; automatic login precheck, scheduled start, outcome notification, opt-out behavior).
- New UI Chromium smoke: passed (auto OFF by default, explicit opt-in/opt-out, weekly entry save, standalone manual Review/Confirm starts one separate run).
- New dedicated runner Chromium smoke: passed (browser-generated keyboard events, fresh field typing, single Create, captured response) using a local inert HKU fixture.
- Scheduled runner Chromium smoke: passed (typing receipt before CAPTCHA request, CAPTCHA request before Create, Create at/after its computed timestamp, single mock submission).

No network request was sent to live HKUFBS. OS notifications, live CAPTCHA challenges, real Edge SSO, and browser restart behavior were simulated or reviewed rather than verified on a user's computer.

## How to reproduce

```sh
node --test tests/*.cjs
python tests/test_v211_ui.py
python tests/test_v211_runner.py
HKU_RUNNER_TIMED=1 python tests/test_v211_runner.py
```

Requires Node.js, Python and Playwright+Chromium **only for developers running the tests**. Regular extension use does not require them.

## Risks still requiring local rehearsal

1. HKUFBS may change the form/response markup or disallow a pre-release reservation form.
2. Browser focus, debugger control, and background timer throttling differ between Edge versions and window states.
3. OS security/notification settings may suppress alerts.
4. Browser closed, computer asleep, missed alarm, or uncompleted SSO/CAPTCHA can prevent a booking.
5. A Create attempt or HTTP 200 is not definitive proof of an accepted booking.
