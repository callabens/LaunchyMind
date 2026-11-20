# LaunchyMind contributor instructions

Read README.md and docs/ARCHITECTURE.md before changing a verdict, a rule, or the scanner.

- The product name is LaunchyMind by callabens. The package is `@callabens/launchymind`.
- The rule engine is the only source of a verdict. Do not add a tool that sets ready, risky, or reject.
- A missing fact, a failed read, or a skipped live check is unchecked. Do not treat it as a pass.
- Enabled rules need a source URL, a verification date, and a test case. Do not invent policy text or citations.
- Rules that are not verified stay disabled in `withheld.yaml`.
- Packs are data. Do not execute code from a pack.
- Do not write project files from the fix flow in this preview.
- Do not add telemetry. The only network client is the link checker.
- Do not say a result is store approval or legal advice. Legal findings stay advisory.
- After a behavior change, run `npm run validate`.
- Do not publish the package. `private` stays true until a release checklist says otherwise.
