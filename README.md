# LaunchyMind by callabens

LaunchyMind is a local-first, open-source pre-release readiness checker for mobile apps. It reads a project, selects the store and legal rules that fit what the files show, and reports a verdict of **ready**, **risky**, or **likely to be rejected**.

Every finding cites evidence (a file and line, or a live URL) and the rule's source link and last-verified date. The verdict is computed by a deterministic rule engine. The model in an agent session does not decide it.

**Status: 1.0.0.** npm has `@callabens/launchymind@1.0.0-rc.1`; the owner publishes 1.0.0 by hand. It is not a store-approval guarantee and it is not legal advice. Apple and Google make the final decision. Ask a lawyer before you rely on a privacy, KVKK, GDPR, or accessibility finding.

## Capability matrix

| Area | Level |
|---|---|
| Verdict from the rule engine | Supported |
| Flutter source scan | Supported |
| React Native and Expo | Partial. Config plugins are not executed. Unseen facts stay unchecked. |
| Native iOS | Partial. Xcode project, Info.plist, entitlements, privacy manifest, Swift Package pins, and Podfile.lock. `scan --build` builds a simulator app when Xcode is installed. |
| Native Android | Partial. Gradle, version catalogs, and source manifests including a release overlay. `scan --build` builds a debug APK when a JDK and the Gradle wrapper are present. |
| Unity | Partial. Project settings, package manifest, plugin manifests, and a generated export when it is present. C# is not compiled. |
| Store listing text and images on disk | Supported for the checks that cite a published size or length. |
| App Store Connect and Play Console | Partial. Read-only when you set keys. The Data safety form is not read; compare a local `launchymind.datasafety.json` instead. |
| RevenueCat | Supported for detection, paywall checks (restore, Terms and privacy links, renewal wording), a secret-key leak check, and an optional read-only `connect revenuecat`. |
| Native build (`--build`) | Partial. Opt-in. Without Flutter, a JDK, or Xcode the build check stays unchecked. Unity is not built. |
| IPA, APK, and AAB | Partial. Drift against the source scan. Some binary fields stay unread. |
| SDK privacy drafts | Partial. A row exists only when a vendor page was opened. Unknown SDKs add no row. AppLovin, StoreKit, and Play Billing stay unknown, and AppsFlyer has no Play row. |
| Legal packs | Partial. KVKK, GDPR, accessibility (with the European Accessibility Act), and Apple Kids are enabled with hashed sources. Rules check project answers and published pages, not a legal conclusion. |
| Source watch | Partial. Hashes are stored. A weekly workflow opens an issue. Rules are not edited. |
| History and local dashboard | Supported when `history: true`. |
| Editor extension | Partial. Packed in CI. Not published to a marketplace. |
| Community packs | Supported as data only, from a path, a git URL, or the registry index. |
| Live device check (`run`, `scan --live`) | Partial. Crash on launch is a rule. First-screen links and permission dialogs are read on Android; on the iOS simulator only launch, purpose strings, and a screenshot. Without a device every check is not checked. |
| Languages | Interface in en, tr, de, fr, es, pt-BR, it, ja, ko, zh-Hans, ar (RTL), ru with `--lang` or LANG / VS Code detection. Rule explanations are English and Turkish; other locales fall back to English with a note. |

## What works in this preview

- Flutter source scan: `pubspec.yaml`, `pubspec.lock`, Dart imports under `lib/`, `Info.plist`, entitlements, `PrivacyInfo.xcprivacy`, `AndroidManifest.xml`, and the app module `build.gradle` / `build.gradle.kts`.
- A first pass for React Native and Expo: `package.json`, `app.json`, JavaScript and TypeScript outside `node_modules`, and the same iOS and Android files. Checks the source does not answer stay unchecked.
- A typed app profile: dependencies, capabilities, permissions, URLs, SDK levels, and the places those facts came from.
- A data-only core rule pack (`packages/packs/core`) with JSON Schema and YAML. Enabled rules were checked against the cited public pages on **2026-11-19**. Anything not re-checked is withheld and cannot change the verdict.
- Live checks for privacy, support, and account-deletion URLs, plus `app-ads.txt` on a declared developer site. `--offline` skips the network.
- CLI output for the terminal, a LaunchPack JSON file, and a single HTML file with no remote scripts or styles.
- An MCP stdio server. `launchymind_apply_fix` and `launchymind_apply_fixes` write only after approval.
- One agent skill, `skills/launchymind-preflight`, that tells an agent when to run the checker and what it must not claim.
- RevenueCat: the SDK is found in pub, npm, CocoaPods, Swift Package, Gradle, and Unity manifests. Paywall rules look for a restore control, Terms of Use and privacy links, and renewal wording. A `sk_` secret key in app source fails and is never printed. `launchymind connect revenuecat` reads products with `REVENUECAT_API_KEY` (GET only) and compares them with product IDs in code. See `docs-site/revenuecat.md`.
- A local Play Data safety declaration, `launchymind.datasafety.json`. `launchymind init <path> --datasafety` writes a draft from verified SDK rows with `reviewed: false`. Once reviewed, a scan compares it with the Play data types the SDK rows name. `launchymind labels <path> --play-csv draft.csv` writes a review sheet (not the Play Console import format).
- `scan --build` builds in a temporary copy and reads the result like `--artifact`.

## What this preview does not do

- It does not publish itself. `.github/workflows/release.yml` publishes only when the owner runs it by hand.
- A folder that is not Flutter, React Native, Expo, native iOS, native Android, or Unity exits `4`. The message starts with "Not a Flutter project".
- It does not read the Play Data safety form or answers App Store Connect does not expose. Questions that live only there stay **unchecked** until you answer them with `launchymind init` or `.launchymind/project.yaml`. Unchecked rules block a ready verdict.
- It does not fully scan required-reason API use or privacy manifests inside the Flutter engine, Pods, or SDK binaries. Those gaps are listed on the report and are not treated as a pass.
- It does not invent privacy-policy text, account-deletion screens, ad-seller lines, or store-console answers.
- Source watch opens an issue when a cited page changes. It does not rewrite the rule.
- It does not claim a privacy-page keyword match is a complete policy review.

## Install and run

Node.js 22.18 or newer.

```bash
npm install
npm run launchymind -- scan path/to/flutter-app
```

Exit codes: `0` when the scan is at or above the `--fail-on` line, `3` when the verdict is reject, `4` when the folder is not a supported project, `1` for other usage errors. `--fail-on` defaults to `reject`, so a risky report does not fail CI unless you pass `--fail-on risky` (exit `2`) or `--fail-on none` (always `0` after a successful scan).

`--output report.json` writes the LaunchPack file and prints the terminal report. It does not also dump the JSON to the terminal. `--json` without `--output` still prints JSON only.

```bash
npm run launchymind -- explain path/to/flutter-app --why-not-ready --offline
npm run launchymind -- connect
npm run launchymind -- labels path/to/flutter-app --lang tr --offline
npm run launchymind -- sources check
npm run launchymind -- history path/to/flutter-app
npm run launchymind -- dashboard path/to/flutter-app
npm run launchymind -- pack search notes
npm run launchymind -- scan path/to/flutter-app --artifact app.apk
npm run launchymind -- scan path/to/flutter-app --json
npm run launchymind -- scan path/to/flutter-app --html report.html
npm run launchymind -- scan path/to/flutter-app --offline
npm run launchymind -- scan path/to/flutter-app --lang tr
npm run launchymind -- rules
npm run launchymind -- pack validate
npm run launchymind -- init path/to/app --set attestations.apple.xcode-sdk=true
npm run launchymind -- pack add ./my-pack --project path/to/app
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
  google.data-safety-ad-id: true
google:
  account: organization # or personal-before-2023-11-13 or personal-after-2023-11-13
  distribution: production # internal-only skips the Data safety and closed-test rules
  closedTest: true
```

Attestations are labeled as your statements. They are not treated as proof from Apple or Google.

`kvkk.explicitConsent: false` means you say processing is not based on explicit consent. When it is `true`, set `kvkk.consentSeparate: true` only if the disclosure text and the consent text are separate documents. Leaving either key out keeps that KVKK rule unchecked, which blocks a ready verdict.

`attestations.google.data-safety-ad-id: true` means the Play Data safety form declares the Android advertising ID. Leave it out and an ads app stays unchecked on that rule. `games_services` is reported as Game Center and Play Games capabilities; it is not a failure by itself.

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
| `launchymind_propose_fix` | A diff and a `fixId`. Writes nothing |
| `launchymind_propose_fixes` | Every writable fix, each with a diff and a `fixId`. Writes nothing |
| `launchymind_apply_fix` | Writes only when `LAUNCHYMIND_ALLOW_APPLY=1`, `approved` is true, and `fixId` is exactly the id from propose. Refuses a dirty git tree unless `allowDirty` is true |
| `launchymind_apply_fixes` | Same approval rule for each item in `fixes`. One fix id does not approve the others |

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

## Approved fixes

`launchymind fix <path> --rule <id>` prints a unified diff with a few lines of context. It writes only with `--yes`, or after you answer `y` in a terminal. `--all` lists every writable fix and asks once per fix, or writes them all with `--yes`. `--dry-run` prints the diffs and does not write. A git checkout with uncommitted changes is refused unless you pass `--allow-dirty`. Paths outside the project are refused. The bytes outside a changed line are left as they were. After a write, LaunchyMind scans again and prints the verdict before and after.

The edits it will write are mechanical:

- set `NSPrivacyTracking` from false to true when collected data is already marked for tracking. It does not invent collected-data types or tracking domains
- add a placeholder Info.plist usage description when the key is missing
- add the Android `AD_ID` permission, or drop `tools:node="remove"` from it

Privacy-policy text, account-deletion screens, and `app-ads.txt` seller lines are propose-only.

The MCP tools use the same edits. Start the server with `LAUNCHYMIND_ALLOW_APPLY=1`. `launchymind_apply_fix` requires `approved: true` and the `fixId` from `launchymind_propose_fix`. `launchymind_apply_fixes` requires that pair on each item.

`launchymind init <path>` asks the store-console questions the scanner cannot see, with the official page for each one. Press enter to skip a question. In CI, pass only the answers you have, for example `--set attestations.google.data-safety-ad-id=true`. A key you do not set stays unchecked.

## GitHub Action

`action.yml` scans a Flutter project, uploads the HTML and JSON reports, writes the verdict to the job summary, and fails according to `fail-on`. An example is in [docs/github-action.md](docs/github-action.md).

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/ROADMAP.md](docs/ROADMAP.md), and [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
