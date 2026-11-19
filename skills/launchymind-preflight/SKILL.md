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

1. Run `launchymind scan <project> --offline` first if the user has not asked you to fetch pages. Use a normal scan when they want privacy and support links checked.
2. Or call the MCP tools in this order: `launchymind_get_overview`, then `launchymind_explain_finding` for each open item. Use `launchymind_get_verdict` if you only need the decision.
3. Tell the user the verdict in plain language: ready, risky, or likely to be rejected. Quote the rule id, the file and line, the source link, and the verified date.
4. If a rule is unchecked, say it could not be checked. Do not fill the gap with a guess.
5. Kids, health, and user-generated content are not visible in code. Ask the user. Do not invent the answer.

## Rules you do not break

- Do not say the app is legally compliant, KVKK-compliant, or GDPR-compliant. Say this is not legal advice and a lawyer should review it.
- Do not say Apple or Google will approve the app. The report already says they make the final decision.
- Do not change a verdict. There is no tool for that. If you disagree, say why and leave the engine result as it is.
- Do not write project files unless the user approves a specific draft. `launchymind_propose_fix` only drafts. `launchymind_apply_fix` is off in this preview and still does not write files.
- After any change, scan again before saying a finding is fixed.
