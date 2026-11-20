# Changelog

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
