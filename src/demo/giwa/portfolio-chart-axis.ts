// The "Your potential earnings" line chart's axes. Pure: no React, no I/O.
//
// Interest is a few percent of the balance a year, so a vertical axis from zero would draw a flat line. The axis starts
// a little below the baseline (what was supplied, or today's value when that is not known) and ends a little above the
// highest value plotted (the what-if line included), unless the what-if dwarfs the projection (plotLayout). The vertical axis has no labels or gridlines; the
// horizontal one names Today, the years in between and the end month.
import { addMonths, monthLabel } from "./savings-format"
import { PROJECTION_RANGES, type ProjectionRange } from "./portfolio-projection"

/** Room below the lowest value and above the highest, as a share of the span between them. */
export const AXIS_PAD_BELOW = 0.12
export const AXIS_PAD_ABOVE = 0.1

export type ChartAxis = Readonly<{
  /** The axis' bottom and top values. */
  min: number
  max: number
}>

/** The vertical axis for a baseline and every value plotted. Never from zero while the baseline is above it. */
export function chartAxis(base: number, values: readonly number[]): ChartAxis {
  const all = [base, ...values].filter((value) => Number.isFinite(value))
  const lo = all.length ? Math.min(...all) : 0
  const hi = all.length ? Math.max(...all) : 0
  // A flat chart still gets a span to draw in: 1% of the value (at least a cent) above it.
  const top = hi > lo ? hi : lo + Math.max(Math.abs(lo) * 0.01, 0.01)
  const span = top - lo
  // Never below half the lowest value, so a steep line on a small balance does not take the axis to zero.
  const min = lo > 0 ? Math.max(lo - span * AXIS_PAD_BELOW, lo / 2) : lo - span * AXIS_PAD_BELOW
  return { min, max: top + span * AXIS_PAD_ABOVE }
}

/**
 * Balanced drawing. The plot has no y labels, so when the what-if dwarfs the projection the gap between the two lines is
 * compressed (never the projected line itself) to keep both readable:
 * - True scale (one axis for both lines, `chartAxis`) is kept whenever the projected line's rise from Today to the end is
 *   at least `BALANCED_MIN_RISE_SHARE` of the plot height (the what-if end, the highest value, then sits at the top).
 * - Otherwise Today sits at `PLOT_BOTTOM_PAD_SHARE`, the projected line rises `COMPRESSED_RISE_SHARE` of the plot to the
 *   end, and the what-if is drawn `extra(t) × k` above it, where k is the projected line's px-per-dollar reduced (never
 *   raised) so the what-if end lands at the top, `PLOT_TOP_PAD_SHARE` below it. The gap scales linearly with the extra
 *   interest, so the dashed line keeps its shape and starts with the solid one at Today.
 */
export const BALANCED_MIN_RISE_SHARE = 0.35
export const COMPRESSED_RISE_SHARE = 0.4
/** The room above the highest value and below Today in compressed mode: the same shares the axis padding gives. */
export const PLOT_TOP_PAD_SHARE = AXIS_PAD_ABOVE / (1 + AXIS_PAD_ABOVE + AXIS_PAD_BELOW)
export const PLOT_BOTTOM_PAD_SHARE = AXIS_PAD_BELOW / (1 + AXIS_PAD_ABOVE + AXIS_PAD_BELOW)

export type PlotLayout = Readonly<{
  /** Each projected value's height in the plot: 0 = the plot's bottom, 1 = its top. */
  projected: readonly number[]
  /** The what-if's heights, never below the projected ones; null without a what-if. */
  whatIf: readonly number[] | null
  /** "compressed" when the what-if gap is drawn closer than true scale. */
  scale: "true" | "compressed"
}>

/** The heights of the projected line and the what-if (month by month, same length) in the plot; see above. */
export function plotLayout(base: number, projected: readonly number[], whatIf: readonly number[] | null): PlotLayout {
  const axis = chartAxis(base, [...projected, ...(whatIf ?? [])])
  const at = (value: number) => (value - axis.min) / (axis.max - axis.min || 1)
  const trueScale: PlotLayout = { projected: projected.map(at), whatIf: whatIf?.map(at) ?? null, scale: "true" }
  const today = projected[0]
  const end = projected[projected.length - 1]
  const whatIfEnd = whatIf?.[whatIf.length - 1]
  if (!whatIf || today === undefined || end === undefined || whatIfEnd === undefined || !(end > today)) return trueScale
  if (at(end) - at(today) >= BALANCED_MIN_RISE_SHARE) return trueScale
  const perDollar = COMPRESSED_RISE_SHARE / (end - today)
  const line = projected.map((value) => PLOT_BOTTOM_PAD_SHARE + (value - today) * perDollar)
  const extraEnd = Math.max(0, whatIfEnd - end)
  const room = 1 - PLOT_TOP_PAD_SHARE - line[line.length - 1]!
  const gapPerDollar = extraEnd > 0 ? Math.min(perDollar, room / extraEnd) : perDollar
  return {
    projected: line,
    whatIf: whatIf.map((value, index) => line[index]! + Math.max(0, value - projected[index]!) * gapPerDollar),
    scale: gapPerDollar < perDollar ? "compressed" : "true",
  }
}

export type YearTick = Readonly<{ month: number; label: string }>

/**
 * The horizontal axis: "Today", then a year every 12 months (every 24 for 10Y), named by the year it falls in; the last
 * (the range's end) is named by its month: "Nov 2029".
 */
export function yearTicks(range: ProjectionRange, today: Date): YearTick[] {
  const { years } = PROJECTION_RANGES.find((option) => option.id === range) ?? PROJECTION_RANGES[0]
  const step = years > 5 ? 24 : 12
  const end = years * 12
  const ticks: YearTick[] = [{ month: 0, label: "Today" }]
  for (let month = step; month <= end; month += step) {
    const date = addMonths(today, month)
    ticks.push({ month, label: month === end ? monthLabel(date) : String(date.getFullYear()) })
  }
  return ticks
}

/** The faint vertical gridlines: Today and every year boundary to the end of the range (months from today). */
export function yearGridMonths(range: ProjectionRange): number[] {
  const { years } = PROJECTION_RANGES.find((option) => option.id === range) ?? PROJECTION_RANGES[0]
  return Array.from({ length: years + 1 }, (_, index) => index * 12)
}
