import 'package:flutter/material.dart';
import 'package:purchases_flutter/purchases_flutter.dart';

// Fixture only. This is not a real key.
const revenueCatKey = 'sk_FAKEfixtureKEYnotREAL0000';

Future<void> setup() async {
  await Purchases.configure(PurchasesConfiguration(revenueCatKey));
}

class Paywall extends StatelessWidget {
  const Paywall({super.key});
  @override
  Widget build(BuildContext context) {
    return const Text('Go Pro subscription for \$4.99');
  }
}
