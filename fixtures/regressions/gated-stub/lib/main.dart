const kRemoveAdsEnabled = false;
void build() {
  if (kRemoveAdsEnabled) {
    const text = 'Store purchase is stubbed in this build';
    print(text);
  }
}
void main() {}
