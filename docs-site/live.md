# Live device check

```bash
launchymind run app-debug.apk --project path/to/app --html report.html
launchymind run Runner-simulator.ipa
launchymind scan path/to/app --build --live
```

`run` installs the artifact and launches it once. Android uses `adb` with the first connected device or running emulator. iOS uses `xcrun simctl` with a booted simulator; an IPA must be a simulator build (`scan --build` makes one). Permissions are not auto-granted, so a launch-time dialog stays visible.

| Check | Android (adb) | iOS simulator (simctl) |
|---|---|---|
| Crash on launch | Process alive after `--settle-ms` (default 8000) and the crash log buffer does not name the app. Rule `google.launch-crash` (Play Minimum Functionality), blocker. | App still in `launchctl list` after the wait. Rule `apple.launch-crash` (Guideline 2.1), blocker. |
| Privacy and support links on the first screen | Read from `uiautomator dump`. Found, or not found on the first screen. Not found is not a failure. | Not checked: simctl cannot read the screen. |
| Account deletion path (Apple 5.1.1(v), Google Play account deletion) | Same as the links, only when the scan found an account sign-in. | Not checked. |
| Permission prompt at launch | A system permission dialog in the UI tree. | Not checked. |
| Permission purpose strings | Not applicable (Android shows no developer text). | `NS*UsageDescription` keys in the IPA Info.plist. |
| App Tracking Transparency prompt | Not applicable. | Not checked: the prompt cannot be read from simctl. Look at the screenshot. |
| Screenshot | `adb exec-out screencap -p` | `simctl io screenshot` |

Screenshots go to `--screenshots <dir>` (default `.launchymind/screenshots`) and are embedded in the HTML report as data URIs, so the file still makes no network request.

Without `adb`, Xcode, a device, or a booted simulator, every check is **not checked** and the launch rules stay **unchecked**. Unchecked is never a pass. Only the launch result feeds the rule engine; the other checks are evidence for a person to read. An AAB is not installed; build an APK. The app is left installed and force-stopped.
