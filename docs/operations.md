# Operator procedures

## Wallet setup

1. Create a new wallet on a clean operator device.
2. Record the recovery phrase offline.
3. Import only the dedicated wallet into the pinned browser extension.
4. Fund the wallet with the approved limited bankroll.
5. Disable automatic deposits and automatic limit increases.
6. Confirm the configured public key before each live session.

Never import a primary wallet. Never capture unlock steps in screenshots, traces, videos, or logs.

## Start sequence

1. Confirm current platform and wallet automation permission records.
2. Confirm the current browser, extension, adapter, strategy, and manifest versions match the gate record.
3. Start PostgreSQL and the read-only data services.
4. Start the reconciler and wait for a clean wallet reconciliation.
5. Start the control service and verify both halt controls.
6. Start the executor in paper mode.
7. Review stream freshness, quote divergence, fee reserve, exposure, and unresolved intent metrics.
8. Enable live mode through the private control plane only when every check passes.

## Emergency halt

Use the entry halt when new risk must stop but checked exits can continue. Use the execution halt when the UI, signing policy, wallet, or transaction identity is uncertain.

An execution halt cannot recall a submitted transaction. Keep the reconciler active unless the host is compromised.

After a halt:

1. Preserve database state and sanitized evidence.
2. Reconcile all signatures and wallet balances with independent RPC data.
3. Resolve every uncertain intent.
4. Review adapter and configuration changes.
5. Test the failure with fixtures.
6. Resume with the expected control revision and an operator reason.

## Wallet recovery

1. Stop the executor and revoke its host access.
2. Verify submitted transactions from an independent RPC endpoint.
3. Move remaining assets with a trusted manual wallet only when compromise is suspected.
4. Create a new dedicated wallet before automation resumes.
5. Never reuse a browser profile that may be compromised.

## UI drift

The executor must halt when critical controls disappear, duplicate, change meaning, or produce an unexpected transaction. Do not patch selectors during a live session. Review the new UI, update fixtures and adapters, rerun contract and failure-injection tests, and create a new gate record.
