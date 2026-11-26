// The Portfolio's growth math: the live estimate behind the "Current value" ticker and the "Your potential earnings"
// line chart. Pure: no React, no I/O.
//
// Only what earns grows: `earningUsd` is the part of the value in holdings with an APY (the Net APY is blended over
// those); the rest (a holding without a rate) is carried flat. With everything earning, value = earningUsd.
import { simulateSavings } from "./savings-simulation"
import { addMonths, monthLabel } from "./savings-format"

const YEAR_MS = 365 * 24 * 60 * 60 * 1000

/** Whether a value and rate can grow at all: both known, finite and above zero. */
export function canGrow(value: number | null, apyPercent: number | null): boolean {
  return value !== null && Number.isFinite(value) && value > 0 && apyPercent !== null && Number.isFinite(apyPercent) && apyPercent > 0
}

/**
 * The on-screen estimate `elapsedMs` after `value` was confirmed: its earning part compounding at the APY,
 * `flat + earning × (1 + apy)^(elapsed / year)`. Display only; re-anchored whenever the data refreshes.
 */
export function accruedValue(input: { value: number; earningUsd?: number; apyPercent: number; elapsedMs: number }): number {
  const earning = Math.min(input.value, Math.max(0, input.earningUsd ?? input.value))
  const years = Math.max(0, input.elapsedMs) / YEAR_MS
  return input.value - earning + earning * Math.pow(1 + input.apyPercent / 100, years)
}

/** The chart's horizons, each 13 points (today + 12 steps); the first is the default. */
export const PROJECTION_RANGES = [
  { id: "3Y", years: 3, stepMonths: 3 },
  { id: "5Y", years: 5, stepMonths: 5 },
  { id: "10Y", years: 10, stepMonths: 10 },
] as const
export type ProjectionRange = (typeof PROJECTION_RANGES)[number]["id"]

export type ProjectionBar = Readonly<{
  /** Months from today (0 = today). */
  month: number
  /** "Today", then the month: "Nov 2027". */
  label: string
  /** The projected value then. */
  value: number
  /** Interest projected from today to then (0 today). */
  projectedInterest: number
}>

/**
 * "What if": the wallet's idle coins (the "Not earning" group, portfolio-idle.ts) deposited today, each earning the
 * rate of its Savings account. They are not part of the value, so only the interest they would earn is added: the
 * what-if line starts with the projection and the gap between them is that extra interest (prices held flat). It applies
 * from `WHAT_IF_MIN_USD` of such coins in all (dust does not count).
 */
export type IdleEarning = Readonly<{ usd: number; apyPercent: number }>
export type WhatIf = Readonly<{ assets: readonly IdleEarning[]; totalUsd: number }>
export const WHAT_IF_MIN_USD = 1

/** The what-if when it applies (coins with a known rate above 0 worth $1 or more in all), else null. */
export function whatIfOf(assets: readonly IdleEarning[] | null | undefined): WhatIf | null {
  const earning = (assets ?? []).filter((asset) => Number.isFinite(asset.usd) && asset.usd > 0 && Number.isFinite(asset.apyPercent) && asset.apyPercent > 0)
  const totalUsd = earning.reduce((sum, asset) => sum + asset.usd, 0)
  return totalUsd >= WHAT_IF_MIN_USD ? { assets: earning, totalUsd } : null
}

type ProjectionInput = {
  value: number | null
  earningUsd?: number
  apyPercent: number | null
  range: ProjectionRange
  today: Date
  /** Adds the interest the idle coins would earn in Savings (the what-if line). */
  whatIf?: WhatIf | null
}

/** `usd` month by month, compounding daily at `apyPercent` (the Savings simulation's model); flat without a rate. */
function growth(usd: number, apyPercent: number, years: number): (month: number) => number {
  if (!(usd > 0) || !(apyPercent > 0)) return () => Math.max(0, usd)
  const points = simulateSavings({ apyPercent, startingBalance: usd, initialDeposit: 0, recurringDeposit: 0, frequency: "monthly", years })
  return (month) => (month === 0 ? usd : points[month]?.balance ?? usd)
}

/**
 * The projected value every month from today to the range's horizon: the earning part compounding daily at today's
 * APY with nothing added or withdrawn, the rest carried flat; with `whatIf`, plus the interest the idle coins would earn
 * in Savings. The line chart draws it. Empty when it cannot grow.
 */
export function projectMonths(input: ProjectionInput): ProjectionBar[] {
  if (!canGrow(input.value, input.apyPercent)) return []
  const value = input.value as number
  const earning = Math.min(value, Math.max(0, input.earningUsd ?? value))
  const { years } = PROJECTION_RANGES.find((range) => range.id === input.range) ?? PROJECTION_RANGES[0]
  const earningAt = growth(earning, input.apyPercent as number, years)
  const idle = (input.whatIf?.assets ?? []).map((asset) => ({ usd: asset.usd, at: growth(asset.usd, asset.apyPercent, years) }))
  const months: ProjectionBar[] = []
  for (let month = 0; month <= years * 12; month += 1) {
    const interest = earningAt(month) - earning + idle.reduce((sum, asset) => sum + asset.at(month) - asset.usd, 0)
    months.push({
      month,
      label: month === 0 ? "Today" : monthLabel(addMonths(input.today, month)),
      value: value + interest,
      projectedInterest: Math.max(0, interest),
    })
  }
  return months
}

/**
 * Thirteen points from today to the range's horizon (3Y every 3 months, 5Y every 5, 10Y every 10), taken from
 * `projectMonths`: the points on the chart that can be pointed at. Empty when it cannot grow.
 */
export function projectEarnings(input: ProjectionInput): ProjectionBar[] {
  const { stepMonths } = PROJECTION_RANGES.find((range) => range.id === input.range) ?? PROJECTION_RANGES[0]
  return projectMonths(input).filter((point) => point.month % stepMonths === 0)
}
