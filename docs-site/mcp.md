# MCP

The server speaks stdio. It uses the same scan as the CLI. There is no tool that sets the verdict.

| Tool | Writes? |
| --- | --- |
| `launchymind_get_overview` | No |
| `launchymind_scan` | No |
| `launchymind_explain_finding` | No |
| `launchymind_get_verdict` | No |
| `launchymind_propose_fix` | No |
| `launchymind_propose_fixes` | No |
| `launchymind_apply_fix` | Only with approval |
| `launchymind_apply_fixes` | Only with approval, one id at a time |

Start it with `LAUNCHYMIND_ALLOW_APPLY=1` before an apply tool can write. Each apply still needs `approved: true` and the exact `fixId` from propose.
