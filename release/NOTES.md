First public beta of DSH SJTU Quota.

- Pace selected SJTU API routes against shared token and request budgets.
- Record local usage and resume native model steps after transient 429 responses.
- Support cancellation, restart persistence, legacy settings and modern Config forms.

Validated locally on Windows/Node 24: 23 automated tests, native Harness 0.1.5-rc.2 and 0.2.0-rc.2 interfaces, isolated CLI install/load/removal, and one fixed-input live SJTU API smoke test (22 tokens). GitHub release assets are published only after all six OS/Node CI jobs pass.

This is a beta. Preflight counts are estimates; the plugin cannot guarantee zero 429s. The seven-day ledger is local accounting, not the school's account balance. Long-running production acceptance remains pending. No keys or conversations are stored by the plugin.

See README.md and SECURITY.md before use. Market listing is a separate submission and review.
