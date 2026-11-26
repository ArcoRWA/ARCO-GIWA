// Public snapshot stand-in. The testnet fund price job is an internal operations tool and is not part of this
// repository, so its status reads as unavailable with no rates and no bot.
import type { ArcoUSDAlertStore } from "../arcousd/alerts.js"

export type PriceBotStatusResponse = {
  /** "unavailable": the heartbeat store could not be read (the rates are still listed). */
  readonly status: "live" | "unavailable"
  readonly error?: string
  /** The yearly rates the bot applies, by productId (bps). */
  readonly rates: readonly { readonly productId: string; readonly rateBps: number }[]
  /** null: the bot has never reported (off, or not deployed yet). */
  readonly bot: null | {
    readonly lastRunAt: string
    readonly lastOkAt: string | null
    readonly lastError: string | null
    /** A running bot (dry-run or live) that has not reported for well over its interval. */
    readonly stale: boolean
    /** The round as the bot wrote it (server/src/funds/price-bot.ts PriceBotReport); null if unreadable. */
    readonly report: Record<string, unknown> | null
  }
}

export async function priceBotStatus(_deps: {
  readonly chainId: number
  readonly store: Pick<ArcoUSDAlertStore, "heartbeat"> | null
  readonly now?: () => number
}): Promise<PriceBotStatusResponse> {
  return { status: "unavailable", error: "Not included in this repository", rates: [], bot: null }
}
