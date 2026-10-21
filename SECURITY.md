# Data and security

The plugin makes no network requests of its own. Model requests still use DSH's provider and authentication. The plugin observes usage and schedules selected requests.

It reads provider endpoint metadata and host package version metadata. Modern provider configuration is read through redacted settings descriptors. It does not read, store or log API key values, cookies or conversation text.

Plugin-owned files are the quota ledger, temporary replacement file and process lock. The ledger contains recent token counts, hourly aggregates, route/model IDs, calibration and aggregate counters. Uninstalling leaves it in place. The default directory is `DSH_HOME/storages/sjtu-quota/`; custom `stateFile` explicitly overrides the location.

One DSH Host owns one ledger. Separate computers and applications are not coordinated. No install scripts, telemetry, uploads or automatic updates are included.

Report ordinary bugs in repository Issues. Never attach API keys, authentication headers, browser storage, unredacted HAR files or full private conversations. Sensitive reports should use GitHub private vulnerability reporting after it has been enabled for the public repository.
