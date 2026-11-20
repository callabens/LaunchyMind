# Public API and schema

LaunchyMind 1.0.0 is the first stable version of the CLI, the LaunchPack schema (version 1), and the data-pack format. The owner publishes it to npm. Until then npm has 1.0.0-rc.1.

The package entry point is `@callabens/launchymind`. It exports the types and helpers in `packages/core`: the LaunchPack report shape, fact names, and the rule schema. The verdict function stays in `packages/verdict` and is the only place a verdict string is chosen.

`LaunchReport.version` is the LaunchPack schema version. It is `1`. Readers should ignore object fields they do not know. Removing or renaming a required field bumps the schema version. Adding a field does not. The JSON Schema is `schemas/launchpack.schema.json`. The tool version in `package.json` follows semver. Before 1.0.0, a release candidate may change the CLI or the schema. After 1.0.0, a breaking CLI flag or a required JSON field change bumps the major version.

A scan report is one JSON object. `verdict` is `ready`, `risky`, or `reject`. `findings` come from the rule engine. `sourceWatch.needsReverify` is empty unless a source check recorded a changed page. It does not change the verdict by itself.
