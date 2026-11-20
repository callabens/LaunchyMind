# GitHub Action

`action.yml` scans a project, uploads the HTML and JSON LaunchPack, writes the verdict into the job summary, and fails according to `fail-on`.

```yaml
- uses: callabens/LaunchyMind@cursor/launchymind-foundation-ec03
  with:
    path: .
    fail-on: reject
    offline: true
```

Use the ref you intend to pin. `fail-on` defaults to `reject`, so a risky report does not fail the job.

The docs site itself deploys only when someone runs the **Docs site** workflow by hand. The **Release** workflow is also manual and needs the `NPM_TOKEN` secret. Neither workflow runs on push.
