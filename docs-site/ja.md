# LaunchyMind（日本語）

LaunchyMind は、モバイルプロジェクトを App Store または Google Play に提出する前にチェックします。判定は **準備完了**、**リスクあり**、**リジェクトの可能性が高い** のいずれかです。判定を決めるのはルールエンジンだけです。これはストアの承認でも法的助言でもありません。

## インストール

Node.js 22.18 以降が必要です。リポジトリから:

```bash
npm install
npm run build
node dist/apps/cli/src/index.js scan path/to/app --offline
```

## クイックスタート

```bash
launchymind scan path/to/app --lang ja
launchymind explain path/to/app --why-not-ready
launchymind init path/to/app --set attestations.apple.xcode-sdk=true
```

`--offline` はネットワークチェックを省略します。確認できない事実は **未確認** のまま残り、未確認があると準備完了にはなりません。空欄の回答が勝手に埋められることはありません。

## 言語

`--lang ja` で日本語になります。`--lang` がない場合は `LC_ALL`、`LC_MESSAGES`、`LANG` のうち最初に設定されているものが使われ、どれもなければ VS Code の表示言語、それもなければ英語です。対応言語: en, tr, de, fr, es, pt-BR, it, ja, ko, zh-Hans, ar, ru。

ルールの出典は原文の言語のまま引用します。App Store Connect、Play Console、App Privacy、Data safety などのストア用語は、各ストアの表記のままです。日本語訳のないルール説明は、その旨の注記付きで英語で表示されます。
