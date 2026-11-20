# Extra CA certificates for the source check

`www.kvkk.gov.tr` sends its leaf certificate without the GlobalSign intermediate,
so Node's fetch fails with "unable to verify the first certificate".

`globalsign-gcc-r46-ov-tls-ca-2025.pem` is the intermediate named in the leaf
certificate's Authority Information Access field
(`http://secure.globalsign.com/cacert/gsgccr46ovtlsca2025.crt`), converted to PEM.
It chains to GlobalSign Root R46, which is already in the system trust store.
Verification stays on: this file only completes the chain.

Run the check with it:

```sh
NODE_EXTRA_CA_CERTS=scripts/ca/globalsign-gcc-r46-ov-tls-ca-2025.pem launchymind sources check
```
