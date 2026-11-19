# Changelog

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
