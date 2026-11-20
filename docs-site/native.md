# Native iOS, Android, and Unity

The same rule engine runs after the scanner reads the project. A fact the files do not show stays unchecked. Unchecked is not a pass.

**iOS.** The scanner reads `project.pbxproj`, `Info.plist`, entitlements, `PrivacyInfo.xcprivacy`, `Package.resolved`, and `Podfile.lock`. It does not build the Xcode project.

**Android.** The scanner reads `build.gradle` or `build.gradle.kts`, `gradle/libs.versions.toml` when a version is referenced, and the main source manifest plus a release overlay when that file exists. It does not run Gradle, so the merged manifest from a build is not opened.

**Unity.** The scanner reads `ProjectSettings/ProjectSettings.asset`, `Packages/manifest.json`, and manifests under `Assets/Plugins`. A generated `ios/` or `android/` export is read with the same readers when those folders are present. C# is scanned for a few phrases and is not compiled.

Pod, Swift Package, Gradle, and Unity package names are mapped onto the SDK knowledge base only when the name is the same SDK already listed there. An unrecognized package does not invent a data type.
