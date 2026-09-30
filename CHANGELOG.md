# Changelog

## [1.0.0-rc.2](https://github.com/email-utils/validator-dns/compare/v1.0.0-rc.1...v1.0.0-rc.2) (2026-09-30)


### Bug Fixes

* follow syntax.maxLength instead of a fixed 512 ([#37](https://github.com/email-utils/validator-dns/issues/37)) ([1e63988](https://github.com/email-utils/validator-dns/commit/1e6398806d71b161741e6232198e45a74fdbd674))

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
