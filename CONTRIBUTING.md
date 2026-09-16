# Contributing to apigo

Use a current Node.js 22 or 24 release and npm. Install with `npm ci`; use `npm run dev -- <command>` while working.

## Before opening a pull request

```bash
npm run check
npm run test:package
```

Add tests for observable behavior, especially request serialization, OpenAPI compatibility, persistence, and sensitive-data handling. Use local HTTP servers and temporary storage directories. Tests must not require a running production API, npm credentials, or network access to a customer service.

## Design conventions

- Keep domain behavior in services. Commander handlers adapt arguments and present results.
- Preserve ESM compatibility and the `dist/index.js` executable entry point.
- Keep machine output clean. Diagnostic and interactive output belongs on stderr.
- Validate user input before sending requests. Never retry writes automatically.
- Preserve environments and saved overrides during API refreshes.
- Do not add telemetry, execute imported scripts, or include credentials in errors/history.
- Prefer small, focused commits and clear descriptions of behavior and validation.

For experiments, set `APIGO_HOME` to a temporary dedicated directory. Never commit a real database, encryption key, environment file, bearer token, or API response containing customer data.

## Pull requests

Describe the concrete problem, the resulting behavior, and relevant validation. State compatibility changes and update the README when command behavior changes. Avoid unrelated refactors.

## Security issues

See [SECURITY.md](SECURITY.md). Do not put live credentials in an issue, screenshot, recording, or fixture.
