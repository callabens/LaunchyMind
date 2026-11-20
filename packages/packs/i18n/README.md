# Locale catalogs

`ui/<locale>.json` holds every interface string: report headings, status and severity words, verdict labels, disclaimers, label-draft headings, and the dashboard. `tests/i18n.test.ts` fails when a locale misses a key or changes a `{placeholder}`.

Locales: en (default), tr, de, fr, es, pt-BR, it, ja, ko, zh-Hans, ar (right-to-left in the HTML report and the dashboard), ru.

Rules:

- Rule sources are quoted in their original language. Do not translate a quote, a URL, a rule id, or a guideline number.
- Store terms stay as the stores write them: App Store Connect, Play Console, App Privacy, Data safety, App Tracking Transparency.
- Rule explanations live in the rule packs as `summary.en` / `summary.tr` and `next.en` / `next.tr`. Other locales can add `rules/<locale>.yaml`:

```yaml
apple.privacy-policy-in-app:
  summary: "…"
  next: "…"
```

An explanation without a translation is shown in English with a note saying so. It is never machine-filled at run time.
