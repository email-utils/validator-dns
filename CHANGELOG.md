# Changelog

## [1.0.0-rc.2](https://github.com/email-utils/validator-dns/compare/v1.0.0-rc.1...v1.0.0-rc.2) (2026-10-06)


### Bug Fixes

* **deps:** bump @email-utils/* dependencies ([#54](https://github.com/email-utils/validator-dns/issues/54)) ([a63ba95](https://github.com/email-utils/validator-dns/commit/a63ba952ce62180067900fca5ed14686275b7ddc))
* **deps:** bump @email-utils/classifier from 1.0.0-rc.3 to 1.0.0-rc.4 in the email-utils group ([#40](https://github.com/email-utils/validator-dns/issues/40)) ([cddbfd4](https://github.com/email-utils/validator-dns/commit/cddbfd40d7f77b91cf050dbf81508c0c61990a00))
* follow syntax.maxLength instead of a fixed 512 ([#37](https://github.com/email-utils/validator-dns/issues/37)) ([1e63988](https://github.com/email-utils/validator-dns/commit/1e6398806d71b161741e6232198e45a74fdbd674))
* reject unknown options ([#52](https://github.com/email-utils/validator-dns/issues/52)) ([00cba05](https://github.com/email-utils/validator-dns/commit/00cba051c8ef01020f74d742ef1564b2660c20b1))
* **scoring:** accept undefined model coefficients ([5acff9f](https://github.com/email-utils/validator-dns/commit/5acff9fcc1ffbabb720293cac57385e4506a9d27))
* **scoring:** stop reading a repeated MX host as a Null MX ([#49](https://github.com/email-utils/validator-dns/issues/49)) ([7aca803](https://github.com/email-utils/validator-dns/commit/7aca8030d04c54f4dc13ddd0c0eec358ea0e1d3c))

## [1.0.0-rc.1](https://github.com/email-utils/validator-dns/compare/v1.0.0-rc.0...v1.0.0-rc.1) (2026-09-30)


### ⚠ BREAKING CHANGES

* replace EmailDnsValidator with checkDns and isValidDns ([#25](https://github.com/email-utils/validator-dns/issues/25))

### Features

* replace EmailDnsValidator with checkDns and isValidDns ([#25](https://github.com/email-utils/validator-dns/issues/25)) ([af57542](https://github.com/email-utils/validator-dns/commit/af57542b1ec117e2dccb9dde2900ce1af287ba2b))
* **resolver:** add createDnsValidator with timeouts, abort signals, and a shared cache ([#27](https://github.com/email-utils/validator-dns/issues/27)) ([c70e11e](https://github.com/email-utils/validator-dns/commit/c70e11ebae17ea2f56ef7947310fe55414a14af5))
* **resolver:** add detectProviderByMx, matched against the classifier's registry ([#28](https://github.com/email-utils/validator-dns/issues/28)) ([1c215f7](https://github.com/email-utils/validator-dns/commit/1c215f77815389487cc6c8a66768e18ca85801b5))
* **scoring:** add probeSmtp and scoreDns with two fitted models ([#29](https://github.com/email-utils/validator-dns/issues/29)) ([32d0e9c](https://github.com/email-utils/validator-dns/commit/32d0e9c3d76187b4583f9ea1f02238b7866f273c))


### Bug Fixes

* reject input over 512 characters before parsing, and add benchmarks ([#35](https://github.com/email-utils/validator-dns/issues/35)) ([7f77417](https://github.com/email-utils/validator-dns/commit/7f77417f5d145268579b29758106a6350ac56c27))
* **scoring:** bound custom model coefficients to ±1e6 ([#33](https://github.com/email-utils/validator-dns/issues/33)) ([d538818](https://github.com/email-utils/validator-dns/commit/d5388182aac1f612ab10ee8635b1b66c56be51a2))
