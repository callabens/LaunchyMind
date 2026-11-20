# CLI

```text
launchymind scan <path> [--json] [--html file] [--output file] [--offline] [--lang en|tr] [--fail-on reject|risky|none] [--artifact file] [--build]
launchymind explain <path> --why-not-ready [--offline] [--json]
launchymind init <path> [--set key=value]
launchymind init <path> --datasafety
launchymind labels <path> [--json] [--lang en|tr] [--play-csv file]
launchymind connect revenuecat [--project path] [--json] [--offline]
launchymind fix <path> --rule <id> [--yes] [--dry-run] [--allow-dirty] [--offline]
launchymind fix <path> --all [--yes] [--dry-run] [--allow-dirty] [--offline]
launchymind pack validate [directory]
launchymind pack search <query>
launchymind pack add <name-or-path-or-git-url> [--project path]
launchymind pack integrity <directory>
launchymind pack list [--project path]
launchymind pack remove <id> [--project path]
launchymind rules
launchymind mcp
```

`explain --why-not-ready` lists every failed rule, every unchecked rule, and every limit that blocks READY. Passing rules are omitted. An info failure does not block READY.

`init` writes `.launchymind/project.yaml`. Keys you skip stay unchecked. `init --datasafety` writes `launchymind.datasafety.json` once and never overwrites it.

`scan --build` is opt-in. It copies the project to a temporary folder, builds a debug APK and an iOS simulator app when Flutter, a JDK with the Gradle wrapper, or Xcode is installed, and reads the result like `--artifact`. A build that did not run stays unchecked. A failed build is a risk with the last log lines in the report.

Store text is read from `fastlane/metadata` and `.launchymind/store`. See the rules page for what is measured.
