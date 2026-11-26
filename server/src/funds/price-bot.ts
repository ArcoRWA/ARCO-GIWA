// Public snapshot stand-in. The testnet fund price job that runs in the keeper worker is an internal
// operations tool and is not part of this repository. This module keeps the worker building: it always
// reports mode "off", so scripts/arcousd/run-keeper.mjs never starts it.

export const PRICE_BOT_GAS_LIMIT = 200_000n

export type FundPriceBotEnv = { mode: "off"; invalid: string[]; intervalMs: number; address: string }

export function parseFundPriceBotEnv(_env: Record<string, string | undefined>): FundPriceBotEnv {
  return { mode: "off", invalid: [], intervalMs: 0, address: "" }
}

function notIncluded(): never {
  throw new Error("FUND_PRICE_BOT_NOT_INCLUDED")
}

export function priceBotFunds(_registry: unknown): never {
  return notIncluded()
}
export function guardedPriceSigner(_input: unknown): never {
  return notIncluded()
}
export function viemPriceBotRpc(_client: unknown): never {
  return notIncluded()
}
export async function priceBotRoles(..._args: unknown[]): Promise<never> {
  return notIncluded()
}
export async function runPriceBotLoop(_input: unknown): Promise<never> {
  return notIncluded()
}
export class FundPriceBot {
  constructor(_input: unknown) {
    notIncluded()
  }
}
