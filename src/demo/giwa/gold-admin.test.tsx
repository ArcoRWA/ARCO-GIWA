import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { asSurplusPreview, GoldAdminView } from "./AdminGold"
import { surplusToAdd } from "./arcousd-admin"
import {
  bpsPercentText,
  goldApyText,
  goldCover,
  goldHeadline,
  goldLiquidity,
  goldNextDistribution,
  goldRateNote,
  goldSurplusStanding,
  goldTimeText,
  goldYieldPauseRows,
  roundUpOunces,
  goldReservePauseRows,
  goldVaultPauseRows,
  mintHeadroomOunces,
  ounceSourceLabel,
  ouncesLabel,
  ouncesText,
  sharePercentText,
  waitText,
} from "./gold-admin"
import type { GiwaArcoGoldReserve, GiwaArcoGoldSavings, GiwaArcoGoldYield } from "./types"
import { VAULT_TABS } from "../../admin/console-model"

const VAULT = {
  blockNumber: "41760000",
  totalAssets: "12500000000000000000",
  totalAssetsOunces: "12.5",
  totalSupply: "12400000000000000000",
  sharePrice: "1008064516129032258",
  sharePriceHuman: "1.008064516129032258",
  seeded: true,
  vaultPaused: false,
  depositPaused: false,
  withdrawPaused: false,
  depositsOpen: true,
  withdrawalsOpen: true,
}

function savings(over: Partial<GiwaArcoGoldSavings> = {}, vault: Partial<typeof VAULT> = {}): GiwaArcoGoldSavings {
  return {
    status: "live",
    chainId: 91342,
    contracts: { arcoGOLD: "0x1111111111111111111111111111111111111111", zap: "0x2222222222222222222222222222222222222222", unit: "0x3333333333333333333333333333333333333333", reserve: "0x4444444444444444444444444444444444444444" },
    readAt: "2026-11-20T08:00:00.000Z",
    savings: { ...VAULT, ...vault },
    apyPercent: 4,
    ounceUsd: 4000,
    ounceUsdSource: "coingecko:pax-gold",
    sharePriceUsd: 4032.26,
    totalAssetsUsd: "50000",
    ...over,
  }
}

function reserve(over: Partial<NonNullable<GiwaArcoGoldReserve["reserve"]>> = {}): GiwaArcoGoldReserve {
  return {
    status: "live",
    chainId: 91342,
    contracts: { unit: "0x3333333333333333333333333333333333333333", reserve: "0x4444444444444444444444444444444444444444", lens: "0x5555555555555555555555555555555555555555" },
    readAt: "2026-11-20T08:00:00.000Z",
    reserve: {
      blockNumber: "41760000",
      totalBacking: "13000000000000000000",
      totalLiabilities: "12500000000000000000",
      totalBackingOunces: "13",
      totalLiabilitiesOunces: "12.5",
      reservePaused: false,
      depositPaused: false,
      redeemPaused: false,
      redeemInstantOnlyPaused: false,
      arcoUSDPaused: false,
      arcoUSDMintPaused: false,
      arcoUSDBurnPaused: false,
      settlementPaused: false,
      queuePaused: false,
      mmfBps: 0,
      mmfTargetBps: 0,
      bufferFloorBps: 10000,
      queueMinDelay: 600,
      mintCap: "100000000000000000000000",
      assets: [
        {
          symbol: "tXAUT",
          address: "0x6666666666666666666666666666666666666666",
          decimals: 6,
          depositEnabled: true,
          redeemEnabled: true,
          instantFeeBps: 10,
          swapFeeBps: 0,
          balance: "13000000",
          queued: "500000",
          available: "12500000",
          balanceHuman: "13",
          queuedHuman: "0.5",
          availableHuman: "12.50834",
          queueLength: 2,
          queueHead: 1,
          queueBacklog: 1,
        },
      ],
      ...over,
    },
  }
}

test("gold admin: ounces show up to 4 decimals with no forced trailing zeros", () => {
  assert.equal(ouncesText("12.5"), "12.5")
  assert.equal(ouncesText("0.00834999"), "0.0083")
  assert.equal(ouncesText("1234.56789"), "1,234.5679")
  assert.equal(ouncesText(7), "7")
  assert.equal(ouncesText(null), "—")
  assert.equal(ouncesText("abc"), "—")
  assert.equal(ouncesLabel("0.5"), "0.5 oz")
  assert.equal(ouncesLabel(undefined), "—")
})

test("gold admin: display rate and ounce source read in words", () => {
  assert.equal(goldApyText(4), "4%")
  assert.equal(goldApyText(4.256), "4.26%")
  assert.equal(goldApyText(null), "Not set")
  assert.equal(ounceSourceLabel("coingecko:pax-gold"), "PAX Gold on CoinGecko")
  assert.equal(ounceSourceLabel("kraken:paxg"), "PAX Gold on Kraken (fallback)")
  assert.equal(ounceSourceLabel(""), "—")
})

test("gold admin: cover is backing less what is owed", () => {
  assert.deepEqual(goldCover({ totalBackingOunces: "13", totalLiabilitiesOunces: "12.5" }), { surplusOunces: 0.5, covered: true })
  assert.deepEqual(goldCover({ totalBackingOunces: "12", totalLiabilitiesOunces: "12" }), { surplusOunces: 0, covered: true })
  assert.equal(goldCover({ totalBackingOunces: "11", totalLiabilitiesOunces: "12" })?.covered, false)
  assert.equal(goldCover({ totalBackingOunces: "x", totalLiabilitiesOunces: "12" }), null)
})

test("gold admin: headline says whether deposits and withdrawals are open", () => {
  assert.equal(goldHeadline(null).label, "Loading")
  assert.equal(goldHeadline(savings({ status: "not-deployed", savings: null })).label, "Not deployed")
  assert.equal(goldHeadline(savings({ status: "unavailable", savings: null })).label, "Unavailable")
  assert.equal(goldHeadline(savings()).label, "Open")
  assert.equal(goldHeadline(savings({}, { seeded: false, depositsOpen: false })).label, "Not seeded")
  assert.equal(goldHeadline(savings({}, { depositsOpen: false })).label, "Deposits paused")
  assert.equal(goldHeadline(savings({}, { withdrawalsOpen: false })).label, "Withdrawals paused")
  assert.equal(goldHeadline(savings({}, { depositsOpen: false, withdrawalsOpen: false })).label, "Paused")
})

test("gold admin: pause lists carry each switch", () => {
  const vaultRows = goldVaultPauseRows({ ...VAULT, withdrawPaused: true })
  assert.deepEqual(vaultRows.map((row) => [row.label, row.paused]), [
    ["ArcoGOLD deposit", false],
    ["ArcoGOLD withdraw", true],
    ["ArcoGOLD (all)", false],
  ])
  const reserveRows = goldReservePauseRows({ ...reserve().reserve!, redeemInstantOnlyPaused: true, arcoUSDMintPaused: true })
  assert.equal(reserveRows.length, 9)
  assert.deepEqual(reserveRows.filter((row) => row.paused).map((row) => row.label), ["Reserve instant redeem", "ArcoXAU mint"])
})

test("gold admin: the page shows totals, cover, coins and contracts", () => {
  const html = renderToStaticMarkup(<GoldAdminView savings={savings()} reserve={reserve()} />)
  assert.match(html, /Admin · Gold/)
  assert.match(html, /Deposits and withdrawals are open/)
  assert.match(html, /12\.5 oz/)
  assert.match(html, /\$50,000 at the ounce price/)
  assert.match(html, /1\.0081 oz/)
  assert.match(html, /\$4,000/)
  assert.match(html, /PAX Gold on CoinGecko/)
  assert.match(html, /Fully backed/)
  assert.match(html, /tXAUT/)
  assert.match(html, /12\.5083/)
  assert.match(html, /0\.1%/)
  assert.match(html, /0x1111…1111/)
  assert.match(html, /0x5555…5555/)
  assert.doesNotMatch(html, /<button/)
})

test("gold admin: an under-backed reserve and a paused vault are called out", () => {
  const html = renderToStaticMarkup(
    <GoldAdminView
      savings={savings({}, { withdrawPaused: true, withdrawalsOpen: false })}
      reserve={reserve({ totalBackingOunces: "12", totalLiabilitiesOunces: "12.5" })}
    />,
  )
  assert.match(html, /Withdrawals paused/)
  assert.match(html, /Under-backed/)
  assert.match(html, /-0\.5 oz/)
  assert.match(html, /Paused/)
})

test("gold admin: not deployed and failed reads say so instead of showing zeros", () => {
  const html = renderToStaticMarkup(
    <GoldAdminView
      savings={savings({ status: "not-deployed", savings: null, contracts: null, ounceUsd: null, sharePriceUsd: null, totalAssetsUsd: null, apyPercent: null })}
      reserve={null}
      reserveError="Request failed"
    />,
  )
  assert.match(html, /Not deployed/)
  assert.match(html, /The gold Reserve could not be loaded: Request failed/)
  assert.match(html, /No price from the rate source/)
  assert.doesNotMatch(html, /0 oz/)
})

test("gold admin: the console menu lists Gold after ArcoUSD", () => {
  const ids = VAULT_TABS.map((tab) => tab.id)
  assert.equal(ids.indexOf("gold"), ids.indexOf("arcousd") + 1)
  assert.equal(VAULT_TABS.find((tab) => tab.id === "gold")?.path, "/vaults/gold")
})

test("gold admin: liquidity splits the backing into buffer and strategies", () => {
  const state = reserve().reserve!
  const all = goldLiquidity(state)
  assert.equal(all.bufferOunces, 13)
  assert.equal(all.queuedOunces, 0.5)
  assert.equal(all.instantOunces, 12.50834)
  assert.equal(all.deployedOunces, 0)
  assert.equal(all.bufferPercent, 100)
  assert.equal(all.deployedPercent, 0)
  const partly = goldLiquidity({ ...state, totalBackingOunces: "20" })
  assert.equal(partly.deployedOunces, 7)
  assert.equal(partly.bufferPercent, 65)
  assert.equal(partly.deployedPercent, 35)
  const empty = goldLiquidity({ totalBackingOunces: "0", assets: [] })
  assert.equal(empty.bufferPercent, null)
  assert.equal(empty.instantOunces, 0)
})

test("gold admin: shares, waits and mint headroom read plainly", () => {
  assert.equal(sharePercentText(100), "100%")
  assert.equal(sharePercentText(62.456), "62.46%")
  assert.equal(sharePercentText(null), "—")
  assert.equal(bpsPercentText(10000), "100%")
  assert.equal(bpsPercentText(250), "2.5%")
  assert.equal(bpsPercentText(undefined), "—")
  assert.equal(waitText(600), "10 minutes")
  assert.equal(waitText(60), "1 minute")
  assert.equal(waitText(45), "45 seconds")
  assert.equal(waitText(5400), "1.5 hours")
  assert.equal(waitText(172800), "2 days")
  assert.equal(waitText(undefined), "—")
  assert.equal(mintHeadroomOunces({ mintCap: "100000000000000000000000", totalLiabilities: "12500000000000000000" }), 99987.5)
  assert.equal(mintHeadroomOunces({ mintCap: "1000000000000000000", totalLiabilities: "2000000000000000000" }), 0)
  assert.equal(mintHeadroomOunces({ totalLiabilities: "2000000000000000000" }), null)
})

test("gold admin: the Liquidity card shows instant liquidity, buffer, strategies and the limits", () => {
  const html = renderToStaticMarkup(<GoldAdminView savings={savings()} reserve={reserve()} />)
  assert.match(html, /Liquidity/)
  assert.match(html, /12\.5083 oz/)
  assert.match(html, /\$50,033\.36 payable at once/)
  assert.match(html, /100% of the backing/)
  assert.match(html, /0% of the backing/)
  assert.match(html, /Buffer 100%, strategies 0%/)
  assert.match(html, /Owed to the Standard queue/)
  assert.match(html, /10 minutes/)
  assert.match(html, /99,987\.5 oz/)
  assert.match(html, /Instant liquidity<\/th>/)
  assert.doesNotMatch(html, />Available</)
  assert.doesNotMatch(html, /<button/)
})

test("gold admin: an older server without the liquidity fields shows dashes, not zeros", () => {
  const state = reserve().reserve!
  const { mmfBps, mmfTargetBps, bufferFloorBps, queueMinDelay, mintCap, settlementPaused, queuePaused, ...older } = state
  void [mmfBps, mmfTargetBps, bufferFloorBps, queueMinDelay, mintCap, settlementPaused, queuePaused]
  const html = renderToStaticMarkup(<GoldAdminView savings={savings()} reserve={{ ...reserve(), reserve: older }} />)
  assert.match(html, /Buffer floor<\/dt><dd[^>]*>—</)
  assert.equal(goldReservePauseRows(older).length, 7)
})

// ─────────────────────────────── the distributor: surplus and yield ───────────────────────────────

const NOW = Date.parse("2026-11-26T00:00:00.000Z")
function goldYield(over: Partial<GiwaArcoGoldYield> = {}, distributor: Partial<GiwaArcoGoldYield["distributor"]> = {}): GiwaArcoGoldYield {
  return {
    distributed: false,
    unvested: "0",
    unvestedOunces: "0",
    vestingPeriodSeconds: 86_400,
    vestingStartedAt: null,
    vestingEndsAt: null,
    rewardRate: "0",
    currentAprBps: 0,
    currentApyBps: 0,
    rewardsPaused: false,
    stale: false,
    ...over,
    distributor: {
      paused: false,
      reservePaused: false,
      unitMintPaused: false,
      minIntervalSeconds: 86_400,
      maxAprBps: 310,
      reserveMarginBps: 50,
      lastDistributionAt: "2026-11-25T17:26:39.000Z",
      nextDistributionAt: "2026-11-26T17:26:39.000Z",
      preview: { amount: "0", amountOunces: "0", surplus: "1754066105000000000", surplusOunces: "1.754066105", rateCap: "0", mintHeadroom: "1", navOk: true },
      ...distributor,
    },
  }
}
/** The gold Reserve after a 2 oz surplus transfer: 51.186779 oz backing against 49.186779 oz owed. */
const FUNDED = { totalBacking: "51186779000000000000", totalLiabilities: "49186779000000000000", totalBackingOunces: "51.186779", totalLiabilitiesOunces: "49.186779" }
const FUNDED_VAULT = { totalAssets: "49186779000000000000", totalAssetsOunces: "49.186779" }

test("gold surplus: the margin, what is payable, a day at the cap and how long it lasts, in ounces", () => {
  const standing = goldSurplusStanding(FUNDED, FUNDED_VAULT, goldYield())!
  assert.equal(ouncesText(standing.surplusUsd), "2")
  assert.equal(ouncesText(standing.marginUsd), "0.2459") // 0.5% of 49.186779 oz
  assert.equal(ouncesText(standing.distributableUsd), "1.7541")
  assert.equal(ouncesText(standing.dailyAtCapUsd), "0.0042") // 49.186779 oz × 3.1% ÷ 365
  assert.equal(Math.floor(standing.daysAtCap!), 419)
  assert.equal(standing.shortfallUsd, 0)
  // Below the margin nothing is payable and the shortfall is what is missing.
  const thin = goldSurplusStanding({ totalBacking: "49286779000000000000", totalLiabilities: "49186779000000000000" }, FUNDED_VAULT, goldYield())!
  assert.deepEqual([thin.distributableUsd, ouncesText(thin.shortfallUsd)], [0, "0.1459"])
  // A typed amount is added to the backing only.
  assert.equal(ouncesText(goldSurplusStanding(FUNDED, FUNDED_VAULT, goldYield(), 0.5)!.distributableUsd), "2.2541")
  assert.equal(goldSurplusStanding({ totalBacking: "x", totalLiabilities: "1" }, FUNDED_VAULT, goldYield()), null)
})

test("gold surplus: suggestions round up to a ten-thousandth of an ounce, not to a whole ounce", () => {
  assert.deepEqual([roundUpOunces(0.27121), roundUpOunces(0.2712), roundUpOunces(3)], [0.2713, 0.2712, 3])
  const thin = goldSurplusStanding({ totalBacking: "49286779000000000000", totalLiabilities: "49186779000000000000" }, FUNDED_VAULT, goldYield())!
  // 0.1459 oz short of the margin + 30 days at 0.004177 oz.
  assert.equal(surplusToAdd(thin, 30, roundUpOunces), 0.2713)
  assert.equal(surplusToAdd(thin, 30), 1) // the dollar rule would ask for a whole ounce
  assert.equal(surplusToAdd(goldSurplusStanding(FUNDED, FUNDED_VAULT, goldYield())!, 90, roundUpOunces), 0)
})

test("gold yield: where the rate comes from, the next distribution and the distributor's switches read in words", () => {
  assert.equal(goldRateNote(null), "—")
  assert.equal(goldRateNote(savings()), "Set in the server code, not on-chain") // an older server, or no distributor
  assert.equal(goldRateNote(savings({ apySource: "display", yield: goldYield() })), "Display rate until the first distribution")
  assert.equal(goldRateNote(savings({ apySource: "distributor", yield: goldYield({ distributed: true }) })), "Paid by the distributor now")
  assert.equal(goldRateNote(savings({ apySource: "distributor", yield: goldYield({ distributed: true, stale: true }) })), "Paid by the distributor (last good read)")

  assert.equal(goldTimeText("not a date"), "—")
  const waiting = goldNextDistribution(goldYield(), NOW)
  assert.deepEqual([waiting.label.startsWith("After "), waiting.attention], [true, false])
  const later = NOW + 2 * 86_400_000
  const due = (preview: Partial<NonNullable<GiwaArcoGoldYield["distributor"]["preview"]>> | null) =>
    goldNextDistribution(goldYield({}, { preview: preview === null ? null : { ...goldYield().distributor.preview!, ...preview } }), later)
  assert.deepEqual(due({ amountOunces: "0.004177" }), { label: "Due now: 0.0042 oz", attention: false })
  assert.deepEqual(due({ amountOunces: "0" }), { label: "Due, nothing to distribute", attention: true })
  assert.deepEqual(due({ navOk: false }), { label: "Due, but the Reserve's value cannot be read", attention: true })
  assert.deepEqual(due(null), { label: "Due; what it would mint could not be read", attention: true })
  assert.deepEqual(goldNextDistribution(goldYield({ rewardsPaused: true }), later), { label: "Paused: no distribution can run", attention: true })
  assert.deepEqual(
    goldYieldPauseRows(goldYield({}, { paused: true })).map((row) => [row.label, row.paused]),
    [["Distributor", true], ["Adding yield to ArcoGOLD", false], ["Minting ArcoXAU", false]],
  )
})

test("gold admin: with a distributor the page shows the surplus card; before the first distribution the rate is still the display rate", () => {
  const html = renderToStaticMarkup(
    <GoldAdminView
      now={NOW}
      savings={savings({ apyPercent: 3.1, apySource: "display", yield: goldYield(), contracts: { ...savings().contracts!, distributor: "0x7777777777777777777777777777777777777777" } }, FUNDED_VAULT)}
      reserve={reserve(FUNDED)}
    />,
  )
  for (const text of ["Surplus for yield", "Display rate until the first distribution", "0.2459 oz", "1.7541 oz", "0.0042 oz", "about 419 days", "None yet", "0x7777…7777"]) {
    assert.ok(html.includes(text), text)
  }
  assert.match(html, /safety margin of 0\.5% of\s+what is owed, at most 3\.1% a year/)
  // Read-only without the wallet wiring: no Add surplus, and the header still says so.
  assert.ok(!html.includes("Add surplus"))
  assert.ok(html.includes("Read-only. This page sends no transactions"))
})

test("gold admin: once it pays, the rate card says so, and Add surplus offers the gold coins in ounces", () => {
  const paying = goldYield({ distributed: true, currentAprBps: 310, currentApyBps: 315, unvested: "2000000000000000", unvestedOunces: "0.002", vestingEndsAt: "2026-11-27T17:26:39.000Z" })
  const html = renderToStaticMarkup(
    <GoldAdminView
      now={NOW}
      savings={savings({ apyPercent: 3.15, apySource: "distributor", yield: paying }, FUNDED_VAULT)}
      reserve={reserve({ ...FUNDED, totalBacking: "49286779000000000000", totalBackingOunces: "49.286779" })}
      addSurplus={{ walletAddress: null, onConnectWallet: () => undefined, onPrepare: async () => Promise.reject(new Error("unused")), onSend: async () => "0x" }}
    />,
  )
  for (const text of ["Paid by the distributor now", "3.15%", "Add surplus", "gold Reserve", "Amount (tXAUT)", "30 days: 0.2713", "Connect wallet", "0.002 oz until", "The one transaction this page sends is Add surplus."]) {
    assert.ok(html.includes(text), text)
  }
  assert.ok(html.includes('id="arcogold-surplus-amount"'))
  assert.ok(!html.includes("Read-only. This page sends no transactions"))
  // Under the margin: called out, not shown as zeros that look fine.
  assert.ok(html.includes("0.1459 oz"))
})

test("gold admin: without a distributor (or on an older server) there is no surplus card and nothing to send", () => {
  const html = renderToStaticMarkup(
    <GoldAdminView savings={savings()} reserve={reserve()} addSurplus={{ walletAddress: null, onConnectWallet: () => undefined, onPrepare: async () => Promise.reject(new Error("unused")), onSend: async () => "0x" }} />,
  )
  assert.ok(!html.includes("Surplus for yield"))
  assert.ok(!html.includes("Add surplus"))
  assert.ok(html.includes("Read-only. This page sends no transactions"))
})

test("gold admin: the server's ounce preview reads through the shared control's fields", () => {
  const reply = {
    symbol: "tXAUT", asset: "0x66", decimals: 6, amount: "500000", amountHuman: "0.5", from: "0xaa", balanceHuman: "2", reserve: "0x44",
    surplusBeforeOunces: "2", surplusAfterOunces: "2.5", transaction: { chainId: 91342, to: "0x66", data: "0x", value: "0", description: "transfer", simulation: { status: "not-run" } },
  }
  const mapped = asSurplusPreview(reply as never)
  assert.deepEqual([mapped.surplusBeforeUsd, mapped.surplusAfterUsd, mapped.amountHuman, "surplusBeforeOunces" in mapped], ["2", "2.5", "0.5", false])
})
