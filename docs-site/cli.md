# CLI

```text
launchymind scan <path> [--json] [--html file] [--output file] [--offline] [--lang en|tr] [--fail-on reject|risky|none]
launchymind explain <path> --why-not-ready [--offline] [--json]
launchymind init <path> [--set key=value]
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

`init` writes `.launchymind/project.yaml`. Keys you skip stay unchecked.

Store text is read from `fastlane/metadata` and `.launchymind/store`. See the rules page for what is measured.
