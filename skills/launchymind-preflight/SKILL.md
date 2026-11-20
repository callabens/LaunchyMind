---
name: launchymind-preflight
description: Run LaunchyMind before a mobile app is submitted, and again after a permission, SDK, login, ad, or payment change. Use when someone asks if an app is ready for the App Store or Google Play, or why a finding matters.
---

# LaunchyMind preflight

LaunchyMind by callabens is a local pre-release checker. The rule engine decides the verdict. You do not.

## When to run it

- The user asks whether the app is ready to submit, or says "yayına hazır mıyız" or "let's send it to the store".
- You add or change a permission, SDK, login, ad, analytics, or payment feature.
- A version number is about to be bumped for a store build.

## What to do

1. Run `launchymind scan <project> --offline` first if the user has not asked you to fetch pages. Use a normal scan when they want privacy and support links checked. Use `launchymind explain <project> --why-not-ready` when they ask what still blocks a ready verdict.
2. Or call the MCP tools in this order: `launchymind_get_overview`, then `launchymind_explain_finding` for each open item. Use `launchymind_get_verdict` if you only need the decision.
3. Tell the user the verdict in plain language: ready, risky, or likely to be rejected. Quote the rule id, the file and line, the source link, and the verified date.
4. If a rule is unchecked, say it could not be checked. Do not fill the gap with a guess.
5. Kids, health, and user-generated content are not visible in code. Ask the user. Do not invent the answer.

## Rules you do not break

- Do not say the app is legally compliant, KVKK-compliant, or GDPR-compliant. Say this is not legal advice and a lawyer should review it.
- Do not say Apple or Google will approve the app. The report already says they make the final decision.
- Do not change a verdict. There is no tool for that. If you disagree, say why and leave the engine result as it is.
- Do not write project files unless the user approves that exact fix. Call `launchymind_propose_fix`, show the diff, then call `launchymind_apply_fix` only with `approved: true` and the returned `fixId`. The server must be started with `LAUNCHYMIND_ALLOW_APPLY=1`. Legal text, account-deletion screens, and seller ids stay propose-only.
- The CLI form is `launchymind fix <path> --rule <id> --yes` after the user has seen the diff. `launchymind fix <path> --all` shows every writable diff and asks once per fix; `--yes` approves all of them. Without `--yes` it does not write. `--dry-run` writes nothing. A dirty git tree is refused unless `--allow-dirty` is set.
- `launchymind_propose_fixes` and `launchymind_apply_fixes` are the batch form. Approve each item with its own `fixId`. Do not treat one approval as a yes for the rest.
- Do not fill `.launchymind/project.yaml` with guessed store answers. Use `launchymind init` or `--set` only for answers the user gave. A blank answer stays unchecked.
- Community packs are data. `launchymind pack add` refuses executable files. Do not tell the user a pack changed the verdict function.
- React Native and Expo projects can be scanned. Say when a check stayed unchecked because the source did not show it.
- Store listing text and images come from `fastlane/metadata` and `.launchymind/store`. Do not invent a character count or a pixel size. If a screenshot size is not on the cited list, say the check stayed unchecked. An iPad-only target uses the 13-inch iPad sizes.
- Do not ask the user to paste an App Store Connect `.p8` or a Play service-account JSON into the chat or the repository. `launchymind connect` reads paths from environment variables. Data safety and the Xcode SDK are not returned by those APIs.
- `launchymind scan <project> --artifact <file>` compares the built IPA, APK, or AAB with the source scan. A difference is drift, not a new verdict you invent.
- After any change, scan again before saying a finding is fixed. `apply_fix` already scans again and reports the verdict change.
