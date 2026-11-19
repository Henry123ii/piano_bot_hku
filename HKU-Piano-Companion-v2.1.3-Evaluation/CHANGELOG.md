# v2.1.3 - Evaluation presentation update

- Removed internal submission, CAPTCHA and manual-verification timing values from the visible interface, review dialogue, instructions and progress messages.
- Kept the underlying fixed constants in `shared.js`, unchanged, including manual and automatic weekly booking paths.
- No expiry, activation or reporting added. The existing passive icon watermark remains intact.

# Changelog

## 2.1.2 — Evaluation edition (no expiration)

- Retains the original 2.1.1 booking controller, dedicated Edge windows and optional automatic weekly mode. No v2.2 precision-timer subsystem.
- Removes editable Create offset and CAPTCHA lead controls. Manual and automatic weekly booking both use fixed targets: a consistent internal schedule; form preparation remains automatic.
- Older stored timing preferences are ignored, so an existing profile cannot unexpectedly override the fixed targets.
- The manual CAPTCHA verification window is also fixed internally, avoiding further timing controls.
- Includes a passive, non-networked visual-asset watermark for distribution provenance. No trial expiration, license server or activation.
- This edition remains experimental and does not guarantee exact click timing or a successful reservation.

# Changelog

## 2.1.2 - Independent booking windows and optional automatic weekly bookings

- **New dedicated runner window:** manual Review/Confirm immediately opens a separate Edge window that owns login verification, fresh typing, CAPTCHA, the timed Create attempt and the result. Closing the original companion does not cancel the runner.
- **New opt-in Automatic weekly booking toggle:** OFF by default. Requires Remember, saved UID/phone, agreement consent, notifications, a weekly row, and an explicit warning/authorization.
- **30-minute login precheck:** verifies an HKUFBS dashboard via the existing Edge session. Alerts and opens/focuses SSO if login is needed.
- **Background scheduled automatic run:** launches a separate runner 90 seconds before the release, then opens the HKUFBS form 60 seconds before release.
- **Final result notification:** notified for success, rejection, pending approval, unknown result and interrupted automatic attempts. Always confirm the actual result in HKU.
- **Crash/duplicate protection:** global run lock, an attempt marker before Create, persisted per-date weekly history, no automatic retry on unclear responses, single Create request.
- **Manual and weekly modes preserved:** same date/release calculation, one-hour restriction, fresh native randomized typing, manual CAPTCHA and calculated Create offset. The standalone companion remains usable for one-off reservations.
- **Safety:** Clear saved details also disables automatic weekly booking. A missed automatic launch is marked for attention rather than submitted hours later.

### Limits

Real HKU SSO, the live booking form, OS notifications, and actual Edge installation still require local testing. Browser sleep and throttling can interrupt scheduled tasks; a separate background window cannot guarantee millisecond precision.

## 1.2.x

Previous releases introduced the weekly planner, six-day release calculation, one-hour restrictions, typing-before-CAPTCHA, 60-second form opening, saved agreement, and manual booking review controls.
