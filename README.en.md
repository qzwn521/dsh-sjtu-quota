# DSH SJTU Quota

Request pacing, local token accounting and transient rate-limit recovery for SJTU API routes in DeepSeek Harness.

**Version 0.1.1-beta.1 is a beta under validation. It has not been listed in the plugin market.**

## Install

```sh
dsh plugin --profile web add github:qzwn521/dsh-sjtu-quota
```

Use your Desktop profile instead of `web` when appropriate. Before release, install the local package or project directory through `dsh plugin add`. Run `/sjtu-quota` and confirm the protected routes.

The exact `models.sjtu.edu.cn` host is detected automatically. Explicit `providers` override detection. Selected routes share a default budget of 300,000 tokens/minute, 10 requests/minute and a conservative local seven-day billion-token budget.

The scheduler reserves estimated input plus the output allowance. Final provider usage replaces the reservation. Transient rate limits pause the native agent request-error recovery path and resume the model step. Waiting is cancellable.

Modern hosts expose native Config forms; legacy hosts use the `sjtu-quota` settings namespace. See the Chinese README for a profile patch. Default safety ratio is 0.9; maximum concurrency is one.

Counts before dispatch are estimates. The plugin cannot guarantee zero 429s or make a request larger than a minute budget fit. It never silently rewrites conversations, changes output caps or summarizes user content.

The local weekly budget is not a server account balance. Other programs, machines and pre-installation activity are excluded. Hourly aggregates can expire up to an hour later than exact seven-day expiry. One Host owns one ledger; no cross-machine coordination is provided.

No network calls of its own, no stored keys or conversation text. See [SECURITY.md](SECURITY.md).

## Validation

Native interfaces were tested on Harness 0.1.5-rc.2 and 0.2.0-rc.2 with real host modules and a mocked provider. All 23 Windows/Node 24 automated tests passed, including package reproducibility and exclusion of private data. Real CLI installation, config composition and removal passed in an isolated DSH_HOME. A fixed-input SJTU Qwen API smoke test returned content and usage (22 total tokens); no deliberate online rate-limit load was generated. Long-task production acceptance remains pending. Cross-platform CI is configured but has not run on GitHub.

```sh
npm test
node scripts/check-release.mjs --draft
node scripts/pack.mjs
```

MIT. Independent community project, unaffiliated with SJTU, DeepSeek or plugin market operators.
