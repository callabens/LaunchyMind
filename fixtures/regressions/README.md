# Regression corpus

These folders are the false positives found while scanning real apps. Each one must keep the status in `tests/round6.test.ts`.

| Folder | What went wrong before | Expected now |
| --- | --- | --- |
| `guarded-sample-ad` | `kReleaseMode ? real : sample` was treated as a shipped sample ad | `google.sample-ad-id` passes |
| `gated-stub` | Stub purchase copy behind `const false` failed | `apple.stub-purchase-ui` passes |
| `minimum-target` | A Flutter lockfile minimum became a target API rejection | `google.target-api` stays unchecked |
| `missing-support` | No support URL in the project failed, even though App Store Connect was not read | `apple.support-contact` stays unchecked |
