# Contributing to LaunchyMind

LaunchyMind is early. The useful way to help is a small, tested change with a source you actually opened.

## Rules are data

Add or change a rule in `packages/packs/core/rules.yaml`, or add a case in `cases.yaml`. Do not put policy text in TypeScript.

An enabled rule needs all of these:

- a stable id
- severity: `blocker`, `risk`, or `info`
- platforms
- `source.url` (https), `source.section`, and `source.publisher`
- `verification.status: verified` and `verification.verifiedAt` as the day you read the source
- English and Turkish summaries that restate the source and do not add duties you did not read
- `appliesWhen` and a pass and/or fail condition that only compare facts
- a `check.note` that says what the scanner really did
- at least one case in `cases.yaml`

If you have not opened the source, put the rule in `withheld.yaml` with `enabled: false` and `verification.status: needs-manual-verification`. A withheld rule must not affect the verdict.

Do not copy long passages from Apple, Google, KVKK, or the GDPR text. Link to them and keep the summary short.

Legal rules stay at `risk` unless the source you read is a hard store rejection. The report must not say an app is legally compliant.

## Scanner facts

If a rule needs a new fact, set it in `packages/scan/src/index.ts`, add the name to `KNOWN_FACTS`, and leave it `unknown` when the file cannot be read. Unknown is not a pass.

Package-to-capability mappings live in `packages/packs/core/signatures.yaml`. Needles are plain strings, not regular expressions, so a pack cannot smuggle executable patterns.

## Checks

```bash
npm run validate
```

Node.js 22.18 or newer. Add a fixture or a rule case for any verdict change.

## Scope

The verdict function is `decideVerdict` in `packages/verdict`. Do not add a tool, flag, or MCP argument that sets it.

`launchymind fix` must refuse to write without `--yes` or an interactive yes, must refuse a path outside the project, and must refuse a dirty git tree unless `--allow-dirty` is set. A test has to prove an unapproved call changes nothing. Do not add a writer for legal text or seller ids.
