# Roadmap

Phases follow the product plan. This preview finishes the foundation those early phases need. It does not claim the later "done" checks that require real apps or a live agent trial outside this repository.

| Phase | Plan | This repository |
| --- | --- | --- |
| 0. Foundation | Repo, schemas, empty CLI, tests, CI, architecture doc | Done for the preview: package, license, CI, schemas, docs |
| 1. Flutter scanner | Profile from pubspec, iOS, and Android | Done for the files listed in the README. Not yet run on Yippo, Stackies, or Skyborough |
| 2. Rule engine and core pack | Verified rules, evidence, unchecked | Done. Each enabled rule has a source, a date, and a case. Withheld rules do not affect the verdict |
| 3. MCP and preflight skill | Read-only tools and one skill | Done in code, including a test that the server lists tools and cannot set a verdict. Not yet tried as a live Cursor or Claude Code session |
| 4. Live checks and HTML | URLs, app-ads.txt, one HTML file | Done, with offline mode and fixture tests. Timeout behavior is covered by the checker; a flaky public site is reported as unchecked, not as a pass |
| 5. Approved fixes and legal pack | propose/apply that writes, KVKK/GDPR depth | KVKK article 10 and the separate-consent communiqué are enabled as risk heuristics. Principle decision 2026/347 and the GDPR baseline are withheld. Drafts exist. Nothing is written |
| 6. Action, ProjectMind, full skills | GitHub Action and the other skills | Not started. The preflight skill mentions re-scan and explain. The other skills are not packaged |
| 7. v0.1 release | Publish, weekly source watch | Not started. The package is private. There is no source-hash job |
| 8. Community packs | Install and reject a bad pack | `pack validate` and `scan --pack` accept the format. There is no `pack add` and no template repo |
| 9. More frameworks | React Native, Expo, native, compiled artifacts | Not started. A non-Flutter folder does not receive a fake ready verdict |

Do not start a later phase by widening the verdict. A new framework needs its own scanner and the same evidence rules.
