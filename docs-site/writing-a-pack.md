# Writing a pack

A pack is data: `pack.yaml`, `rules.yaml`, `withheld.yaml`, and `cases.yaml`. LaunchyMind refuses JavaScript, shell, and any other file it could run.

```bash
launchymind pack validate ./my-pack
launchymind pack add ./my-pack --project path/to/app
```

An enabled rule needs a source you opened, a verification date, English and Turkish summaries, and conditions that only compare facts. The longer guide is [docs/writing-a-pack.md](https://github.com/callabens/LaunchyMind/blob/cursor/launchymind-foundation-ec03/docs/writing-a-pack.md) in the repository.
