# Release gates

## Historical gate

- Freeze the strategy configuration and candidate universe.
- Use at least 30 out-of-sample days and 200 closed simulated trades.
- Include failed, rugged, delisted, migrated, and unsellable assets.
- Include observation latency, fees, failed transactions, slippage, impact, and infrastructure cost.
- Require positive net expectancy with a positive lower 95% clustered confidence bound.
- Require profit factor of at least 1.2 and drawdown below 10%.
- Require nonnegative aggregate return with doubled costs and latency.

Missing point-in-time safety fields block the gate. A favorable result does not guarantee future profit.

## Paper gate

- Run for at least 14 consecutive days and complete 100 paper round trips.
- Require positive net expectancy and profit factor of at least 1.2 after conservative costs.
- Require drawdown below 10% and no accounting discrepancy.
- Inject stale quotes, stream gaps, selector drift, route migration, RPC disagreement, crashes, duplicate events, and daily-loss breaches.
- Prove that uncertain submissions never cause a duplicate submit.

## Limited-live gate

- Record current platform, wallet, jurisdiction, tax, and automation permission reviews.
- Verify inspected-message digest binding for the pinned wallet extension.
- Verify exact transaction policies and sell paths on both supported routes.
- Test the out-of-process kill mechanism and wallet recovery procedure.
- Fund only the dedicated wallet and retain a separate fee reserve.

Start at 0.25% per position, 1% daily loss, and 2% total exposure.

## Expansion gate

- Complete at least seven days and 30 settled live round trips.
- Require positive net expectancy after all costs.
- Require zero duplicate, unresolved, or policy-violating transactions.
- Confirm realized latency, slippage, and fees remain within the stress envelope.
- Repeat the observation window after any strategy, browser, wallet, adapter, or protocol change.

No setting can exceed 5% per position, 10% daily loss, or 40% total exposure.
