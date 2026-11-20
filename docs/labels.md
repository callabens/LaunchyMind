# Labels and legal packs

`launchymind labels <path>` prints a draft of App Privacy and Play Data safety rows. A row exists only when `packages/packs/sdk/sdks.yaml` has a vendor page that was opened, with a date. An SDK marked unknown adds no data type. The command says the result is a draft, not a store form and not legal advice. Turkish text is `--lang tr`.

If a verified row says the SDK may use data for third-party advertising and the app privacy manifest sets `NSPrivacyTracking` to false, the rule engine reports a risk. If the project says the advertising ID was not declared and a verified row lists a device identifier, that is also a risk. A blank project answer stays unchecked.

Legal packs live in `packages/packs/legal`. They load when `project.yaml` names a region, sets `audience.kids`, or sets `packs.<name>: true`. Set `packs.kvkk: false` to keep the KVKK pack off even in region `TR`. GDPR and accessibility rules stay disabled until their source text is re-opened. Nothing in those packs is legal advice.
