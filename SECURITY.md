# Security review and hardening — 9 October 2026

Scope: the backend, Expo mobile source, locally available Git history, dependency lockfiles and local secret file permissions. The landing page is static; it does not submit transactions or store wallet sessions. No live funds were moved, production infrastructure was not penetration-tested, and no production backend/mobile release was deployed.

## Implemented

- Wallet ownership: five-minute, single-use challenges verified with Ed25519; opaque one-hour sessions; logout revocation. No private keys pass through the API. Mobile sign-in explicitly signs a narrowly validated text challenge and keeps the API session in SecureStore.
- Authorization: private wallet routes, receipt saving/listing, trade building/confirmation and wallet-specific alerts require a session; supplied wallet identities must match it. Anonymous market data, quotes and public alerts remain available. Receipt lists are wallet-scoped and paginated (100 by default, maximum 200).
- Trade binding: the build response contains an HMAC-authenticated execution intent covering the wallet, market, original quote and serialized transaction-message hash. Confirmation independently checks successful chain status, the wallet signer, identical message bytes and actual matching balance movements. Unrelated successful transactions and fabricated fills are rejected. Intents expire after 24 hours.
- Replay handling: receipt signatures are idempotent in memory and file storage. Postgres uses a transaction-scoped advisory lock plus network/signature lookup across replicas, including existing rows; a supporting signature index is created. Legacy duplicate executions are excluded from holdings/P&L aggregation. Existing records are not deleted.
- Receipt accuracy: token balances are summed across the owner's accounts; native SOL and wrapped-SOL rent/close behavior are normalized. Fee collection requires an observed transfer to the intended treasury account, rather than merely an enabled setting. A receipt content hash is a checksum, **not** an independent cryptographic attestation.
- Client signing: expected fee payer/signer, unsigned payload, instruction families, a single recognized swap, token spending/output bounds, SOL overhead and token authorities are checked. Simulation uses an independently configured RPC. Normal token transfers to arbitrary destinations, delegation changes, extra signers and unrecognized programs fail closed.
- Confirmation UX: automatic confirmation retries reuse the submitted signature. Pending confirmation is persisted on device and blocks a new submission for that wallet/market until resolved. A shared submission lock prevents concurrent mounted screens from signing duplicate trades while the journal is loading. SecureStore persistence failures surface an explicit already-submitted warning.
- API abuse: bounded per-IP request buckets, stricter costs for auth/writes, request/body limits, no trust in arbitrary forwarded-IP headers, an explicit browser-origin allowlist, no-store/nosniff headers, per-IP and global WebSocket limits, heartbeat and slow-client backpressure. Rule count is limited per wallet and globally.
- Persistence: file updates use serialized atomic replacement and owner-only permissions. Corrupt files fail loudly rather than silently being overwritten with empty stores. Alert callbacks catch persistence failures instead of causing unhandled promise rejection.
- Database: remote Postgres TLS certificate verification is enabled, with configurable custom CA. URL SSL options cannot silently weaken the explicit TLS policy. ClickHouse database identifiers are validated.
- Secrets: current tracked text and 90 backend/97 frontend historical text blobs were scanned heuristically without printing values; no matching private-key/credential patterns were found. Sensitive path history checks found no tracked `.env` or keypair files. This is not proof that no credential has ever leaked elsewhere. Existing local `.env` files now use owner-only permissions; the secrets directory is owner-only. Keypair creation uses exclusive writes.
- Dependencies: compatible `npm audit fix --ignore-scripts` patches applied to both lockfiles, including Fastify/fast-uri and the reported critical shell-quote issue. No forced major framework/Solana migrations were applied.

## Required coordinated rollout

1. Configure a randomly generated **32+ byte** `EXECUTION_INTENT_SECRET` in backend deployment secrets before production startup. Keep it stable across restarts and replicas; never expose it through `EXPO_PUBLIC_*`. Rotating it invalidates outstanding execution intents. Development without it uses an ephemeral process key.
2. Configure `CORS_ORIGINS` with exact browser origins. Include local preview origins only in development. Native Android requests do not require a browser CORS entry.
3. If behind a reverse proxy, set `TRUSTED_PROXY_IPS` to the actual trusted proxy IPs/CIDRs. Do not blindly trust all forwarded headers. Otherwise requests behind that proxy share a rate-limit bucket.
4. Verify the deployed Postgres CA chain. Supply `DATABASE_SSL_CA` for a private CA; do not turn certificate verification back off. Local loopback Postgres can run without TLS.
5. Run **one API process/replica** until auth challenges, sessions, rate limits and alert rules use shared atomic storage. File-mode receipts also require one process. Receipt replay protection in Postgres itself is cross-replica, but sessions and alert-rule storage are not.
6. Release the matching app/API together in a maintenance window. Old mobile clients have no authentication token or execution intent and will correctly be rejected. Existing mobile sessions require reconnection. There is no insecure legacy-auth bypass.
7. Configure a reliable, app-safe `EXPO_PUBLIC_SOLANA_RPC_URL` if public Solana RPC limits prevent simulations. Never bundle a privileged provider API key. Validate actual wallet message-signing support on Android (Phantom/Solflare/Jupiter as applicable).
8. Smoke-test connect/sign-in, public browsing, private receipts, alert create/delete, analyze, transaction review, wallet approval/cancellation, confirm/retry and reconnect. Device signing and production TLS/RPC access cannot be proven by an offline test suite.
9. Review legacy receipts before relying on historical “verified” or fee-collected claims: records created by the old verifier are not retroactively authenticated by this patch. Reconcile historical activity with chain data; no historical records were erased.

## Remaining risks / limitations

The review is not a clean bill of health or an exhaustive formal audit. npm still reports **14 backend packages (7 high, 7 moderate)** and **33 frontend packages (20 high, 13 moderate)** after compatible patches. These counts include dependent packages inheriting the same advisory; they are not counts of unique exploits.

Remaining root advisory families:

| Dependency | Area | Why not forced in this patch |
| --- | --- | --- |
| bigint-buffer | Solana/Phoenix backend dependency | Native buffer-overflow advisory; npm reports no safe patched release in this dependency tree. Requires upstream replacement or separately reviewed native-free migration. |
| toml | Phoenix code-generation/tooling dependency | Resolving it requires changing the older Metaplex/Phoenix dependency chain. No production TOML parser entrypoint was identified in our app source; dependency installation and tooling still deserve isolation. |
| stream-json | Solana RPC tooling | Older API dependency chain; forcing a new major could break RPC behavior. Review upstream migration and any reachable streaming parser usage. |
| uuid | Solana / build tooling | npm suggests major dependent-package changes. Application code now uses Node `randomUUID` for newly changed receipt/rule IDs; transitive packages still need upstream remediation. |
| braces | Expo/Metro build tooling | No compatible patched version reported in the installed tree; keep untrusted projects/patterns away from build tools. |
| node-forge | Expo signing/build tooling and dependency chain | No compatible automatic patch reported; requires upstream SDK/tooling remediation. |
| decode-uri-component | Expo Router | npm suggests a new Expo Router major. This needs coordinated Expo compatibility testing, not a blind override. |

A compromised trusted RPC or recognized swap program remains a security boundary. Client simulation is a pre-sign observation, not a guarantee of future chain state or protocol correctness. The app's instruction checks intentionally reject unusual transaction formats; unsupported routes must be reviewed rather than bypassing checks. Native SOL overhead is capped at 0.02 SOL and output tolerance is disclosed as 97.8% of the analyzed output.

A wallet can submit a transaction and fail to return its signature (network/wallet failure); no app can safely infer non-submission from that error alone. Reconcile wallet history before retrying uncertain submissions. An unresolved/expired persisted confirmation intentionally blocks further trades for that wallet/market until reconciled. Cross-device concurrent submissions are not prevented by the local journal.

Per-IP controls are not a substitute for edge DDoS protection, deployment IAM, backups, secret management and monitoring. Those external systems were not configured by this change.

## Validation

- 35 backend regression and security tests pass; they run with actual nested test execution (`--test-isolation=none`; the local Node 25 isolated runner otherwise only reported file-level results).
- Both TypeScript checks pass.
- 9 mobile security tests pass, covering mocked RPC, malicious transaction cases and concurrent submission locking.
- Android production JavaScript export succeeds (not a signed native APK or real-device wallet test).
- Current-lockfile npm audits and heuristic Git-history secret scans.

Implementation references: [OWASP REST security](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html), [Mobile Wallet Adapter specification](https://solana-mobile.github.io/mobile-wallet-adapter/spec/spec.html). Advisory URLs and exact affected versions are recorded by `npm audit --json` against the committed lockfiles.

Audit snapshots: [backend npm report](security-audit/backend-npm-audit.json), [frontend npm report](security-audit/frontend-npm-audit.json).
