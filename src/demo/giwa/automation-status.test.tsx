import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { AutomationCard } from "./AutomationCard"
import {
  automationSummary,
  goldAutomationRow,
  keeperAutomationRow,
  lowGasHint,
  priceBotAutomationRow,
  type AutomationRead,
} from "./automation-status"
import type { GiwaArcoGoldSavings, GiwaArcoGoldYield, GiwaArcoUSDKeeper, GiwaArcoUSDKeeperReport, GiwaPriceBotStatus } from "./types"

// A made-up rate for fixtures (not a product's real rate).
const FIXTURE_RATE_BPS = 500

const NOW = Date.parse("2026-11-27T03:00:00.000Z")
const MIN = 60_000
const iso = (ms: number) => new Date(ms).toISOString()
const ok = <T,>(data: T): AutomationRead<T> => ({ data, error: null })
const failed = <T,>(error = "HTTP 503"): AutomationRead<T> => ({ data: null, error })
const loading = <T,>(): AutomationRead<T> => ({ data: null, error: null })

const keeperReport = (over: Partial<GiwaArcoUSDKeeperReport> = {}): GiwaArcoUSDKeeperReport => ({
  mode: "live",
  address: "0x00000000000000000000000000000000000000ee",
  intervalMs: 60_000,
  batch: 20,
  gasBalanceWei: "48500000000000000",
  lowGasWei: "10000000000000000",
  lowGas: false,
  canAffordTx: true,
  simulations: [],
  lastTx: null,
  pending: null,
  distribute: { state: "waiting", nextAt: iso(NOW + 5 * 60 * MIN), amountUsd: "1.2", detail: null },
  goldDistribute: { state: "waiting", nextAt: iso(NOW + 5 * 60 * MIN), amountUsd: "0.0012", detail: null },
  note: null,
  ...over,
})
const keeper = (report: GiwaArcoUSDKeeperReport | null, over: Partial<NonNullable<GiwaArcoUSDKeeper["keeper"]>> = {}): GiwaArcoUSDKeeper => ({
  status: "live",
  keeper: { lastRunAt: iso(NOW - 30_000), lastOkAt: iso(NOW - 30_000), lastError: null, stale: false, report, ...over },
})

const goldYield = (distributor: Partial<GiwaArcoGoldYield["distributor"]> = {}): GiwaArcoGoldYield => ({
  distributed: true,
  unvested: "0",
  unvestedOunces: "0",
  vestingPeriodSeconds: 86_400,
  vestingStartedAt: null,
  vestingEndsAt: null,
  rewardRate: "0",
  currentAprBps: 310,
  currentApyBps: 315,
  rewardsPaused: false,
  stale: false,
  distributor: {
    paused: false,
    reservePaused: false,
    unitMintPaused: false,
    minIntervalSeconds: 86_400,
    maxAprBps: 310,
    reserveMarginBps: 50,
    lastDistributionAt: iso(NOW - 19 * 60 * MIN),
    nextDistributionAt: iso(NOW + 5 * 60 * MIN),
    preview: { amount: "1", amountOunces: "0.0012", surplus: "1", surplusOunces: "1", rateCap: "1", mintHeadroom: "1", navOk: true },
    ...distributor,
  },
})
const gold = (over: Partial<GiwaArcoGoldSavings> = {}): GiwaArcoGoldSavings => ({
  status: "live",
  chainId: 91342,
  contracts: { arcoGOLD: "0x1", zap: "0x2", unit: "0x3", reserve: "0x4", distributor: "0x5" },
  readAt: iso(NOW),
  savings: null,
  apyPercent: 3.15,
  apySource: "distributor",
  yield: goldYield(),
  ounceUsd: 4000,
  ounceUsdSource: "x",
  sharePriceUsd: null,
  totalAssetsUsd: null,
  ...over,
})

const fund = (productId: string, symbol: string, postedAt: string) => ({ productId, symbol, rateBps: FIXTURE_RATE_BPS, price: "1.001", postedAt, state: "posted-today" as const, next: null, hash: null, detail: "Already posted today (UTC)" })
const priceBot = (report: Record<string, unknown> = {}, bot: Partial<NonNullable<GiwaPriceBotStatus["bot"]>> = {}): GiwaPriceBotStatus => ({
  status: "live",
  rates: [{ productId: "home", rateBps: FIXTURE_RATE_BPS }],
  bot: {
    lastRunAt: iso(NOW - 9 * MIN),
    lastOkAt: iso(NOW - 9 * MIN),
    lastError: null,
    stale: false,
    ...bot,
    report: {
      mode: "live",
      address: "0x00000000000000000000000000000000000000b0",
      intervalMs: 600_000,
      ok: true,
      error: null,
      balanceWei: "19500000000000000",
      funds: [fund("home", "HOME", iso(NOW - 2 * 60 * MIN))],
      ...report,
    },
  },
})

test("automation: the keeper row reads its mode the way the Keeper bot card does", () => {
  const live = keeperAutomationRow(ok(keeper(keeperReport())), NOW)
  assert.deepEqual([live.name, live.status.label, live.lastRun, live.gas, live.attention, live.page], ["ArcoUSD queue & yield", "Running", "just now", { text: "0.0485 ETH", low: false }, false, "arcousd"])
  assert.match(live.next ?? "", /^Pays the queue every 1m · Savings yield after \d{1,2} Nov, \d{2}:\d{2}$/)
  assert.equal(keeperAutomationRow(ok(keeper(keeperReport({ mode: "dry-run" }))), NOW).status.label, "Dry run")
  assert.equal(keeperAutomationRow(ok(keeper(keeperReport({ mode: "dry-run" }))), NOW).gas, null) // a dry run spends no gas
  const off = keeperAutomationRow(ok(keeper(keeperReport({ mode: "off" }))), NOW)
  assert.deepEqual([off.status.label, off.next, off.attention], ["Off", null, false])
  assert.deepEqual([keeperAutomationRow(ok({ status: "live", keeper: null }), NOW).status.label, keeperAutomationRow(ok({ status: "live", keeper: null }), NOW).detail], ["Off", "The keeper has not run yet"])
  const stale = keeperAutomationRow(ok(keeper(keeperReport(), { stale: true, lastRunAt: iso(NOW - 20 * MIN) })), NOW)
  assert.deepEqual([stale.status.label, stale.lastRun, stale.attention], ["Not reporting", "20m ago", true])
  const failing = keeperAutomationRow(ok(keeper(keeperReport(), { lastError: "Send failed: nonce too low", lastOkAt: iso(NOW - 11 * MIN) })), NOW)
  assert.deepEqual([failing.status.label, failing.detail, failing.attention], ["Error", "Send failed: nonce too low", true])
  const retrying = keeperAutomationRow(ok(keeper(keeperReport(), { lastError: "blip", lastOkAt: iso(NOW - 2 * MIN) })), NOW)
  assert.deepEqual([retrying.status.label, retrying.attention], ["Running", false])
  const lowGas = keeperAutomationRow(ok(keeper(keeperReport({ lowGas: true, gasBalanceWei: "4200000000000000" }))), NOW)
  assert.deepEqual([lowGas.status.label, lowGas.gas, lowGas.attention], ["Running", { text: "0.0042 ETH", low: true }, true])
  const down = keeperAutomationRow(failed(), NOW)
  assert.deepEqual([down.status.label, down.detail, down.attention], ["Unavailable", "HTTP 503", true])
  assert.equal(keeperAutomationRow(ok({ status: "unavailable", error: "db down", keeper: null }), NOW).status.label, "Unavailable")
  assert.equal(keeperAutomationRow(loading(), NOW).status.label, "Loading")
})

test("automation: the gold row joins the keeper's gold step with the gold distributor's next time", () => {
  const live = goldAutomationRow(ok(keeper(keeperReport())), ok(gold()), NOW)
  assert.deepEqual([live.name, live.status.label, live.detail, live.attention, live.page], ["Gold yield", "Running", null, false, "gold"])
  assert.match(live.next ?? "", /^After \d{1,2} Nov, \d{2}:\d{2}$/)
  // The keeper's state carries over: off, not reporting, unread.
  assert.deepEqual([goldAutomationRow(ok(keeper(keeperReport({ mode: "off" }))), ok(gold()), NOW).status.label, goldAutomationRow(ok(keeper(keeperReport({ mode: "off" }))), ok(gold()), NOW).detail], ["Off", "The keeper is off: distribute from the Gold page"])
  assert.equal(goldAutomationRow(ok(keeper(keeperReport(), { stale: true })), ok(gold()), NOW).status.label, "Not reporting")
  assert.equal(goldAutomationRow(failed(), ok(gold()), NOW).status.label, "Unavailable")
  // The gold step's own states.
  const errored = goldAutomationRow(ok(keeper(keeperReport({ goldDistribute: { state: "reverts", nextAt: null, amountUsd: null, detail: "Pausable: paused" } }))), ok(gold()), NOW)
  assert.deepEqual([errored.status.label, errored.detail, errored.attention], ["Error", "distribute() would revert: Pausable: paused", true])
  const noDistributor = goldAutomationRow(ok(keeper(keeperReport({ goldDistribute: { state: "not-deployed", nextAt: null, amountUsd: null, detail: null } }))), ok(gold()), NOW)
  assert.deepEqual([noDistributor.status.label, noDistributor.detail, noDistributor.next], ["Off", "ArcoGOLD has no distributor", null])
  const sent = goldAutomationRow(ok(keeper(keeperReport({ goldDistribute: { state: "sent", nextAt: null, amountUsd: "0.0125", detail: "Distributed" } }))), ok(gold()), NOW)
  assert.equal(sent.detail, "Distributed 0.0125 oz") // ounces, never dollars
  const older = goldAutomationRow(ok(keeper(keeperReport({ goldDistribute: undefined }))), ok(gold()), NOW)
  assert.deepEqual([older.status.label, older.detail], ["Running", "This keeper does not report a gold step yet"])
  // The gold read: failed, or a paused distributor (the Gold page's attention cases).
  const unread = goldAutomationRow(ok(keeper(keeperReport())), failed(), NOW)
  assert.deepEqual([unread.next, unread.attention], ["The gold distributor could not be read", true])
  const paused = goldAutomationRow(ok(keeper(keeperReport())), ok(gold({ yield: goldYield({ paused: true }) })), NOW)
  assert.deepEqual([paused.next, paused.attention], ["Paused: no distribution can run", true])
  // Shares the keeper wallet: low gas there is low gas here.
  assert.deepEqual(goldAutomationRow(ok(keeper(keeperReport({ lowGas: true }))), ok(gold()), NOW).gas?.low, true)
})

test("automation: the price bot row uses the Prices card's headline, and says when it next posts", () => {
  const live = priceBotAutomationRow(ok(priceBot()), NOW)
  assert.deepEqual([live.name, live.status.label, live.lastRun, live.gas, live.attention, live.page], ["Price bot", "Running", "9m ago", { text: "0.0195 ETH", low: false }, false, "prices"])
  assert.match(live.next ?? "", /^Next prices after \d{1,2} Nov, \d{2}:\d{2}$/) // all posted today: the next UTC day, in local time
  const due = priceBotAutomationRow(ok(priceBot({ funds: [fund("home", "HOME", iso(NOW - 26 * 60 * MIN))] })), NOW)
  assert.equal(due.next, "Posts today's prices within 10m")
  assert.equal(priceBotAutomationRow(ok(priceBot({ mode: "dry-run" })), NOW).status.label, "Dry run")
  const off = priceBotAutomationRow(ok({ status: "live", rates: [], bot: null }), NOW)
  assert.deepEqual([off.status.label, off.next, off.gas, off.attention], ["Off", null, null, false])
  const stale = priceBotAutomationRow(ok(priceBot({}, { stale: true })), NOW)
  assert.deepEqual([stale.status.label, stale.attention], ["Not reporting", true])
  const failing = priceBotAutomationRow(ok(priceBot({ ok: false, error: "HOME: The post would revert: PPF: deviation" })), NOW)
  assert.deepEqual([failing.status.label, failing.detail, failing.attention], ["Error", "HOME: The post would revert: PPF: deviation", true])
  const low = priceBotAutomationRow(ok(priceBot({ balanceWei: "4200000000000000" })), NOW) // today's bot: no lowGas field, below 0.005 ETH
  assert.deepEqual([low.gas, low.attention], [{ text: "0.0042 ETH", low: true }, true])
  assert.deepEqual([priceBotAutomationRow(failed(), NOW).status.label, priceBotAutomationRow(failed(), NOW).attention], ["Unavailable", true])
  assert.equal(priceBotAutomationRow(ok({ status: "unavailable", error: "Price bot read failed: timeout", rates: [], bot: null }), NOW).status.label, "Unavailable")
  assert.equal(priceBotAutomationRow(loading(), NOW).status.label, "Loading")
})

test("automation: the summary line and the card, with rows that link to their pages", () => {
  const healthy = [keeperAutomationRow(ok(keeper(keeperReport())), NOW), goldAutomationRow(ok(keeper(keeperReport())), ok(gold()), NOW), priceBotAutomationRow(ok(priceBot()), NOW)]
  assert.deepEqual(automationSummary(healthy), { text: "All running", tone: "positive" })
  const oneOff = [...healthy.slice(0, 2), priceBotAutomationRow(ok({ status: "live", rates: [], bot: null }), NOW)]
  assert.equal(automationSummary(oneOff).text, "Nothing needs attention · 1 off")
  const trouble = [keeperAutomationRow(failed(), NOW), goldAutomationRow(failed(), ok(gold()), NOW), priceBotAutomationRow(ok(priceBot({ balanceWei: "1" })), NOW)]
  assert.deepEqual(automationSummary(trouble), { text: "3 need attention", tone: "negative" })
  assert.equal(automationSummary([trouble[2], ...healthy.slice(0, 2)]).text, "1 needs attention")
  assert.equal(lowGasHint({ id: "price-bot" }), "Low: send GIWA Sepolia ETH to the bot wallet")
  assert.equal(lowGasHint({ id: "keeper" }), "Low: send GIWA Sepolia ETH to the keeper wallet")

  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={["/vaults/monitoring"]}>
      <Routes>
        <Route path="/vaults/monitoring" element={<AutomationCard rows={trouble} />} />
      </Routes>
    </MemoryRouter>,
  )
  for (const expected of ["Automation", "3 need attention", "ArcoUSD queue &amp; yield", "Gold yield", "Price bot", "Unavailable", "Low: send GIWA Sepolia ETH to the bot wallet"]) {
    assert.ok(html.includes(expected), expected)
  }
  for (const page of ["arcousd", "gold", "prices"]) assert.ok(html.includes(`href="/vaults/${page}"`), page)
  assert.doesNotMatch(html, /overflow-x-auto|min-w-\[\d/) // stacks at phone width, never scrolls sideways
  // The same card in the legacy in-app admin links to its own pages.
  const legacy = renderToStaticMarkup(
    <MemoryRouter initialEntries={["/admin/monitoring"]}>
      <Routes>
        <Route path="/admin">
          <Route path="monitoring" element={<AutomationCard rows={healthy} />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
  assert.ok(legacy.includes('href="/admin/gold"'))
})
