# Locale catalogs

`ui/<locale>.json` holds every interface string: report headings, status and severity words, verdict labels, disclaimers, label-draft headings, and the dashboard. `tests/i18n.test.ts` fails when a locale misses a key or changes a `{placeholder}`.

Locales: en (default), tr, de, fr, es, pt-BR, it, ja, ko, zh-Hans, ar (right-to-left in the HTML report and the dashboard), ru.

Rules:

- Rule sources are quoted in their original language. Do not translate a quote, a URL, a rule id, or a guideline number.
- Store terms use the name each store gives them in that language (Google Play's Data safety is "Datensicherheit" in German, "データ セーフティ" in Japanese, "أمان البيانات" in Arabic; Apple's App Privacy is "App-Datenschutz", "Appのプライバシー", "خصوصية التطبيق"). Product names, identifiers, file names, keys, and URLs stay as written: App Store Connect, Play Console, NSPrivacyTracking, AD_ID, project.yaml.
- Rule explanations live in the rule packs as `title`, `summary.en` / `summary.tr` and `next.en` / `next.tr`. Every other locale has `rules/<locale>.yaml` with a `title`, a `summary`, and a `next` for every rule whose English text has one; `rules/tr.yaml` adds the Turkish titles:

```yaml
apple.privacy-policy-in-app:
  title: "…"
  summary: "…"
  next: "…"
```

`tests/i18n.test.ts` fails when any shipped rule (core and legal packs) is missing from a locale file, misses one of those keys, has a `next` that English does not, or names a rule that does not exist. A community or project rule with no translation is shown in English with a note saying so. Nothing is machine-filled at run time.
