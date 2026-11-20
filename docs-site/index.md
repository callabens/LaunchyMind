# LaunchyMind

LaunchyMind by callabens checks a mobile project before you send it to the App Store or Google Play. The verdict is **ready**, **risky**, or **likely to be rejected**. Only the rule engine chooses it.

This is not store approval and it is not legal advice.

## Install

Node.js 22.18 or newer. From a checkout:

```bash
npm install
npm run build
node dist/apps/cli/src/index.js scan path/to/app --offline
```

The package name is `@callabens/launchymind`. Publishing to npm is a manual GitHub Action that needs an `NPM_TOKEN` secret. This site does not publish the package.

## Quick start

```bash
launchymind scan path/to/app
launchymind explain path/to/app --why-not-ready
launchymind init path/to/app --set attestations.apple.xcode-sdk=true
```

`--offline` skips network checks. A missing fact stays **unchecked**. Unchecked blocks a ready verdict. A blank answer is never filled in for you.

Exit codes: `0` under the `--fail-on` line (the default is `reject`, so risky is `0`), `2` when `--fail-on risky` and the verdict is risky, `3` for reject, `4` when the folder is not a supported project, `1` for other errors.

## Language

`--lang <locale>` picks the language. Without it, the first set of `LC_ALL`, `LC_MESSAGES`, and `LANG` decides; if none is set, the VS Code display language; otherwise English. Supported: en, tr, de, fr, es, pt-BR, it, ja, ko, zh-Hans, ar (right-to-left in the HTML report and dashboard), ru. Rule sources are quoted in their original language, and store terms such as App Store Connect, Play Console, App Privacy, and Data safety stay as the stores write them. A rule explanation without a translation is shown in English with a note.

Supported projects are Flutter, React Native, Expo, native iOS, native Android, and Unity. See the capability matrix in the README. This release is `1.0.1`. The owner publishes it to npm; until then npm has `1.0.0`.
