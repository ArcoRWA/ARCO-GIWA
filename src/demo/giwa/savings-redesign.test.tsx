// The Savings page redesign: the pure rules (simulation, treemap, backing, amounts, wording) and the static markup of
// its sections. The full-screen deposit / withdraw flow is portalled, so its rules are tested through savings-transfer.

import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import { AllocationTreemap, BackingCard, cardPlacement, sliceValue } from "./AllocationTreemap"
import type { SavingsAccount } from "./savings"
import { RollingDigits } from "./RollingDigits"
import { SavingsAccordion } from "./SavingsAccordion"
import { BackingBar, BackingBreakdown, barOrder, LiquidityBreakdown } from "./SavingsBreakdown"
import { goldLiquidity, liquiditySlices, singleCoinLiquidity, stablecoinLiquidity } from "./savings-liquidity"
import { SAVINGS_BACKING, SAVINGS_POWERED_BY, reserveAssetLabel, savingsBacking, savingsDepositLabel, savingsExposure } from "./savings-backing"
import {
  balanceParts,
  groupDigits,
  horizonLong,
  horizonShort,
  monthLabel,
  rollingAmount,
  rollingDecimals,
  tokenAmount,
  usd,
  usdCompact,
} from "./savings-format"
import { HeroOrbits, heroApyText, heroHeadline, SavingsHeroCard, savingsHeroTone, type SavingsHeroProps } from "./SavingsHeroCard"
import { PortfolioHero } from "./PortfolioHero"
import { vaultImageFor } from "./catalog"
import { paymentAssetIcon } from "./components"
import { niceTicks, simulateSavings } from "./savings-simulation"
import { SavingsSimulation } from "./SavingsSimulation"
import { apyChangeLabel, SavingsStatsRow, sparklinePath, sparklinePointAt } from "./SavingsStatsRow"
import { SavingsTabs, savingsApyRange, savingsApyRangeShort, savingsGoldMarks } from "./SavingsTabs"
import {
  amountForPercent,
  exceedsBalance,
  operationMatchesMode,
  pendingWithdrawals,
  percentOfBalance,
  redemptionTimelineText,
  sanitizeAmountInput,
  transferCta,
} from "./savings-transfer"
import { squarify } from "./savings-treemap"
import type { GiwaRedemption } from "./types"
import { easeOutCubic, rollingValue } from "./useRollingNumber"

const near = (actual: number, expected: number, tolerance = 0.01) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`)

// ── simulation ────────────────────────────────────────────────────────────

test("simulation: one point per month for five years, deposits counted per frequency", () => {
  const base = { apyPercent: 0, startingBalance: 0, initialDeposit: 1000, recurringDeposit: 500 }
  const monthly = simulateSavings({ ...base, frequency: "monthly" })
  assert.equal(monthly.length, 61)
  assert.deepEqual([monthly[0]!.month, monthly[60]!.month], [0, 60])
  assert.equal(monthly[60]!.contributed, 1000 + 500 * 60)
  assert.equal(simulateSavings({ ...base, frequency: "weekly" })[60]!.contributed, 1000 + 500 * 260)
  assert.equal(simulateSavings({ ...base, frequency: "daily" })[60]!.contributed, 1000 + 500 * 1825)
  // At 0% nothing is earned and the balance is what went in.
  assert.equal(monthly[60]!.earned, 0)
  assert.equal(monthly[60]!.balance, monthly[60]!.contributed)
})

test("simulation: a lump sum grows by exactly the APY each year", () => {
  const points = simulateSavings({ apyPercent: 3.8, startingBalance: 0, initialDeposit: 1000, recurringDeposit: 0, frequency: "monthly" })
  near(points[12]!.balance, 1038)
  near(points[60]!.earned, 1000 * (1.038 ** 5 - 1))
})

test("simulation: a balance already held earns too and counts as put in", () => {
  const withBalance = simulateSavings({ apyPercent: 3.8, startingBalance: 18_750, initialDeposit: 1000, recurringDeposit: 0, frequency: "monthly" })
  near(withBalance[60]!.earned, 19_750 * (1.038 ** 5 - 1))
  assert.equal(withBalance[0]!.contributed, 19_750)
})

test("simulation: monthly deposits earn less than the same amount deposited on day one", () => {
  const recurring = simulateSavings({ apyPercent: 5, startingBalance: 0, initialDeposit: 0, recurringDeposit: 100, frequency: "monthly" })[60]!
  const lump = simulateSavings({ apyPercent: 5, startingBalance: 0, initialDeposit: 6000, recurringDeposit: 0, frequency: "monthly" })[60]!
  assert.ok(recurring.earned > 0 && recurring.earned < lump.earned)
})

test("niceTicks: round steps from 0 past the top", () => {
  assert.deepEqual(niceTicks(7180, 8), [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000])
  assert.deepEqual(niceTicks(3131, 6), [0, 1000, 2000, 3000, 4000])
  assert.deepEqual(niceTicks(0), [0])
})

// ── treemap ───────────────────────────────────────────────────────────────

test("squarify: tiles cover the box, sized by value, larger first", () => {
  const items = SAVINGS_BACKING.map((slice) => ({ id: slice.id, value: slice.percent }))
  for (const aspect of [2.4, 0.75]) {
    const tiles = squarify(items, aspect)
    assert.equal(tiles.length, 5)
    near(tiles.reduce((sum, tile) => sum + tile.w * tile.h, 0), 1, 1e-9)
    for (const tile of tiles) {
      const value = items.find((item) => item.id === tile.id)!.value
      near(tile.w * tile.h, value / 100, 1e-9)
      assert.ok(tile.x >= -1e-9 && tile.y >= -1e-9 && tile.x + tile.w <= 1 + 1e-9 && tile.y + tile.h <= 1 + 1e-9)
    }
    // No two tiles overlap.
    for (const a of tiles) {
      for (const b of tiles) {
        if (a === b) continue
        const overlapW = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
        const overlapH = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
        assert.ok(overlapW <= 1e-9 || overlapH <= 1e-9, `${a.id} overlaps ${b.id}`)
      }
    }
  }
  // Wide box: the largest slice is a full-height column on the left.
  const wide = squarify(items, 2.4)[0]!
  assert.equal(wide.id, "fidelity")
  near(wide.x, 0, 1e-9)
  near(wide.h, 1, 1e-9)
})

test("squarify: nothing to lay out gives no tiles; non-positive values are skipped", () => {
  assert.deepEqual(squarify([], 2), [])
  assert.deepEqual(squarify([{ id: "a", value: 0 }], 2), [])
  assert.deepEqual(squarify([{ id: "a", value: 1 }, { id: "b", value: -1 }], 2).map((tile) => tile.id), ["a"])
})

// ── backing ───────────────────────────────────────────────────────────────

test("backing: the published allocation adds up to 100 and names its three managers", () => {
  assert.equal(SAVINGS_BACKING.reduce((sum, slice) => sum + slice.percent, 0), 100)
  assert.deepEqual(
    SAVINGS_BACKING.map((slice) => [slice.label, slice.percent]),
    [["Fidelity", 40], ["UBS", 20], ["Franklin Templeton", 10], ["Crypto & RWA-backed loans", 20], ["Instant liquidity reserve", 10]],
  )
  assert.deepEqual(SAVINGS_POWERED_BY.map((mark) => mark.name), ["Fidelity", "Franklin Templeton", "UBS", "Morpho"])
  // Every logo file is in public/, so none falls back to its initial.
  for (const mark of SAVINGS_POWERED_BY) assert.ok(existsSync(new URL(`../../../public${mark.logo}`, import.meta.url)), mark.logo)
})

test("exposure: the backing grouped by asset type, the reserve in the vault's own coin", () => {
  assert.deepEqual(
    savingsExposure("tUSDC").map((slice) => [slice.label, slice.percent]),
    [["U.S. Treasury & money market funds", 70], ["Crypto & RWA-backed loans", 20], ["USDC instant reserve", 10]],
  )
  assert.equal(savingsExposure("tWETH")[2]!.label, "ETH instant reserve")
  assert.deepEqual(["tUSDC", "tWETH", "tXRP", "tBTC", "USDC"].map(reserveAssetLabel), ["USDC", "ETH", "XRP", "BTC", "USDC"])
})

test("deposit label: the stablecoin account invites Stablecoins, the gold account Gold, the others their coin", () => {
  assert.deepEqual(["tUSDC", "USDC", "tWETH", "tXRP"].map(savingsDepositLabel), ["Stablecoins", "Stablecoins", "ETH", "XRP"])
  assert.deepEqual(["tPAXG", "PAXG", "tXAUT", "XAUT"].map(savingsDepositLabel), ["Gold", "Gold", "Gold", "Gold"])
})

test("gold icons: ArcoGOLD's token mark, and PAXG / XAUT (and their test coins) with their own marks", () => {
  assert.equal(vaultImageFor({ productId: "arcogold", vaultConfig: null }), "/logos/arcogold.png")
  assert.deepEqual(["PAXG", "tPAXG", "XAUT", "tXAUT"].map(paymentAssetIcon), ["/logos/paxg.png", "/logos/paxg.png", "/logos/xaut.png", "/logos/xaut.png"])
  for (const file of ["arcogold.png", "paxg.png", "xaut.png"]) assert.ok(existsSync(new URL(`../../../public/logos/${file}`, import.meta.url)), file)
  // The other coins keep theirs.
  assert.equal(paymentAssetIcon("tBTC"), "/logos/bitcoin.svg")
  assert.equal(paymentAssetIcon("tDOGE"), undefined)
})

// ── amounts and the main button ───────────────────────────────────────────

test("amount input: digits and one point, capped decimals, no leading zeros", () => {
  assert.equal(sanitizeAmountInput("00012.345678", 2), "12.34")
  assert.equal(sanitizeAmountInput(".", 6), "0.")
  assert.equal(sanitizeAmountInput("1.2.3", 6), "1.23")
  assert.equal(sanitizeAmountInput("abc", 6), "")
  assert.equal(sanitizeAmountInput("7.", 0), "7")
})

test("amount input: a decimal comma is a decimal point, thousands commas are dropped", () => {
  // Typed on a keypad set to a decimal-comma locale.
  assert.equal(sanitizeAmountInput("1,5", 6), "1.5")
  assert.equal(sanitizeAmountInput("12,34", 6), "12.34")
  assert.equal(sanitizeAmountInput("1,", 6), "1.")
  // Pasted grouped amounts.
  assert.equal(sanitizeAmountInput("1,000", 6), "1000")
  assert.equal(sanitizeAmountInput("1,234,567", 6), "1234567")
  assert.equal(sanitizeAmountInput("1,000.5", 6), "1000.5")
  assert.equal(sanitizeAmountInput(" 2 500 ", 6), "2500")
})

test("withdraw helpers: the hook's operation kind, this product's pending withdrawals, the settlement time", () => {
  assert.equal(operationMatchesMode("deposit", "deposit"), true)
  assert.equal(operationMatchesMode("redeemInstant", "deposit"), false)
  assert.equal(operationMatchesMode("redeemInstant", "withdraw"), true)
  assert.equal(operationMatchesMode("requestRedeem", "withdraw"), true)
  assert.equal(operationMatchesMode("deposit", "withdraw"), false)
  const row = (productId: string, status: string, requestId = "1") =>
    ({ requestId, productId, walletAddress: "0x1", redemptionVaultAddress: "0x2", sharesIn: "1", lockedAssetsOut: "0", status }) as GiwaRedemption
  const rows = [row("arcousd", "REQUESTED", "1"), row("aeth", "REQUESTED", "2"), row("arcousd", "SETTLED", "3"), row("ARCOUSD", "settling", "4")]
  assert.deepEqual(pendingWithdrawals(rows, "arcousd").map((item) => item.requestId), ["1", "4"])
  // A malformed row (no product / status) is skipped rather than breaking the screen.
  assert.deepEqual(pendingWithdrawals([{ requestId: "9" } as unknown as GiwaRedemption, ...rows], "arcousd").length, 2)
  assert.equal(redemptionTimelineText(3), "3 Days")
  assert.equal(redemptionTimelineText(null), "30-90 Business Days")
})

test("percent shortcuts: MAX spends the exact balance, shares are cut, the slider follows the amount", () => {
  assert.equal(amountForPercent("1000.123456", 100, 6), "1000.123456")
  assert.equal(amountForPercent("1000", 25, 6), "250")
  assert.equal(amountForPercent("0.000001", 50, 6), "")
  assert.equal(amountForPercent("--", 50, 6), "")
  assert.equal(amountForPercent("10", 33.33, 18, 4), "3.333")
  assert.equal(percentOfBalance("250", "1000", 6), 25)
  assert.equal(percentOfBalance("2000", "1000", 6), 100)
  assert.equal(percentOfBalance("1", "--", 6), 0)
  assert.equal(exceedsBalance("1000.000001", "1000", 6), true)
  assert.equal(exceedsBalance("1000", "1000", 6), false)
})

test("main button: wallet prerequisites first, then the amount, then Review", () => {
  const base = { amount: "10", balance: "100", decimals: 6, paused: false }
  assert.deepEqual(transferCta({ ...base, phase: "disconnected" }), { label: "Connect Wallet", action: "connect", disabled: false })
  assert.deepEqual(transferCta({ ...base, phase: "wrong-network" }), { label: "Switch to GIWA", action: "switch-network", disabled: false })
  assert.equal(transferCta({ ...base, phase: "missing-gas" }).action, "faucet")
  assert.equal(transferCta({ ...base, phase: "approving" }).disabled, true)
  assert.equal(transferCta({ ...base, phase: "ready", paused: true }).label, "Temporarily unavailable")
  assert.equal(transferCta({ ...base, phase: "ready", amount: "" }).label, "Enter an Amount")
  assert.equal(transferCta({ ...base, phase: "ready", amount: "0" }).label, "Enter an Amount")
  assert.equal(transferCta({ ...base, phase: "ready", amount: "101" }).label, "Insufficient Balance")
  assert.deepEqual(transferCta({ ...base, phase: "allowance-required" }), { label: "Review", action: "review", disabled: false })
  // Until the hook holds this screen's operation, nothing can be reviewed or sent.
  assert.deepEqual(transferCta({ ...base, phase: "ready", synced: false }), { label: "Processing the transaction", action: null, disabled: true })
  assert.equal(transferCta({ ...base, phase: "disconnected", synced: false }).action, "connect")
})

// ── wording ───────────────────────────────────────────────────────────────

test("format: money keeps at most two decimals, the live balance always shows cents and three more digits", () => {
  assert.equal(usd(6975.45), "$6,975.45")
  assert.equal(usd(1000), "$1,000")
  assert.equal(usd(Number.NaN), "—")
  assert.equal(usdCompact(5_200_000_000), "$5.2B")
  assert.equal(usdCompact(2500), "$2.5K")
  assert.equal(usdCompact(0), "$0")
  assert.deepEqual(balanceParts(19750.0330699), { whole: "$19,750", cents: ".03", tail: "306" })
  assert.deepEqual(balanceParts(0), { whole: "$0", cents: ".00", tail: "000" })
  assert.equal(tokenAmount(999.80003999), "999.8")
  assert.deepEqual([horizonShort(7), horizonShort(36), horizonShort(43)], ["7m", "3y", "3y 7m"])
  assert.equal(horizonLong(5), "5 years")
  assert.equal(monthLabel(new Date(2029, 9, 1)), "Oct 2029")
  assert.deepEqual(["", "0.", "1234.5", "1000000", "12.3456"].map(groupDigits), ["", "0.", "1,234.5", "1,000,000", "12.3456"])
})

test("rolling balance: decimals kept in place while it rolls, at least two, as many as the final figure shows", () => {
  assert.deepEqual([0, 1000, 999.80003999, 0.5, 0.12345, 1234.5678].map((value) => rollingDecimals(value)), [2, 2, 2, 2, 4, 4])
  assert.equal(rollingAmount(0, 2), "0.00")
  assert.equal(rollingAmount(999.80003999, 2), "999.80")
  assert.equal(rollingAmount(1000, 2), "1,000.00")
  assert.equal(rollingAmount(523.1789, 2), "523.17", "cut, never rounded up")
  assert.equal(rollingAmount(0.12345, 4), "0.1234")
  assert.equal(rollingAmount(Number.NaN, 2), "—")
})

test("rolling balance: eases out from the figure shown to the new one, landing exactly on it", () => {
  assert.equal(easeOutCubic(0), 0)
  assert.equal(easeOutCubic(1), 1)
  assert.equal(easeOutCubic(2), 1)
  assert.ok(easeOutCubic(0.5) > 0.5, "fast at first")
  assert.equal(rollingValue(0, 1000, 0, 900), 0)
  assert.equal(rollingValue(0, 1000, 900, 900), 1000)
  assert.equal(rollingValue(0, 1000, 5000, 900), 1000)
  assert.equal(rollingValue(1000, 0, 450, 900), 125, "a withdrawal rolls down the same way")
  assert.equal(rollingValue(3, 7, 10, 0), 7)
})

test("rolling digits: one clipped slot per character; they roll in only when asked, the way the figure moved", () => {
  const still = renderToStaticMarkup(<RollingDigits text="1,234.5" trend="up" />)
  assert.equal(still.split("[clip-path:inset(0)]").length - 1, 7)
  assert.equal(still.replace(/<[^>]+>/g, ""), "1,234.5")
  assert.doesNotMatch(still, /savings-digit-/)
  assert.match(still, /^<span aria-hidden="true"/, "decorative: the figure's text is given beside it")
  const entering = renderToStaticMarkup(<RollingDigits text="99.8" trend="up" enter />)
  assert.equal(entering.split("savings-digit-in-up").length - 1, 4, "every digit rolls in from below")
  assert.match(renderToStaticMarkup(<RollingDigits text="5" trend="down" enter />), /savings-digit-in-down/)
  // The motion lives in the theme, and stops under reduced motion (the leaving digits are hidden outright).
  const theme = readFileSync(new URL("../theme.css", import.meta.url), "utf8")
  for (const name of ["in-up", "out-up", "in-down", "out-down"]) assert.match(theme, new RegExp(`@keyframes savings-digit-${name} \\{`), name)
  const reduced = theme.slice(theme.lastIndexOf("@media (prefers-reduced-motion: reduce)"))
  assert.match(reduced, /\.savings-digit-in-up,\s*\.arco-demo \.savings-digit-in-down \{ animation: none; \}/)
  assert.match(reduced, /\.savings-digit-out-up,\s*\.arco-demo \.savings-digit-out-down \{ display: none; \}/)
})

test("sparkline: a step line across the box ending at the latest value", () => {
  assert.equal(sparklinePath([{ ts: 1, value: 4 }]), null)
  const path = sparklinePath([{ ts: 0, value: 3 }, { ts: 10, value: 4 }])!
  assert.match(path.d, /^M0 36\.00 H400\.00 V4\.00 H400$/)
  assert.deepEqual(path.end, { x: 400, y: 4 })
})

test("sparkline pointer: the point whose step covers the pointer, the dot at the pointer on that step", () => {
  const points = [{ ts: 0, value: 3 }, { ts: 10, value: 3.5 }, { ts: 20, value: 4 }]
  assert.equal(sparklinePointAt([{ ts: 0, value: 3 }], 0.5), null)
  assert.deepEqual(sparklinePointAt(points, 0), { index: 0, x: 0, y: 36 })
  // Just before the second point's moment the first step still holds; at it, the second.
  assert.deepEqual(sparklinePointAt(points, 0.49), { index: 0, x: 196, y: 36 })
  assert.deepEqual(sparklinePointAt(points, 0.5), { index: 1, x: 200, y: 20 })
  // Past either edge it stays on the line.
  assert.deepEqual(sparklinePointAt(points, 1.4), { index: 2, x: 400, y: 4 })
  assert.deepEqual(sparklinePointAt(points, -1), { index: 0, x: 0, y: 36 })
})

test("APY change: in percent, up to two decimals, no trailing zeros", () => {
  assert.equal(apyChangeLabel(0.8), "0.8%")
  assert.equal(apyChangeLabel(0), "0%")
  assert.equal(apyChangeLabel(0.123), "0.12%")
})

// ── markup ────────────────────────────────────────────────────────────────

const heroProps = (over: Partial<SavingsHeroProps> = {}): SavingsHeroProps => ({
  connected: false,
  depositLabel: "Stablecoins",
  tokenSymbol: "arcoUSD",
  tokenIcon: "/logos/arco.png",
  paySymbol: "USDC",
  payIcon: "/logos/usdc.svg",
  balanceUsd: null,
  shares: null,
  available: null,
  availableUsd: null,
  apyPercent: 4.79,
  onDeposit: () => undefined,
  onWithdraw: () => undefined,
  ...over,
})

test("savings card before a wallet: the headline, the APY as the hero, the features and who the reserves are held with", () => {
  const html = renderToStaticMarkup(<SavingsHeroCard {...heroProps()} />)
  const text = (markup: string) => markup.replace(/<!-- -->/g, "")
  // No label line over it (look "C"): the headline first, then the APY (no brackets), read with its unit by
  // screen readers, and a small letter-spaced "APY" after the figure for the eye.
  assert.doesNotMatch(html, /data-hero-apy-label|STABLECOIN SAVINGS/)
  assert.match(text(html), /<h2 class="[^"]*">Make your Stablecoins work<\/h2>/)
  assert.doesNotMatch(html, /start saving<\/h2>/)
  const h2 = html.match(/<h2 class="([^"]*)">/)![1]!.split(" ")
  for (const token of ["text-[19px]", "md:text-xl", "font-medium", "text-[var(--color-savings-on-hero-muted)]"]) assert.ok(h2.includes(token), `headline: ${token}`)
  const apy = html.match(/<p data-hero-apy="" class="[^"]*">(.*?)<\/p>/)![1]!
  // No drawn brackets round the figure: the row is the figure and its unit, nothing else.
  assert.doesNotMatch(apy, /<span aria-hidden="true" class="[^"]*"><\/span>/)
  assert.match(apy, /^<span class="[^"]*md:text-\[84px\]/)
  assert.match(apy, /<span class="[^"]*md:text-\[84px\][^"]*">4\.79%<span class="sr-only"> APY<\/span><\/span>/)
  assert.match(apy, /font-medium/)
  // The unit after the figure, at its foot, hidden from screen readers (the figure already says "APY").
  const unit = apy.match(/<span aria-hidden="true" data-hero-apy-unit="" class="([^"]*)">APY<\/span>$/)
  assert.ok(unit, "the APY unit last in the row")
  for (const token of ["self-end", "font-semibold", "tracking-[0.14em]"]) assert.ok(unit[1]!.split(" ").includes(token), `unit: ${token}`)
  // In the card's own text colour (the muted one fell under 4.5:1 over the aurora's brightest light).
  assert.ok(!unit[1]!.includes("on-hero-muted"))
  assert.ok(html.indexOf("<h2") < html.indexOf("data-hero-apy="))
  assert.equal(heroHeadline("BTC"), "Make your BTC work")
  assert.equal(heroHeadline("Gold"), "Make your Gold work")
  // The outlined "saving" pill and its bars mark are gone.
  assert.doesNotMatch(html, /data-hero-pill=""[^>]*>saving/)
  assert.doesNotMatch(html, /lucide-chart-no-axes-column/)
  assert.match(html, /Institution-grade backing/)
  // Four slides; the onchain-settlement one is gone.
  assert.match(html, /aria-label="1 of 4"/)
  assert.doesNotMatch(html, /Settled onchain on GIWA/)
  assert.match(html, /Powered by/)
  // Logos only, in order, each named for screen readers; no names written out.
  const logos = [...html.matchAll(/<img src="([^"]+)" alt="([^"]+)"/g)].map((match) => [match[2], match[1]])
  assert.deepEqual(logos.filter(([name]) => ["Fidelity", "Franklin Templeton", "UBS", "Morpho"].includes(name!)), [
    ["Fidelity", "/logos/powered-by/fidelity.png"],
    ["Franklin Templeton", "/logos/powered-by/franklin.png"],
    ["UBS", "/logos/umint.svg"],
    ["Morpho", "/logos/powered-by/morpho.png"],
  ])
  // Round badges, each after the first tucked half under the one before it (28px badges, 14px overlap), the first on
  // top; the one pointed at comes to the front.
  const stack = [...html.matchAll(/<li class="([^"]*)" style="--stack-z:(\d+)">/g)].map((match) => [match[1]!.split(" "), Number(match[2])] as const)
  assert.deepEqual(stack.map(([, z]) => z), [4, 3, 2, 1])
  for (const [index, [classes]] of stack.entries()) {
    for (const token of ["group/logo", "z-[var(--stack-z)]", "hover:z-10"]) assert.ok(classes.includes(token), `${token} on logo ${index}`)
    assert.equal(classes.includes("-ml-3.5"), index > 0, `logo ${index} overlap`)
    // The pointer area itself never moves.
    assert.ok(!classes.some((token) => token.includes("translate")), `logo ${index} stays put`)
  }
  // The badge pointed at lifts and grows a little; the badges before it move left and those after it right.
  const unescape = (value: string) => value.replace(/&gt;/g, ">").replace(/&amp;/g, "&")
  const badges = [...html.matchAll(/<span class="(flex size-7 [^"]*)">/g)].map((match) => unescape(match[1]!).split(" "))
  assert.equal(badges.length, 4)
  for (const classes of badges) {
    for (const token of [
      "rounded-[var(--radius-pill)]",
      "ring-2",
      "group-hover/logo:-translate-y-1",
      "group-hover/logo:scale-110",
      "[li:hover~li>&]:translate-x-2",
      "[li:has(~li:hover)>&]:-translate-x-2",
    ]) {
      assert.ok(classes.includes(token), token)
    }
  }
  // Each name is written once, in its logo's label above it: hidden until pointed at, and kept from screen readers
  // (the logo's alt already names the partner).
  const names = ["Fidelity", "Franklin Templeton", "UBS", "Morpho"]
  const labels = [...html.matchAll(/<span aria-hidden="true" class="([^"]*)">([^<]+)<\/span>/g)].filter((match) => names.includes(match[2]!))
  assert.deepEqual(labels.map((match) => match[2]), names)
  for (const match of labels) {
    for (const token of ["invisible", "opacity-0", "group-hover/logo:visible", "group-hover/logo:opacity-100"]) assert.ok(match[1]!.split(" ").includes(token), token)
  }
  for (const name of names) assert.equal(html.split(`>${name}<`).length - 1, 1, `${name} written once`)
  // The bottom row, on one line: chevrons pointing right at the token, the arcoUSD mark (40px, 30px on a phone; on no disc
  // of its own) and name, a hairline, then "Powered by" and the logos. On the narrowest phones the words give way.
  const row = html.slice(html.indexOf("data-hero-token-row"))
  assert.match(html, /<div data-hero-token-row="" class="flex min-w-0 items-center [^"]*">/)
  assert.match(row, /^data-hero-token-row="" class="[^"]*"><span aria-hidden="true" data-hero-chevrons=""/)
  assert.equal((row.slice(0, row.indexOf("</span>", row.indexOf("data-hero-chevrons"))).match(/lucide-chevron-right/g) ?? []).length, 3)
  assert.doesNotMatch(html, /lucide-chevron-down/)
  assert.match(row, /<span class="flex shrink-0 items-center gap-1\.5 md:gap-2\.5"><img src="\/logos\/arco\.png" alt="arcoUSD" title="arcoUSD" width="40" height="40" class="[^"]*max-md:!size-\[30px\]/)
  assert.match(row, /<span class="whitespace-nowrap text-base font-medium md:text-lg">arcoUSD<\/span>/)
  assert.ok(row.indexOf(">arcoUSD<") < row.indexOf("Powered by"))
  const words = row.match(/<span class="([^"]*)">Powered by<\/span>/)![1]!.split(" ")
  for (const token of ["whitespace-nowrap", "uppercase", "max-[359px]:hidden"]) assert.ok(words.includes(token), token)
  assert.doesNotMatch(html, /Savings Balance/)
  assert.doesNotMatch(html, />Deposit</)
})

test("savings card before a wallet: the whole card connects one, the Connect Wallet pill shows it, the slides and logos stay usable", () => {
  // Pointing only where a pointer can hover (a tap would leave :hover stuck on a touch screen); focus everywhere.
  const ON_HOVER = "[@media(hover:hover)]:group-has-[[data-hero-connect]:hover]/hero:"
  const ON_FOCUS = "group-has-[[data-hero-connect]:focus-visible]/hero:"
  for (const tone of ["blue", "cream", "gold"] as const) {
    const html = renderToStaticMarkup(<SavingsHeroCard {...heroProps({ tone, onConnect: () => undefined })} />)
    // One button over the card, named for what it does; first in the card, so first in the tab order.
    const button = html.match(/<button type="button" data-hero-connect="" aria-label="Connect wallet to start saving" class="([^"]*)"><\/button>/)
    assert.ok(button, `${tone}: the connect button`)
    for (const token of ["absolute", "inset-0", "z-[1]", "cursor-pointer", "focus-visible:-outline-offset-4", "focus-visible:outline-[var(--color-arco-on-dark)]"]) {
      assert.ok(button[1]!.split(" ").includes(token), `${tone}: ${token}`)
    }
    assert.ok(html.indexOf("data-hero-connect") < html.indexOf("<h2"), `${tone}: before the headline`)
    assert.match(html, /<section aria-label="Your savings" data-savings-tone="[a-z]+" class="[^"]*\bgroup\/hero\b/)
    // The "Connect Wallet →" pill: always shown (bottom right; under the token row on a phone), in the card's CTA
    // colours; for the eye only (the button says it for screen readers), and under the button so a press on it connects.
    const pill = html.match(/<span aria-hidden="true" data-hero-pill="" data-hero-connect-hint="" class="([^"]*)">Connect Wallet<svg [^>]*class="([^"]*lucide-arrow-right[^"]*)"/)
    assert.ok(pill, `${tone}: the Connect Wallet pill`)
    const pillClasses = pill[1]!.split(" ")
    for (const token of ["inline-flex", "rounded-[var(--radius-pill)]", "bg-[var(--color-savings-hero-cta)]", "text-[var(--color-savings-hero-cta-ink)]", "order-first", "md:order-none", "w-full", "md:w-auto", "md:self-end", "motion-reduce:transition-none"]) {
      assert.ok(pillClasses.includes(token), `${tone}: pill ${token}`)
    }
    assert.ok(!pillClasses.some((token) => token.startsWith("opacity-")), `${tone}: never hidden`)
    // Pointed at (only where a pointer can hover) or focused: it lights up (a halo in the card's line colour) and its arrow steps on.
    for (const state of [ON_HOVER, ON_FOCUS]) {
      for (const look of ["bg-[var(--color-savings-hero-cta-hover)]", "shadow-[0_0_0_4px_var(--color-savings-on-hero-line),0_0_28px_var(--color-savings-on-hero-line)]"]) {
        assert.ok(pillClasses.includes(`${state}${look}`), `${tone}: pill ${state}${look}`)
      }
      assert.ok(pill[2]!.split(" ").includes(`${state}translate-x-1`), `${tone}: arrow ${state}`)
    }
    assert.ok(!html.includes(" group-has-[[data-hero-connect]:hover]/hero:"), `${tone}: no ungated hover look`)
    assert.doesNotMatch(html, /data-hero-wallet|lucide-wallet/)
    // The slides and the partner logos sit above the button (z-10 over z-[1]); a browser check covers the stacking itself.
    const slides = html.match(/<div class="([^"]*)"><div class="w-full"><div role="group" aria-roledescription="slide"/)
    const logos = html.match(/<div class="([^"]*)"><div class="flex items-center gap-1\.5 md:gap-3"><span[^>]*>Powered by</)
    for (const [name, wrapper] of [["slides", slides], ["logos", logos]] as const) {
      assert.ok(wrapper, `${tone}: ${name} wrapper`)
      for (const token of ["relative", "z-10"]) assert.ok(wrapper[1]!.split(" ").includes(token), `${tone}: ${name} ${token}`)
    }
    // The logos' layer is only as wide as the logos (a wider layer would take the press from the card).
    assert.ok(logos![1]!.split(" ").includes("shrink-0"))
  }

  // Without onConnect the card is not a button and shows no pill; once connected there is no connect button either.
  const plain = renderToStaticMarkup(<SavingsHeroCard {...heroProps()} />)
  for (const gone of ["data-hero-connect", "data-hero-pill", "Connect Wallet", "group/hero"]) assert.ok(!plain.includes(gone), gone)
  const connected = renderToStaticMarkup(<SavingsHeroCard {...heroProps({ connected: true, onConnect: () => undefined })} />)
  assert.ok(!connected.includes("data-hero-connect"))

  // The Savings page hands the card the wallet's connect (the header's Connect Wallet modal).
  const page = readFileSync(new URL("./SavingsPage.tsx", import.meta.url), "utf8")
  const call = page.slice(page.indexOf("<SavingsHeroCard"), page.indexOf("/>", page.indexOf("<SavingsHeroCard")))
  assert.match(call, /onConnect=\{[^}]*wallet\.connect\(\)/)
})

test("savings card with a wallet: balance, coins available, Deposit and Withdraw", () => {
  const html = renderToStaticMarkup(
    <SavingsHeroCard {...heroProps({ connected: true, balanceUsd: 1234.56789, shares: 1234.31, available: 500, availableUsd: 500 })} />,
  )
  assert.match(html, /Savings Balance/)
  assert.match(html, /<span class="sr-only">\$1,234\.57<\/span>/)
  // The figure rolls digit by digit: one clipped slot per character ($1,234 · .56 · 789), still reading the same, and
  // nothing rolls when it is first shown.
  assert.ok(html.replace(/<[^>]+>/g, "").includes("$1,234.56789"))
  assert.equal(html.split("[clip-path:inset(0)]").length - 1, 12)
  assert.doesNotMatch(html, /savings-digit-/)
  assert.match(html, /1,234\.31 arcoUSD/)
  // The token mark beside the shares and the wallet coin beside what is available: each its own mark on no disc, with
  // the card's hairline.
  assert.match(html, /tabular-nums"><img src="\/logos\/arco\.png" alt="arcoUSD" title="arcoUSD" width="24" height="24"/)
  assert.match(html, /<img src="\/logos\/usdc\.svg" alt="USDC" title="USDC" width="20" height="20" class="shrink-0 object-contain ring-1 ring-\[var\(--color-savings-on-hero-line\)\]"/)
  assert.doesNotMatch(html, /style="width:20px;height:20px"><img/)
  assert.match(html, />Earning</)
  // What the wallet can deposit is named as the headline names it: Stablecoins here, the coin elsewhere.
  assert.match(html, /Available Stablecoins/)
  assert.match(html, /The stablecoins in your connected wallet that you can deposit\./)
  assert.doesNotMatch(html, /Available USDC/)
  assert.match(renderToStaticMarkup(<SavingsHeroCard {...heroProps({ connected: true, depositLabel: "ETH", paySymbol: "tWETH" })} />), /Available ETH/)
  assert.match(html, /\$500/)
  assert.match(html, />Deposit<\/button>/)
  assert.match(html, />Withdraw<\/button>/)
  // No balance yet: no Earning chip, and the figure reads just $0.00 (the ticking digits wait for a balance).
  const empty = renderToStaticMarkup(<SavingsHeroCard {...heroProps({ connected: true, balanceUsd: 0, shares: 0 })} />)
  assert.doesNotMatch(empty, />Earning</)
  const emptyFigure = empty.replace(/<[^>]+>/g, "")
  assert.ok(emptyFigure.includes("$0.00") && !emptyFigure.includes("$0.00000"), emptyFigure)
  assert.equal(empty.split("[clip-path:inset(0)]").length - 1, 5, "$0 · .00")
})

test("savings card look: the navy card by default, black with cream lines and light for Crypto Native", () => {
  for (const connected of [false, true]) {
    const blue = renderToStaticMarkup(<SavingsHeroCard {...heroProps({ connected })} />)
    assert.match(blue, /data-savings-tone="blue"/)
    assert.match(blue, /linear-gradient\(135deg, var\(--color-arco-hero-deco-1\)/)
    const cream = renderToStaticMarkup(<SavingsHeroCard {...heroProps({ connected, tone: "cream" })} />)
    assert.match(cream, /data-savings-tone="cream"/)
    assert.match(cream, /style="background-color:var\(--color-arco-hero\)"/)
  }
  // The cream look re-scopes the card's lines, panels, aurora and orbits to the brand cream (--color-arco-cream).
  const theme = readFileSync(new URL("../theme.css", import.meta.url), "utf8")
  const scope = theme.slice(theme.indexOf('[data-savings-tone="cream"] {'))
  const block = scope.slice(0, scope.indexOf("}"))
  assert.match(block, /--color-savings-orbit-dot: rgba\(255, 253, 235, 0\.95\)/)
  for (const name of ["on-hero-line", "on-hero-fill", "aurora-1", "aurora-2", "aurora-3", "aurora-4", "orbit-line"]) {
    assert.match(block, new RegExp(`--color-savings-${name}: rgba\\(225, 224, 204, `), name)
  }
})

test("savings card look: light gold for Gold, every colour on it re-scoped to the brown ink", () => {
  assert.deepEqual((["stablecoins", "crypto-native", "gold"] as const).map(savingsHeroTone), ["blue", "cream", "gold"])
  const page = readFileSync(new URL("./SavingsPage.tsx", import.meta.url), "utf8")
  assert.match(page, /tone=\{savingsHeroTone\(savingsAssetCategory\(selected\.symbol\)\)\}/)
  for (const connected of [false, true]) {
    const html = renderToStaticMarkup(<SavingsHeroCard {...heroProps({ connected, tone: "gold", depositLabel: "Gold", balanceUsd: 10, shares: 1 })} />)
    assert.match(html, /data-savings-tone="gold"/)
    assert.match(html, /linear-gradient\(135deg, var\(--color-savings-gold-1\) 0%, var\(--color-savings-gold-2\) 42%, var\(--color-savings-gold-3\) 100%\)/)
    assert.match(html, connected ? /Available Gold/ : /Make your Gold work/)
  }
  const connected = renderToStaticMarkup(<SavingsHeroCard {...heroProps({ connected: true, tone: "gold", depositLabel: "Gold", balanceUsd: 10, shares: 1 })} />)
  assert.match(connected, /The gold in your connected wallet that you can deposit\./)
  // The Deposit button and the Earning pill read card-scoped tokens (navy and cream cards: white / ink, delta green).
  assert.match(connected, /bg-\[var\(--color-savings-hero-cta\)\][^"]*text-\[var\(--color-savings-hero-cta-ink\)\][^"]*hover:bg-\[var\(--color-savings-hero-cta-hover\)\]/)
  assert.match(connected, /text-\[var\(--color-savings-hero-earning\)\]/)

  const theme = readFileSync(new URL("../theme.css", import.meta.url), "utf8")
  const scope = theme.slice(theme.indexOf('[data-savings-tone="gold"] {'))
  const block = scope.slice(0, scope.indexOf("}"))
  for (const [name, value] of [
    ["arco-on-dark", "savings-gold-ink"],
    ["arco-hero", "savings-gold-3"],
    ["savings-on-hero-muted", "savings-gold-muted"],
    ["savings-on-hero-line", "savings-gold-line"],
    ["savings-on-hero-fill", "savings-gold-fill"],
    ["savings-aurora-1", "savings-gold-aurora-1"],
    ["savings-aurora-4", "savings-gold-aurora-4"],
    ["savings-hero-cta", "savings-gold-cta"],
    ["savings-hero-cta-ink", "savings-gold-3"],
    ["savings-hero-earning", "savings-gold-earning"],
    ["savings-orbit-line", "savings-gold-orbit-line"],
    ["savings-orbit-dot", "savings-gold-orbit-dot"],
  ]) {
    assert.match(block, new RegExp(`--color-${name}: var\\(--color-${value}\\);`), name)
  }
  // The top left is a pale gold, not white (2026-11), with the white aurora toned down so the left stays gold.
  for (const [name, value] of [["gold-1", "#fff3b3"], ["gold-2", "#ffed8a"], ["gold-3", "#ffe23d"], ["gold-ink", "#2e1f00"], ["gold-cta", "#4f3900"]]) { // design-tokens:allow (the brief's colours, asserted against theme.css)
    assert.match(theme, new RegExp(`--color-savings-${name}: ${value};`), name)
  }
  assert.match(theme, /--color-savings-gold-aurora-1: rgba\(255, 255, 255, 0\.3\);/)
  assert.match(theme, /--color-savings-gold-aurora-3: rgba\(255, 255, 255, 0\.2\);/)
  // The navy and cream cards keep their colours: the new card tokens stand for the ones they used.
  assert.match(theme, /--color-savings-hero-cta: var\(--color-arco-surface\);/)
  assert.match(theme, /--color-savings-hero-cta-ink: var\(--color-arco-ink\);/)
  assert.match(theme, /--color-savings-hero-earning: var\(--color-arco-delta-up\);/)
  assert.match(theme, /--color-savings-tip-text: var\(--color-arco-on-dark\);/)
})

test("savings card APY: max 2 decimals, no forced trailing zeros; a headline per account; no number while unknown", () => {
  assert.deepEqual([3.1, 4.02, 2.79, 6, 4.019, 3.10000001, 0].map(heroApyText), ["3.1%", "4.02%", "2.79%", "6%", "4.02%", "3.1%", "0%"])
  assert.equal(heroApyText(null), null)
  assert.equal(heroApyText(Number.NaN), null)

  // Crypto: the selected coin's APY as one number, under "Make your BTC work"; no coin switcher inside the card (the
  // tabs pick the coin).
  const crypto = renderToStaticMarkup(<SavingsHeroCard {...heroProps({ tone: "cream", depositLabel: "BTC", tokenSymbol: "aBTC", apyPercent: 2.79, onConnect: () => undefined })} />)
  assert.match(crypto, />Make your BTC work<\/h2><p data-hero-apy=""/)
  assert.match(crypto, />2\.79%<span class="sr-only"> APY<\/span>/)
  assert.doesNotMatch(crypto, /aria-pressed="(true|false)"[^>]*>[^<]*<img/)
  assert.equal((crypto.match(/data-hero-apy=""/g) ?? []).length, 1)
  assert.match(renderToStaticMarkup(<SavingsHeroCard {...heroProps({ tone: "gold", depositLabel: "Gold", apyPercent: 3.1 })} />), />Make your Gold work<\/h2><p data-hero-apy="" [^>]*>.*>3\.1%</)

  // Unknown APY: no number and no "APY"; the headline is the hero, at its earlier size.
  const unknown = renderToStaticMarkup(<SavingsHeroCard {...heroProps({ apyPercent: null, onConnect: () => undefined })} />)
  assert.doesNotMatch(unknown, /data-hero-apy|>APY<|\d%</)
  assert.match(unknown.replace(/<!-- -->/g, ""), /<h2 class="[^"]*text-\[30px\][^"]*sm:text-\[36px\][^"]*">Make your Stablecoins work<\/h2>/)
  assert.match(unknown, /data-hero-pill=""/)
})

test("savings card background: no grid; the aurora, then three tilted orbits with a glowing dot each, kept off the text", () => {
  for (const connected of [false, true]) {
    for (const tone of ["blue", "cream", "gold"] as const) {
      const html = renderToStaticMarkup(<SavingsHeroCard {...heroProps({ connected, tone, onConnect: () => undefined })} />)
      // The grid pattern is gone (the Featured Funds card keeps its own).
      assert.doesNotMatch(html, /background-size:28px 28px|linear-gradient\(90deg, var\(--color-savings-on-hero-fill\) 1px/)
      // The aurora as it was, then the orbit layer: decorative, behind the content, in two layers (lines, dots).
      assert.equal((html.match(/savings-aurora-[a-d] absolute/g) ?? []).length, 4)
      const layer = html.match(/<div aria-hidden="true" data-hero-orbits="(welcome|connected)" class="([^"]*)">/)
      assert.ok(layer, `${tone}: the orbits`)
      assert.equal(layer[1], connected ? "connected" : "welcome")
      for (const token of ["pointer-events-none", "absolute", "inset-0", "-z-10", "overflow-hidden"]) assert.ok(layer[2]!.split(" ").includes(token), token)
      assert.ok(html.indexOf("savings-aurora-d") < html.indexOf("data-hero-orbits"))
      for (const name of ["savings-orbit-1", "savings-orbit-2", "savings-orbit-3", "savings-orbit-dot-a", "savings-orbit-dot-b", "savings-orbit-dot-c"]) {
        assert.equal(html.split(name).length - 1, 1, name)
      }
    }
  }
  // The slides panel is liquid glass (theme.css .savings-glass, with a stronger blur for its text); the connected
  // card's Available strip stays frosted (8px). The orbits blur behind both.
  assert.match(renderToStaticMarkup(<SavingsHeroCard {...heroProps()} />), /aria-roledescription="slide"[^>]*class="savings-glass savings-glass-panel [^"]*rounded-\[22px\]/)
  const connected = renderToStaticMarkup(<SavingsHeroCard {...heroProps({ connected: true, balanceUsd: 10, shares: 1 })} />)
  assert.match(connected, /<div class="flex flex-col gap-4 border-t [^"]*backdrop-blur-\[8px\][^"]*"><div><p [^>]*>Available Stablecoins/)
  // No APY on the connected card.
  assert.doesNotMatch(connected, /data-hero-apy/)

  const theme = readFileSync(new URL("../theme.css", import.meta.url), "utf8")
  // Lines in the card's orbit colour; each dot travels its ellipse by offset-path at its own speed (9s, 13s, 6s).
  assert.match(theme, /\.savings-orbit \{[^}]*border: 1px solid var\(--color-savings-orbit-line\);/)
  assert.match(theme, /\.savings-orbit-dot \{[^}]*background: var\(--color-savings-orbit-dot\);[^}]*animation: savings-orbit 9s linear infinite;/)
  assert.match(theme, /\.savings-orbit-dot-a \{ offset-path: path\("M 0 150 A 330 150 0 1 1 660 150 A 330 150 0 1 1 0 150"\);/)
  assert.match(theme, /\.savings-orbit-dot-b \{ offset-path: path\([^)]*\);[^}]*animation-duration: 13s;/)
  assert.match(theme, /\.savings-orbit-dot-c \{ offset-path: path\([^)]*\);[^}]*animation-duration: 6s;/)
  assert.match(theme, /@keyframes savings-orbit \{\s*from \{ offset-distance: 0%; \}\s*to \{ offset-distance: 100%; \}/)
  // A static fallback without offset-path; still under reduced motion.
  assert.match(theme, /@supports not \(offset-path: path\("M 0 0 L 1 1"\)\) \{\s*\.arco-demo \.savings-orbit-dot \{ animation: none;/)
  const reduced = theme.slice(theme.lastIndexOf("@media (prefers-reduced-motion: reduce)"))
  assert.match(reduced, /\.arco-demo \.savings-orbit-dot,/)
  // The navy card's orbit colours (the mock's); the cream and gold cards re-scope them (tests above).
  assert.match(theme, /--color-savings-orbit-line: rgba\(160, 185, 255, 0\.3\);/)
  assert.match(theme, /--color-savings-orbit-dot: rgba\(190, 210, 255, 0\.9\);/)
  // Kept off the text: the dots are masked to text-free parts of each card and hidden on phones.
  assert.match(theme, /\[data-hero-orbits="welcome"\] \.savings-orbit-dots \{[^}]*mask-composite: intersect;/)
  assert.match(theme, /\[data-hero-orbits="connected"\] \.savings-orbit-dots \{[^}]*mask-composite: intersect;/)
  assert.match(theme, /@media \(max-width: 767px\) \{\s*\.arco-demo \[data-hero-orbits\] \.savings-orbit-dots \{ display: none; \}/)
})

test("orbit dots: the Portfolio card's rings carry the Savings card's moving dots; the Savings card's orbits unchanged", () => {
  const rings = '<span class="savings-orbit savings-orbit-1"></span><span class="savings-orbit savings-orbit-2"></span><span class="savings-orbit savings-orbit-3"></span>'
  const dots = '<span class="savings-orbit-dot savings-orbit-dot-a"></span><span class="savings-orbit-dot savings-orbit-dot-b"></span><span class="savings-orbit-dot savings-orbit-dot-c"></span>'
  const frame = (layout: string, inner: string) => `<div aria-hidden="true" data-hero-orbits="${layout}" class="pointer-events-none absolute inset-0 -z-10 overflow-hidden">${inner}</div>`
  // The Savings card's markup, exactly as before: lines and dots in their own layers (each with its own masks).
  for (const layout of ["welcome", "connected"] as const) {
    assert.equal(
      renderToStaticMarkup(<HeroOrbits layout={layout} />),
      frame(layout, `<div class="savings-orbit-layer savings-orbit-lines"><div class="savings-orbits">${rings}</div></div><div class="savings-orbit-layer savings-orbit-dots"><div class="savings-orbits">${dots}</div></div>`),
    )
  }
  // The Portfolio card: the same three dots (the same animated classes: speeds, glow, reduced-motion stop, fallback
  // spots) in a layer that takes the lines' "portfolio" mask (right of the current value), kept off the glass panels in
  // the card's pixels, and hidden on phones (the rings show only in the panels' band there).
  const portfolio = renderToStaticMarkup(<HeroOrbits layout="portfolio" />)
  const parts = portfolio.match(/^<div aria-hidden="true" data-hero-orbits="portfolio" class="pointer-events-none absolute inset-0 -z-10 overflow-hidden"><div class="savings-orbit-layer savings-orbit-lines"><div class="savings-orbits">(.*?)<\/div><\/div><div class="savings-orbit-layer savings-orbit-lines max-md:hidden" data-orbit-dots="portfolio"><div class="absolute inset-0 ([^"]*)"><div class="absolute inset-0 ([^"]*)"><div class="savings-orbits">(.*?)<\/div><\/div><\/div><\/div><\/div>$/)
  assert.ok(parts, portfolio)
  assert.equal(parts[1], rings)
  // The same dots; under reduced motion the inner one stops where this card shows it (above the panels).
  assert.equal(parts[4], dots.replace("savings-orbit-dot savings-orbit-dot-c", "savings-orbit-dot savings-orbit-dot-c motion-reduce:![offset-distance:22.5%]"))
  // Further right than the lines (off the live digits), and off the glass panels.
  assert.match(parts[2]!, /\[mask-image:linear-gradient\(to_right,transparent_60%,var\(--color-arco-ink\)_66%\)\]/)
  assert.match(parts[3]!, /\[mask-image:linear-gradient\(to_left,transparent_368px,var\(--color-arco-ink\)_380px\),linear-gradient\(to_top,transparent_128px,var\(--color-arco-ink\)_140px\)\]/)
  assert.match(parts[3]!, /\[mask-composite:add\]/)
  assert.doesNotMatch(portfolio, /savings-orbit-dots/, "not the dots layer theme.css hides on this card")
  // And the Portfolio card draws it, decorative.
  const hero = renderToStaticMarkup(<PortfolioHero value={1000} earningUsd={1000} apyPercent={4} supplied="$900" earned="$100" apy="4%" notes={[]} />)
  assert.ok(hero.includes(portfolio), "the Portfolio hero renders these orbits, aria-hidden")
  // The lines' "portfolio" mask (theme.css), which the dots layer takes, keeps them right of the current value.
  const theme = readFileSync(new URL("../theme.css", import.meta.url), "utf8")
  assert.match(theme, /\[data-hero-orbits="portfolio"\] \.savings-orbit-lines \{\s*-webkit-mask-image: linear-gradient\(to right, transparent 50%, \S+ 58%\);/)
})

const account = (symbol: string, over: Partial<SavingsAccount> = {}): SavingsAccount => ({
  key: `real:v-${symbol}:${symbol}`,
  symbol,
  icon: `/accept/${symbol}.png`,
  apy: "4.79%",
  disabled: false,
  vault: null,
  vaultId: `v-${symbol}`,
  sortOrder: null,
  ...over,
})

test("tabs: Stablecoins stacks its coins in one tab; Crypto Native stacks its supported coins with their APY range", () => {
  const accounts = [account("USDC"), account("RLUSD"), account("ETH", { apy: "3.86%" }), account("XRP", { disabled: true })]
  const html = renderToStaticMarkup(<SavingsTabs accounts={accounts} selectedKey={accounts[2]!.key} onSelect={() => undefined} />)
  assert.match(html, /Stablecoins/)
  // Every coin the deposit and withdraw screens take, with the marks they show, though the Vault Config lists two.
  assert.match(html, /<span class="sr-only">USDC, USDT, RLUSD, ArcoUSD<\/span>/)
  const stack = html.slice(0, html.indexOf('<span class="sr-only">'))
  assert.deepEqual(
    [...stack.matchAll(/<img src="([^"]+)"/g)].map((match) => match[1]),
    ["/logos/usdc.svg", "/logos/usdt.png", "/logos/rlusd.png", "/logos/arcousd.png"],
  )
  // The marks overlap with no ring around them (no white behind a coin), the first on top.
  assert.doesNotMatch(stack, /ring-/)
  assert.deepEqual([...stack.matchAll(/style="z-index:(\d+)"/g)].map((match) => Number(match[1])), [4, 3, 2, 1])
  assert.match(html, />Crypto</)
  // One tab for Crypto, opening a menu. XRP is coming soon: no mark, no part in the range, no "Soon".
  const tab = html.match(/<button type="button" data-savings-tab="" data-crypto-tab="" data-selected="true" aria-haspopup="menu" aria-expanded="false"[^>]*>(.*?)<\/button>/)
  assert.ok(tab, "the Crypto Native tab")
  assert.deepEqual([...tab[1]!.matchAll(/<img src="([^"]+)"/g)].map((match) => match[1]), ["/accept/ETH.png"])
  // Read out in full for screen readers; the figure on show is for the eye.
  assert.match(tab[1]!, /<span class="sr-only">Crypto: ETH, 3\.86% APY; ETH selected<\/span>/)
  assert.match(tab[1]!, /<span class="savings-tab-full savings-tab-apy tabular-nums">3\.86%<\/span><span class="savings-tab-short savings-tab-apy tabular-nums">3\.86%<\/span><svg/)
  assert.doesNotMatch(html, /XRP|Soon/)
  // Closed: no menu in the page.
  assert.doesNotMatch(html, /role="menu"/)
})

test("tabs: Crypto Native shows every supported coin stacked and the lowest to the highest APY", () => {
  const accounts = [account("USDC"), account("XRP", { apy: "4.57%" }), account("ETH", { apy: "3.86%" }), account("BTC", { apy: "—" }), account("SOL", { apy: "9%", disabled: true })]
  const html = renderToStaticMarkup(<SavingsTabs accounts={accounts} selectedKey={accounts[0]!.key} onSelect={() => undefined} />)
  const tab = html.match(/<button type="button" data-savings-tab="" data-crypto-tab="" data-selected="false"[^>]*>(.*?)<\/button>/)![1]!
  // In the accounts' order, the first on top; the coming-soon SOL is left out.
  assert.deepEqual([...tab.matchAll(/<img src="([^"]+)"/g)].map((match) => match[1]), ["/accept/XRP.png", "/accept/ETH.png", "/accept/BTC.png"])
  assert.deepEqual([...tab.matchAll(/style="z-index:(\d+)"/g)].map((match) => Number(match[1])), [3, 2, 1])
  assert.match(tab, /<span class="sr-only">Crypto: XRP, ETH, BTC, 3\.86% to 4\.57% APY<\/span>/)
  assert.match(tab, />3\.86% ~ 4\.57%</)

  // The range: as the figures are written; one figure when there is one or they agree; none without a figure.
  assert.equal(savingsApyRange([{ apy: "4.57%" }, { apy: "3.86%" }, { apy: "4.1%" }]), "3.86% ~ 4.57%")
  assert.equal(savingsApyRange([{ apy: "3.86%" }]), "3.86%")
  assert.equal(savingsApyRange([{ apy: "4%" }, { apy: "4%" }]), "4%")
  assert.equal(savingsApyRange([{ apy: "—" }, { apy: "3.86%" }]), "3.86%")
  assert.equal(savingsApyRange([{ apy: "—" }]), null)
  assert.equal(savingsApyRange([]), null)
  // Written short for a two-line tab.
  assert.equal(savingsApyRangeShort("2.79% ~ 4.57%"), "2.79~4.57%")
  assert.equal(savingsApyRangeShort("3.86%"), "3.86%")

  // No coin that can be saved today: no Crypto Native tab.
  assert.doesNotMatch(renderToStaticMarkup(<SavingsTabs accounts={[account("USDC"), account("XRP", { disabled: true })]} selectedKey={null} onSelect={() => undefined} />), /\bCrypto\b/)
})

test("tabs: Gold is one tab after Crypto Native, PAXG and XAUT stacked with the APY, no menu", () => {
  const gold = [account("PAXG", { key: "real:arcogold:PAXG", vaultId: "arcogold", apy: "3.1%" }), account("XAUT", { key: "real:arcogold:XAUT", vaultId: "arcogold", apy: "3.1%" })]
  const accounts = [account("USDC"), account("ETH", { apy: "3.86%" }), ...gold]
  const html = renderToStaticMarkup(<SavingsTabs accounts={accounts} selectedKey={gold[1]!.key} onSelect={() => undefined} />)
  assert.ok(html.indexOf(">Stablecoins<") < html.indexOf(">Crypto<") && html.indexOf(">Crypto<") < html.indexOf(">Gold<"))
  const tabs = [...html.matchAll(/<button type="button" data-savings-tab="" data-gold-tab="" aria-pressed="(\w+)"[^>]*>(.*?)<\/button>/g)]
  assert.equal(tabs.length, 1, "one Gold button")
  const [, pressed, tab] = tabs[0]!
  // Either gold coin selected presses the one tab.
  assert.equal(pressed, "true")
  assert.deepEqual([...tab!.matchAll(/<img src="([^"]+)"/g)].map((match) => match[1]), ["/logos/paxg.png", "/logos/xaut.png"])
  assert.deepEqual([...tab!.matchAll(/style="z-index:(\d+)"/g)].map((match) => Number(match[1])), [2, 1])
  assert.match(tab!, /<span class="sr-only">PAXG, XAUT<\/span>/)
  assert.match(tab!, />3\.1%</)
  assert.doesNotMatch(tab!, /lucide-chevron-down/)
  assert.doesNotMatch(html.slice(html.indexOf(">Gold<")), /aria-haspopup/)
  // Only the Crypto Native tab opens a menu.
  assert.equal(html.split('aria-haspopup="menu"').length - 1, 1)
  // The test coins read as their coins; one mark each.
  assert.deepEqual(savingsGoldMarks([{ symbol: "tXAUT", icon: null }, { symbol: "tPAXG", icon: null }, { symbol: "PAXG", icon: null }]).map((mark) => mark.symbol), ["PAXG", "XAUT"])
  // No gold account, no Gold tab; Stablecoins and Crypto Native no longer take the gold coins.
  const without = renderToStaticMarkup(<SavingsTabs accounts={accounts.slice(0, 2)} selectedKey={null} onSelect={() => undefined} />)
  assert.doesNotMatch(without, /Gold|data-gold-tab/)
  assert.doesNotMatch(html.slice(0, html.indexOf(">Gold<")), /PAXG|XAUT/)
})

test("tabs: a stablecoin the Vault Config lists beyond those trails the stack with its own mark", () => {
  const html = renderToStaticMarkup(
    <SavingsTabs accounts={[account("USDC"), account("PYUSD", { disabled: true }), account("usdt")]} selectedKey={null} onSelect={() => undefined} />,
  )
  // One mark per coin: the configured usdt is the USDT already stacked.
  assert.match(html, /<span class="sr-only">USDC, USDT, RLUSD, ArcoUSD, PYUSD<\/span>/)
  assert.match(html, /<img src="\/logos\/arcousd\.png"[^>]*><\/span><span [^>]*><img src="\/accept\/PYUSD\.png"/)
  // No stablecoin account, no Stablecoins tab.
  assert.doesNotMatch(renderToStaticMarkup(<SavingsTabs accounts={[account("ETH")]} selectedKey={null} onSelect={() => undefined} />), /Stablecoins/)
})

test("tabs: one glass track of equal columns with a lens on the selected tab, the refraction filter drawn once", () => {
  for (const accounts of [[account("USDC"), account("ETH")], [account("USDC"), account("ETH"), account("PAXG")]]) {
    const html = renderToStaticMarkup(<SavingsTabs accounts={accounts} selectedKey={accounts[1]!.key} onSelect={() => undefined} />)
    // The tabs measure their own width (a container), not the window's (the nav rail takes part of a wide window).
    assert.match(html, /^<div class="savings-tabs w-full">/)
    assert.match(html, /<nav aria-label="Savings accounts"><div data-savings-tabs-track="" class="savings-tabs-track savings-glass" style="([^"]*)">/)
    const style = html.match(/data-savings-tabs-track="" [^>]*style="([^"]*)"/)![1]!
    // As many equal columns as tabs; the lens on the second.
    assert.equal(style, `--savings-tab-count:${accounts.length};--savings-tab-index:1`)
    assert.equal((html.match(/data-savings-lens=""/g) ?? []).length, 1)
    assert.match(html, /<span aria-hidden="true" data-savings-lens="" class="savings-glass-lens"><\/span>/)
    // Every tab is one button with its name and its marks and rate (a whole column), in the card's colours.
    const tabs = [...html.matchAll(/<button type="button" data-savings-tab=""[^>]*class="([^"]*)"/g)].map((match) => match[1]!.split(" "))
    assert.equal(tabs.length, accounts.length)
    tabs.forEach((classes, index) => {
      for (const token of ["savings-tab", "focus-visible:outline-[var(--color-arco-on-dark)]", "motion-reduce:transition-none"]) assert.ok(classes.includes(token), `tab ${index}: ${token}`)
      assert.ok(classes.includes(index === 1 ? "text-[var(--color-arco-on-dark)]" : "text-[var(--color-savings-on-hero-muted)]"), `tab ${index}: colour`)
    })
    // The SVG filter that bends the light behind the glass: once, hidden, no room taken.
    assert.equal((html.match(/<filter id="savings-glass-refraction"/g) ?? []).length, 1)
    assert.match(html, /<svg aria-hidden="true" focusable="false" width="0" height="0" class="pointer-events-none absolute size-0 overflow-hidden"><filter id="savings-glass-refraction"[^>]*><feTurbulence[^>]*><\/feTurbulence><feGaussianBlur[^>]*><\/feGaussianBlur><feDisplacementMap[^>]*><\/feDisplacementMap><\/filter><\/svg>/)
    assert.doesNotMatch(html, /overflow-x-auto|rounded-t-/)
  }
  // Nothing selected: no lens.
  assert.doesNotMatch(renderToStaticMarkup(<SavingsTabs accounts={[account("USDC"), account("ETH")]} selectedKey={null} onSelect={() => undefined} />), /data-savings-lens/)

  // The glass and the lens (theme.css): the plain blur for every browser, the refraction only where it is supported
  // (not Safari or Firefox); the lens slides by transform, a little springy, and not under reduced motion.
  const theme = readFileSync(new URL("../theme.css", import.meta.url), "utf8")
  const glass = theme.slice(theme.indexOf(".arco-demo .savings-glass {"))
  assert.match(glass, /^\.arco-demo \.savings-glass \{\s*background: var\(--color-savings-glass-tint\);\s*-webkit-backdrop-filter: blur\(3px\) saturate\(180%\) brightness\(1\.08\);\s*backdrop-filter: blur\(3px\) saturate\(180%\) brightness\(1\.08\);/)
  assert.match(theme, /@supports \(backdrop-filter: url\(#savings-glass-refraction\)\) and \(not \(font: -apple-system-body\)\) and \(not \(-moz-appearance: none\)\) \{\s*\.arco-demo \.savings-glass \{ backdrop-filter: url\(#savings-glass-refraction\) blur\(2px\)/)
  const lens = theme.slice(theme.indexOf(".arco-demo .savings-glass-lens {"))
  assert.match(lens.slice(0, lens.indexOf("}")), /transform: translateX\(calc\(var\(--savings-tab-index, 0\) \* 100%\)\);\s*transition: transform 0\.5s cubic-bezier\(0\.3, 1\.45, 0\.45, 1\);/)
  assert.match(theme, /@media \(prefers-reduced-motion: reduce\) \{\s*\.arco-demo \.savings-glass-lens \{ transition: none; \}/)
  // The glass colours per card: navy by default, re-scoped by the cream and gold cards.
  for (const name of ["tint", "rim", "rim-soft", "lens", "shadow", "menu"]) {
    assert.match(theme, new RegExp(`\\.arco-demo \\{[\\s\\S]*--color-savings-glass-${name}: rgba\\(`), `default ${name}`)
    const cream = theme.slice(theme.indexOf('[data-savings-tone="cream"] {'))
    assert.match(cream.slice(0, cream.indexOf("}")), new RegExp(`--color-savings-glass-${name}: rgba\\(`), `cream ${name}`)
    const gold = theme.slice(theme.indexOf('[data-savings-tone="gold"] {'))
    assert.match(gold.slice(0, gold.indexOf("}")), new RegExp(`--color-savings-glass-${name}: var\\(--color-savings-gold-glass-${name}\\);`), `gold ${name}`)
  }
})

test("tabs: one line each from 47rem of track; below it two lines (name, then marks and rate), Crypto's range short and its chevron by its name", () => {
  const gold = [account("PAXG", { key: "real:arcogold:PAXG", vaultId: "arcogold", apy: "3.1%" }), account("XAUT", { key: "real:arcogold:XAUT", vaultId: "arcogold", apy: "3.1%" })]
  const accounts = [account("USDC"), account("BTC", { apy: "2.79%" }), account("XRP", { apy: "4.57%" }), ...gold]
  const html = renderToStaticMarkup(<SavingsTabs accounts={accounts} selectedKey={accounts[1]!.key} onSelect={() => undefined} />)
  // Each tab: the name, then its marks and rate (the layout itself is theme.css .savings-tab, by the track's width).
  for (const label of ["Stablecoins", "Gold"]) assert.match(html, new RegExp(`<span class="savings-tab-name font-medium">${label}</span><span class="savings-tab-meta">`))
  // Crypto: its name (read in its summary) with a chevron for two lines, the full and the short range, a chevron for one line.
  const crypto = html.match(/<button type="button" data-savings-tab="" data-crypto-tab=""[^>]*>(.*?)<\/button>/)![1]!
  assert.match(crypto, /^<span aria-hidden="true" class="savings-tab-name font-semibold">Crypto<svg[^>]*class="[^"]*savings-tab-chevron-name[^"]*"/)
  assert.match(crypto, /<span class="savings-tab-full savings-tab-apy tabular-nums">2\.79% ~ 4\.57%<\/span><span class="savings-tab-short savings-tab-apy tabular-nums">2\.79~4\.57%<\/span><svg[^>]*class="[^"]*savings-tab-chevron-meta[^"]*"/)
  assert.match(html, /<span class="sr-only">USDC, USDT, RLUSD, ArcoUSD<\/span>/)
  assert.match(html, /<span class="sr-only">Crypto: BTC, XRP, 2\.79% to 4\.57% APY; BTC selected<\/span>/)
  assert.match(html, /<span class="sr-only">PAXG, XAUT<\/span>/)
  // Marks 20px, 16px on two lines.
  for (const img of html.matchAll(/<img [^>]*class="([^"]*)"/g)) assert.ok(img[1]!.split(" ").includes("savings-tab-mark"))

  const theme = readFileSync(new URL("../theme.css", import.meta.url), "utf8")
  const narrow = theme.slice(theme.indexOf("@container (max-width: 46.99rem) {"))
  const block = narrow.slice(0, narrow.indexOf("\n}\n"))
  for (const rule of [
    /\.savings-tabs-track \{ border-radius: 22px; \}/,
    /\.savings-tab \{[^}]*min-height: 54px;[^}]*flex-direction: column;/,
    /\.savings-tab-full,\s*\.arco-demo \.savings-tab-chevron-meta \{ display: none; \}/,
    /\.savings-tab-short,\s*\.arco-demo \.savings-tab-chevron-name \{ display: inline-flex; \}/,
    /\.savings-tab-mark \{ width: 16px !important; height: 16px !important; \}/,
  ]) {
    assert.match(block, rule)
  }
  // Under 22rem of track (the narrowest phones) the rate takes its own line under the marks, on every tab.
  assert.match(theme, /@container \(max-width: 21\.99rem\) \{\s*\.arco-demo \.savings-tab-apy \{ flex-basis: 100%; \}\s*\}/)
  assert.match(theme, /\.arco-demo \.savings-tabs \{ container-type: inline-size; \}/)
  assert.match(theme, /\.arco-demo \.savings-tab-short,\s*\.arco-demo \.savings-tab-chevron-name \{ display: none; \}/)
})

test("savings card: the tabs sit inside its top in both states, above the connect button; the page hands them in", () => {
  const tabs = <SavingsTabs accounts={[account("USDC"), account("ETH")]} selectedKey={null} onSelect={() => undefined} />
  for (const connected of [false, true]) {
    for (const tone of ["blue", "cream", "gold"] as const) {
      const html = renderToStaticMarkup(<SavingsHeroCard {...heroProps({ connected, tone, tabs, onConnect: () => undefined, balanceUsd: 1, shares: 1 })} />)
      const slot = html.match(/<div data-hero-tabs="" class="([^"]*)"><div class="savings-tabs w-full">/)
      assert.ok(slot, `${tone} ${connected}: the tabs in the card`)
      for (const token of ["relative", "z-20", "px-2.5", "pt-2.5", "md:px-3", "md:pt-3"]) assert.ok(slot[1]!.split(" ").includes(token), token)
      // In the card, after the aurora and the connect button, before the content (and its orbits).
      assert.ok(html.indexOf("savings-aurora-d") < html.indexOf("data-hero-tabs"))
      assert.ok(html.indexOf("data-hero-tabs") < html.indexOf("data-hero-orbits"))
      if (!connected) assert.ok(html.indexOf("data-hero-connect") < html.indexOf("data-hero-tabs"))
    }
  }
  // Before a wallet: 352px tall from `md`, the content just under the tabs.
  const welcome = renderToStaticMarkup(<SavingsHeroCard {...heroProps({ tabs })} />)
  assert.match(welcome, /<section aria-label="Your savings" data-savings-tone="blue" class="[^"]*md:min-h-\[352px\]/)
  assert.match(welcome, /class="flex min-h-\[291px\] [^"]*pt-\[18px\] md:min-h-\[286px\] md:pt-3\.5"/)
  // Without tabs (on its own) the card keeps its own top padding.
  assert.match(renderToStaticMarkup(<SavingsHeroCard {...heroProps()} />), /class="flex min-h-\[291px\] [^"]*pt-5 md:min-h-\[352px\] md:pt-7"/)

  const page = readFileSync(new URL("./SavingsPage.tsx", import.meta.url), "utf8")
  assert.match(page, /const tabs = \(\s*<SavingsTabs/)
  assert.match(page, /<SavingsDetail\s+key=\{selected\.vault\.productId\}\s+vault=\{selected\.vault\}\s+tabs=\{tabs\}/)
  const call = page.slice(page.indexOf("<SavingsHeroCard"), page.indexOf("/>", page.indexOf("<SavingsHeroCard")))
  assert.match(call, /tabs=\{tabs\}/)
})

test("rows: one card, each row a button with its icon, title and chevron, opening on its own; summaries only when closed", () => {
  const sections = [
    { id: "backing", title: "Backing", icon: null, summary: null, preview: <span>backing bar</span>, content: <p>backing body</p> },
    { id: "liquidity", title: "Liquidity", icon: null, summary: "Instant liquidity: $5.17K", content: <p>liquidity body</p> },
    { id: "simulation", title: "Simulation", icon: null, summary: null, content: <p>simulation body</p> },
  ]
  const closed = renderToStaticMarkup(<SavingsAccordion sections={sections} />)
  // All closed by default; one card with hairlines between the rows.
  assert.equal(closed.match(/aria-expanded="false"/g)?.length, 3)
  assert.equal(closed.match(/rounded-\[22px\]/g)?.length, 1)
  assert.equal(closed.match(/border-t border-\[var\(--color-arco-border\)\]/g)?.length, 2)
  assert.deepEqual([...closed.matchAll(/data-section="([^"]+)"/g)].map((match) => match[1]), ["backing", "liquidity", "simulation"])
  // The summary on the right of a closed row, from `sm` up only; the preview (the Backing bar) in the row's header, beside
  // the button (not in it, so it may hold controls), as its description; clicks pass through it to the button.
  assert.match(closed, /<span class="hidden truncate [^"]*sm:inline">Instant liquidity: \$5\.17K<\/span>/)
  assert.match(closed, /aria-describedby="([^"]+)"[^>]*>(?:(?!<\/button>).)*<\/button><\/h3><div id="\1" class="pointer-events-none relative z-10 w-full"><span>backing bar<\/span><\/div>/s)
  // The button's ::after stretches over the whole header (a click anywhere on it toggles) and carries the focus ring.
  assert.match(closed, /<div class="relative flex min-h-\[60px\] w-full flex-col justify-center gap-3 px-5 py-4 sm:px-6"><h3><button /)
  assert.equal(closed.match(/after:absolute after:inset-0 /g)?.length, 3)
  assert.equal(closed.match(/focus-visible:after:outline-\[var\(--color-arco-ink\)\]/g)?.length, 3)
  assert.match(closed, /after:rounded-t-\[21px\]/)
  assert.match(closed, /after:rounded-b-\[21px\]"><span aria-hidden="true"[^>]*><\/span><span id="[^"]+-simulation-title"/)
  // Only the Backing row has a preview.
  assert.equal(closed.match(/aria-describedby=/g)?.length, 1)
  // Named by the title alone; no "Show details" text; the chevron points down.
  assert.match(closed, /aria-labelledby="([^"]+-backing-title)"[^>]*>.*?<span id="\1"[^>]*>Backing<\/span>/s)
  assert.doesNotMatch(closed, /Show details|Hide details/)
  assert.doesNotMatch(closed, /rotate-180/)
  for (const body of ["backing body", "liquidity body", "simulation body"]) assert.doesNotMatch(closed, new RegExp(body))
  // Open: its content, the chevron up, its summary gone; the preview stays.
  const open = renderToStaticMarkup(<SavingsAccordion sections={sections} initialOpen="liquidity" />)
  assert.match(open, /aria-expanded="true"[^>]*>(?:(?!<\/button>).)*Liquidity/s)
  assert.match(open, /liquidity body/)
  assert.match(open, /rotate-180/)
  assert.doesNotMatch(open, /Instant liquidity: \$5\.17K/)
  assert.match(open, /backing bar/)
  assert.doesNotMatch(open, /backing body|simulation body/)
  // The chevron's turn stays still under reduced motion.
  assert.match(open, /transition-transform [^"]*motion-reduce:transition-none/)
})

test("backing bar: the slices largest first in the account's tone, a legend of each with its share from `sm` up", () => {
  const backing = savingsBacking({ symbol: "USDC", icon: null })
  assert.deepEqual(barOrder(backing).map((slice) => slice.id), ["fidelity", "ubs", "loans", "franklin-templeton", "reserve"])
  const html = renderToStaticMarkup(<BackingBar slices={backing} tone="gold" />)
  assert.match(html, /data-savings-bar-tone="gold"/)
  // Each slice is a button named by its label and share, growing by its share, darkest first; none picked yet.
  const names = ["Fidelity 40%", "UBS 20%", "Crypto &amp; RWA-backed loans 20%", "Franklin Templeton 10%", "Instant liquidity reserve 10%"]
  assert.deepEqual(
    [
      ...html.matchAll(
        /<button type="button" data-bar-slice="([^"]+)" aria-label="([^"]+)" aria-pressed="false" class="[^"]*" style="flex-grow:(\d+)"><span aria-hidden="true" class="absolute inset-0 rounded-\[inherit\] bg-\[var\(--color-savings-bar-(\d)\)\]/g,
      ),
    ].map((m) => [m[1], m[2], m[4], m[3]]),
    [["fidelity", names[0], "1", "40"], ["ubs", names[1], "2", "20"], ["loans", names[2], "3", "20"], ["franklin-templeton", names[3], "4", "10"], ["reserve", names[4], "5", "10"]],
  )
  assert.match(html, /<div class="flex h-3 w-full gap-0\.5">/)
  // No clipping box round the bar (the tip shows over it): the ends are rounded on the first and last slices instead.
  assert.doesNotMatch(html, /overflow-hidden/)
  assert.equal(html.match(/rounded-l-\[2px\]/g)?.length, 1)
  assert.equal(html.match(/rounded-r-\[2px\]/g)?.length, 1)
  assert.match(html, /data-bar-slice="fidelity"[^>]*class="[^"]*rounded-l-\[2px\]/)
  assert.match(html, /data-bar-slice="reserve"[^>]*class="[^"]*rounded-r-\[2px\]/)
  // A 12px taller tap target above and below, the same look; the focus ring as elsewhere; no tip until pointed at.
  assert.match(html, /data-bar-slice="fidelity"[^>]*class="pointer-events-auto relative [^"]*before:absolute before:inset-x-0 before:-inset-y-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-\[var\(--color-arco-ink\)\]/)
  assert.doesNotMatch(html, /data-bar-tip|data-emphasis/)
  // The legend is hidden on phones and from screen readers (the buttons carry the names); no "Backing assets" amount.
  assert.match(html, /<div aria-hidden="true" class="hidden [^"]*sm:flex">/)
  const legend = html.slice(html.indexOf('<div aria-hidden="true" class="hidden')).replace(/<!-- -->/g, "")
  for (const label of names) assert.ok(legend.includes(`</span>${label}</span>`), label)
  // Before a slice is tapped there is no line under the bar (and no hint asking for a tap).
  assert.doesNotMatch(html, /data-bar-caption|Tap the bar/)
  assert.doesNotMatch(html, /Backing assets|\$/)
  // Every bar colour is a token, re-scoped per tone in theme.css.
  const theme = readFileSync(new URL("../theme.css", import.meta.url), "utf8")
  for (const tone of ["cream", "gold"]) {
    const block = theme.slice(theme.indexOf(`[data-savings-bar-tone="${tone}"] {`))
    for (const n of [1, 2, 3, 4, 5]) assert.match(block.slice(0, block.indexOf("}")), new RegExp(`--color-savings-bar-${n}: var\\(`))
  }
})

test("backing breakdown: By manager (the Backing tiles with their cards) first; a pressed pill toggle for By asset type", () => {
  const backing = savingsBacking({ symbol: "USDC", icon: null })
  const html = renderToStaticMarkup(<BackingBreakdown backing={backing} exposure={savingsExposure("tUSDC")} totalUsd={50_000} />)
  assert.match(html, /<div role="group" aria-label="Backing"/)
  assert.match(html, /aria-pressed="true"[^>]*>By manager<\/button>/)
  assert.match(html, /aria-pressed="false"[^>]*>By asset type<\/button>/)
  // The managers' tiles take focus (their cards open on pointing or focus), as before.
  assert.match(html, /<ul aria-label="Backing assets"/)
  assert.match(html, /tabindex="0"/)
  assert.doesNotMatch(html, /U\.S\. Treasury/)
  // No amount over the tiles: the backing is the TVL.
  assert.doesNotMatch(html, /\$50K/)
})

test("instant liquidity: the Reserve's payable buffer per coin (stablecoins at $1, gold at the ounce price), else the vault's own coin", () => {
  const asset = (symbol: string, available: number, redeemEnabled = true) => ({
    option: { symbol, logo: `/logos/${symbol.toLowerCase()}.png` },
    available,
    redeemEnabled,
    swapFeeBps: 0,
    instantFeeBps: 100,
  })
  const stable = stablecoinLiquidity({ assets: [asset("USDC", 1000), asset("USDT", 500), asset("RLUSD", 0), asset("PYUSD", 900, false)] } as never)
  // Less the 1% Instant fee; a coin that does not pay out is left out.
  assert.equal(stable.usd, 1485)
  assert.deepEqual(stable.coins.map((coin) => [coin.symbol, coin.amount]), [["USDC", 990], ["USDT", 495], ["RLUSD", 0]])
  // Tiles: shares of what can be paid; a coin with nothing to pay gets none.
  assert.deepEqual(liquiditySlices(stable).map((slice) => [slice.label, Number(slice.percent.toFixed(2))]), [["USDC", 66.67], ["USDT", 33.33]])
  const gold = goldLiquidity({ ounceUsd: 2400, coins: [asset("PAXG", 2), asset("XAUT", 1)] } as never)
  near(gold.usd!, 2.97 * 2400)
  // Without an ounce price: no dollars, the split by ounces still known.
  const unpriced = goldLiquidity({ ounceUsd: null, coins: [asset("PAXG", 2), asset("XAUT", 1)] } as never)
  assert.equal(unpriced.usd, null)
  assert.equal(liquiditySlices(unpriced).length, 2)
  // One coin: all of it, its dollars as read (or unknown).
  assert.deepEqual(liquiditySlices(singleCoinLiquidity("BTC", "/logos/bitcoin.svg", 1840)), [{ id: "BTC", label: "BTC", percent: 100, logo: "/logos/bitcoin.svg" }])
  assert.equal(singleCoinLiquidity("BTC", null, null).usd, null)
  assert.equal(singleCoinLiquidity("BTC", null, Number.NaN).usd, null)
  // Nothing payable at all: no tiles.
  assert.deepEqual(liquiditySlices(stablecoinLiquidity({ assets: [asset("USDC", 0), asset("USDT", 0)] } as never)), [])
})

test("liquidity row: the amount, then the largest coin across the top and the others side by side, each with its share", () => {
  const coin = (symbol: string, logo: string, available: number) => ({ option: { symbol, logo }, available, redeemEnabled: true, swapFeeBps: 0, instantFeeBps: 0 })
  const slices = liquiditySlices(
    stablecoinLiquidity({ assets: [coin("USDT", "/logos/usdt.png", 213), coin("USDC", "/logos/usdc.svg", 4760), coin("RLUSD", "/logos/rlusd.png", 200)] } as never),
  )
  const html = renderToStaticMarkup(<LiquidityBreakdown amountText="$5.17K" slices={slices} />)
  assert.match(html, />Instant liquidity<\/p><p [^>]*>\$5\.17K<\/p>/)
  const text = html.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|")
  assert.match(text, /\|USDC\|92\.02%\|USDT\|4\.12%\|RLUSD\|3\.87%\|/)
  assert.match(html, /<li [^>]*style="[^"]*grid-column:1 \/ -1"/)
  assert.match(html, /grid-template-columns:minmax\(88px, 4\.1[0-9]*fr\) minmax\(88px, 3\.8[0-9]*fr\)/)
  // One coin: one shorter tile at 100%; unknown amounts show the placeholder and no tiles.
  const one = renderToStaticMarkup(<LiquidityBreakdown amountText="—" slices={[{ id: "BTC", label: "BTC", percent: 100, logo: "/logos/bitcoin.svg" }]} />)
  assert.match(one, /h-\[120px\]/)
  assert.match(one, />100%</)
  assert.doesNotMatch(renderToStaticMarkup(<LiquidityBreakdown amountText="—" slices={[]} />), /<ul/)
})

test("treemap: every slice named with its share, managers with their logos", () => {
  const html = renderToStaticMarkup(<AllocationTreemap slices={SAVINGS_BACKING} title="Backing assets" info="x" total="$1.2M" />)
  assert.match(html, /\$1\.2M/)
  for (const slice of SAVINGS_BACKING) {
    assert.match(html, new RegExp(`>${slice.label.replace(/[&]/g, "&amp;")}</span>`))
    assert.match(html, new RegExp(`>${slice.percent}%</span>`))
  }
  assert.match(html, /fidelity\.png/)
  assert.match(html, /umint\.svg/)
  // Without details (the Exposure tiles) a tile only names itself on hover, natively, and takes no focus.
  assert.match(html, /title="Fidelity · 40%"/)
  assert.doesNotMatch(html, /tabindex=/)
})

test("backing details: who manages each slice, what it is held in (as DigiFT names it) and on which chain", () => {
  const backing = savingsBacking({ symbol: "USDC", icon: "/logos/usdc.svg" })
  assert.deepEqual(backing.map((slice) => [slice.id, slice.percent]), SAVINGS_BACKING.map((slice) => [slice.id, slice.percent]))
  const rows = backing.map((slice) => [slice.id, slice.detail?.manager.role, slice.detail?.manager.name, slice.detail?.asset.name, slice.detail?.asset.symbol])
  assert.deepEqual(rows, [
    ["fidelity", "Asset manager", "Fidelity", "Reserve-Grade US Treasury Strategy Token", "RRDY"],
    ["ubs", "Asset manager", "UBS", "UBS (SG) Global Opportunities VCC - UBS Money Market (USD)", "uMINT"],
    ["franklin-templeton", "Asset manager", "Franklin Templeton", "Franklin OnChain Institutional Liquidity Fund", "iBENJI"],
    ["loans", "Protocol", "Morpho", "Crypto & RWA-backed loans", null],
    ["reserve", "Asset manager", "Arco", "Instant liquidity reserve", "USDC"],
  ])
  // The fund tokens' own marks; every asset is issued on Ethereum; every mark is a file in public/.
  assert.deepEqual(backing.map((slice) => slice.detail?.asset.logo), ["/logos/rrdy.png", "/logos/umint.svg", "/logos/ibenji.svg", null, "/logos/usdc.svg"])
  for (const slice of backing) {
    assert.equal(slice.detail?.chain.name, "Ethereum")
    for (const logo of [slice.detail?.manager.logo, slice.detail?.asset.logo, slice.detail?.chain.logo]) {
      if (logo) assert.ok(existsSync(new URL(`../../../public${logo}`, import.meta.url)), logo)
    }
  }
  // The reserve is held in the account's own coin.
  const ethBacking = savingsBacking({ symbol: "ETH", icon: "/logos/aeth.png" })
  assert.equal(ethBacking[ethBacking.length - 1]?.detail?.asset.symbol, "ETH")
})

test("backing card: the asset's name, then its manager, the token, chain, value and share; placed beside its tile", () => {
  const slice = savingsBacking({ symbol: "USDC", icon: null })[0]!
  const html = renderToStaticMarkup(<BackingCard id="card" slice={slice} detail={slice.detail!} value={sliceValue(slice.percent, 50_000)} />)
  assert.match(html, /role="tooltip"/)
  // The title is the asset's name alone; its ticker (with the token's mark) is the Asset row, under the manager.
  const text = html.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|")
  assert.equal(text, "|Reserve-Grade US Treasury Strategy Token|Asset manager|Fidelity|Asset|RRDY|Chain|Ethereum|Allocation|$20K|Share|40%|")
  assert.match(html, /src="\/logos\/rrdy\.png"/)
  assert.match(html, /src="\/logos\/powered-by\/fidelity\.png"/)
  assert.match(html, /src="\/logos\/ethereum\.svg"/)
  assert.equal(sliceValue(10, null), null)
  // The loans have no mark of their own: the card shows Morpho's.
  const loans = savingsBacking({ symbol: "USDC", icon: null })[3]!
  const loansCard = renderToStaticMarkup(<BackingCard id="card" slice={loans} detail={loans.detail!} value="$10K" />)
  assert.match(loansCard, /^<div[^>]*>(?:(?!<dl).)*src="\/logos\/powered-by\/morpho\.png"/s)
  // They hold no token of their own, so no Asset row.
  assert.doesNotMatch(loansCard, />Asset</)
  // Beside the tile on its right when there is room, else on its left, else over it inside the grid.
  assert.deepEqual(cardPlacement({ left: 0, top: 10, width: 300, height: 200 }, 900), { left: 308, top: 10 })
  assert.deepEqual(cardPlacement({ left: 600, top: 0, width: 300, height: 100 }, 900), { left: 304, top: 0 })
  assert.deepEqual(cardPlacement({ left: 20, top: 40, width: 300, height: 100 }, 340), { left: 28, top: 48 })
  // In a grid with details, the tiles take focus and leave the naming to the card.
  const grid = renderToStaticMarkup(<AllocationTreemap slices={savingsBacking({ symbol: "USDC", icon: null })} title="Backing assets" info="x" total={null} />)
  assert.match(grid, /tabindex="0"/)
  assert.doesNotMatch(grid, /title="Fidelity · 40%"/)
})

test("simulation section: earnings and balance over five years at the APY", () => {
  const expected = simulateSavings({ apyPercent: 4.79, startingBalance: 0, initialDeposit: 1000, recurringDeposit: 500, frequency: "monthly" })[60]!
  const html = renderToStaticMarkup(<SavingsSimulation apyPercent={4.79} startingBalance={0} maxDeposit={null} />)
  assert.match(html, /Earn over 5 years/)
  assert.match(html, new RegExp(usd(expected.earned).replace(/[$.]/g, "\\$&")))
  assert.match(html, new RegExp(usd(expected.balance).replace(/[$.]/g, "\\$&")))
  assert.doesNotMatch(html, />MAX</)
  assert.match(renderToStaticMarkup(<SavingsSimulation apyPercent={4.79} startingBalance={0} maxDeposit={250} />), />MAX</)
  assert.match(renderToStaticMarkup(<SavingsSimulation apyPercent={null} startingBalance={0} maxDeposit={null} />), /The APY is not known yet/)
})

test("figures row: APY, TVL and Instant liquidity; on phones the APY across, the other two side by side", () => {
  const html = renderToStaticMarkup(<SavingsStatsRow apyText="4.79%" history={undefined} tvlText="$12.4K" liquidityText="$1.24K" />)
  assert.match(html, />4\.79%</)
  assert.match(html, />TVL/)
  assert.match(html, />\$12\.4K</)
  assert.match(html, /<svg[^>]*lucide-zap[^>]*>.*?<\/svg>Instant liquidity<\/p><p [^>]*>\$1\.24K<\/p>/)
  assert.match(html, /^<div class="grid w-full grid-cols-2 [^"]*sm:grid-cols-\[minmax\(0,1fr\)_auto_auto\]">/)
  assert.match(html, /<div class="group\/apy relative col-span-2 [^"]*sm:col-span-1">/)
  // Unknown: the page's placeholder.
  assert.match(renderToStaticMarkup(<SavingsStatsRow apyText="4.79%" history={undefined} tvlText="$12.4K" />), /Instant liquidity<\/p><p [^>]*>—<\/p>/)
  assert.match(html, /APY Details/)
  assert.doesNotMatch(html, /Users/)
  // With a history: the change over the line beside the APY (no date until the line is pointed at).
  const history = {
    productId: "sarcousd",
    apy: null,
    points: [0, 1, 2].map((day) => ({ t: Math.floor(Date.now() / 1000) - (2 - day) * 86_400, navBase: 1, navUsd: 1, apy: [3.8, 4.2, 4.6][day] })),
  }
  const withLine = renderToStaticMarkup(<SavingsStatsRow apyText="4.6%" history={history} tvlText="$1K" />)
  assert.match(withLine, />4\.6%</)
  // Up in green.
  assert.match(withLine, /text-\[var\(--color-arco-up-text\)\][^>]*>.*0\.8%/)
  const falling = { ...history, points: history.points.map((point, i) => ({ ...point, apy: [4.6, 4.2, 3.8][i] })) }
  // Down in red.
  assert.match(renderToStaticMarkup(<SavingsStatsRow apyText="3.8%" history={falling} tvlText="$1K" />), /text-\[var\(--color-arco-down\)\][^>]*>.*0\.8%/)
  assert.doesNotMatch(withLine, /, 20\d\d</)
})

test("savings card: with several coins to deposit, what is available is their total, the coins held stacked beside it", () => {
  const html = renderToStaticMarkup(
    <SavingsHeroCard
      {...heroProps({
        connected: true,
        available: 9_000,
        availableUsd: 29_005,
        availableCoins: [
          { icon: "/logos/rlusd.png", symbol: "RLUSD" },
          { icon: "/logos/usdc.svg", symbol: "USDC" },
        ],
      })}
    />,
  )
  assert.match(html, /\$29,005/)
  const stack = html.slice(html.indexOf("data-coin-stack"))
  assert.deepEqual([...stack.matchAll(/<img src="([^"]+)" alt="([^"]+)"/g)].map((match) => [match[2], match[1]]), [
    ["RLUSD", "/logos/rlusd.png"],
    ["USDC", "/logos/usdc.svg"],
  ])
  // Tucked under each other, the first on top, with no dark ring around them; the pay coin's own mark is not repeated.
  assert.match(stack, /<span class="relative inline-flex -ml-1\.5" style="z-index:1">/)
  assert.doesNotMatch(stack, /ring-2|color-arco-hero/)
  assert.equal(html.split('width="20"').length - 1, 2)
  // A single coin held: its own mark, no stack. None held: the pay coin's own mark, as before.
  const one = renderToStaticMarkup(
    <SavingsHeroCard {...heroProps({ connected: true, available: 0, availableUsd: 10_000, availableCoins: [{ icon: "/logos/usdt.png", symbol: "USDT" }] })} />,
  )
  assert.doesNotMatch(one, /data-coin-stack/)
  assert.match(one, /<img src="\/logos\/usdt\.png" alt="USDT" title="USDT" width="20" height="20"/)
  assert.doesNotMatch(one, /alt="USDC"/)
  const none = renderToStaticMarkup(<SavingsHeroCard {...heroProps({ connected: true, available: 500, availableUsd: 500, availableCoins: [] })} />)
  assert.doesNotMatch(none, /data-coin-stack/)
  assert.match(none, /<img src="\/logos\/usdc\.svg" alt="USDC" title="USDC" width="20" height="20"/)
})

test("savings card: the Earning dot beats like a heart with a halo fading out of it, and stays still under reduced motion", () => {
  const html = renderToStaticMarkup(<SavingsHeroCard {...heroProps({ connected: true, balanceUsd: 100, shares: 99.98 })} />)
  assert.match(
    html,
    /<span aria-hidden="true" class="relative inline-flex size-1\.5 shrink-0"><span class="savings-heartbeat-halo absolute inset-0 [^"]*"><\/span><span class="savings-heartbeat-dot relative [^"]*"><\/span><\/span>Earning/,
  )
  // Nothing beats before there is a balance (no Earning chip).
  assert.doesNotMatch(renderToStaticMarkup(<SavingsHeroCard {...heroProps({ connected: true, balanceUsd: 0, shares: 0 })} />), /savings-heartbeat/)
  const theme = readFileSync(new URL("../theme.css", import.meta.url), "utf8")
  assert.match(theme, /\.savings-heartbeat-dot \{\s*transform-origin: center;\s*animation: savings-heartbeat-dot 1\.6s ease-in-out infinite;/)
  assert.match(theme, /@keyframes savings-heartbeat-dot \{/)
  assert.match(theme, /@keyframes savings-heartbeat-halo \{/)
  const reduced = theme.slice(theme.lastIndexOf("@media (prefers-reduced-motion: reduce)"))
  assert.match(reduced, /\.savings-heartbeat-dot,\s*\.arco-demo \.savings-heartbeat-halo,/)
  assert.match(reduced, /\.savings-heartbeat-halo \{ opacity: 0; \}/)
})

test("BTC savings: the coin shows Bitcoin's own mark; the aBTC token has its own", async () => {
  const { paymentAssetIcon } = await import("./components")
  const { vaultImageFor } = await import("./catalog")
  const { savingsAssetCategory } = await import("./savings-category")
  // "Available BTC" and the coin a deposit spends: the coin's mark, not the savings token's.
  assert.equal(paymentAssetIcon("tBTC"), "/logos/bitcoin.svg")
  // The aBTC token (no image set in the Vault Config): its own mark.
  assert.equal(vaultImageFor({ productId: "abtc", vaultConfig: null } as never), "/logos/abtc.png")
  for (const file of ["bitcoin.svg", "abtc.png"]) {
    assert.ok(readFileSync(new URL(`../../../public/logos/${file}`, import.meta.url)).length > 0, file)
  }
  // It sits with ETH and XRP under Crypto.
  assert.equal(savingsAssetCategory("BTC"), "crypto-native")
})
