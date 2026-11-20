# Store console

`launchymind connect` uses your own App Store Connect `.p8` key and Play service-account JSON. The paths stay in environment variables outside the repository. The command never prints the key, and CI for this project does not have real credentials.

The full variable list and the fields each API actually returns are in the repository guide `docs/connect.md`.

Play Data safety cannot be read. The API only has a write method. The Xcode SDK is not on the App Store Connect build record, which exposes `minOsVersion` only. Those answers stay in `.launchymind/project.yaml`.
