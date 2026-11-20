# Store console connection

`launchymind connect` reads the App Store Connect API and the Google Play Developer API when you point it at keys that stay on your machine. It does not print those keys, and it does not commit them.

Set the variables in the environment of the command. A shell profile outside this repository is the right place.

```bash
export LAUNCHYMIND_ASC_KEY_ID="the key id"
export LAUNCHYMIND_ASC_ISSUER_ID="the issuer id"
export LAUNCHYMIND_ASC_KEY_PATH="/secure/AuthKey.p8"
export LAUNCHYMIND_ASC_BUNDLE_ID="dev.example.app"
export LAUNCHYMIND_PLAY_JSON="/secure/play-service-account.json"
export LAUNCHYMIND_PLAY_PACKAGE="dev.example.app"
launchymind connect
launchymind scan path/to/app
```

`--offline` does not call either API.

## What is read

App Store Connect, from the official API:

- Privacy policy URL on an app info localization. This can satisfy the declared privacy URL. It is not an in-app link.
- Support URL on a version localization.
- Whether an age rating declaration exists. The individual answers are not copied into the report.
- `minOsVersion` on the latest build.

The build record does not include the Xcode version or the SDK that compiled the app. `attestation.apple.xcode-sdk` stays a manual answer.

Google Play:

- An edit is opened, tracks are read, and the edit is deleted without commit. Nothing is published.
- A production release sets distribution to production. Beta sets open. Alpha sets closed. Only an internal release sets internal-only.

`POST applications.dataSafety` writes a CSV. There is no read method, so the Data safety form and the advertising-ID answer stay manual. The tracks resource also does not include the 12-tester, 14-day clock, so `google.closed-test` stays manual.

## CI

Do not put `.p8` files, service-account JSON, or tokens in the repository or in CI variables for this project. Tests mock `fetch`.
