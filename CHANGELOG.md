# Changelog

## 1.0.0

- RevenueCat support. The SDK is detected in Flutter, React Native, CocoaPods, Swift Package, Gradle, and Unity manifests. New rules check a restore control (Apple 3.1.1), Terms of Use and privacy links on a subscription paywall, Play subscription price, period, and auto-renew wording, and a RevenueCat `sk_` secret key in app source (redacted in reports). `launchymind connect revenuecat` reads products, entitlements, and offerings with `REVENUECAT_API_KEY` (GET only) and compares them with product IDs in code.
- GDPR (6 rules), accessibility including the European Accessibility Act (4 rules), and Apple Kids (2 rules) packs are enabled with hashed sources. The live privacy-page check also reports retention, complaint-right, and third-country transfer wording.
- A local Play Data safety declaration, `launchymind.datasafety.json`. `init --datasafety` writes a draft from verified SDK rows with `reviewed: false`. A reviewed file is compared with the Play data types the SDK rows name. `labels --play-csv` writes a review sheet.
- `scan --build` (opt-in) builds a debug APK and an iOS simulator app in a temporary copy when the toolchain exists and reads them like `--artifact`. A build that did not run stays unchecked.
- SDK knowledge base: Play rows for RevenueCat and Adjust from their Data safety pages. AppLovin stays unknown: its 13.7.0 privacy manifest lists no collected data types and no vendor page lists them. AppsFlyer has no Play row because its help page refused the request. StoreKit and Play Billing stay unknown with the pages that were opened.
- Source watch: KVKK pages are hashed (with the GlobalSign intermediate certificate the server does not send). A non-200 response or an empty page is reported as broken, not unchanged. Empty stored hashes are dropped. Requests send `Accept-Language: en-US`.
- `init` asks the payments, GDPR, accessibility, EAA, and Kids questions.

## 1.0.0-rc.1

This is a release candidate, not 1.0.0. The owner publishes 1.0.0.

- Native iOS, native Android, and Unity projects are scanned with the same rule engine. Files that do not show a fact leave that check unchecked.
- `registry/index.json` lists data-only packs by name, pinned commit, and integrity hash. `pack search` and `pack add <name>` use it. Packs are still not executed.
- LaunchPack schema version stays 1. Snapshot tests cover fixture verdicts. The docs describe the semver policy.

## 0.5.0

- Play Data safety rows for Google Mobile Ads now come from Google's Android disclosure for SDK 25.5.0. Unity Ads, LevelPlay, Firebase Analytics, Crashlytics, Cloud Messaging, Adjust, and AppsFlyer have draft rows only for data those opened pages state. AppLovin, StoreKit, and Play Billing stay unknown, with the page that was opened and the reason.
- `launchymind sources check` fetches every rule source, compares a normalized hash, and prints a short excerpt when a page changed. It does not edit rule text. `--record` stores a hash only when the URL has none. A weekly workflow opens a GitHub issue for a human review. A saved status file flags those rules as needs re-verify.
- `history: true` in project.yaml saves each scan summary. `launchymind history` prints the trend. `launchymind dashboard` writes one local HTML file with no network requests. An editor extension under `extensions/vscode` shows findings in Problems and uses the same yes-before-write fix flow. CI packs it and does not publish it.

## 0.4.0

- A data-only SDK knowledge base drafts App Privacy and Play Data safety rows for vendor pages that were opened. Unknown SDKs add no row. `launchymind labels` and `launchymind_labels` print the draft in English or Turkish. A disagreement with the privacy manifest or with `google.data-safety-ad-id: false` is a risk finding.
- Separate legal packs for KVKK, GDPR, COPPA, Apple Kids Category, Google Play Families, EU DSA trader status, and accessibility. A pack loads when `project.yaml` regions, kids, or an explicit packs flag say so. Rules whose source text was not re-opened stay disabled. The wording says this is not legal advice.

## 0.3.0

- iPad-only apps are detected from `TARGETED_DEVICE_FAMILY`, `UIDeviceFamily`, or Expo `supportsTablet`. Their screenshots are checked against the 13-inch iPad sizes. If the device family cannot be read, an iPad-sized set stays unchecked.
- The Play icon's 1024 KB file-size cap is measured.
- A past copyright year stays unflagged. Apple's field is the year the rights were obtained, and the help page's example is 2014.
- `launchymind connect` can read App Store Connect and Google Play with keys supplied by environment variables. Tests mock the network. Data safety, the closed-test clock, and the Xcode SDK stay manual because those APIs do not expose them.
- `launchymind scan --artifact` reads an IPA, APK, or AAB and compares targetSdk, AD_ID, the privacy-manifest tracking flag, and the camera usage string with the source scan.

## 0.2.0

- The package metadata is ready to publish: exports, bin, engines, files, and `publishConfig.access`. `npm publish` is a manual workflow that needs `NPM_TOKEN` and was not run.
- A VitePress site in `docs-site` covers install, CLI, MCP, the skill, the GitHub Action, rules, packs, and the approval flow, with a Turkish page. CI builds it. GitHub Pages deploy is manual.
- `launchymind explain <path> --why-not-ready` lists the failures, unchecked rules, and limits that block READY.
- `fixtures/regressions` keeps the sample-ad guard, the gated stub purchase, the Flutter minimum target SDK, and a missing App Store Connect support URL from becoming false failures again.
- Store listing text and images are read from `fastlane/metadata` and `.launchymind/store`. Length, placeholder, platform-name, price, keyword, locale, URL, icon, and screenshot checks use the cited Apple and Play pages. A screenshot size that is not on Apple's list stays unchecked.

## 0.1.0-dev.5

- Fix diffs are unified hunks. The privacy-manifest edit changes only the `NSPrivacyTracking` line and leaves the rest of the file byte for byte.
- `launchymind fix <path> --all` lists every writable fix and asks once per fix. `--yes` approves all of them. MCP `launchymind_propose_fixes` and `launchymind_apply_fixes` use the same approval rule.
- `launchymind init` writes `.launchymind/project.yaml` from store-console answers you supply. A blank answer stays unchecked.
- `path_provider` is covered only when `path_provider_foundation` is at least 2.3.2 and older than 2.6.0. Version 2.6.0 deleted `PrivacyInfo.xcprivacy`. Otherwise the listed-SDK finding stays unchecked and says why.
- `launchymind pack add`, `pack list`, and `pack remove` install data-only packs. A file that is not yaml, json, markdown, or license text is refused.
- React Native and Expo projects are scanned. Platform rules use Info.plist, the Android manifest, and the privacy manifest. Checks the source does not answer stay unchecked.

## 0.1.0-dev.4

- `launchymind fix <path> --rule <id> --yes` writes a deterministic edit, prints a diff, and scans again. `--dry-run` writes nothing. A dirty git tree and paths outside the project are refused.
- MCP `launchymind_apply_fix` writes only with `LAUNCHYMIND_ALLOW_APPLY=1`, `approved: true`, and the exact `fixId` from propose.
- Writable edits: privacy-manifest tracking flag and missing collected-data entries, Info.plist usage-description placeholders, and the Android AD_ID permission.
- GitHub Action `action.yml` uploads the HTML and JSON reports, writes a job summary, and fails according to `fail-on`.

## 0.1.0-dev.3

- A Google sample ad id behind `kReleaseMode ? real : sample`, `!kReleaseMode`, or `kDebugMode` (ternary or if/else) is not a failure.
- Stub purchase copy guarded by a const false flag is an observation. Reachable stub copy still fails.
- HTML findings use plain titles. An inferred support URL is listed once.
- Listed SDK manifests: a versioned table of plugins that ship PrivacyInfo.xcprivacy. path_provider was left out until the foundation package range was checked.
- Android ads check the AD_ID permission, including a google_mobile_ads merge, and a Data safety advertising-ID answer.
- Game Center and Play Games (`games_services`) are capabilities.

## 0.1.0-dev.2

- Consent-withdrawal text matches "Withdrawing Consent" and "Rızanızı Geri Alma", and live evidence shows the matched or missing section.
- A missing App Store Connect privacy or support field is unchecked, not a failure. A broken page that was actually found still fails.
- The privacy URL host is used for app-ads.txt and a support-page probe when those URLs were not declared.
- Ads or tracking apps get a risk check when the privacy manifest's tracking fields disagree, or when the app has no manifest.
- `flutter.targetSdkVersion` can be filled from a versioned Flutter SDK default table. A low number that comes only from a lockfile minimum stays unchecked.
- Transitive lockfile packages are no longer listed as observations. Reports lead with problems and a plain-language next step. `--output` does not also print JSON.
- New risk checks: stub purchase copy without a purchase SDK, Google's sample ad publisher id, and a missing UMP consent call when ads are present.
- A missing in-app privacy link stays blocking, with a narrower headline (`NOT READY`) when it is the only blocker. `--fail-on` defaults to `reject`.
- A privacy page that says the app is not for children is compared with `audience.kids`.
- A folder that is not a Flutter project exits `4`.
- The README example includes `kvkk.consentSeparate`.

## 0.1.0-dev.1

Development preview. Not published to npm.

- Flutter project scanner and typed app profile.
- Data-only core rule pack, verified against the cited public pages on 2026-11-19. Unverified rules are withheld.
- Deterministic verdict: ready, risky, or likely to be rejected.
- CLI terminal, LaunchPack JSON, and self-contained HTML report.
- Live link checks with an offline switch.
- MCP stdio server and the `launchymind-preflight` skill.
- Fix drafts that do not write files.
