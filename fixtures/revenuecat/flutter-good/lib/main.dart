import 'package:flutter/material.dart';
import 'package:purchases_flutter/purchases_flutter.dart';

const privacyUrl = 'https://example.com/privacy';
const termsUrl = 'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/';

Future<void> setup() async {
  await Purchases.configure(PurchasesConfiguration('appl_publicFixtureKey'));
  await Purchases.getProducts(['pro_monthly', 'pro_yearly']);
}

class Paywall extends StatelessWidget {
  const Paywall({super.key});
  @override
  Widget build(BuildContext context) {
    return Column(children: const [
      Text('Pro subscription: \$4.99 per month. Renews automatically until you cancel.'),
      Text('Terms of Use'),
      Text('Privacy Policy'),
      TextButton(onPressed: Purchases.restorePurchases, child: Text('Restore Purchases')),
    ]);
  }
}
