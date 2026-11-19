# Security and privacy - 1.2.0

This is an unofficial personal reservation companion. Use only with authorization
and according to institutional booking rules. It makes one confirmed Create
attempt per run, with no automatic submission retry or server refresh loop.

## Local data

UID and phone are optional local remembered preferences. Agreement consent is
stored separately when explicitly checked and can be revoked by unticking.
Weekly rows, reminder delivery markers and dated attempt history are stored in
`chrome.storage.local`. Logs/results can contain personal information returned
by HKU; export them only after reviewing/redacting them. Clear saved details &
log removes preferences, consent and logs; weekly records remain until deleted.
Removing/reinstalling or clearing extension data may erase all local settings.

No project-owned backend, analytics, cookie export or external CAPTCHA-solving
service is present. Passwords and 2FA are entered only into HKU's own pages.
Never commit auth.json, browser profiles, cookies, real UIDs/phones or private logs.

## Permissions

- `tabs`, `scripting`: open/probe the selected HKU pages, fill/verify forms and
  observe the booking response.
- `storage`: local preferences, consent, schedules, logs and attempt state.
- `notifications`: manual CAPTCHA warnings and weekly reminders.
- `debugger`: powerful required permission for browser-level keyboard events.
  This implementation validates the exact confirmed HKU reservation URL before
  input, sends Input.dispatchKeyEvent only, and detaches afterwards. No arbitrary
  debugging command endpoint is exposed to web pages.
- `alarms` (new in 1.2.0): reconstructible weekly reminders and periodic local
  schedule maintenance. It does not authorize or perform bookings.

Host permissions are limited to HKUFBS and declared reCAPTCHA frame paths.
Background planner commands reject senders outside the extension's own pages.
Reminder notifications contain the room and practice time, not UID or phone.

## Booking safeguards

Each attempt has a unique typing receipt. Visible prefilled values are insufficient.
Create waits for fully typed, committed values and CAPTCHA verification where
present. Target changes, lost typing focus and unexpected field changes produce
an explicit error rather than an unsafe submission. Uncertain submission results
are not retried. Weekly attempts are recorded before submission; duplicate starts
are blocked until the user explicitly resets an occurrence after checking HKU.

Saved agreement consent is permission to check the agreement during confirmed
attempts, not permission to book unattended. Every dated booking still requires
review and confirmation. Timetable rows and reminders alone never start one.

Browser freezes, session expiry, site changes and unavailable slots remain
possible. No timing or CAPTCHA-avoidance guarantee is made.

## Automatic weekly bookings

When the Automatic weekly booking switch is enabled, the user has explicitly authorized one live attempt for each eligible future occurrence. Details remain in Edge storage; the background scheduler does not transmit them except through the normal HKUFBS form. Disabling automatic mode stops future starts but does not cancel an active run. Login and CAPTCHA remain in HKU-owned pages and may need manual action. There are no automatic retries after a sent or uncertain Create attempt.
