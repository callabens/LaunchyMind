# Approval flow

Fixes that need a human stay as drafts. The writes LaunchyMind will make are mechanical: the privacy-manifest tracking flag, a missing Info.plist usage sentence, and the Android `AD_ID` permission.

```bash
launchymind fix path/to/app --rule apple.privacy-manifest-tracking --dry-run
launchymind fix path/to/app --rule apple.privacy-manifest-tracking --yes
launchymind fix path/to/app --all
```

`--dry-run` prints a unified diff and writes nothing. Without `--yes`, a terminal asks once per fix. A non-interactive shell without `--yes` writes nothing. A dirty git tree is refused unless you pass `--allow-dirty`. Paths outside the project are refused. The bytes outside a changed line stay as they were.

On MCP, `launchymind_apply_fix` needs `LAUNCHYMIND_ALLOW_APPLY=1`, `approved: true`, and the `fixId` returned by `launchymind_propose_fix`. `launchymind_apply_fixes` requires that pair on every item. One approval does not cover the others.

After a write, LaunchyMind scans again and prints the verdict before and after.
