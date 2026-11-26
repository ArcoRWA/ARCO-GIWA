import assert from "node:assert/strict"
import test from "node:test"
import { AXIS_PAD_ABOVE, AXIS_PAD_BELOW, BALANCED_MIN_RISE_SHARE, chartAxis, COMPRESSED_RISE_SHARE, PLOT_BOTTOM_PAD_SHARE, PLOT_TOP_PAD_SHARE, plotLayout, yearGridMonths, yearTicks } from "./portfolio-chart-axis"
import { usdCompact } from "./savings-format"

const TODAY = new Date(2026, 10, 26)

test("the axis starts a little below Supplied, never at zero, and ends a little above the highest value", () => {
  const axis = chartAxis(12_000, [12_412.36, 13_000, 13_946.11])
  const span = 13_946.11 - 12_000
  assert.ok(Math.abs(axis.min - (12_000 - span * AXIS_PAD_BELOW)) < 1e-9)
  assert.ok(Math.abs(axis.max - (13_946.11 + span * AXIS_PAD_ABOVE)) < 1e-9)
  assert.ok(axis.min > 0)
  // A steep line on a small balance: the axis stops at half the lowest value, never zero.
  const steep = chartAxis(10, [10, 200])
  assert.equal(steep.min, 5)
  // The what-if line (here the highest) is taken in.
  assert.ok(Math.abs(chartAxis(386_646.61, [386_659.47, 390_230.65, 430_381.62]).max - (430_381.62 + (430_381.62 - 386_646.61) * AXIS_PAD_ABOVE)) < 1e-6)
  // A value below Supplied (a loss) moves the foot down to it.
  assert.ok(chartAxis(1_000, [950, 990]).min < 950)
  // Flat: still a span to draw in.
  const flat = chartAxis(500, [500, 500])
  assert.ok(flat.max > 500 && flat.min > 0 && flat.min < 500)
  // The compact formatter keeps its 2-decimal default.
  assert.equal(usdCompact(28_530_000), "$28.53M")
})

test("x labels: Today, then every year (3Y, 5Y) or every second year (10Y), the last named by its month", () => {
  assert.deepEqual(yearTicks("3Y", TODAY), [{ month: 0, label: "Today" }, { month: 12, label: "2027" }, { month: 24, label: "2028" }, { month: 36, label: "Nov 2029" }])
  assert.deepEqual(yearTicks("5Y", TODAY).map((tick) => tick.label), ["Today", "2027", "2028", "2029", "2030", "Nov 2031"])
  assert.deepEqual(yearTicks("10Y", TODAY).map((tick) => tick.label), ["Today", "2028", "2030", "2032", "2034", "Nov 2036"])
})

test("vertical gridlines: Today and every year boundary", () => {
  assert.deepEqual(yearGridMonths("3Y"), [0, 12, 24, 36])
  assert.equal(yearGridMonths("5Y").length, 6)
  assert.deepEqual(yearGridMonths("10Y"), [0, 12, 24, 36, 48, 60, 72, 84, 96, 108, 120])
})

test("balanced drawing: true scale while the projected line rises enough, else only the what-if gap is compressed", () => {
  assert.equal(BALANCED_MIN_RISE_SHARE, 0.35)
  assert.equal(COMPRESSED_RISE_SHARE, 0.4)
  assert.ok(Math.abs(PLOT_TOP_PAD_SHARE - 0.1 / 1.22) < 1e-12 && Math.abs(PLOT_BOTTOM_PAD_SHARE - 0.12 / 1.22) < 1e-12)
  const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`)
  const line = [1_000, 1_050, 1_100]
  // True scale: exactly the one-axis mapping (both lines on chartAxis).
  for (const whatIf of [null, [1_000, 1_060, 1_120], line]) {
    const layout = plotLayout(1_000, line, whatIf)
    const axis = chartAxis(1_000, [...line, ...(whatIf ?? [])])
    assert.equal(layout.scale, "true")
    assert.deepEqual(layout.projected, line.map((v) => (v - axis.min) / (axis.max - axis.min)))
    assert.deepEqual(layout.whatIf, whatIf?.map((v) => (v - axis.min) / (axis.max - axis.min)) ?? null)
  }
  // The rule: the line's rise at true scale is 100 / (1.22 × (100 + extra)), 35% at extra ≈ 134.19.
  const edge = 100 / (1.22 * BALANCED_MIN_RISE_SHARE) - 100
  assert.equal(plotLayout(1_000, line, [1_000, 1_050 + (edge - 0.01) / 2, 1_100 + edge - 0.01]).scale, "true")
  assert.equal(plotLayout(1_000, line, [1_000, 1_050 + (edge + 0.01) / 2, 1_100 + edge + 0.01]).scale, "compressed")
  // Compressed: Today at the bottom padding, the line rising its share, the what-if end at the top padding, the gap
  // linear in the extra interest and never below the line.
  const big = plotLayout(1_000, line, [1_000, 6_000, 11_100])
  assert.equal(big.scale, "compressed")
  close(big.projected[0]!, PLOT_BOTTOM_PAD_SHARE)
  close(big.projected[2]! - big.projected[0]!, COMPRESSED_RISE_SHARE)
  close(big.projected[1]! - big.projected[0]!, COMPRESSED_RISE_SHARE / 2)
  close(big.whatIf![2]!, 1 - PLOT_TOP_PAD_SHARE)
  close(big.whatIf![0]!, big.projected[0]!)
  close((big.whatIf![1]! - big.projected[1]!) / (big.whatIf![2]! - big.projected[2]!), 4_950 / 10_000)
  assert.ok(big.whatIf!.every((h, i) => h >= big.projected[i]!))
  // A line that rises little only because the value is far above Supplied, with a small what-if: the line takes its
  // share, but the gap is never drawn larger than true scale (so not "compressed").
  const smallGap = plotLayout(500, line, [1_000, 1_051, 1_102])
  assert.equal(smallGap.scale, "true")
  close(smallGap.whatIf![2]! - smallGap.projected[2]!, 2 * (COMPRESSED_RISE_SHARE / 100))
  assert.ok(smallGap.whatIf![2]! < 1 - PLOT_TOP_PAD_SHARE)
})
