# v2.1.3 release note

This update changes display copy only, and leaves `shared.js` scheduling constants, the automatic weekly scheduler, the booking functions and the icon watermark unchanged. The prior testing record below is retained for reference to v2.1.2.

# Validation report — v2.1.2 Evaluation Edition

Base: v2.1.1 booking engine, unchanged in its click dispatcher. These are edition-specific checks; see `TEST_REPORT_v2.1.1_archived.md` for historical v2.1.1 test notes, not validation of this edition.

Validation performed: JavaScript syntax checks, `node --test tests/test_evaluation.cjs`, and the existing mock UI flow. These checks use no HKU network requests. Edge installation, HKU SSO, live CAPTCHA and booking response are not verifiable in this environment.

No expiry, phone-home, activation key, or license gate is present. The build marker is passive and embedded solely in icon pixels.
