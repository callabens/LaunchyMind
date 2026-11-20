# GitHub Action

`action.yml` scans a Flutter project with LaunchyMind, uploads `report.html` and `launchpack.json`, and writes the verdict into the job summary. The step fails when the verdict is at or past `--fail-on`. The default is `reject`, so a risky report stays green and a reject report fails the job.

This is not store approval and not legal advice.

## Example

```yaml
name: LaunchyMind
on:
  pull_request:
jobs:
  readiness:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: callabens/LaunchyMind@main
        with:
          path: .
          fail-on: reject
          offline: "true"
```

From this repository, `uses: ./` runs the action in the checkout. `offline: "false"` turns on the live link checker.

The action installs this package's dependencies in the action directory and does not publish to npm. A non-Flutter path exits 4.
