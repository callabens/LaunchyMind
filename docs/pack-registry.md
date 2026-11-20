# Pack registry

`registry/index.json` lists data-only packs. Each entry has a name, a git repository, a path inside that repository, a pinned commit, and an integrity hash. `launchymind pack add` checks the hash before it copies files. It does not run code from the pack.

```bash
launchymind pack search notes
launchymind pack add example-notes --project path/to/app
launchymind pack integrity registry/packs/example-notes
```

`example-notes` enables no rules. It is there so the index and the hash check can be tried.

## Submitting a pack

1. Put the pack in `registry/packs/<name>/` with `pack.yaml`, `rules.yaml`, `withheld.yaml`, and `cases.yaml`. Only yaml, json, markdown, and license text.
2. Run `launchymind pack validate registry/packs/<name>` and `launchymind pack integrity registry/packs/<name>`.
3. Add an object to `registry/index.json`. `commit` is the full git commit that contains those exact files. `integrity` is the hash from the command above.
4. Open a pull request. A reviewer checks the source URLs. Do not send a pack that tells the tool to execute code.
