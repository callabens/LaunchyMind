# Rules and sources

Enabled rules live in `packages/packs/core/rules.yaml`. Each one has an https source, a section, a publisher, and the date that page was read. A rule without that verification stays in `withheld.yaml` and cannot change the verdict.

The engine compares facts. A missing fact is the string `unknown`. Unknown does not pass and does not fail, so the rule stays unchecked. Unchecked blocks READY.

Store listing rules run only when `fastlane/metadata` or `.launchymind/store` has files. They cover length limits, placeholder text, other-platform names, future-promise phrases, a copyright year after the scan year, price claims, repeated keywords, English and Turkish feature words, listing URLs when the scan is online, and local icon and screenshot sizes. A screenshot size that is not on Apple's specification list stays unchecked. Play screenshot edges outside 320–3840 pixels are a failure because that range is on the Play help page.

Official pages used for the store checks include:

- [App Store Connect app information](https://developer.apple.com/help/app-store-connect/reference/app-information/app-information/)
- [Platform version information](https://developer.apple.com/help/app-store-connect/reference/app-information/platform-version-information/)
- [Screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications)
- [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [Configuring your app icon](https://developer.apple.com/documentation/xcode/configuring-your-app-icon)
- [Play store listing setup](https://support.google.com/googleplay/android-developer/answer/9859152)
- [Play preview assets](https://support.google.com/googleplay/android-developer/answer/9866151)
