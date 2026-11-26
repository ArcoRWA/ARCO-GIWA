import assert from "node:assert/strict"
import test from "node:test"
import {
  arcoGoldPrincipalFlows, catalogPrincipalFlows, plausibleEarnedUnits, principalFromFlows, principalTotals, principalUsd,
  sArcoUsdPrincipalFlows, type PrincipalFlow,
} from "./portfolio-principal"
import type { GiwaActivity, GiwaCatalogItem, GiwaRedemption } from "./types"

const DAY = 86_400_000
const NOW = Date.parse("2026-11-26T00:00:00Z")
const ago = (days: number) => new Date(NOW - days * DAY).toISOString()
const e18 = (n: number) => (BigInt(Math.round(n * 1e6)) * 10n ** 12n).toString()
const e6 = (n: number) => BigInt(Math.round(n * 1e6)).toString()

const fund = {
  productId: "beqty",
  paymentAsset: { symbol: "tUSDC", name: "Test USDC", decimals: 6 },
  depositVaultAddress: "0xDeP0000000000000000000000000000000000001",
  redemptionVaultAddress: "0xRed0000000000000000000000000000000000002",
} as unknown as GiwaCatalogItem
const DEP = "0xdep0000000000000000000000000000000000001"
const RED = "0xred0000000000000000000000000000000000002"
const ev = (eventName: string, contractAddress: string, args: Record<string, unknown>, blockTimestamp: string | null = ago(30)): GiwaActivity =>
  ({ eventName, contractAddress, txHash: "0x0", blockNumber: 1, blockTimestamp, args })
const red = (status: string, lockedAssetsOut: string, productId = "beqty"): GiwaRedemption =>
  ({ requestId: "1", productId, walletAddress: "0xabc", redemptionVaultAddress: RED, sharesIn: "0", lockedAssetsOut, status }) as GiwaRedemption
const sum = (flows: PrincipalFlow[] | null) => flows!.reduce((total, flow) => total + flow.units, 0)
const known = (suppliedUnits: number, earnedUnits: number, depositedUnits: number) => ({ status: "known", suppliedUnits, earnedUnits, depositedUnits })
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`)

test("catalog vault: deposits minus instant redeems and every request-based redemption, in the payment asset", () => {
  const events = [
    ev("ProductDeposit", DEP, { paymentAssets: e6(1000), sharesOut: e18(990) }),
    ev("ProductDeposit", DEP.toUpperCase().replace("0X", "0x"), { paymentAssets: e6(500) }),
    ev("ProductRedeemInstant", RED, { sharesIn: e18(100), assetsOut: e6(101) }),
    // Not this vault's, not a principal movement, or double-counted elsewhere: ignored.
    ev("ProductDeposit", "0xother000000000000000000000000000000000003", { paymentAssets: e6(9999) }),
    ev("ProductRedeemRequested", RED, { assetsOut: e6(50) }),
    ev("FaucetDrip", DEP, { amount: e6(5) }),
  ]
  const redemptions = [red("REQUESTED", e6(50)), red("SETTLING", e6(20)), red("SETTLED", e6(10)), red("CLAIMED", e6(5)), red("SETTLED", e6(777), "other")]
  close(sum(catalogPrincipalFlows(fund, events, redemptions)), 1000 + 500 - 101 - 50 - 20 - 10 - 5)
})

test("catalog vault: a deposit request counts once fulfilled, not while open", () => {
  const requested = (id: string) => ev("ProductDepositRequested", DEP, { requestId: id, paymentAssets: e6(300), sharesOut: e18(300) })
  const open = catalogPrincipalFlows(fund, [requested("7")], [])
  assert.equal(sum(open), 0)
  const done = catalogPrincipalFlows(fund, [requested("7"), ev("ProductDepositFulfilled", DEP, { requestId: "7", sharesOut: e18(300) })], [])
  close(sum(done), 300)
  // A fulfilment on another vault (same request id) does not count.
  assert.equal(sum(catalogPrincipalFlows(fund, [requested("7"), ev("ProductDepositFulfilled", "0xother000000000000000000000000000000000003", { requestId: "7" })], [])), 0)
})

test("catalog vault: unknown decimals or an unreadable amount is unreadable, never zero", () => {
  assert.equal(catalogPrincipalFlows({ ...fund, paymentAsset: null } as GiwaCatalogItem, [], []), null)
  assert.equal(catalogPrincipalFlows(fund, [ev("ProductDeposit", DEP, { paymentAssets: "abc" })], []), null)
  assert.equal(catalogPrincipalFlows(fund, [], [red("REQUESTED", "-5")]), null)
  assert.deepEqual(principalFromFlows({ flows: null, currentUnits: 10, apyPercent: 5, now: NOW }), { status: "unknown", reason: "unreadable" })
})

test("sArcoUSD: Zap deposits / redeems on the Zap and the vault's own Deposit / Withdraw, in ArcoUSD", () => {
  const VAULT = "0xcAEF04FeA7f9c2561dbCA95E39a6b06043df30Fd", ZAP = "0xf4554ea97218645cF2EB209Cd540BD91321ba1E1"
  const events = [
    ev("ZapDeposit", ZAP.toLowerCase(), { amount: e6(1000), arcoUSDIn: e18(999), shares: e18(980) }),
    ev("ZapRedeem", ZAP.toLowerCase(), { shares: e18(100), arcoUSDOut: e18(102), assetOut: e6(101.9) }),
    ev("Deposit", VAULT.toLowerCase(), { assets: e18(50), shares: e18(49) }),
    ev("Withdraw", VAULT.toLowerCase(), { assets: e18(10), shares: e18(9.8) }),
    // A gold Zap's rows (same names, other contract) are not sArcoUSD's.
    ev("ZapDeposit", "0x6c67403808dcda693e5b9f2ddf543659ff3f27b4", { arcoUSDIn: e18(7) }),
  ]
  close(sum(sArcoUsdPrincipalFlows(events, { vault: VAULT, zap: ZAP })), 999 - 102 + 50 - 10)
})

test("ArcoGOLD: Zap and direct vault rows in ounces, told apart from sArcoUSD only by contract; no rows → unknown", () => {
  const VAULT = "0xCfBB1da2040Bd559B2d7a96F818494d922Fb1860", ZAP = "0x6C67403808DCDA693e5B9f2ddF543659FF3f27B4"
  const events = [
    ev("ZapDeposit", ZAP.toLowerCase(), { asset: "0xpaxg", amount: e18(2.01), arcoUSDIn: e18(2), shares: e18(1.6) }),
    ev("ZapRedeem", ZAP.toLowerCase(), { shares: e18(0.4), arcoUSDOut: e18(0.5), assetOut: e6(0.499) }),
    ev("Deposit", VAULT.toLowerCase(), { assets: e18(0.25), shares: e18(0.2) }),
    ev("Withdraw", VAULT.toLowerCase(), { assets: e18(0.05), shares: e18(0.04) }),
    ev("ZapDeposit", "0xf4554ea97218645cf2eb209cd540bd91321ba1e1", { arcoUSDIn: e18(1000) }),
  ]
  const flows = arcoGoldPrincipalFlows(events, { vault: VAULT, zap: ZAP })
  close(sum(flows), 2 - 0.5 + 0.25 - 0.05)
  // 1.7 oz supplied, the position worth 1.72 oz now: 0.02 oz earned, valued at today's ounce price.
  const principal = principalFromFlows({ flows, currentUnits: 1.72, apyPercent: 3.1, now: NOW })
  assert.equal(principal.status, "known")
  const usd = principalUsd(principal, 2400)
  assert.equal(usd.status, "known")
  if (usd.status === "known") { close(usd.supplied, 1.7 * 2400); close(usd.earned, 0.02 * 2400); close(usd.supplied + usd.earned, 1.72 * 2400) }
  // Before the server indexes gold: no rows, so the holding's principal is unknown (shown "—"), not zero.
  assert.deepEqual(principalFromFlows({ flows: arcoGoldPrincipalFlows([], { vault: VAULT, zap: ZAP }), currentUnits: 1.72, apyPercent: 3.1, now: NOW }), { status: "unknown", reason: "no-records" })
  assert.deepEqual(principalUsd({ status: "unknown", reason: "no-records" }, 2400), { status: "unknown" })
})

test("supplied + earned = current value, and a price move of the asset is never earned", () => {
  const flows = [{ units: 0.5, at: NOW - 200 * DAY }]
  const principal = principalFromFlows({ flows, currentUnits: 0.51, apyPercent: 4, now: NOW })
  close((principal as { earnedUnits: number }).earnedUnits, 0.01)
  for (const price of [60_000, 90_000]) {
    const usd = principalUsd(principal, price)
    assert.equal(usd.status, "known")
    if (usd.status === "known") { close(usd.supplied + usd.earned, 0.51 * price); close(usd.earned, 0.01 * price) }
  }
  assert.deepEqual(principalUsd(principal, null), { status: "unknown" }, "no price: unknown")
})

test("mixed deposits and withdrawals net out; dust either side of exact is fine", () => {
  const flows = [{ units: 1000, at: NOW - 100 * DAY }, { units: -400, at: null }, { units: 200, at: NOW - 10 * DAY }]
  assert.deepEqual(principalFromFlows({ flows, currentUnits: 812, apyPercent: 5, now: NOW }), known(800, 12, 1200))
  assert.deepEqual(principalFromFlows({ flows, currentUnits: 799.99, apyPercent: 5, now: NOW }), known(799.99, 0, 1200), "a hair below: nothing earned")
})

test("negative earned beyond dust (tokens sent away, or a loss) is unknown, never a negative figure", () => {
  assert.deepEqual(principalFromFlows({ flows: [{ units: 1000, at: NOW - DAY }], currentUnits: 900, apyPercent: 5, now: NOW }), { status: "unknown", reason: "below-supplied" })
  assert.deepEqual(principalFromFlows({ flows: [{ units: 1000, at: NOW - DAY }, { units: -1000, at: null }], currentUnits: 50, apyPercent: 5, now: NOW }), { status: "unknown", reason: "no-records" })
})

test("a transfer-in the records cannot explain is unknown; plausible yield is not", () => {
  // Held a year at 5%: 5% earned is plausible.
  assert.equal(principalFromFlows({ flows: [{ units: 1000, at: NOW - 365 * DAY }], currentUnits: 1050, apyPercent: 5, now: NOW }).status, "known")
  // Deposited 10 days ago, 40% more in the position: a transfer-in.
  assert.deepEqual(principalFromFlows({ flows: [{ units: 1000, at: NOW - 10 * DAY }], currentUnits: 1400, apyPercent: 5, now: NOW }), { status: "unknown", reason: "unexplained-balance" })
  // No deposit on record at all.
  assert.deepEqual(principalFromFlows({ flows: [], currentUnits: 10, apyPercent: 5, now: NOW }), { status: "unknown", reason: "no-records" })
  // The bound: at least a quarter year at max(20%, 2 × APY); a year when no deposit is dated.
  close(plausibleEarnedUnits(1000, 5, NOW - DAY, NOW), 1000 * (Math.pow(1.2, 0.25) - 1))
  close(plausibleEarnedUnits(1000, 15, NOW - 2 * 365 * DAY, NOW), 1000 * (Math.pow(1.3, 2) - 1))
  close(plausibleEarnedUnits(1000, null, null, NOW), 200)
})


test("totals: sums of the known holdings, partial when some are unknown, nothing while any is loading", () => {
  const a = { status: "known", supplied: 100, earned: 5, deposited: 120, suppliedUnits: 100, earnedUnits: 5 } as const
  const b = { status: "known", supplied: 50, earned: 1, deposited: 50, suppliedUnits: 0.0005, earnedUnits: 0.00001 } as const
  assert.deepEqual(principalTotals([a, b]), { supplied: 150, earned: 6, deposited: 170, partial: false, loading: false })
  assert.deepEqual(principalTotals([a, { status: "unknown" }]), { supplied: 100, earned: 5, deposited: 120, partial: true, loading: false })
  assert.deepEqual(principalTotals([{ status: "unknown" }]), { supplied: null, earned: null, deposited: null, partial: false, loading: false })
  assert.deepEqual(principalTotals([a, { status: "loading" }]), { supplied: null, earned: null, deposited: null, partial: false, loading: true })
  assert.deepEqual(principalTotals([]), { supplied: 0, earned: 0, deposited: 0, partial: false, loading: false })
})

test("the units behind the dollars: in the holding's own asset, supplied + earned = what the position is worth in it", () => {
  // sArcoUSD, in ArcoUSD (a dollar each): 1,000 zapped in, the position worth 1,021.5 ArcoUSD now.
  const SARCO = "0xcAEF04FeA7f9c2561dbCA95E39a6b06043df30Fd", SZAP = "0xf4554ea97218645cF2EB209Cd540BD91321ba1E1"
  const sArco = principalUsd(principalFromFlows({
    flows: sArcoUsdPrincipalFlows([ev("ZapDeposit", SZAP, { arcoUSDIn: e18(1_000) }, ago(200))], { vault: SARCO, zap: SZAP }),
    currentUnits: 1_021.5, apyPercent: 4.5, now: NOW,
  }), 1)
  assert.equal(sArco.status, "known")
  if (sArco.status === "known") { close(sArco.suppliedUnits, 1_000); close(sArco.earnedUnits, 21.5); close(sArco.supplied, 1_000); close(sArco.earned, 21.5) }
  // A catalog vault paid in tBTC (8 decimals): 0.05 tBTC in, worth 0.0512 tBTC now, at $92,000 a tBTC.
  const btcVault = { ...fund, productId: "abtc", paymentAsset: { symbol: "tBTC", name: "Test BTC", decimals: 8 } } as unknown as GiwaCatalogItem
  const btc = principalUsd(principalFromFlows({
    flows: catalogPrincipalFlows(btcVault, [ev("ProductDeposit", DEP, { paymentAssets: String(5_000_000) }, ago(200))], []),
    currentUnits: 0.0512, apyPercent: 2.4, now: NOW,
  }), 92_000)
  assert.equal(btc.status, "known")
  if (btc.status === "known") {
    close(btc.suppliedUnits, 0.05); close(btc.earnedUnits, 0.0012)
    close(btc.suppliedUnits + btc.earnedUnits, 0.0512)
    close(btc.supplied, 0.05 * 92_000); close(btc.earned, 0.0012 * 92_000)
  }
  // ArcoGOLD, in troy ounces: 1.7 oz in, worth 1.72 oz now, at $2,400 an ounce.
  const GVAULT = "0xCfBB1da2040Bd559B2d7a96F818494d922Fb1860", GZAP = "0x6C67403808DCDA693e5B9f2ddF543659FF3f27B4"
  const gold = principalUsd(principalFromFlows({
    flows: arcoGoldPrincipalFlows([ev("ZapDeposit", GZAP, { arcoUSDIn: e18(1.7) }, ago(100))], { vault: GVAULT, zap: GZAP }),
    currentUnits: 1.72, apyPercent: 3.1, now: NOW,
  }), 2_400)
  assert.equal(gold.status, "known")
  if (gold.status === "known") { close(gold.suppliedUnits, 1.7); close(gold.earnedUnits, 0.02); close(gold.earned, 0.02 * 2_400) }
  // Within dust below what was supplied: the position is the supplied, nothing earned, in units too.
  const flat = principalUsd(principalFromFlows({ flows: [{ units: 100, at: null }], currentUnits: 99.995, apyPercent: 4, now: NOW }), 1)
  if (flat.status === "known") { close(flat.suppliedUnits, 99.995); assert.equal(flat.earnedUnits, 0) } else assert.fail("known")
  // Unknown principal: no units at all.
  assert.deepEqual(principalUsd({ status: "unknown", reason: "no-records" }, 92_000), { status: "unknown" })
  assert.deepEqual(principalUsd(principalFromFlows({ flows: [], currentUnits: 1, apyPercent: 4, now: NOW }), 1), { status: "unknown" })
})
