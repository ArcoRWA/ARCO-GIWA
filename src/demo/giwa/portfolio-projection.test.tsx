import assert from "node:assert/strict"
import test from "node:test"
import { accruedValue, canGrow, PROJECTION_RANGES, projectEarnings, projectMonths, whatIfOf } from "./portfolio-projection"

const YEAR = 365 * 24 * 60 * 60 * 1000
const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`)
const TODAY = new Date(2026, 10, 26)

test("the ticker's value compounds the earning part at the APY from when it was read, the rest flat", () => {
  close(accruedValue({ value: 1000, apyPercent: 5, elapsedMs: 0 }), 1000)
  close(accruedValue({ value: 1000, apyPercent: 5, elapsedMs: YEAR }), 1050)
  close(accruedValue({ value: 1000, apyPercent: 5, elapsedMs: YEAR / 2 }), 1000 * Math.sqrt(1.05))
  // 200 of the 1000 is ArcoUSD (no rate): only 800 grows.
  close(accruedValue({ value: 1000, earningUsd: 800, apyPercent: 5, elapsedMs: YEAR }), 1040)
  close(accruedValue({ value: 1000, apyPercent: 5, elapsedMs: -5 }), 1000, 1e-12)
  // A second at 4% on $12,412: about 1.6e-5 dollars, which the three extra digits show moving.
  const perSecond = accruedValue({ value: 12_412.36, apyPercent: 4.12, elapsedMs: 1000 }) - 12_412.36
  assert.ok(perSecond > 1e-5 && perSecond < 2e-5, String(perSecond))
})

test("nothing grows without a known positive value and rate", () => {
  assert.equal(canGrow(100, 4), true)
  for (const [value, apy] of [[null, 4], [100, null], [0, 4], [100, 0], [100, -1], [Number.NaN, 4]] as const) assert.equal(canGrow(value, apy), false)
  assert.deepEqual(projectEarnings({ value: null, apyPercent: 4, range: "3Y", today: TODAY }), [])
  assert.deepEqual(projectEarnings({ value: 100, apyPercent: null, range: "3Y", today: TODAY }), [])
})

test("the ranges are 3Y, 5Y and 10Y, 3Y first (the default); no 1Y", () => {
  assert.deepEqual(PROJECTION_RANGES.map((range) => range.id), ["3Y", "5Y", "10Y"])
})

test("13 bars: 3Y every 3 months, 5Y every 5, 10Y every 10; today first with no projected interest", () => {
  for (const [range, step, end] of [["3Y", 3, "Nov 2029"], ["5Y", 5, "Nov 2031"], ["10Y", 10, "Nov 2036"]] as const) {
    const bars = projectEarnings({ value: 12_412.36, apyPercent: 4.12, range, today: TODAY })
    assert.equal(bars.length, 13, range)
    assert.deepEqual(bars.map((bar) => bar.month), Array.from({ length: 13 }, (_, i) => i * step))
    assert.equal(bars[0]!.label, "Today")
    assert.equal(bars[0]!.projectedInterest, 0)
    close(bars[0]!.value, 12_412.36)
    assert.equal(bars[12]!.label, end)
    // Every later bar is a month and a year, and no two bars share one (unambiguous over ten years).
    for (const bar of bars.slice(1)) assert.match(bar.label, /^[A-Z][a-z]{2} \d{4}$/)
    assert.equal(new Set(bars.map((bar) => bar.label)).size, 13)
    for (let i = 1; i < bars.length; i++) assert.ok(bars[i]!.projectedInterest > bars[i - 1]!.projectedInterest)
  }
  const threeYears = projectEarnings({ value: 12_412.36, apyPercent: 4.12, range: "3Y", today: TODAY })
  assert.equal(threeYears[1]!.label, "Feb 2027")
  // Daily compounding over whole years grows by exactly the APY each year.
  close(threeYears[12]!.value, 12_412.36 * 1.0412 ** 3, 1e-6)
  const tenYears = projectEarnings({ value: 12_412.36, apyPercent: 4.12, range: "10Y", today: TODAY })
  assert.equal(tenYears[1]!.label, "Sep 2027")
  close(tenYears[12]!.value, 12_412.36 * 1.0412 ** 10, 1e-5)
})

test("the flat part (a holding without a rate) is carried, not grown", () => {
  const bars = projectEarnings({ value: 1000, earningUsd: 600, apyPercent: 10, range: "3Y", today: TODAY })
  close(bars[12]!.projectedInterest, 600 * (1.1 ** 3 - 1))
  close(bars[12]!.value, 400 + 600 * 1.1 ** 3)
})

test("the line is drawn month by month; its 13 points are every step of the range", () => {
  const months = projectMonths({ value: 1000, apyPercent: 5, range: "5Y", today: TODAY })
  assert.equal(months.length, 61)
  assert.deepEqual(projectEarnings({ value: 1000, apyPercent: 5, range: "5Y", today: TODAY }), months.filter((m) => m.month % 5 === 0))
})

test("what-if: adds the interest idle coins would earn at their Savings rates; starts with the projection", () => {
  const input = { value: 1000, earningUsd: 600, apyPercent: 10, range: "3Y", today: TODAY } as const
  const base = projectEarnings(input)
  const whatIf = projectEarnings({ ...input, whatIf: whatIfOf([{ usd: 400, apyPercent: 5 }, { usd: 200, apyPercent: 2 }]) })
  close(whatIf[0]!.value, base[0]!.value)
  // Their principal is not added: only 400 × (1.05³ − 1) + 200 × (1.02³ − 1) on top of the projection.
  close(whatIf[12]!.value - base[12]!.value, 400 * (1.05 ** 3 - 1) + 200 * (1.02 ** 3 - 1))
  close(whatIf[12]!.projectedInterest, base[12]!.projectedInterest + 400 * (1.05 ** 3 - 1) + 200 * (1.02 ** 3 - 1))
  for (let i = 1; i < 13; i++) assert.ok(whatIf[i]!.value > base[i]!.value)
  // No idle coins: no difference.
  assert.deepEqual(projectEarnings({ ...input, whatIf: whatIfOf([]) }), base)
})

test("what-if condition: coins with a known rate above 0 worth $1 or more in all", () => {
  assert.deepEqual(whatIfOf([{ usd: 0.6, apyPercent: 5 }, { usd: 0.5, apyPercent: 2 }]), { assets: [{ usd: 0.6, apyPercent: 5 }, { usd: 0.5, apyPercent: 2 }], totalUsd: 1.1 })
  assert.equal(whatIfOf([{ usd: 0.6, apyPercent: 5 }, { usd: 0.3, apyPercent: 2 }]), null, "dust")
  assert.equal(whatIfOf([{ usd: 100, apyPercent: 0 }]), null)
  assert.equal(whatIfOf([{ usd: 100, apyPercent: Number.NaN }]), null)
  assert.equal(whatIfOf(null), null)
  // A coin with no rate is left out of the sum.
  assert.deepEqual(whatIfOf([{ usd: 100, apyPercent: 0 }, { usd: 5, apyPercent: 3 }]), { assets: [{ usd: 5, apyPercent: 3 }], totalUsd: 5 })
})
