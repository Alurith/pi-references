# Changelog

## [0.4.0] - 2026-11-10

- Apply `/references add` in the current session without reloading other extensions. Respect project trust and preserve unchanged Git checkout paths.
- Add read-only `/references status [alias]` with alias completion, checkout commit verification, and Git operation state.
- Cancel and await Git work from commands, input, and autocomplete during session shutdown.
- Cancel interactive reference dialogs when the session ends so shutdown does not wait for user input.
- Pin Pi development dependencies to 1.5.2.

## [0.3.0] - 2026-11-06

### Changed

- Require Pi 1.5.0 or later, below 2.0.0; pin development dependencies to 1.5.0.
- Use structured system-prompt sections without the legacy full-prompt fallback.
- Limit combined Git command output to 4 MiB and report truncated output separately from cancellation and timeouts.
- Keep up to four Git synchronizations running without waiting for a whole batch to finish; preserve result order.
- Cancel autocomplete Git operations when either the completion request or the session ends.

### Fixed

- Update Git test executors for Pi's required `ExecResult.truncated` field.
