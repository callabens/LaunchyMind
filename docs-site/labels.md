# Labels and legal packs

`launchymind labels <path>` prints a draft of App Privacy and Play Data safety rows. A row exists only when `packages/packs/sdk/sdks.yaml` has a vendor page that was opened, with a date. An SDK marked unknown adds no data type. The command says the result is a draft, not a store form and not legal advice. Turkish text is `--lang tr`.

If a verified row says the SDK may use data for third-party advertising and the app privacy manifest sets `NSPrivacyTracking` to false, the rule engine reports a risk. If the project says the advertising ID was not declared and a verified row lists a device identifier, that is also a risk. A blank project answer stays unchecked.

Legal packs live in `packages/packs/legal`. They load when `project.yaml` names a region, sets `audience.kids`, or sets `packs.<name>: true`. Set `packs.kvkk: false` to keep the KVKK pack off even in region `TR`. Set `packs.accessibility: true` to load the accessibility pack. GDPR loads for an EU or EEA region and Apple Kids loads with `audience.kids`. Nothing in those packs is legal advice.

| Pack | Rules | Source |
|---|---|---|
| GDPR | Article 13 notice contents, Article 6 lawful basis, Article 7(3) withdrawal of consent, Article 17 erasure path, Article 28 processors, Article 13(1)(f) and Chapter V transfers | Regulation (EU) 2016/679 on EUR-Lex |
| Accessibility | Screen-reader labels in source (info), Apple Accessibility Nutrition Labels (info, voluntary), European Accessibility Act scope (Article 2(2), microenterprise exemption Article 4(5)), EAA service information (Article 13 and Annex V) | Android accessibility guide, App Store Connect help, Directive (EU) 2019/882 |
| Apple Kids | Parental gate, third-party analytics exception | App Review Guidelines 1.3 and 5.1.4 |

EUR-Lex answers scripted requests with a bot challenge. Its hashes were recorded from a browser and the weekly source check reports the page as broken, not unchanged, when the challenge comes back.

## Local Play Data safety declaration

Google's Play Developer API can write the Data safety form but cannot read it. Keep your answers in `launchymind.datasafety.json` at the project root:

```json
{
  "format": 1,
  "reviewed": true,
  "collectsOrShares": true,
  "types": [
    { "type": "Purchase history", "collected": true, "shared": false, "purposes": ["App functionality"] }
  ]
}
```

`type` must be one of the data type names Play Console uses (answer 10787469). `launchymind init <path> --datasafety` writes a draft from verified SDK rows with `reviewed: false`. A file with `reviewed: false` or invalid JSON stays unchecked. Once reviewed, a scan fails `google.data-safety-declaration-sdks` when a verified SDK row names a Play data type the file does not declare. Vendor wording with no single Play type, such as "IP address", is listed for manual mapping and does not fail. Without the file the rule does not apply.

`launchymind labels <path> --play-csv draft.csv` writes a review sheet with the Play data type, the vendor wording, the SDK, purposes, and the source. It is not the Play Console import format.
