import 'package:google_mobile_ads/google_mobile_ads.dart';

String unit() => kReleaseMode
    ? 'ca-app-pub-2828327093104652/1234567890'
    : 'ca-app-pub-3940256099942544/6300978111';

void load() {
  ConsentInformation.instance.requestConsentInfoUpdate();
}
