# LaunchyMind (Türkçe)

LaunchyMind, bir mobil projeyi App Store veya Google Play'e göndermeden önce denetler. Karar **hazır**, **riskli** veya **ret ihtimali yüksek** olur. Kararı yalnızca kural motoru verir. Bu, mağaza onayı veya hukuk görüşü değildir.

## Kurulum

Node.js 22.18 veya daha yeni bir sürüm gerekir. Depodan:

```bash
npm install
npm run build
node dist/apps/cli/src/index.js scan uygulama-yolu --offline
```

npm'e yayın, `NPM_TOKEN` sırrı isteyen elle çalışan bir GitHub Action'dır. Bu site paketi yayınlamaz.

## Hızlı başlangıç

```bash
launchymind scan uygulama-yolu
launchymind explain uygulama-yolu --why-not-ready
launchymind init uygulama-yolu --set attestations.apple.xcode-sdk=true
```

`--offline` ağ isteklerini atlar. Bilinmeyen bir olgu **kontrol edilemedi** kalır ve hazır kararını engeller. Boş bırakılan bir cevap uydurulmaz.

`explain --why-not-ready`, READY kararını engelleyen başarısız kuralları, kontrol edilemeyen kuralları ve sınırları listeler.

Düzeltme yazmak için `--yes` veya terminalde ayrı bir onay gerekir. MCP tarafında `approved: true` ve `propose` aracının verdiği `fixId` birlikte gerekir. Anahtarlar sizde kalır; depoya yazılmaz.

## Dil

`--lang tr` Türkçeyi seçer. `--lang` yoksa `LC_ALL`, `LC_MESSAGES` ve `LANG` içinden ilk tanımlı olan karar verir; hiçbiri yoksa VS Code görüntüleme dili, o da yoksa İngilizce kullanılır. Desteklenenler: en, tr, de, fr, es, pt-BR, it, ja, ko, zh-Hans, ar, ru.

Kural kaynakları özgün dillerinde alıntılanır. App Store Connect, Play Console, App Privacy ve Data safety gibi mağaza terimleri mağazaların yazdığı gibi kalır.
