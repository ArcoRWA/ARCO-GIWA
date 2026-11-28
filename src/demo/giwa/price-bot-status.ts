import { agoText, gasText, shortAddress } from "./arcousd-admin"
import type { Tone } from "./stocks-admin/ui"
import type { GiwaPriceBotFund, GiwaPriceBotStatus } from "./types"

// Pure helpers for the Price bot card on the admin Prices page: what the bot is doing, in words.

/** "7%" / "11.28%" from basis points (max 2 decimals, no forced zeros). */
export function rateText(rateBps: number | null | undefined): string {
  if (rateBps === null || rateBps === undefined || !Number.isFinite(rateBps)) return "—"
  return `${Number((rateBps / 100).toFixed(2))}%`
}

/** A feed price: up to 4 decimals, at least 2 (the NAV rule): "1.00", "1.0012", "1.0222". */
export function botPriceText(price: string | null | undefined): string {
  const value = Number(price)
  if (price === null || price === undefined || price === "" || !Number.isFinite(value)) return "—"
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })
}

/** The bot's headline: off, never seen, stopped reporting, failing, dry run, or running. */
export function priceBotHeadline(status: GiwaPriceBotStatus | null): { label: string; tone: Tone; detail: string } {
  if (!status) return { label: "Loading", tone: "neutral", detail: "" }
  if (status.status === "unavailable") return { label: "Unavailable", tone: "attention", detail: status.error ?? "The bot's status could not be read" }
  const bot = status.bot
  const mode = bot?.report?.mode
  if (!bot || mode === "off" || mode === undefined) {
    return { label: "Off", tone: "neutral", detail: "The bot is not running. Prices change only when posted by hand below." }
  }
  if (bot.stale) return { label: "Not reporting", tone: "negative", detail: "The bot has stopped reporting. Check the keeper worker." }
  if (bot.report?.ok === false || bot.lastError) {
    return { label: mode === "live" ? "Running with errors" : "Dry run with errors", tone: "negative", detail: bot.report?.error ?? bot.lastError ?? "The last round failed" }
  }
  if (mode === "dry-run") return { label: "Dry run", tone: "attention", detail: "The bot reads and reports but posts nothing." }
  return { label: "Running", tone: "positive", detail: "Posts once a day (UTC) for each product below." }
}

const FUND_STATE: Record<GiwaPriceBotFund["state"], { label: string; tone: Tone }> = {
  posted: { label: "Posted", tone: "positive" },
  "would-post": { label: "Would post", tone: "attention" },
  "posted-today": { label: "Done today", tone: "neutral" },
  pending: { label: "Pending", tone: "active" },
  skipped: { label: "Skipped", tone: "attention" },
  error: { label: "Error", tone: "negative" },
}

export function fundStateBadge(state: GiwaPriceBotFund["state"]): { label: string; tone: Tone } {
  return FUND_STATE[state] ?? { label: state, tone: "neutral" }
}

export type PriceBotRow = {
  productId: string
  symbol: string
  rate: string
  price: string
  posted: string
  state: { label: string; tone: Tone } | null
  /** "→ 1.0015" when the round posted or would post a new price. */
  next: string | null
  detail: string
}

/**
 * One row per fund the bot is set up for: its rate always, and what the last round saw when there is one. Funds are
 * named by the catalog's symbol when the bot has not reported them yet.
 */
export function priceBotRows(status: GiwaPriceBotStatus | null, symbols: Record<string, string>, now: number): PriceBotRow[] {
  if (!status) return []
  const seen = new Map((status.bot?.report?.funds ?? []).map((fund) => [fund.productId, fund]))
  return status.rates.map(({ productId, rateBps }) => {
    const fund = seen.get(productId)
    return {
      productId,
      symbol: fund?.symbol ?? symbols[productId] ?? productId,
      rate: `${rateText(rateBps)} a year`,
      price: botPriceText(fund?.price),
      posted: fund?.postedAt ? agoText(fund.postedAt, now) : "—",
      state: fund ? fundStateBadge(fund.state) : null,
      next: fund?.next && (fund.state === "posted" || fund.state === "would-post" || fund.state === "pending") ? `→ ${botPriceText(fund.next)}` : null,
      detail: fund?.detail ?? "No round yet",
    }
  })
}

/** The bot's own default threshold (server PRICE_BOT_DEFAULTS.lowGasWei), for reports that do not carry one. */
export const PRICE_BOT_LOW_GAS_WEI = 5_000_000_000_000_000n

/**
 * The bot wallet's gas: "0.0042 ETH", and whether it is low. A live bot only (a dry run spends no gas), the way the
 * watcher's price-bot:low-gas alert judges it: the report's own `lowGas`, or below 0.005 ETH for a report from an older
 * bot without one.
 */
export function priceBotGas(report: NonNullable<NonNullable<GiwaPriceBotStatus["bot"]>["report"]> | null | undefined): { text: string; low: boolean } {
  const balance = report?.balanceWei
  const text = gasText(balance)
  if (report?.mode !== "live" || !balance || !/^\d+$/.test(balance)) return { text, low: false }
  if (typeof report.lowGas === "boolean") return { text, low: report.lowGas }
  const threshold = report.lowGasWei && /^\d+$/.test(report.lowGasWei) ? BigInt(report.lowGasWei) : PRICE_BOT_LOW_GAS_WEI
  return { text, low: BigInt(balance) < threshold }
}

export const PRICE_BOT_LOW_GAS_HINT = "Low: send GIWA Sepolia ETH to the bot wallet"

/**
 * Why the connected wallet cannot post a price by hand, in an operator's words. `short` sits under each disabled
 * control; `full` once, by the sign button, keeps the role name for engineers. Wording only: the check is the same.
 */
export function manualPostBlockedText(input: { symbol: string; wallet: string; botPosts: boolean }): { short: string; full: string } {
  const daily = input.botPosts ? `The price bot posts ${input.symbol}'s price every day. ` : ""
  return {
    short: `${daily}Posting by hand needs the admin wallet.`,
    full: `${daily}Posting by hand needs the admin wallet: the connected wallet ${shortAddress(input.wallet)} cannot post to this price feed (it does not hold FEED_ADMIN_ROLE).`,
  }
}
