# Booking timing in v2.1.2

All offsets derive from the same Hong Kong release timestamp.

| Action | Time |
|---|---|
| Automatic weekly session check | Release - 30 minutes |
| Automatic weekly controller starts | Release - 90 seconds |
| HKUFBS form opens | Release - 60 seconds |
| reCAPTCHA checkbox requested | Automatically, after typing |
| Create | Fixed internal submission target |

Manual sessions open a separate booking runner immediately after confirmation, then wait for the same target times. Automatic weekly sessions are opt-in; their runner opens without confirmation at each occurrence.

Fresh 60-150 ms randomized typing always completes before CAPTCHA is requested. It is never skipped to catch up; unexpected loading delays can still cause lateness.

A separate, unfocused Edge window is less intrusive, but may be throttled. No program can promise exact server receipt timing. Keep Edge and the machine awake.
