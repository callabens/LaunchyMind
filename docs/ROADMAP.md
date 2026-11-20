# Roadmap

Phases follow the product plan. This preview finishes the foundation those early phases need. It does not claim the later "done" checks that require real apps or a live agent trial outside this repository.

| Phase | Plan | This repository |
| --- | --- | --- |
| 0. Foundation | Repo, schemas, empty CLI, tests, CI, architecture doc | Done for the preview: package, license, CI, schemas, docs |
| 1. Flutter scanner | Profile from pubspec, iOS, and Android | Done for the files listed in the README. Not yet run on Yippo, Stackies, or Skyborough |
| 2. Rule engine and core pack | Verified rules, evidence, unchecked | Done. Each enabled rule has a source, a date, and a case. Withheld rules do not affect the verdict |
| 3. MCP and preflight skill | Read-only tools and one skill | Done in code, including a test that the server lists tools and cannot set a verdict. Not yet tried as a live Cursor or Claude Code session |
| 4. Live checks and HTML | URLs, app-ads.txt, one HTML file | Done, with offline mode and fixture tests. Timeout behavior is covered by the checker; a flaky public site is reported as unchecked, not as a pass |
| 5. Approved fixes and legal pack | propose/apply that writes, KVKK/GDPR depth | Approved edits write after a diff and an explicit yes. KVKK article 10 and the separate-consent communiqué are enabled as risk heuristics. Principle decision 2026/347 and the GDPR baseline are withheld |
| 6. Action, ProjectMind, full skills | GitHub Action and the other skills | `action.yml` uploads the report and honors `fail-on`. The other skills are not packaged |
| 7. v0.2 package and docs | Publish metadata, docs site, explain, regressions | Package metadata is 0.2.0. The release workflow is manual and was not run. The docs site builds in CI. `explain --why-not-ready` and `fixtures/regressions` are in the tree. There is still no weekly source-hash job |
| 7b. v0.3 store text and images | Local listing files, official limits, icons and screenshots | `fastlane/metadata` and `.launchymind/store` are read. iPad-only catalogs use the 13-inch sizes. The Play icon 1024 KB cap is measured. A past copyright year is not a failure |
| 7c. v0.4 store console | Optional API read with the user's keys | `launchymind connect` reads the fields the official APIs expose. Data safety, the closed-test clock, and the Xcode SDK stay manual. See `docs/connect.md` |
| 7d. v0.5 artifacts | IPA, APK, and AAB | `scan --artifact` reads those packages and flags drift against the source scan |
| 7e. v0.6 SDK labels | Versioned SDK disclosures and draft nutrition labels | `packages/packs/sdk/sdks.yaml` records only pages that were opened. `launchymind labels` prints a draft. Unknown SDKs add no row |
| 7f. v0.7 legal packs | KVKK, GDPR, COPPA, kids, Families, DSA, accessibility | Packs load from regions, kids, or an explicit packs flag. Unverified rules stay disabled |
| 7g. v0.8 source watch | Hashes of cited pages | `launchymind sources check` reports a changed or broken source. A weekly workflow opens an issue. The rule text stays as it was |
| 7h. v0.9 history | Local trend, dashboard, editor | History is off until project.yaml says so. The dashboard is one HTML file. The editor extension is packed in CI and not published |
| 8. Community packs | Install and reject a bad pack | `pack add` installs data into `.launchymind/packs` and refuses executable files. See `docs/writing-a-pack.md` |
| 9. More frameworks | React Native, Expo, native, compiled artifacts | React Native and Expo are detected and the shared platform rules run. Native projects and built artifacts are not scanned |

Do not start a later phase by widening the verdict. A new framework needs its own scanner and the same evidence rules.
