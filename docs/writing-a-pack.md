# Writing a LaunchyMind pack

A pack is data. It is four YAML files and, if you want, a short README and a license. LaunchyMind will not install JavaScript, TypeScript, shell scripts, or anything else it could run.

```text
pack.yaml
rules.yaml
withheld.yaml
cases.yaml
```

`pack.yaml` names the pack (`format: 1`, an id of letters, numbers, dots, and dashes, a version, a license, an engine range, authors, `verifiedAt`, and a description).

`rules.yaml` and `withheld.yaml` each hold a `rules:` list. An enabled rule needs a source URL you opened, a verification date, English and Turkish summaries, and `appliesWhen` / `evaluate` conditions that only compare facts. The fact names are the ones in `KNOWN_FACTS`. A withheld rule stays disabled. `cases.yaml` needs at least one case for every enabled rule. `launchymind pack validate <directory>` checks the same schema as the core pack.

Install it into a project:

```bash
launchymind pack add ./my-pack --project path/to/app
launchymind pack add https://example.com/my-pack.git --project path/to/app
launchymind pack list --project path/to/app
launchymind pack remove example.notes --project path/to/app
```

`pack add` copies the data files into `.launchymind/packs/<id>`. A git URL is cloned with hooks disabled and is rejected if the tree contains a file that is not yaml, json, markdown, or license text. The next scan loads those rules after the core pack. A rule id that repeats a core rule is skipped. The verdict function does not change: the new rules only add findings.

Do not put policy text, seller ids, or instructions to execute code in a pack.
