import assert from "node:assert/strict"
import { createRequire, registerHooks } from "node:module"
import test from "node:test"

// The Portfolio page's Activity tab (look "V3"), rendered through the real page with the same boundary stubs as
// PortfolioPage.dom.test.tsx: the summary against the hero's Supplied, the filter, the day-grouped feed and its states.
const runtime = process.env.GIWA_HOST_DOM_RUNTIME
const A = "0x1111111111111111111111111111111111111111"
const DAY = 86_400_000
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
const e6 = (n: number) => BigInt(Math.round(n * 1e6)).toString()
const e18 = (n: number) => (BigInt(Math.round(n * 1e6)) * 10n ** 12n).toString()
const at = (daysAgo: number, hour = 12) => { const d = new Date(Date.now() - daysAgo * DAY); d.setUTCHours(hour, 0, 0, 0); return d.toISOString() }
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`

test("Portfolio Activity tab: summary = the hero's Supplied, filter, day-grouped feed, states", { skip: !runtime }, async t => {
  const { JSDOM } = createRequire(runtime!)("jsdom")
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://fixture.invalid", pretendToBeVisual: true })
  const boundary = {
    wallet: { address: A as string | null, chainId: 91342, connect: async () => {} },
    balance: async (_token: string, _wallet: string) => "0",
  }
  class ResizeObserver { observe() {} unobserve() {} disconnect() {} }
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, ResizeObserver, IS_REACT_ACT_ENVIRONMENT: true, __giwaPortfolioTest: boundary }
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (context.parentURL?.endsWith("/PortfolioPage.tsx")) {
      const code = specifier === "./wallet" ? "export const useGiwaWallet=()=>globalThis.__giwaPortfolioTest.wallet;"
        : specifier === "./contracts" ? "export const readShareSupply=async()=>({decimals:6}); export const readTokenBalance=(...args)=>globalThis.__giwaPortfolioTest.balance(...args);" : null
      if (code) return { url: `data:text/javascript,${encodeURIComponent(code)}`, shortCircuit: true }
    }
    return next(specifier, context)
  } })
  t.after(() => {
    hooks.deregister(); dom.window.close()
    for (const key of Object.keys(globals)) { const before = previous[key]; if (before) Object.defineProperty(globalThis, key, before); else Reflect.deleteProperty(globalThis, key) }
  })
  const { act } = await import("react")
  const { createRoot } = await import("react-dom/client")
  const { MemoryRouter } = await import("react-router-dom")
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query")
  const { default: Portfolio } = await import("./PortfolioPage")
  const { ArcoUsdLiveContext } = await import("./arcousd-live-context")
  const { ArcoGoldLiveContext } = await import("./arcogold-live-context")
  const { giwaApi, normalizeCatalog } = await import("./api")
  const { explorerTx } = await import("./wallet")
  const { default: snapshot } = await import("./investor-shell/verification/deployed-giwa.snapshot.json")
  const catalog = normalizeCatalog(snapshot.catalog).filter(product => product.productTokenAddress)
  assert.ok(catalog.length >= 3)
  const fund = { ...catalog[1]!, vaultConfig: { ...catalog[1]!.vaultConfig, kind: "product" } } as typeof catalog[number]
  const closed = { ...catalog[2]!, vaultConfig: { ...catalog[2]!.vaultConfig, kind: "product" } } as typeof catalog[number]
  const ARCO = "0x3d6Cb251d6aA62591ce9f6a13781a6dC590411Da", SARCO = "0xcAEF04FeA7f9c2561dbCA95E39a6b06043df30Fd", ZAP = "0xf4554ea97218645cF2EB209Cd540BD91321ba1E1"
  const GOLD = "0xCfBB1da2040Bd559B2d7a96F818494d922Fb1860", GOLD_ZAP = "0x6C67403808DCDA693e5B9f2ddF543659FF3f27B4"
  const live = {
    arcoUSD: ARCO, reserve: "0x4942711396B53df5b02fD8065E77FA2c9D27512F", assets: [], depositPaused: false, redeemPaused: false,
    savings: { sArcoUSD: SARCO, zap: ZAP, sharePrice: 1.02, apyPercent: 4.5, paidApyPercent: 4.5, depositsOpen: true, withdrawalsOpen: true },
  }
  const gold = { arcoGOLD: GOLD, zap: GOLD_ZAP, coins: [], sharePrice: 1.25, ounceUsd: 2400, apyPercent: 3.1, depositPaused: false, redeemPaused: false, depositsOpen: true, withdrawalsOpen: true }
  const before = { ...giwaApi }
  t.after(() => Object.assign(giwaApi, before))
  const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) }) }
  const wallet = A.toLowerCase()
  const ev = (eventName: string, contractAddress: string, args: Record<string, unknown>, blockTimestamp: string | null, n: number) =>
    ({ eventName, txHash: hash(n), blockNumber: n, contractAddress: contractAddress.toLowerCase(), blockTimestamp, args: { ...args, walletAddress: wallet } })
  // The full fixture: the fund (in, part out, a redemption pending), a closed fund, sArcoUSD in and out through the Zap,
  // ArcoGOLD in through the gold Zap, 50 ArcoUSD held, and a faucet drip that never shows.
  const fullEvents = [
    ev("ProductDeposit", fund.depositVaultAddress!, { paymentAssets: e6(1000), sharesOut: e18(500) }, at(200, 9), 1),
    ev("ProductRedeemInstant", fund.redemptionVaultAddress!, { sharesIn: e18(50), assetsOut: e6(101) }, at(100, 10), 2),
    ev("ProductDeposit", closed.depositVaultAddress!, { paymentAssets: e6(300), sharesOut: e18(300) }, at(250, 8), 3),
    ev("ProductRedeemInstant", closed.redemptionVaultAddress!, { sharesIn: e18(300), assetsOut: e6(306.5) }, at(150, 8), 4),
    ev("ZapDeposit", ZAP, { arcoUSDIn: e18(100), shares: e18(100) }, at(60, 14), 5),
    ev("ZapRedeem", ZAP, { arcoUSDOut: e18(2.04), shares: e18(2) }, at(30, 13), 6),
    ev("ZapDeposit", GOLD_ZAP, { arcoUSDIn: e18(2.45), shares: e18(2) }, at(30, 9), 7),
    ev("FaucetDrip", "0x00000000000000000000000000000000000000fa", { amount: e18(5) }, at(5), 8),
  ]
  const fullRedemptions = [{ requestId: "7", productId: fund.productId, walletAddress: wallet, redemptionVaultAddress: fund.redemptionVaultAddress, sharesIn: e18(20), lockedAssetsOut: e6(40.5), status: "REQUESTED", createdAt: at(10, 17), requestedTxHash: hash(9) }]
  function reset() {
    boundary.wallet.address = A
    giwaApi.catalog = async () => [fund, closed]
    giwaApi.market = async () => [
      { productId: fund.productId, navBase: 2.1, navUsd: 2.1, baseUsd: 1, apy: 6, impliedApy: null },
      { productId: closed.productId, navBase: 1.05, navUsd: 1.05, baseUsd: 1, apy: 4, impliedApy: null },
    ]
    // 430 fund shares (500 − 50 − 20) × 2.1 = $903; 98 sArcoUSD; 2 ArcoGOLD; 50 ArcoUSD.
    boundary.balance = async (token) => token === fund.productTokenAddress ? "430" : token === SARCO ? "98" : token === GOLD ? "2" : token === ARCO ? "50" : "0"
    giwaApi.activity = async () => fullEvents as never
    giwaApi.redemptions = async () => fullRedemptions as never
  }
  async function mount(withLive = true) {
    const element = document.createElement("div"); document.body.append(element)
    const root = createRoot(element)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <ArcoUsdLiveContext.Provider value={(withLive ? live : null) as never}>
          <ArcoGoldLiveContext.Provider value={(withLive ? gold : null) as never}>
            <MemoryRouter><Portfolio /></MemoryRouter>
          </ArcoGoldLiveContext.Provider>
        </ArcoUsdLiveContext.Provider>
      </QueryClientProvider>,
    ))
    await settle()
    const click = async (name: string, scope: ParentNode = element) => {
      const button = [...scope.querySelectorAll("button")].find(button => button.textContent === name)
      assert.ok(button, `Missing ${name}`); await act(async () => button.click()); await settle()
    }
    const part = (id: string) => element.querySelector(`[data-testid="${id}"]`)?.textContent ?? null
    const supplied = () => part("portfolio-supplied")?.replace(/^Supplied /, "") ?? null
    const summary = () => ["activity-deposited", "activity-withdrawn", "activity-net-supplied"].map(part)
    const feedRows = () => [...element.querySelectorAll("li[data-activity]")]
    const sentences = () => feedRows().map(li => li.querySelector(".sr-only")?.textContent)
    const days = () => [...element.querySelectorAll('[data-testid="activity-feed"] h3')].map(h => h.textContent)
    const cents = (text: string | null) => Math.round(Number((text ?? "").replace(/[^0-9.]/g, "")) * 100)
    return { element, click, part, supplied, summary, feedRows, sentences, days, cents, text: () => element.textContent ?? "", async close() { await act(async () => root.unmount()); client.clear(); element.remove() } }
  }

  await t.test("summary: Net supplied is the hero's Supplied, Deposited − Withdrawn adds up; closed positions are said; idle ArcoUSD stays out", async () => {
    reset()
    const m = await mount()
    try {
      const heroSupplied = m.supplied()
      await m.click("Activity")
      const [deposited, withdrawn, net] = m.summary()
      // Fund: 1000 − 101 − 40.5 = $858.50; sArcoUSD: 100 − 2.04 = $97.96; ArcoGOLD: 2.45 oz × $2,400 = $5,880; the $50 of idle ArcoUSD is not counted.
      assert.equal(heroSupplied, "$6,836.46")
      assert.equal(net, heroSupplied, "Net supplied is the hero's Supplied")
      assert.equal(deposited, "+$6,980.00") // 1000 + 100 + 5,880
      assert.equal(withdrawn, "−$143.54") // 101 + 40.5 + 2.04
      assert.equal(m.cents(deposited) - m.cents(withdrawn), m.cents(net))
      assert.ok(m.element.querySelector('[data-testid="activity-deposited"]')!.className.includes("--color-arco-up-text"))
      const notes = m.part("activity-notes") ?? ""
      assert.match(notes, /Values at today's prices\./)
      assert.match(notes, /activity for positions you have closed is listed but not counted/)
      assert.doesNotMatch(notes, /ArcoUSD/)
      assert.doesNotMatch(notes, /Partial/)
    } finally { await m.close() }
  })

  await t.test("feed: one card, grouped by day newest first; each row a sentence, a signed value at today's price and its transaction", async () => {
    reset()
    const m = await mount()
    try {
      await m.click("Activity")
      const rows = m.feedRows()
      assert.equal(rows.length, 8, "7 events less the faucet drip, plus the pending redemption")
      assert.doesNotMatch(m.text(), /FaucetDrip|Faucet/)
      assert.doesNotMatch(m.text(), /Network|TxID/)
      // Newest first: the pending redemption 10 days ago, the two from 30 days ago (13:00 then 09:00) under one day.
      const s = m.sentences()
      assert.match(s[0]!, /^Redemption request, 20 [^,]+ \([^)]+\), −\$40\.50, [A-Z][a-z]{2} \d+, \d{4} at 17:00 UTC\.$/) // 40.5 USDC at $1 (navUsd / navBase)
      assert.match(s[1]!, /^Withdraw, 2 sArcoUSD \(sArcoUSD\), −\$2\.04, .* at 13:00 UTC\.$/)
      assert.match(s[2]!, /^Deposit, 2 ArcoGOLD \(ArcoGOLD\), \+\$5,880\.00, .* at 09:00 UTC\.$/)
      assert.match(s[3]!, /^Deposit, 100 sArcoUSD \(sArcoUSD\), \+\$100\.00, /)
      assert.match(s[4]!, /^Redemption complete, 50 [^,]+, −\$101\.00, /)
      assert.match(s[7]!, /^Deposit, 300 [^,]+, \+\$300\.00, /) // the closed fund: 300 in
      const days = m.days()
      assert.equal(days.length, 7)
      assert.equal(new Set(days).size, 7)
      assert.equal(m.element.querySelectorAll('[data-testid="activity-feed"] section').length, 7)
      // Lists, each named by its day heading; icons and visual parts hidden from screen readers.
      for (const section of m.element.querySelectorAll('[data-testid="activity-feed"] section')) {
        const id = section.querySelector("h3")!.id
        assert.equal(section.querySelector("ul")!.getAttribute("aria-labelledby"), id)
      }
      const first = rows[0]!
      assert.equal(first.querySelector("svg")?.closest('[aria-hidden="true"]') !== null, true)
      // Pending: the amber chip; a withdrawal: the up-green tint; a deposit: the neutral chip, its value green.
      assert.ok(first.querySelector('[aria-hidden="true"]')!.className.includes("--color-risk-medium-bg"))
      assert.ok(rows[1]!.querySelector('[aria-hidden="true"]')!.className.includes("--color-risk-low-bg"))
      assert.ok(rows[2]!.querySelector('[aria-hidden="true"]')!.className.includes("--color-arco-chip"))
      assert.equal(rows[2]!.querySelector('[data-cell="usd"]')!.textContent, "+$5,880.00")
      assert.ok(rows[2]!.querySelector('[data-cell="usd"]')!.className.includes("--color-arco-up-text"))
      assert.equal(rows[1]!.querySelector('[data-cell="usd"]')!.textContent, "−$2.04")
      // The transaction: wide, its short hash; phones, the time; both open the explorer in a new tab with a focus ring.
      const links = [...rows[1]!.querySelectorAll("a")]
      assert.equal(links.length, 2)
      for (const link of links) {
        assert.equal(link.getAttribute("href"), explorerTx(hash(6)))
        assert.equal(link.getAttribute("target"), "_blank")
        assert.match(link.getAttribute("aria-label") ?? "", /^View transaction 0x0000…0006 on the explorer$/)
        assert.ok(link.className.includes("focus-visible:outline-[var(--color-arco-ink)]"))
      }
      assert.ok(links[0]!.className.includes("hidden") && links[0]!.className.includes("sm:inline-flex"))
      assert.ok(links[1]!.className.includes("sm:hidden"))
      assert.equal(links[1]!.textContent, "13:00 UTC")
    } finally { await m.close() }
  })

  await t.test("filter: Deposits are money in; Withdrawals include the pending redemption; the summary stays", async () => {
    reset()
    const m = await mount()
    try {
      await m.click("Activity")
      const group = m.element.querySelector('[aria-label="Activity filter"]')!
      assert.deepEqual([...group.querySelectorAll("button")].map(b => [b.textContent, b.getAttribute("aria-pressed")]), [["All", "true"], ["Deposits", "false"], ["Withdrawals", "false"]])
      const summary = m.summary()
      await m.click("Deposits", group)
      assert.deepEqual(m.sentences().map(s => s!.split(",")[0]), ["Deposit", "Deposit", "Deposit", "Deposit"])
      assert.deepEqual(m.summary(), summary)
      await m.click("Withdrawals", group)
      assert.deepEqual(m.sentences().map(s => s!.split(",")[0]), ["Redemption request", "Withdraw", "Redemption complete", "Redemption complete"])
      await m.click("All", group)
      assert.equal(m.feedRows().length, 8)
    } finally { await m.close() }
  })

  await t.test("partial: a holding with no deposit record is left out with the hero's Partial note; none known is '—'", async () => {
    reset()
    // Only the fund's records: sArcoUSD and ArcoGOLD are held with none, so they are unknown.
    giwaApi.activity = async () => fullEvents.slice(0, 2) as never
    const m = await mount()
    try {
      const heroSupplied = m.supplied()
      await m.click("Activity")
      assert.equal(heroSupplied, "$858.50") // the fund alone; idle ArcoUSD is not counted
      assert.equal(m.part("activity-net-supplied"), heroSupplied)
      assert.equal(m.part("activity-deposited"), "+$1,000.00")
      assert.equal(m.part("activity-withdrawn"), "−$141.50")
      assert.match(m.part("activity-notes") ?? "", /Partial — some holdings have no deposit record, so these totals leave them out\./)
      assert.doesNotMatch(m.part("activity-notes") ?? "", /closed/)
    } finally { await m.close() }
    // Nothing known (no records at all, no ArcoUSD): "—" everywhere, as in the hero, and no Partial note.
    reset()
    giwaApi.activity = async () => []
    giwaApi.redemptions = async () => []
    boundary.balance = async (token) => token === fund.productTokenAddress ? "10" : "0"
    const none = await mount()
    try {
      assert.equal(none.supplied(), "—")
      await none.click("Activity")
      assert.deepEqual(none.summary(), ["—", "—", "—"])
      assert.doesNotMatch(none.part("activity-notes") ?? "", /Partial/)
      assert.match(none.text(), /No indexed activity yet\./)
    } finally { await none.close() }
  })

  await t.test("loading shows no figures; empty says so; filters with nothing say so", async () => {
    reset()
    const pending = deferred<never[]>()
    giwaApi.activity = () => pending.promise
    const m = await mount()
    try {
      await m.click("Activity")
      assert.match(m.part("activity-feed") ?? "", /Loading your activity…/)
      assert.deepEqual(m.summary(), ["—", "—", "—"])
      assert.doesNotMatch(m.text(), /No indexed activity/)
    } finally { pending.resolve([]); await m.close() }
    reset()
    giwaApi.activity = async () => []
    giwaApi.redemptions = async () => []
    boundary.balance = async () => "0"
    const empty = await mount(false)
    try {
      await empty.click("Activity")
      assert.match(empty.text(), /No indexed activity yet\./)
      assert.deepEqual(empty.summary(), ["$0.00", "$0.00", "$0.00"])
      assert.equal(empty.supplied(), "$0.00")
      await empty.click("Withdrawals")
      assert.match(empty.part("activity-feed") ?? "", /No withdrawals yet\./)
    } finally { await empty.close() }
  })
})
