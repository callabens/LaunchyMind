# LaunchyMind by callabens

LaunchyMind is a local-first, open-source pre-release readiness checker for mobile apps. It reads a Flutter project, selects the store and legal rules that fit what the app actually does, and reports a verdict of **ready**, **risky**, or **likely to be rejected**.

Every finding cites evidence (a file and line, or a live URL) and the rule's source link and last-verified date. The verdict is computed by a deterministic rule engine. The model in an agent session does not decide it.

**Status: v0.1 development preview.** This is not a store-approval guarantee and it is not legal advice. Apple and Google make the final decision. Ask a lawyer before you rely on a privacy or KVKK finding.

## What works in this preview

- Flutter source scan: `pubspec.yaml`, `pubspec.lock`, Dart imports under `lib/`, `Info.plist`, entitlements, `PrivacyInfo.xcprivacy`, `AndroidManifest.xml`, and the app module `build.gradle` / `build.gradle.kts`.
- A typed app profile: dependencies, capabilities, permissions, URLs, SDK levels, and the places those facts came from.
- A data-only core rule pack (`packages/packs/core`) with JSON Schema and YAML. Enabled rules were checked against the cited public pages on **2026-11-19**. Anything not re-checked is withheld and cannot change the verdict.
- Live checks for privacy, support, and account-deletion URLs, plus `app-ads.txt` on a declared developer site. `--offline` skips the network.
- CLI output for the terminal, a LaunchPack JSON file, and a single HTML file with no remote scripts or styles.
- An MCP stdio server with read-only tools plus a fix draft tool. Applying a fix does not write files.
- One agent skill, `skills/launchymind-preflight`, that tells an agent when to run the checker and what it must not claim.

## What this preview does not do

- It does not publish to npm (`"private": true`).
- It does not scan React Native, Expo, native iOS, native Android, IPA, or AAB files. A non-Flutter folder is reported as risky because the Flutter check fails, not as a verdict for that other stack.
- It does not read App Store Connect or Play Console. Questions that live only there (Xcode 26, age-rating answers, the Data safety form, closed testing, account type) stay **unchecked** until you answer them in `.launchymind/project.yaml`. Unchecked rules block a ready verdict.
- It does not fully scan required-reason API use or privacy manifests inside the Flutter engine, Pods, or SDK binaries. Those gaps are listed on the report and are not treated as a pass.
- It does not write fixes. `launchymind fix propose` prints a draft. `launchymind fix apply` refuses.
- It does not ship a GitHub Action, a community pack installer, or weekly source monitoring. `launchymind pack validate` can check a pack directory that uses the same format. `scan` reads the core pack unless you pass `--pack`.
- It does not claim a privacy-page keyword match is a complete policy review.

## Install and run

Node.js 22.18 or newer.

```bash
npm install
npm run launchymind -- scan path/to/flutter-app
```

Exit codes: `0` when the scan is at or above the `--fail-on` line, `3` when the verdict is reject, `4` when the folder is not a Flutter project, `1` for other usage errors. `--fail-on` defaults to `reject`, so a risky report does not fail CI unless you pass `--fail-on risky` (exit `2`) or `--fail-on none` (always `0` after a successful scan).

`--output report.json` writes the LaunchPack file and prints the terminal report. It does not also dump the JSON to the terminal. `--json` without `--output` still prints JSON only.

```bash
npm run launchymind -- scan path/to/flutter-app --json
npm run launchymind -- scan path/to/flutter-app --html report.html
npm run launchymind -- scan path/to/flutter-app --offline
npm run launchymind -- scan path/to/flutter-app --lang tr
npm run launchymind -- rules
npm run launchymind -- pack validate
npm run launchymind -- mcp
```

Things the scanner cannot see belong in `.launchymind/project.yaml`:

```yaml
appName: Harbor Notes
developerName: Your Name
audience:
  kids: false
  health: false
  userGeneratedContent: false
kvkk:
  explicitConsent: false
  consentSeparate: true
urls:
  privacy: https://example.com/privacy
  support: https://example.com/support
  developerWebsite: https://example.com
attestations:
  apple.xcode-sdk: true
  apple.age-rating: true
  google.data-safety-form: true
google:
  account: organization # or personal-before-2023-11-13 or personal-after-2023-11-13
  distribution: production # internal-only skips the Data safety and closed-test rules
  closedTest: true
```

Attestations are labeled as your statements. They are not treated as proof from Apple or Google.

`kvkk.explicitConsent: false` means you say processing is not based on explicit consent. When it is `true`, set `kvkk.consentSeparate: true` only if the disclosure text and the consent text are separate documents. Leaving either key out keeps that KVKK rule unchecked, which blocks a ready verdict.

## How a verdict is chosen

1. Scan the project. Code is not executed and is not uploaded.
2. Turn the scan into facts. A missing fact is `unknown`, never a silent pass.
3. Load the rule pack. Rules are data. They do not contain code.
4. Optionally fetch the public URLs the project named.
5. Each applicable rule returns pass, fail, or unchecked.
6. `decideVerdict` is the only function that names the verdict:
   - any blocker **fail** → likely to be rejected
   - any risk **fail**, or any **unchecked** rule → risky
   - every applicable rule passed → ready

A stale verification date is shown on the finding. It does not by itself change the verdict. Withheld rules (KVKK principle decision 2026/347, and the GDPR baseline) are listed and ignored.

## MCP

The server speaks stdio and uses the same scan as the CLI.

| Tool | What it does |
| --- | --- |
| `launchymind_get_overview` | Capabilities, verdict, and open findings |
| `launchymind_scan` | Full report |
| `launchymind_explain_finding` | One rule, its source, and its evidence |
| `launchymind_get_verdict` | The engine verdict. It has no field that sets a verdict |
| `launchymind_propose_fix` | A draft. Writes nothing |
| `launchymind_apply_fix` | Off unless `LAUNCHYMIND_ALLOW_APPLY=1`, and even then this preview writes nothing |

```json
{
  "mcpServers": {
    "launchymind": {
      "command": "node",
      "args": ["--experimental-strip-types", "apps/cli/src/index.ts", "mcp"]
    }
  }
}
```

Run that from a checkout of this repository. The skill in `skills/launchymind-preflight/SKILL.md` tells an agent when to call it.

## Privacy

There is no telemetry. The only network calls are the link checker, and only for `http` and `https` URLs found in the project. Usernames and passwords in URLs are rejected. Use `--offline` to make no requests at all.

## Development

```bash
npm run validate
```

That runs lint, typecheck, tests, and the build. Tests cover the rule cases and three Flutter fixtures: `fixtures/flutter/reject-camera`, `fixtures/flutter/risky-accounts`, and `fixtures/flutter/ready-notes`. The ready fixture stays risky offline. It is ready when its privacy and support pages answer the live checks.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/ROADMAP.md](docs/ROADMAP.md), and [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
