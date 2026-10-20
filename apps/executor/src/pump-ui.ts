import type { Locator, Page } from "playwright";

import { ExecutionSafetyError } from "./errors.js";
import type { PumpUiAdapter, TradeRequest, UiTradeSnapshot } from "./types.js";

/**
 * Reviewed, accessibility-based page contract. Values are supplied by stable
 * labelled fields, never token names, icons, screen coordinates, or broad text.
 */
export interface PumpUiContract {
  origin: string;
  walletLabel: string;
  mintLabel: string;
  amountLabel: string;
  minimumReceivedLabel: string;
  routeLabel: string;
  slippageLabel: string;
  buyButtonName: string;
  sellButtonName: string;
}

async function exactlyOne(locator: Locator, name: string): Promise<Locator> {
  if ((await locator.count()) !== 1 || !(await locator.isVisible())) {
    throw new ExecutionSafetyError(`UI contract mismatch for ${name}`, "UI_CONTRACT_MISMATCH");
  }
  return locator;
}

async function labelledValue(page: Page, label: string): Promise<string> {
  const field = await exactlyOne(page.getByLabel(label, { exact: true }), `label ${label}`);
  const value = await field.inputValue();
  if (value.trim().length === 0) {
    throw new ExecutionSafetyError(`Empty required UI field ${label}`, "UI_CONTRACT_MISMATCH");
  }
  return value.trim();
}

function parseBaseUnits(value: string, label: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new ExecutionSafetyError(`Non-integer ${label} in UI`, "UI_VALUE_INVALID");
  }
  return BigInt(value);
}

function parseBps(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new ExecutionSafetyError("Non-integer slippage in UI", "UI_VALUE_INVALID");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ExecutionSafetyError("Invalid slippage in UI", "UI_VALUE_INVALID");
  }
  return parsed;
}

function assertExact(expected: string | bigint | number, actual: string | bigint | number, field: string): void {
  if (expected !== actual) {
    throw new ExecutionSafetyError(`UI ${field} does not match the approved trade`, "UI_TRADE_MISMATCH");
  }
}

/**
 * Playwright implementation intentionally performs inspection only. A wallet
 * adapter owns the approval click after transaction policy validation.
 */
export class PlaywrightPumpUiAdapter implements PumpUiAdapter {
  constructor(
    private readonly page: Page,
    private readonly contract: PumpUiContract,
  ) {}

  async inspectTrade(request: TradeRequest): Promise<UiTradeSnapshot> {
    const currentOrigin = new URL(this.page.url()).origin;
    const configuredOrigin = new URL(this.contract.origin).origin;
    const requestedOrigin = new URL(request.expectedOrigin).origin;
    if (currentOrigin !== configuredOrigin || currentOrigin !== requestedOrigin) {
      throw new ExecutionSafetyError("Pump UI origin is not the reviewed HTTPS origin", "ORIGIN_MISMATCH");
    }
    if (new URL(currentOrigin).protocol !== "https:") {
      throw new ExecutionSafetyError("Pump UI must use HTTPS", "ORIGIN_MISMATCH");
    }

    const expectedButton = request.intent.side === "buy" ? this.contract.buyButtonName : this.contract.sellButtonName;
    const action = await exactlyOne(this.page.getByRole("button", { name: expectedButton, exact: true }), "trade action");
    if ((await action.getAttribute("aria-disabled")) === "true") {
      throw new ExecutionSafetyError("Trade action is disabled", "UI_CONTRACT_MISMATCH");
    }

    const [wallet, mint, rawAmount, rawMinimumOutput, route, rawSlippage] = await Promise.all([
      labelledValue(this.page, this.contract.walletLabel),
      labelledValue(this.page, this.contract.mintLabel),
      labelledValue(this.page, this.contract.amountLabel),
      labelledValue(this.page, this.contract.minimumReceivedLabel),
      labelledValue(this.page, this.contract.routeLabel),
      labelledValue(this.page, this.contract.slippageLabel),
    ]);
    const snapshot: UiTradeSnapshot = {
      origin: currentOrigin,
      wallet,
      mint,
      side: request.intent.side,
      inputAmount: parseBaseUnits(rawAmount, "input amount"),
      minimumOutput: parseBaseUnits(rawMinimumOutput, "minimum received"),
      route: route === "bonding_curve" || route === "pumpswap"
        ? route
        : (() => { throw new ExecutionSafetyError("Unknown UI route", "UI_VALUE_INVALID"); })(),
      slippageBps: parseBps(rawSlippage),
    };

    assertExact(request.intent.wallet, snapshot.wallet, "wallet");
    assertExact(request.intent.mint, snapshot.mint, "mint");
    assertExact(request.intent.amountLamports, snapshot.inputAmount, "input amount");
    assertExact(request.quote.route, snapshot.route, "route");
    assertExact(request.quote.minimumOutput, snapshot.minimumOutput, "minimum received");
    assertExact(request.slippageBps, snapshot.slippageBps, "slippage");
    return snapshot;
  }
}
