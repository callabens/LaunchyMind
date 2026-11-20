# History and source watch

`launchymind sources check` fetches each rule's source URL and compares a normalized hash with `packages/packs/source-watch/baseline.yaml`. A difference is printed with a short excerpt. The command does not change rule text. `--record` stores a hash only for a URL that does not have one yet. `--record-status` writes `.launchymind/source-status.json`, and the next scan lists those rules under needs re-verify.

The weekly Source watch workflow opens a GitHub issue when a page changed or failed to load. It does not open a pull request.

Set `history: true` in `.launchymind/project.yaml` before a scan is saved. `launchymind history` prints the verdict trend. `launchymind dashboard` writes one HTML file. That file has no script source and does not call out to the network.

The editor extension in `extensions/vscode` runs the CLI, shows failed and unchecked findings in Problems, and links the rule id to its source. Apply Fix asks for approval before it writes.
