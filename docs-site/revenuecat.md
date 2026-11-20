# RevenueCat

LaunchyMind finds the RevenueCat SDK in `pubspec.yaml` (`purchases_flutter`), `package.json` (`react-native-purchases`), CocoaPods (`RevenueCat`, `RevenueCatUI`), Swift Package pins (`purchases-ios`, `purchases-ios-spm`), Gradle (`com.revenuecat.purchases:purchases`, `purchases-ui`), and the Unity package manifest (`com.revenuecat.purchases-unity`). It also turns on the payments checks.

## Rules

| Rule | What is checked | Source |
|---|---|---|
| `apple.restore-purchases` | A restore control (`restorePurchases` or a "Restore purchases" label) is in the source, or `attestations.payments.restore-control` is true | App Review Guidelines 3.1.1 |
| `apple.subscription-paywall-links` | Terms of Use (EULA) and privacy wording on the paywall, or `attestations.payments.paywall-links` | Apple, Auto-renewable subscriptions |
| `google.subscription-offer-terms` | Price, billing period, and auto-renew wording in source | Google Play, subscriptions policy (answer 9900533) |
| `revenuecat.secret-key-in-app` | No `sk_` secret API key in app source. The key is redacted in the report. | RevenueCat, Authentication |
| `revenuecat.products-configured` | Only with `connect revenuecat`: the product IDs written in code exist in RevenueCat, or the project has products, entitlements, and offerings | RevenueCat API v2 |

A RevenueCat UI paywall is not assumed to show a restore button. If your restore control comes from a remote paywall, answer the attestation.

## Read-only connect

```bash
export REVENUECAT_API_KEY=sk_...        # a v2 secret key with read access
export REVENUECAT_PROJECT_ID=proj...    # optional; the first project is used otherwise
launchymind connect revenuecat --project path/to/app
```

The command sends only GET requests to `https://api.revenuecat.com/v2` for projects, products, entitlements, and offerings. The key is never logged or written to a report; errors redact it. Without `REVENUECAT_API_KEY`, or with `--offline`, `revenuecat.products-configured` does not apply. A network error leaves it unchecked.

Use a restricted read-only key, keep it in your shell or CI secret store, and never put a secret key in the app. Public SDK keys (`appl_`, `goog_`, `amzn_`) are fine in the app.

## Statuses

- `match`: every product ID written in code is configured.
- `mismatch`: at least one product ID in code is missing from RevenueCat. This fails.
- `configured`: no IDs are hard-coded; RevenueCat has at least one product, entitlement, and offering.
- `incomplete`: no IDs are hard-coded and one of those lists is empty. This fails.
- `unknown`: the API could not be read. This stays unchecked.
