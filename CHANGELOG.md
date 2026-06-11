# Changelog

## [Unreleased]

## [0.0.1] - 2026-06-11
### Added
- Initial release, extracted from the tool-rental production app (pre-verification extraction; v0.1.0 marks the device-verified cut).
- `cdpWagmiConnector` — bare-RN wagmi connector over `@coinbase/cdp-core`.
- `createCdpEip1193Provider` — EIP-1193 boundary for non-wagmi consumers.
- Coinbase Smart Wallet ERC-1271 / ERC-6492 signature wrapping helpers.
- `cdpSendCalls` sponsored sends; cross-verifier-chain `cdpSignMessage`.
