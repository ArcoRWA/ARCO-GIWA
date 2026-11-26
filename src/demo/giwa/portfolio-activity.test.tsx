import assert from "node:assert/strict"
import test from "node:test"
import { reserveEventWallet, savingsEventWallet, withActivityWallet } from "../../../server/src/arcousd/activity"
import { ARCOGOLD_HOLDING, SARCOUSD_HOLDING, buildActivityFeed, type ActivityRow } from "./activity-feed"
import {
  activityAssetUsd, activityDayLabel, activitySummary, activityTimeLabel, activityUsd, filterActivity, groupActivityByDay,
} from "./portfolio-activity"
import {
  arcoGoldPrincipalFlows, catalogPrincipalFlows, principalFromFlows, principalTotals, principalUsd, sArcoUsdPrincipalFlows,
} from "./portfolio-principal"
import type { GiwaMarketEntry } from "./api"
import type { GiwaActivity, GiwaCatalogItem, GiwaRedemption } from "./types"

const e18 = (n: number) => (BigInt(Math.round(n * 1e6)) * 10n ** 12n).toString()
const e6 = (n: number) => BigInt(Math.round(n * 1e6)).toString()
const WALLET = "0xaaaa00000000000000000000000000000000aaaa"
const DEP = "0xdep0000000000000000000000000000000000001"
const RED = "0xred0000000000000000000000000000000000002"
const SARCO = "0xcaef04fea7f9c2561dbca95e39a6b06043df30fd"
const ZAP = "0xf4554ea97218645cf2eb209cd540bd91321ba1e1"
const GOLD = "0xcfbb1da2040bd559b2d7a96f818494d922fb1860"
const GOLD_ZAP = "0x6c67403808dcda693e5b9f2ddf543659ff3f27b4"
const RESERVE = "0x4942711396b53df5b02fd8065e77fa2c9d27512f"
const SAVINGS = { sArcoUSD: { vault: SARCO, zap: ZAP }, arcoGold: { vault: GOLD, zap: GOLD_ZAP } }

const fund = {
  productId: "home",
  symbol: "HOME",
  paymentAsset: { symbol: "tUSDC", name: "Test USDC", decimals: 6 },
  depositVaultAddress: DEP,
  redemptionVaultAddress: RED,
  productTokenAddress: "0xtok",
  vaultConfig: null,
} as unknown as GiwaCatalogItem
let seq = 0
const ev = (eventName: string, contractAddress: string, args: Record<string, unknown>, blockTimestamp: string | null = "2026-11-19T14:36:00Z"): GiwaActivity =>
  ({ eventName, contractAddress, txHash: `0x${(++seq).toString(16).padStart(64, "0")}`, blockNumber: seq, blockTimestamp, args })
const red = (requestId: string, status: string, over: Partial<GiwaRedemption> = {}): GiwaRedemption =>
  ({ requestId, productId: "home", walletAddress: WALLET, redemptionVaultAddress: RED, sharesIn: e18(50), lockedAssetsOut: e6(50.03), status, createdAt: "2026-10-20T17:54:00Z", ...over }) as GiwaRedemption
const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`)
const one = (rows: ActivityRow[]) => { assert.equal(rows.length, 1); return rows[0]! }

test("catalog rows: Deposit in, instant Redemption complete out, each with its token count and the asset it moved", () => {
  const deposit = one(buildActivityFeed([ev("ProductDeposit", DEP, { paymentAssets: e6(100), sharesOut: e18(99.5) })], [], [fund]))
  assert.deepEqual([deposit.typeLabel, deposit.direction, deposit.holding, deposit.tokenAmount, deposit.assetUnits], ["Deposit", "in", "home", 99.5, 100])
  const redeem = one(buildActivityFeed([ev("ProductRedeemInstant", RED, { sharesIn: e18(100), assetsOut: e6(100.42) })], [], [fund]))
  assert.deepEqual([redeem.typeLabel, redeem.direction, redeem.tokenAmount, redeem.assetUnits], ["Redemption complete", "out", 100, 100.42])
  // A catalog product the feed cannot resolve keeps its row, with no asset amount (never a guess).
  const stray = one(buildActivityFeed([ev("ProductDeposit", "0xelse", { paymentAssets: e6(5), sharesOut: e18(5), symbol: "X" })], [], [fund]))
  assert.deepEqual([stray.holding, stray.assetUnits], [null, null])
})

test("redemption requests: requested and settling are pending withdrawals, settled ones are out; valued at the locked assets", () => {
  const feed = buildActivityFeed([], [red("1", "REQUESTED"), red("2", "SETTLING"), red("3", "SETTLED", { settledAt: "2026-10-21T00:00:00Z" })], [fund])
  const byId = (id: string) => feed.find((row) => row.key.endsWith(`:${id}`))!
  assert.deepEqual([byId("1").typeLabel, byId("1").direction], ["Redemption request", "pending"])
  assert.deepEqual([byId("2").typeLabel, byId("2").direction], ["Pending", "pending"])
  assert.deepEqual([byId("3").typeLabel, byId("3").direction], ["Redemption complete", "out"])
  for (const row of feed) { assert.equal(row.assetUnits, 50.03); assert.equal(row.tokenAmount, 50); assert.equal(row.holding, "home") }
})

test("sArcoUSD and ArcoGOLD rows: Zap and direct vault deposits / withdrawals, told apart by contract only", () => {
  const events = [
    ev("ZapDeposit", ZAP, { arcoUSDIn: e18(847), shares: e18(830), walletAddress: WALLET }),
    ev("ZapRedeem", ZAP, { arcoUSDOut: e18(10.02), shares: e18(10), walletAddress: WALLET }),
    ev("Deposit", SARCO, { assets: e18(50), shares: e18(49), walletAddress: WALLET }),
    ev("Withdraw", SARCO, { assets: e18(5), shares: e18(4.9), walletAddress: WALLET }),
    ev("ZapDeposit", GOLD_ZAP, { arcoUSDIn: e18(0.8612), shares: e18(0.7), walletAddress: WALLET }),
    ev("ZapRedeem", GOLD_ZAP, { arcoUSDOut: e18(0.1), shares: e18(0.08), walletAddress: WALLET }),
    ev("Deposit", GOLD, { assets: e18(0.25), shares: e18(0.2), walletAddress: WALLET }),
    ev("Withdraw", GOLD, { assets: e18(0.05), shares: e18(0.04), walletAddress: WALLET }),
  ]
  const feed = buildActivityFeed(events, [], [fund], SAVINGS)
  assert.equal(feed.length, 8)
  const view = feed.map((row) => [row.typeLabel, row.direction, row.holding, row.product.symbol, row.tokenAmount, row.assetUnits])
  assert.deepEqual(view, [
    ["Deposit", "in", SARCOUSD_HOLDING, "sArcoUSD", 830, 847],
    ["Withdraw", "out", SARCOUSD_HOLDING, "sArcoUSD", 10, 10.02],
    ["Deposit", "in", SARCOUSD_HOLDING, "sArcoUSD", 49, 50],
    ["Withdraw", "out", SARCOUSD_HOLDING, "sArcoUSD", 4.9, 5],
    ["Deposit", "in", ARCOGOLD_HOLDING, "ArcoGOLD", 0.7, 0.8612],
    ["Withdraw", "out", ARCOGOLD_HOLDING, "ArcoGOLD", 0.08, 0.1],
    ["Deposit", "in", ARCOGOLD_HOLDING, "ArcoGOLD", 0.2, 0.25],
    ["Withdraw", "out", ARCOGOLD_HOLDING, "ArcoGOLD", 0.04, 0.05],
  ])
  assert.equal(feed[4]!.product.imageUrl, "/logos/arcogold.png")
  assert.equal(feed[0]!.product.imageUrl, "/logos/sarcousd.png")
  // The same rows, the same amounts Supplied counts: the feed's signed asset units net to the principal flows.
  const net = (holding: string) => feed.filter((row) => row.holding === holding).reduce((sum, row) => sum + (row.direction === "in" ? 1 : -1) * row.assetUnits!, 0)
  close(net(SARCOUSD_HOLDING), sArcoUsdPrincipalFlows(events, SAVINGS.sArcoUSD)!.reduce((sum, flow) => sum + flow.units, 0))
  close(net(ARCOGOLD_HOLDING), arcoGoldPrincipalFlows(events, SAVINGS.arcoGold)!.reduce((sum, flow) => sum + flow.units, 0))
  // Before a stack is live its rows are not listed (never shown as some other product).
  assert.deepEqual(buildActivityFeed(events, [], [fund], { sArcoUSD: null, arcoGold: null }), [])
  assert.deepEqual(buildActivityFeed(events, [], [fund], { sArcoUSD: SAVINGS.sArcoUSD, arcoGold: null }).map((row) => row.holding), Array(4).fill(SARCOUSD_HOLDING))
})

test("left out: FaucetDrip, ArcoUSD Reserve mint / redeem rows, request events and operational rows", () => {
  const feed = buildActivityFeed(
    [
      ev("FaucetDrip", "0xfaucet", { amount: e18(9), walletAddress: WALLET }),
      ev("Deposited", RESERVE, { sender: WALLET, recipient: WALLET, assetAmount: e6(10), arcoUSDOut: e18(10), walletAddress: WALLET }),
      ev("RedeemedInstant", RESERVE, { sender: WALLET, arcoUSDIn: e18(4), walletAddress: WALLET }),
      ev("RedeemQueued", RESERVE, { owner: WALLET, walletAddress: WALLET }),
      ev("ProductRedeemRequested", RED, { sharesIn: e18(3), requestId: "1" }),
      ev("PriceUpdated", "0xfeed", {}),
    ],
    [],
    [fund],
    SAVINGS,
  )
  assert.deepEqual(feed, [])
})

test("no double counting: through the server's attribution, one Zap deposit or redeem is one row, its inner steps are nobody's", () => {
  // What the chain emits for one app deposit through the Zap, and for a direct vault deposit and a Zap redeem, as the
  // indexers attribute them (server/src/arcousd/activity.ts) and the activity endpoint returns them (walletAddress = the
  // wallet's own).
  const zapDeposit = [
    { contract: RESERVE, name: "Deposited", args: { sender: ZAP, recipient: ZAP, assetAmount: e6(100), arcoUSDOut: e18(100) } },
    { contract: SARCO, name: "Deposit", args: { sender: ZAP, owner: WALLET, assets: e18(100), shares: e18(98) } },
    { contract: ZAP, name: "ZapDeposit", args: { caller: WALLET, receiver: WALLET, amount: e6(100), arcoUSDIn: e18(100), shares: e18(98) } },
  ]
  const zapRedeem = [
    { contract: SARCO, name: "Withdraw", args: { sender: ZAP, receiver: ZAP, owner: WALLET, assets: e18(20.4), shares: e18(20) } },
    { contract: RESERVE, name: "RedeemedInstant", args: { sender: ZAP, recipient: WALLET, arcoUSDIn: e18(20.4), assetOut: e6(20.4) } },
    { contract: ZAP, name: "ZapRedeem", args: { caller: WALLET, receiver: WALLET, shares: e18(20), arcoUSDOut: e18(20.4), assetOut: e6(20.4) } },
  ]
  const direct = [{ contract: SARCO, name: "Deposit", args: { sender: WALLET, owner: WALLET, assets: e18(5), shares: e18(4.9) } }]
  const goldZap = [
    { contract: GOLD, name: "Deposit", args: { sender: GOLD_ZAP, owner: WALLET, assets: e18(0.5), shares: e18(0.4) } },
    { contract: GOLD_ZAP, name: "ZapDeposit", args: { caller: WALLET, receiver: WALLET, amount: e18(0.51), arcoUSDIn: e18(0.5), shares: e18(0.4) } },
  ]
  const indexed = [...zapDeposit, ...zapRedeem, ...direct].map(({ contract, name, args }) => {
    const wallet = contract === RESERVE ? reserveEventWallet(name, args, { zap: ZAP, router: null }) : savingsEventWallet(name, args, { zap: ZAP })
    return ev(name, contract, withActivityWallet(args as never, wallet) as Record<string, unknown>)
  }).concat(goldZap.map(({ contract, name, args }) => ev(name, contract, withActivityWallet(args as never, savingsEventWallet(name, args, { zap: GOLD_ZAP })) as Record<string, unknown>)))
  // The endpoint: only rows whose walletAddress is the wallet's (PrismaArcoService.activityForWallet).
  const returned = indexed.filter((event) => event.args.walletAddress === WALLET)
  assert.deepEqual(returned.map((event) => event.eventName), ["ZapDeposit", "ZapRedeem", "Deposit", "ZapDeposit"])
  const feed = buildActivityFeed(returned, [], [fund], SAVINGS)
  assert.deepEqual(feed.map((row) => [row.typeLabel, row.holding, row.assetUnits]), [
    ["Deposit", SARCOUSD_HOLDING, 100],
    ["Withdraw", SARCOUSD_HOLDING, 20.4],
    ["Deposit", SARCOUSD_HOLDING, 5],
    ["Deposit", ARCOGOLD_HOLDING, 0.5],
  ])
  close(sArcoUsdPrincipalFlows(returned, SAVINGS.sArcoUSD)!.reduce((sum, flow) => sum + flow.units, 0), 100 - 20.4 + 5)
  // Even handed every row the chain emitted, the feed never lists a Reserve step, and lists a vault step only as the
  // vault's own row: the double count is kept out by the server's attribution, which this pins.
  assert.equal(buildActivityFeed(indexed, [], [fund], SAVINGS).filter((row) => row.holding === SARCOUSD_HOLDING).length, 5)
})

test("rows are valued at today's price: asset units × one unit's dollars, + in, − out; unknown price is null", () => {
  const market = new Map<string, GiwaMarketEntry>([["home", { productId: "home", navBase: 1.0042, navUsd: 1.0042, baseUsd: 1, apy: 5, impliedApy: null } as GiwaMarketEntry]])
  const price = activityAssetUsd({ market, sArcoUsdLive: true, ounceUsd: 4132 })
  assert.equal(price("home"), 1)
  assert.equal(price(SARCOUSD_HOLDING), 1)
  assert.equal(price(ARCOGOLD_HOLDING), 4132)
  assert.equal(price("other"), null)
  assert.equal(price(null), null)
  assert.equal(activityAssetUsd({ market, sArcoUsdLive: false, ounceUsd: null })(ARCOGOLD_HOLDING), null)
  const [gold] = buildActivityFeed([ev("ZapDeposit", GOLD_ZAP, { arcoUSDIn: e18(0.8612), shares: e18(0.7) })], [], [], SAVINGS)
  close(activityUsd(gold!, price)!, 0.8612 * 4132)
  const [out] = buildActivityFeed([ev("ProductRedeemInstant", RED, { sharesIn: e18(100), assetsOut: e6(100.42) })], [], [fund])
  close(activityUsd(out!, price)!, -100.42)
  const [pending] = buildActivityFeed([], [red("9", "REQUESTED")], [fund])
  close(activityUsd(pending!, price)!, -50.03)
  assert.equal(activityUsd(gold!, () => null), null)
})

test("summary: Net supplied is the hero's Supplied; Deposited − Withdrawn = Net supplied to the cent, with a closed position and a partial", () => {
  const sArco = SAVINGS.sArcoUSD
  const closedFund = { ...fund, productId: "closed", depositVaultAddress: "0xdep9", redemptionVaultAddress: "0xred9" } as GiwaCatalogItem
  const now = Date.parse("2026-11-26T00:00:00Z")
  const events = [
    ev("ProductDeposit", DEP, { paymentAssets: e6(1000), sharesOut: e18(1000) }, "2026-06-01T00:00:00Z"),
    ev("ProductRedeemInstant", RED, { sharesIn: e18(200), assetsOut: e6(201.37) }, "2026-09-01T00:00:00Z"),
    ev("ZapDeposit", ZAP, { arcoUSDIn: e18(847), shares: e18(830) }, "2026-09-26T00:00:00Z"),
    ev("ZapRedeem", ZAP, { arcoUSDOut: e18(10.02), shares: e18(10) }, "2026-10-20T00:00:00Z"),
    // A closed position: in and all out (with its interest). Not held, so not in Supplied, nor in the totals.
    ev("ProductDeposit", "0xdep9", { paymentAssets: e6(300), sharesOut: e18(300) }, "2026-03-01T00:00:00Z"),
    ev("ProductRedeemInstant", "0xred9", { sharesIn: e18(300), assetsOut: e6(306.5) }, "2026-08-01T00:00:00Z"),
  ]
  const redemptions = [red("1", "REQUESTED", { lockedAssetsOut: e6(50.03) })]
  // The page's holdings: the fund (navBase 1.03 per share, 749.9 shares) and sArcoUSD (820 shares at 1.0215), plus 50
  // ArcoUSD — principal as PortfolioPage computes it.
  const fundPrincipal = principalUsd(principalFromFlows({ flows: catalogPrincipalFlows(fund, events, redemptions), currentUnits: 749.9 * 1.03, apyPercent: 5, now }), 1)
  const sArcoPrincipal = principalUsd(principalFromFlows({ flows: sArcoUsdPrincipalFlows(events, sArco), currentUnits: 820 * 1.0215, apyPercent: 4.5, now }), 1)
  const arcoUSD = { status: "known", supplied: 50, earned: 0, deposited: 50, suppliedUnits: 50, earnedUnits: 0 } as const
  const totals = principalTotals([fundPrincipal, sArcoPrincipal, arcoUSD])
  assert.equal(totals.partial, false)
  const summary = activitySummary({ supplied: totals.supplied!, deposited: totals.deposited! })
  close(summary.netSupplied, Math.round(totals.supplied! * 100) / 100)
  // Supplied = (1000 − 201.37 − 50.03) + (847 − 10.02) + 50; Deposited = 1000 + 847 + 50; Withdrawn = the rest.
  close(summary.netSupplied, 748.6 + 836.98 + 50, 1e-6)
  close(summary.deposited, 1897, 1e-6)
  close(summary.withdrawn, 201.37 + 50.03 + 10.02, 1e-6)
  assert.equal(Math.round((summary.deposited - summary.withdrawn) * 100), Math.round(summary.netSupplied * 100))
  // The closed position's rows are in the feed, outside the totals.
  const feed = buildActivityFeed(events, redemptions, [fund, closedFund], SAVINGS)
  assert.equal(feed.filter((row) => row.holding === "closed").length, 2)

  // Partial: a holding with no deposit record is left out of both (the hero's rule), the identity still holds.
  const partial = principalTotals([fundPrincipal, { status: "unknown" }])
  assert.equal(partial.partial, true)
  const partialSummary = activitySummary({ supplied: partial.supplied!, deposited: partial.deposited! })
  close(partialSummary.netSupplied, 748.6, 1e-6)
  close(partialSummary.deposited - partialSummary.withdrawn, partialSummary.netSupplied, 1e-9)

  // Rounding dust: the clamp case (position a hair under supplied) still adds up exactly on screen.
  const clamped = principalUsd(principalFromFlows({ flows: [{ units: 1000, at: null }, { units: -400.004, at: null }], currentUnits: 599.99, apyPercent: 5, now }), 1.0000001)
  assert.equal(clamped.status, "known")
  if (clamped.status === "known") {
    const s = activitySummary({ supplied: clamped.supplied, deposited: clamped.deposited })
    assert.equal(Math.round(s.deposited * 100) - Math.round(s.withdrawn * 100), Math.round(s.netSupplied * 100))
  }
})

test("filters: Deposits are money in; Withdrawals are money out and redemptions still pending", () => {
  const feed = buildActivityFeed(
    [ev("ProductDeposit", DEP, { paymentAssets: e6(1), sharesOut: e18(1) }), ev("ZapRedeem", ZAP, { arcoUSDOut: e18(2), shares: e18(2) })],
    [red("1", "REQUESTED"), red("2", "SETTLED")],
    [fund],
    SAVINGS,
  )
  assert.equal(filterActivity(feed, "all").length, 4)
  assert.deepEqual(filterActivity(feed, "deposits").map((row) => row.typeLabel), ["Deposit"])
  assert.deepEqual(filterActivity(feed, "withdrawals").map((row) => row.typeLabel).sort(), ["Redemption complete", "Redemption request", "Withdraw"])
})

test("day groups: newest first by UTC day, undated rows last under 'Date unknown'; labels and times in UTC", () => {
  const feed = buildActivityFeed(
    [
      ev("ProductDeposit", DEP, { sharesOut: e18(1) }, "2026-11-18T05:53:00Z"),
      ev("ProductDeposit", DEP, { sharesOut: e18(1) }, "2026-11-19T14:36:00Z"),
      ev("ProductDeposit", DEP, { sharesOut: e18(1) }, null),
      ev("ProductDeposit", DEP, { sharesOut: e18(1) }, "2026-11-19T23:59:00Z"),
    ],
    [],
    [fund],
  )
  const days = groupActivityByDay(feed)
  assert.deepEqual(days.map((day) => [day.label, day.rows.length]), [["Nov 19, 2026", 2], ["Nov 18, 2026", 1], ["Date unknown", 1]])
  assert.deepEqual(days[0]!.rows.map((row) => activityTimeLabel(row.sortTs)), ["23:59 UTC", "14:36 UTC"])
  assert.equal(activityTimeLabel(0), null)
  assert.equal(activityDayLabel(Date.parse("2026-01-05T00:00:00Z")), "Jan 5, 2026")
})
