# Architecture

LaunchyMind follows the same shape as ProjectMind: a deterministic core, local files, and an agent surface that cannot overrule the core. The implementation is TypeScript on Node.js 22.18+, ESM, Zod for the rule contract, and the official MCP SDK.

## Pipeline

`runScan` in `packages/pipeline` is the only path the CLI and the MCP server use.

1. **Scan** (`packages/scan`) reads a Flutter, React Native, or Expo project and returns a typed profile, a fact map, evidence records, observations, and scan limits. A folder that is none of those throws before a verdict.
2. **Live** (`packages/live`) fetches privacy, support, account-deletion, and `app-ads.txt` URLs when a checker is enabled. Offline mode records `skipped` and does not call the checker.
3. **Rules** (`packages/rules`) load YAML, validate it, and evaluate each enabled rule against the facts.
4. **Verdict** (`packages/verdict`) maps findings to ready, risky, or reject. This module exports one decision function and accepts no override.
5. **Report** (`packages/report`) renders the terminal, LaunchPack JSON, and HTML.

Facts the scanner cannot know are the string `unknown`. Comparisons against `unknown` do not pass and do not fail, so the rule stays unchecked. Unchecked blocks ready. A blocker fail is the only path to "likely to be rejected".

## Rule packs

`packages/packs/core` is data:

- `pack.yaml` names the pack and its date
- `rules.yaml` holds enabled rules
- `withheld.yaml` holds rules that still need a human to read the source
- `cases.yaml` is the test suite for those rules
- `signatures.yaml` maps package names to capabilities

Conditions are `all`, `any`, and one comparison (`eq`, `neq`, `gte`, `lt`). There is no expression language and no code field. `schemas/rule.schema.json` documents a rule. Zod is what the loader enforces.

`appliesWhen` decides whether a rule runs. The `platforms` field is for readers.

A rule's `check.confidence` is `direct`, `heuristic`, or `attestation`. Attestations come from `.launchymind/project.yaml` and are labeled as the developer's statement.

## What the scanner will not pretend to know

The report always lists limits that do not, by themselves, block ready:

- required-reason API use is not fully parsed
- the Flutter engine's own privacy manifest is not opened
- Pods and merged Android manifests are not the source of truth
- phone/tablet target API 36 is assumed; Wear, TV, Automotive, and XR are not detected
- App Store Connect and Play Console are not queried
- Dart is not type-checked or executed

Those limits are visible so a ready verdict cannot be read as "we looked at everything".

## Agent surface

`packages/mcp` registers the read tools plus propose and apply, including the batch pair. `launchymind_get_verdict` returns the engine result and its input schema has no verdict field. `launchymind_apply_fix` and `launchymind_apply_fixes` write a deterministic edit only when the operator set `LAUNCHYMIND_ALLOW_APPLY=1`, `approved` is true, and each `fixId` matches propose. They refuse paths outside the project and a dirty git tree unless `allowDirty` is true. Diffs are unified hunks.

`packages/fixes` returns drafts for rules that need a human. Privacy drafts start with a lawyer warning. The tracking edit changes only the `NSPrivacyTracking` boolean.

`launchymind init` writes `.launchymind/project.yaml` from answers the user supplied. `packages/packs` installs data-only packs under `.launchymind/packs` and the scan appends their rules. A non-data file is refused and is not executed.

## Later seams

Native projects, IPA and AAB files, and weekly source monitoring are named in `docs/ROADMAP.md` and are not implemented. `scan --pack` can still point at one pack directory instead of the core pack.
