// The Portfolio Activity tab's view logic (look "V3": summary + feed). Pure: no React, no I/O.
//
// Summary: Deposited · Withdrawn · Net supplied. Net supplied IS the hero's Supplied (principalTotals over the current
// holdings, portfolio-principal.ts); Deposited is the deposits behind it from the same records (`totals.deposited`:
// the same holdings, asset units × today's price), and Withdrawn is what closes the gap, rounded to the cent first so
// the three figures on screen always add up (Deposited − Withdrawn = Net supplied).
// So the summary counts exactly what the hero counts:
//   • holdings held now whose principal is known (unknown ones are left out, with the hero's "Partial" note);
//   • not closed positions: the feed lists their rows, the totals do not (a note says so);
//   • idle coins (ArcoUSD and the other "Not earning" assets) are outside both, as they are outside the hero.
// Feed rows are valued the same way: asset units moved × today's price of one unit.
import type { ActivityDirection, ActivityRow } from "./activity-feed"
import { ARCOGOLD_HOLDING, SARCOUSD_HOLDING } from "./activity-feed"
import type { GiwaMarketEntry } from "./api"

export type ActivityFilter = "all" | "deposits" | "withdrawals"

export const ACTIVITY_FILTERS: readonly { id: ActivityFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "deposits", label: "Deposits" },
  { id: "withdrawals", label: "Withdrawals" },
]

const FILTER_DIRECTIONS: Record<ActivityFilter, readonly ActivityDirection[]> = {
  all: ["in", "out", "pending"],
  deposits: ["in"],
  // A redemption request that is not paid yet is a withdrawal on its way.
  withdrawals: ["out", "pending"],
}

export function filterActivity(rows: readonly ActivityRow[], filter: ActivityFilter): ActivityRow[] {
  return rows.filter((row) => FILTER_DIRECTIONS[filter].includes(row.direction))
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

export type ActivityDay = Readonly<{ key: string; label: string; rows: readonly ActivityRow[] }>

/** "Nov 19, 2026" (UTC, as the block timestamps are), or "Date unknown". */
export function activityDayLabel(ts: number): string {
  if (!(ts > 0)) return "Date unknown"
  const date = new Date(ts)
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`
}

/** "14:38 UTC", or null when the time is unknown. */
export function activityTimeLabel(ts: number): string | null {
  if (!(ts > 0)) return null
  return `${new Date(ts).toISOString().slice(11, 16)} UTC`
}

/** Rows (already newest first) grouped by their UTC day, in order; undated rows last, under "Date unknown". */
export function groupActivityByDay(rows: readonly ActivityRow[]): ActivityDay[] {
  const days: { key: string; label: string; rows: ActivityRow[] }[] = []
  const ordered = [...rows].sort((a, b) => b.sortTs - a.sortTs)
  for (const row of ordered) {
    const key = row.sortTs > 0 ? new Date(row.sortTs).toISOString().slice(0, 10) : "unknown"
    const last = days[days.length - 1]
    if (last && last.key === key) last.rows.push(row)
    else days.push({ key, label: activityDayLabel(row.sortTs), rows: [row] })
  }
  return days
}

/** Today's dollars for one unit of a holding's asset, or null without a price. */
export type AssetUsdOf = (holding: string | null) => number | null

/**
 * The prices the Activity tab values rows at, the ones Supplied uses: a catalog product's payment asset at
 * navUsd / navBase, sArcoUSD's ArcoUSD at a dollar (while Savings is live), ArcoGOLD's ounce at the gold read's price.
 */
export function activityAssetUsd(input: {
  market: ReadonlyMap<string, GiwaMarketEntry>
  sArcoUsdLive: boolean
  ounceUsd: number | null
}): AssetUsdOf {
  return (holding) => {
    if (holding === null) return null
    if (holding === SARCOUSD_HOLDING) return input.sArcoUsdLive ? 1 : null
    if (holding === ARCOGOLD_HOLDING) return positivePrice(input.ounceUsd)
    const entry = input.market.get(holding)
    const navUsd = entry?.navUsd ?? null
    const navBase = entry?.navBase ?? null
    return navUsd != null && navBase != null && navBase > 0 ? positivePrice(navUsd / navBase) : null
  }
}

function positivePrice(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value > 0 ? value : null
}

/** A row's signed dollars at today's price: + into a product, − out of it (a pending redemption too); null unknown. */
export function activityUsd(row: ActivityRow, assetUsdOf: AssetUsdOf): number | null {
  const price = assetUsdOf(row.holding)
  if (row.assetUnits === null || price === null) return null
  return (row.direction === "in" ? 1 : -1) * row.assetUnits * price
}

const cents = (n: number) => Math.round(n * 100) / 100

export type ActivitySummary = Readonly<{ deposited: number; withdrawn: number; netSupplied: number }>

/**
 * The summary from the hero's own totals: Net supplied = `supplied` (the hero's Supplied), Deposited = `deposited`,
 * Withdrawn = Deposited − Net supplied, all to the cent so the figures shown add up exactly.
 */
export function activitySummary(totals: { supplied: number; deposited: number }): ActivitySummary {
  const netSupplied = cents(totals.supplied)
  const deposited = Math.max(cents(totals.deposited), netSupplied)
  return { deposited, withdrawn: cents(deposited - netSupplied), netSupplied }
}
