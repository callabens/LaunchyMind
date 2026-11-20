# LaunchyMind (Deutsch)

LaunchyMind prüft ein mobiles Projekt, bevor Sie es an den App Store oder Google Play senden. Das Ergebnis ist **bereit**, **riskant** oder **Ablehnung wahrscheinlich**. Nur die Regel-Engine entscheidet. Das ist keine Store-Freigabe und keine Rechtsberatung.

## Installation

Node.js 22.18 oder neuer. Aus einem Checkout:

```bash
npm install
npm run build
node dist/apps/cli/src/index.js scan pfad/zur/app --offline
```

## Schnellstart

```bash
launchymind scan pfad/zur/app --lang de
launchymind explain pfad/zur/app --why-not-ready
launchymind init pfad/zur/app --set attestations.apple.xcode-sdk=true
```

`--offline` überspringt Netzwerkprüfungen. Ein fehlender Fakt bleibt **ungeprüft**, und ungeprüft verhindert das Ergebnis „bereit“. Eine leere Antwort wird nie für Sie ausgefüllt.

## Sprache

`--lang de` wählt Deutsch. Ohne `--lang` entscheidet die erste gesetzte Variable von `LC_ALL`, `LC_MESSAGES` und `LANG`; ist keine gesetzt, die Anzeigesprache von VS Code; sonst Englisch. Unterstützt: en, tr, de, fr, es, pt-BR, it, ja, ko, zh-Hans, ar, ru.

Regelquellen werden in ihrer Originalsprache zitiert. Begriffe der Stores wie App Store Connect, Play Console, App Privacy und Data safety bleiben so, wie die Stores sie schreiben. Eine Regelerklärung ohne deutsche Übersetzung wird auf Englisch angezeigt, mit einem Hinweis.
