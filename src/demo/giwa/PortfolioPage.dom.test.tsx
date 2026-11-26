import assert from "node:assert/strict"
import { createRequire, registerHooks } from "node:module"
import test from "node:test"

const runtime = process.env.GIWA_HOST_DOM_RUNTIME
const A = "0x1111111111111111111111111111111111111111"
const B = "0x2222222222222222222222222222222222222222"
const DAY = 86_400_000
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
const e6 = (n: number) => BigInt(Math.round(n * 1e6)).toString()
const e18 = (n: number) => (BigInt(Math.round(n * 1e6)) * 10n ** 12n).toString()
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString()

test("main Portfolio: current value, supplied and earned, potential earnings, Savings and Funds holdings", { skip: !runtime }, async t => {
  const { JSDOM } = createRequire(runtime!)("jsdom")
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://fixture.invalid", pretendToBeVisual: true })
  const boundary = {
    wallet: { address: A, chainId: 91342, connect: async () => {} },
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
  const { ArcoUsdLiveContext, ArcoUsdLiveFailedContext, ArcoUsdLivePendingContext } = await import("./arcousd-live-context")
  const { ArcoGoldLiveContext } = await import("./arcogold-live-context")
  const { giwaApi, normalizeCatalog } = await import("./api")
  const { default: snapshot } = await import("./investor-shell/verification/deployed-giwa.snapshot.json")
  const catalog = normalizeCatalog(snapshot.catalog).filter(product => product.productTokenAddress)
  const products = catalog.slice(0, 1)
  assert.equal(products.length, 1)
  // One Savings vault and one Fund, by their configured kind.
  const saving = { ...catalog[0]!, vaultConfig: { ...catalog[0]!.vaultConfig, kind: "saving" } } as typeof catalog[number]
  const fund = { ...catalog[1]!, vaultConfig: { ...catalog[1]!.vaultConfig, kind: "product" } } as typeof catalog[number]
  assert.notEqual(saving.symbol, fund.symbol)
  const before = { ...giwaApi }
  t.after(() => Object.assign(giwaApi, before))
  // Catalog completion enables the holdings query, which then enables history.
  const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) }) }
  function reset() {
    boundary.wallet.address = A; boundary.balance = async () => "0"
    giwaApi.catalog = async () => products
    giwaApi.market = async () => [{ productId: products[0]!.productId, navBase: 1, navUsd: 1, baseUsd: 1, apy: 5, impliedApy: null }]
    giwaApi.activity = async () => []
    giwaApi.redemptions = async () => []
  }
  const deposit = (product: typeof catalog[number], usdc: number, days = 365) =>
    ({ eventName: "ProductDeposit", txHash: `0x${usdc}`, blockNumber: 1, contractAddress: product.depositVaultAddress, blockTimestamp: ago(days), args: { paymentAssets: e6(usdc), sharesOut: e18(usdc), walletAddress: A.toLowerCase() } })
  async function mount(live: unknown = null, status: { pending?: boolean; failed?: { retry: () => void } | null; gold?: unknown } = {}) {
    const element = document.createElement("div"); document.body.append(element)
    const root = createRoot(element)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    const render = async () => {
      await act(async () => root.render(
        <QueryClientProvider client={client}>
          <ArcoUsdLivePendingContext.Provider value={status.pending ?? false}>
            <ArcoUsdLiveFailedContext.Provider value={status.failed ?? null}>
              <ArcoUsdLiveContext.Provider value={live as never}>
                <ArcoGoldLiveContext.Provider value={(status.gold ?? null) as never}>
                  <MemoryRouter><Portfolio /></MemoryRouter>
                </ArcoGoldLiveContext.Provider>
              </ArcoUsdLiveContext.Provider>
            </ArcoUsdLiveFailedContext.Provider>
          </ArcoUsdLivePendingContext.Provider>
        </QueryClientProvider>,
      ))
      await settle()
    }
    const click = async (name: string, scope: ParentNode = element) => {
      const button = [...scope.querySelectorAll("button")].find(button => button.textContent === name)
      assert.ok(button, `Missing ${name}`); await act(async () => button.click()); await settle()
    }
    await render()
    const part = (id: string) => element.querySelector(`[data-testid="${id}"]`)?.textContent ?? null
    // The holdings table's cells for a row (wide layout), by its key.
    // What a sighted user reads in a node: its text without the screen-reader-only labels.
    const visible = (node: Element | null | undefined) => {
      if (!node) return null
      const copy = node.cloneNode(true) as Element
      copy.querySelectorAll(".sr-only").forEach(hidden => hidden.remove())
      return copy.textContent
    }
    const row = (key: string) => element.querySelector(`li[data-holding="${key}"]`)
    // A holding row's asset text (symbol and chip), then Supplied, Earned, APY and Current value.
    const cells = (key: string) => {
      const li = row(key)
      if (!li) return []
      return [visible(li.firstElementChild), ...["supplied", "earned", "apy", "value"].map(cell => visible(li.querySelector(`[data-cell="${cell}"]`)))]
    }
    const held = () => [...element.querySelectorAll("li[data-holding]")].map(li => li.getAttribute("data-holding"))
    const group = (id: string) => visible(element.querySelector(`[data-testid="portfolio-group-${id}"]`))
    const link = (key: string) => row(key)?.querySelector("a")?.getAttribute("href") ?? null
    // The asset lines under a holding row's Supplied, Earned and Current value (null where there is none).
    const units = (key: string) => ["supplied", "earned", "value"].map(cell => visible(row(key)?.querySelector(`[data-cell="${cell}-units"]`)))
    return { element, render, click, part, cells, units, held, group, link, row, text: () => element.textContent ?? "", async close() { await act(async () => root.unmount()); client.clear(); element.remove() } }
  }

  await t.test("catalog loading and failure cannot display a confirmed zero; Refresh recovers", async () => {
    reset(); const pending = deferred<ReturnType<typeof normalizeCatalog>>()
    giwaApi.catalog = () => pending.promise
    const m = await mount()
    try {
      assert.match(m.text(), /Loading your holdings/); assert.doesNotMatch(m.text(), /\$0|No holdings yet/)
      assert.equal(m.part("portfolio-supplied"), "Supplied —")
      assert.match(m.part("portfolio-earnings-empty") ?? "", /Loading your potential earnings/)
      await act(async () => pending.resolve(products)); await settle()
      assert.match(m.text(), /No holdings yet/)
      assert.equal(m.part("portfolio-supplied"), "Supplied $0.00")
      assert.match(m.part("portfolio-earnings-empty") ?? "", /Deposit into Savings or Funds to see your potential earnings/)
      giwaApi.catalog = async () => { throw new Error("private transport detail") }
      await m.render()
      await m.click("Refresh")
      assert.match(m.text(), /Holdings could not be loaded/); assert.doesNotMatch(m.text(), /\$0|No holdings yet|private transport/)
      giwaApi.catalog = async () => products
      await m.render()
      await m.click("Refresh")
      assert.match(m.text(), /No holdings yet/)
    } finally { await m.close() }
  })

  await t.test("RPC failure is not zero holdings; successful retry and full remount re-read the wallet", async () => {
    reset(); let count = 0
    boundary.balance = async () => { count++; throw new Error("RPC unavailable") }
    const m = await mount()
    try {
      assert.match(m.text(), /Holdings could not be loaded/); assert.doesNotMatch(m.text(), /\$0|No holdings yet/)
      boundary.balance = async () => { count++; return "0" }
      await m.click("Refresh")
      assert.match(m.text(), /No holdings yet/)
    } finally { await m.close() }
    const reads = count
    const reloaded = await mount()
    try { assert.ok(count > reads); assert.match(reloaded.text(), /No holdings yet/) }
    finally { await reloaded.close() }
  })

  await t.test("price failure keeps the confirmed holding (its balance in place of a value) and hides unconfirmed valuation", async () => {
    reset(); boundary.balance = async () => "2"
    giwaApi.market = async () => { throw new Error("market unavailable") }
    const m = await mount()
    try {
      assert.match(m.text(), /Current valuations are unavailable/)
      assert.doesNotMatch(m.text(), /No holdings yet|\$0/)
      assert.deepEqual(m.cells(products[0]!.productId).slice(1), ["—", "—", "—", `2 ${products[0]!.symbol}`])
      assert.equal(m.part("portfolio-allocation"), null, "no allocation tiles any more")
      assert.equal(m.group("funds"), "Funds1 holding—", "no group value or share without current valuations")
      assert.equal(m.part("portfolio-earned"), "—")
      assert.equal(m.part("portfolio-net-apy"), "—", "nothing priced: no Net APY")
    } finally { await m.close() }
  })

  await t.test("the header: current value, Supplied, Lifetime Earned and Net APY; the chart from today's value", async () => {
    reset(); boundary.balance = async () => "1000"
    giwaApi.market = async () => [{ productId: products[0]!.productId, navBase: 1.04, navUsd: 1.04, baseUsd: 1, apy: 4.12, impliedApy: null }]
    giwaApi.activity = async () => [deposit(products[0]!, 1000)] as never
    const m = await mount()
    try {
      // 1,000 shares × $1.04 = $1,040: $1,000 supplied, $40 earned.
      assert.match(m.part("portfolio-current-value") ?? "", /^\$1,040\.00/, "screen readers get one 2-decimal value first")
      assert.ok(m.element.querySelector("[data-ticker-digits]"), "the three extra digits tick")
      assert.equal(m.element.querySelector("[data-ticker-digits]")?.closest("[aria-hidden]") !== null, true, "ticker digits are hidden from screen readers")
      assert.equal(m.part("portfolio-supplied"), "Supplied $1,000.00")
      assert.equal(m.part("portfolio-earned"), "+$40.00")
      assert.equal(m.part("portfolio-net-apy"), "4.12%")
      assert.match(m.text(), /Live/)
      assert.doesNotMatch(m.text(), /Net Worth|Net Rate/)
      assert.deepEqual(m.cells(products[0]!.productId).slice(1), ["$1,000.00", "+$40.00", "4.12%", "$1,040.00"])
      // Under each figure, the same in the vault's payment asset (tUSDC: a dollar coin, so up to 2 decimals); the earned
      // line signed and green like the dollars, the others muted.
      assert.equal(products[0]!.paymentAssetSymbol, "tUSDC")
      assert.deepEqual(m.units(products[0]!.productId), ["1,000 tUSDC", "+40 tUSDC", "1,040 tUSDC"])
      const unitLine = (cell: string) => m.row(products[0]!.productId)!.querySelector(`[data-cell="${cell}-units"]`)!
      assert.match(unitLine("earned").className, /text-\[var\(--color-arco-up-text\)\]/)
      assert.match(unitLine("supplied").className, /text-xs .*text-\[var\(--color-arco-muted-text\)\]/)
      assert.match(unitLine("value").className, /text-\[var\(--color-arco-muted-text\)\]/)
      // Read out dollars, then the asset.
      assert.equal(m.row(products[0]!.productId)!.querySelector('[data-cell="supplied"]')!.parentElement!.textContent, "Supplied $1,000.00" + "1,000 tUSDC")
      assert.equal(unitLine("value").parentElement!.textContent, "Current value $1,040.00" + "1,040 tUSDC" + "Earned +$40.00")
      // Phones: Supplied / Earned (and their lines) are wide only; under Current value the asset line shows on every
      // width, and the earned line stays in dollars.
      assert.ok(unitLine("supplied").parentElement!.className.includes("hidden sm:flex"))
      assert.ok(unitLine("earned").parentElement!.className.includes("hidden sm:flex"))
      assert.doesNotMatch(unitLine("value").className, /hidden/)
      assert.equal(m.row(products[0]!.productId)!.querySelector('[data-cell="earned-phone"]')!.textContent, "Earned +$40.00")
      // The wallet's 1,000 tUSDC (the Fund's payment coin) is Not earning: listed apart, in none of the numbers above.
      // No Savings vault takes tUSDC here, so there is no what-if.
      assert.equal(m.group("idle"), "Not earning1 asset$1,000.00")
      // The chart: ranges 3Y / 5Y / 10Y with 3Y first and chosen; a line with a scrubber over every month to three years out.
      const { money } = await import("../lib/format")
      const chips = [...m.element.querySelectorAll('[aria-label="Projection range"] button')]
      assert.deepEqual(chips.map(chip => chip.textContent), ["3Y", "5Y", "10Y"])
      assert.deepEqual(chips.map(chip => chip.getAttribute("aria-pressed")), ["true", "false", "false"])
      const yearsOut = (years: number) => new RegExp(`^[A-Z][a-z]{2} ${new Date().getFullYear() + years}$`)
      const slider = () => m.element.querySelector('[role="slider"][aria-label="Projected value by month"]') as HTMLElement
      const label = () => m.part("portfolio-earnings-readout-label")
      // jsdom lays nothing out: the plot is the 640px fallback, the months spread over 14..624.
      const at = (month: number, total: number) => 14 + (month / total) * 610
      const pointer = (type: string, clientX = 0, pointerType = "mouse") =>
        new dom.window.PointerEvent(type, { bubbles: true, cancelable: true, clientX, clientY: 100, pointerType, pointerId: 1, button: 0 })
      const fire = (node: EventTarget, event: Event) => act(async () => { node.dispatchEvent(event) })
      assert.ok(slider(), "one slider over the plot")
      assert.equal(slider().tabIndex, 0, "one tab stop")
      assert.deepEqual(["aria-valuemin", "aria-valuemax", "aria-valuenow"].map(name => slider().getAttribute(name)), ["0", "36", "36"])
      assert.match(slider().getAttribute("aria-valuetext") ?? "", /^[A-Z][a-z]{2} \d{4}: \$1,173\.91 projected$/)
      assert.ok(m.element.querySelector('[data-testid="portfolio-earnings-line"]'), "a line, not bars")
      assert.equal(m.element.querySelector("[data-segment]"), null, "no bar segments")
      // At rest: today's value on the left, the handle on the end; no end-value block, no tooltip.
      assert.equal(m.part("portfolio-earnings-readout"), "Today · Current value$1,040.00\u00a0")
      assert.equal(m.part("portfolio-earnings-end"), null)
      assert.equal(m.part("portfolio-earnings-tooltip"), null)
      assert.equal(m.element.querySelector('[data-testid="portfolio-earnings-scrubber"]')?.getAttribute("data-index"), "36")
      // The fine print lives in the "?" tip now (at today's Net APY), not under the chart.
      assert.match(m.part("portfolio-earnings-tip") ?? "", /^Estimate only, at today's 4\.12% Net APY with nothing added or withdrawn\. Rates change; returns are not guaranteed\. The vertical axis starts near what you supplied, not at zero\.$/)
      assert.equal([...m.element.querySelectorAll("p")].filter(p => /Estimate only/.test(p.textContent ?? "")).length, 0, "no fine-print paragraph")
      // No y labels, no Supplied baseline; faint vertical gridlines at Today and each year.
      assert.equal(m.element.querySelectorAll("[data-axis-tick]").length, 0)
      assert.equal(m.element.querySelector('[data-testid="portfolio-earnings-baseline"]'), null)
      assert.equal(m.element.querySelectorAll("[data-gridline]").length, 4)
      assert.equal(m.part("portfolio-earnings-legend"), "Projected balance")
      assert.equal(m.part("portfolio-earnings-what-if"), null, "no ArcoUSD: no what-if")
      assert.equal(m.part("portfolio-earnings-cta"), null)
      // Pointing at the end: its month, $1,173.91 and the interest earned so far ($40) plus projected ($133.91).
      await fire(slider(), pointer("pointermove", at(36, 36)))
      assert.match(label() ?? "", yearsOut(3))
      assert.equal(m.part("portfolio-earnings-value"), "$1,173.91")
      assert.equal(m.part("portfolio-earnings-interest"), "+$173.91 interest")
      // Today: the interest earned so far.
      await fire(slider(), pointer("pointermove", at(0, 36)))
      assert.equal(m.part("portfolio-earnings-readout"), "Today$1,040.00+$40.00 interest")
      // Back to rest when the window loses focus, and after a tap when a press lands outside the chart.
      await act(async () => { dom.window.dispatchEvent(new dom.window.Event("blur")) })
      assert.equal(label(), "Today · Current value", "window blur: at rest")
      await fire(slider(), pointer("pointerdown", at(9, 36), "touch"))
      await fire(slider(), pointer("pointerup", at(9, 36), "touch"))
      assert.match(label() ?? "", /^[A-Z][a-z]{2} \d{4}$/, "a tap points at its month")
      await fire(slider(), pointer("pointerdown", at(9, 36), "touch"))
      assert.match(label() ?? "", /^[A-Z][a-z]{2} \d{4}$/, "a press on the chart keeps it")
      await fire(dom.window.document.body, pointer("pointerdown", 0, "touch"))
      assert.equal(label(), "Today · Current value", "a press elsewhere: at rest")
      // 5Y and 10Y: every month, ending five and ten years out.
      await m.click("5Y")
      assert.equal(slider().getAttribute("aria-valuemax"), "60")
      assert.equal(m.element.querySelectorAll("[data-gridline]").length, 6)
      await fire(slider(), pointer("pointermove", at(60, 60)))
      assert.equal(m.part("portfolio-earnings-value"), money(1040 * 1.0412 ** 5))
      await m.click("10Y")
      assert.equal(slider().getAttribute("aria-valuemax"), "120")
      assert.equal(m.element.querySelectorAll("[data-gridline]").length, 11)
      await fire(slider(), pointer("pointermove", at(120, 120)))
      assert.equal(m.part("portfolio-earnings-value"), money(1040 * 1.0412 ** 10))
      assert.match(label() ?? "", yearsOut(10))
      assert.match([...m.element.querySelectorAll("[data-axis-year]")].slice(-1)[0]?.textContent ?? "", yearsOut(10), "the end month names the x axis' right end")
      // Every month after today is named by month and year, and no two share a name.
      const names: string[] = []
      for (let month = 0; month <= 120; month += 1) {
        await fire(slider(), new dom.window.KeyboardEvent("keydown", { key: month === 0 ? "Home" : "ArrowRight", bubbles: true, cancelable: true }))
        names.push(label()!)
      }
      assert.equal(names[0], "Today")
      for (const name of names.slice(1)) assert.match(name, /^[A-Z][a-z]{2} \d{4}$/)
      assert.equal(new Set(names).size, 121)
    } finally { await m.close() }
  })

  await t.test("a holding with no deposit record is unknown: '—' in its row, the header sums the rest with a Partial note", async () => {
    reset()
    giwaApi.catalog = async () => [saving, fund]
    giwaApi.market = async () => [
      { productId: saving.productId, navBase: 1, navUsd: 1, baseUsd: 1, apy: 5, impliedApy: null },
      { productId: fund.productId, navBase: 2, navUsd: 2, baseUsd: 1, apy: 8, impliedApy: null },
    ]
    boundary.balance = async (token) => token === saving.productTokenAddress ? "3" : token === fund.productTokenAddress ? "4" : "0"
    // The Savings vault's 3 were deposited; the Fund's 4 shares arrived with no record (a transfer).
    giwaApi.activity = async () => [deposit(saving, 2.95)] as never
    const m = await mount()
    try {
      assert.deepEqual(m.cells(saving.productId).slice(1), ["$2.95", "+$0.05", "5%", "$3.00"])
      assert.deepEqual(m.cells(fund.productId).slice(1), ["—", "—", "8%", "$8.00"])
      // Units: the known Savings row in all three; the Fund with no record has none under "—", its value's still shows
      // (4 shares × 2 tUSDC a share).
      assert.deepEqual(m.units(saving.productId), [`2.95 ${saving.paymentAssetSymbol}`, `+0.05 ${saving.paymentAssetSymbol}`, `3 ${saving.paymentAssetSymbol}`])
      assert.deepEqual(m.units(fund.productId), [null, null, `8 ${fund.paymentAssetSymbol}`])
      // Group totals: the Savings group's earned is known; the Funds group's is left out, never a wrong sum.
      assert.equal(m.group("savings"), "Savings1 holding · 27.27%$3.00+$0.05")
      assert.equal(m.group("funds"), "Funds1 holding · 72.73%$8.00")
      assert.equal(m.part("portfolio-supplied"), "Supplied $2.95")
      assert.equal(m.part("portfolio-earned"), "+$0.05")
      assert.match(m.text(), /Partial — some holdings have no deposit record/)
      // The chart shows no partial sums: supplied cannot be split from earned, so the axis starts near the current value
      // with no Supplied baseline, and the interest under a month is the interest projected on top of it.
      const partialSlider = m.element.querySelector('[role="slider"]') as HTMLElement
      const move = (clientX: number) => act(async () => { partialSlider.dispatchEvent(new dom.window.PointerEvent("pointermove", { bubbles: true, clientX, clientY: 100, pointerType: "mouse", pointerId: 1 })) })
      await move(624)
      assert.match(m.part("portfolio-earnings-readout") ?? "", /^[A-Z][a-z]{2} \d{4}\$[\d,.]+\+\$[\d.,]+ interest$/)
      await move(14)
      assert.equal(m.part("portfolio-earnings-readout"), "Today$11.00+$0.00 interest")
      assert.equal(m.element.querySelector('[data-testid="portfolio-earnings-baseline"]'), null)
      assert.equal(m.element.querySelectorAll("[data-axis-tick]").length, 0)
      assert.equal(m.part("portfolio-earnings-legend"), "Projected balance")
      // Nothing known at all: "—", no Partial note.
      giwaApi.activity = async () => []
      await m.click("Refresh")
      assert.equal(m.part("portfolio-supplied"), "Supplied —")
      assert.equal(m.part("portfolio-earned"), "—")
      assert.doesNotMatch(m.text(), /Partial — some holdings/)
      assert.match(m.part("portfolio-current-value") ?? "", /^\$11\.00/, "the value and the chart need no records")
      assert.equal(m.element.querySelector('[role="slider"]')?.getAttribute("aria-valuemax"), "36")
    } finally { await m.close() }
  })

  await t.test("while the records load Supplied is not a zero; records that fail are said, the value stays", async () => {
    reset(); boundary.balance = async () => "2"
    const pending = deferred<never[]>()
    giwaApi.activity = () => pending.promise
    const m = await mount()
    try {
      assert.equal(m.part("portfolio-supplied"), "Supplied —"); assert.equal(m.part("portfolio-earned"), "—")
      assert.deepEqual(m.cells(products[0]!.productId).slice(1, 3), ["—", "—"])
      assert.match(m.part("portfolio-current-value") ?? "", /^\$2\.00/)
    } finally { pending.resolve([]); await m.close() }
    giwaApi.activity = async () => { throw new Error("indexer down") }
    const failed = await mount()
    try {
      assert.match(failed.text(), /Your deposit history could not be loaded/)
      assert.equal(failed.part("portfolio-supplied"), "Supplied —")
      assert.match(failed.part("portfolio-current-value") ?? "", /^\$2\.00/)
    } finally { await failed.close() }
  })

  await t.test("Activity needs both streams; a failed stream never appears as no activity", async () => {
    reset(); giwaApi.redemptions = async () => { throw new Error("redemptions unavailable") }
    const m = await mount()
    try {
      await m.click("Activity")
      assert.match(m.text(), /Activity could not be loaded/); assert.doesNotMatch(m.text(), /No indexed activity/)
      giwaApi.redemptions = async () => []
      await m.click("Refresh")
      assert.match(m.text(), /No indexed activity yet/)
    } finally { await m.close() }
  })

  await t.test("wallet B never displays a delayed holdings response for A", async () => {
    reset(); const pending = deferred<string>()
    boundary.balance = async (_token, wallet) => wallet === A ? pending.promise : "0"
    const m = await mount()
    try {
      assert.match(m.text(), /Loading your holdings/)
      boundary.wallet.address = B; await m.render()
      assert.match(m.text(), /No holdings yet/)
      await act(async () => pending.resolve("123")); await settle()
      assert.match(m.text(), /No holdings yet/); assert.doesNotMatch(m.text(), /123/)
    } finally { await m.close() }
  })

  await t.test("product views: Savings then Funds groups with headings, shares and links (no Stocks, no tiles)", async () => {
    reset()
    const { categoryTitle } = await import("./fund-categories")
    giwaApi.catalog = async () => [saving, fund]
    giwaApi.market = async () => [
      { productId: saving.productId, navBase: 1, navUsd: 1, baseUsd: 1, apy: 5, impliedApy: null },
      { productId: fund.productId, navBase: 2, navUsd: 2, baseUsd: 1, apy: 8, impliedApy: null },
    ]
    boundary.balance = async (token) => token === saving.productTokenAddress ? "3" : token === fund.productTokenAddress ? "4" : "0"
    const m = await mount()
    try {
      const views = [...m.element.querySelectorAll('[aria-label="Portfolio products"] button')].map((button) => button.textContent)
      assert.deepEqual(views, ["All Portfolio", "Savings", "Funds"])
      assert.equal(m.part("portfolio-allocation"), null, "the allocation tiles are gone")
      // Groups in order, each a section named by its h3, its rows a list; the Savings group first though the Fund is larger.
      const sections = [...m.element.querySelectorAll("[data-group]")]
      assert.deepEqual(sections.map(s => s.querySelector("h3")?.textContent), ["Savings", "Funds"])
      for (const section of sections) {
        const id = section.querySelector("h3")!.id
        assert.equal(section.getAttribute("aria-labelledby"), id)
        assert.equal(section.querySelector("ul")?.getAttribute("aria-labelledby"), id)
      }
      assert.deepEqual(m.held(), [saving.productId, fund.productId])
      assert.equal(m.group("savings"), "Savings1 holding · 27.27%$3.00")
      assert.equal(m.group("funds"), "Funds1 holding · 72.73%$8.00")
      assert.doesNotMatch(m.text(), /Stocks|NVDA/)
      // Asset: symbol, then the kind chip (the Savings coin's kind; the fund's category, as on the Funds list).
      // (The name after "·" is read out on phones and shown from sm up; `visible` drops sr-only text.)
      assert.equal(m.cells(saving.productId)[0], `${saving.symbol}·Stablecoins`)
      assert.ok(m.row(saving.productId)!.textContent!.includes(saving.name), "the name is read out")
      assert.ok(m.cells(fund.productId)[0]?.endsWith(categoryTitle(fund.vaultConfig!.category!)), m.cells(fund.productId)[0] ?? "")
      // Rows are plain list items: no link, no chevron, nothing that opens another page.
      for (const li of m.element.querySelectorAll("li[data-holding]")) {
        assert.equal(li.querySelector("a, button, [role=link], svg"), null, li.getAttribute("data-holding") ?? "")
      }
      assert.equal(m.link(saving.productId), null)
      assert.equal(m.link(fund.productId), null)
      // Phones: no Supplied / Earned columns; what it earned sits under the value.
      assert.ok(m.row(fund.productId)!.querySelector('[data-cell="supplied"]')!.parentElement!.className.includes("hidden sm:flex"))
      assert.ok(m.row(fund.productId)!.querySelector('[data-cell="earned"]')!.parentElement!.className.includes("hidden sm:flex"))
      assert.ok(m.row(fund.productId)!.querySelector('[data-cell="earned-phone"]')!.className.includes("sm:hidden"))
      // Header labels; sorting stays within each group, so the groups keep their order.
      const holdings = m.element.querySelector('[data-testid="portfolio-holdings"]')!
      assert.equal(holdings.firstElementChild?.nextElementSibling?.textContent, "AssetSuppliedEarnedAPYCurrent value")
      await m.click("APY", holdings); await m.click("APY", holdings)
      assert.deepEqual(m.held(), [saving.productId, fund.productId])
      await m.click("Savings")
      assert.deepEqual(m.held(), [saving.productId])
      assert.equal(m.group("savings"), "Savings1 holding · 27.27%$3.00", "a single group keeps its heading, share and bar")
      assert.equal(m.group("funds"), null)
      await m.click("Funds")
      assert.deepEqual(m.held(), [fund.productId])
      await m.click("All Portfolio")
      assert.equal(m.held().length, 2)
      await m.click("Activity")
      assert.doesNotMatch(m.text(), /NVDA|Stocks trades/)
    } finally { await m.close() }
    // Nothing held: the empty state offers Savings and Funds only.
    reset()
    const empty = await mount()
    try {
      assert.match(empty.text(), /No holdings yet/)
      assert.match(empty.text(), /Deposit into Savings or Funds to start building your portfolio\./)
      assert.doesNotMatch(empty.text(), /Stocks/)
    } finally { await empty.close() }
  })

  await t.test("ArcoUSD v1: sArcoUSD is a Savings row; ArcoUSD and the Reserve's coins are Not earning, outside the portfolio", async () => {
    reset()
    const ARCO = "0x3d6Cb251d6aA62591ce9f6a13781a6dC590411Da", SARCO = "0xcAEF04FeA7f9c2561dbCA95E39a6b06043df30Fd", ZAP = "0xf4554ea97218645cF2EB209Cd540BD91321ba1E1"
    const USDT = "0x5555555555555555555555555555555555555555"
    const usdt = {
      option: { key: "usdt-giwa", symbol: "USDT", name: "Tether USD", logo: "/logos/usdt.png", decimals: 6, chain: "giwa", chainName: "GIWA" },
      token: USDT, symbol: "tUSDT", decimals: 6, depositEnabled: true, redeemEnabled: true, swapFeeBps: 0, instantFeeBps: 0, available: 0,
    }
    const live = {
      arcoUSD: ARCO, reserve: "0x4942711396B53df5b02fD8065E77FA2c9D27512F", assets: [usdt], depositPaused: false, redeemPaused: false,
      savings: { sArcoUSD: SARCO, zap: ZAP, sharePrice: 1.02, apyPercent: 4.5, paidApyPercent: 4.5, depositsOpen: true, withdrawalsOpen: true },
    }
    giwaApi.activity = async () => [{ eventName: "ZapDeposit", txHash: "0xzap", blockNumber: 1, contractAddress: ZAP.toLowerCase(), blockTimestamp: ago(200), args: { arcoUSDIn: e18(100), shares: e18(100), walletAddress: A.toLowerCase() } }] as never
    // The catalog vault holds nothing; the wallet has 100 sArcoUSD (deposited), 50 ArcoUSD and 20 tUSDT (not earning).
    boundary.balance = async (token) => (token === ARCO ? "50" : token === SARCO ? "100" : token === USDT ? "20" : "0")
    const m = await mount(live)
    const IDLE_ARCO = `idle:${ARCO.toLowerCase()}`, IDLE_USDT = `idle:${USDT.toLowerCase()}`
    try {
      // Savings is the sArcoUSD alone: 100 × 1.02 = $102. ArcoUSD and tUSDT are in the "Not earning" group, last.
      assert.equal(m.group("savings"), "Savings1 holding · 100%$102.00+$2.00")
      assert.equal(m.group("funds"), null, "a group with no holdings is not shown")
      assert.deepEqual([...m.element.querySelectorAll("[data-group]")].map(g => g.querySelector("h3")?.textContent), ["Savings", "Not earning"])
      assert.equal(m.group("idle"), "Not earning2 assets$70.00", "no share of the portfolio, no earned total")
      assert.equal(m.element.querySelector('[data-testid="portfolio-group-idle"] .rounded-full'), null, "no share bar")
      assert.deepEqual(m.held(), ["arcousd:sArcoUSD", IDLE_ARCO, IDLE_USDT])
      assert.equal(m.cells(IDLE_ARCO)[0], "ArcoUSD·Not earning")
      assert.ok(m.row(IDLE_ARCO)!.textContent!.startsWith("ArcoUSD·Arco USD"), "its name is read out")
      assert.deepEqual(m.cells(IDLE_ARCO).slice(1), ["—", "—", "—", "$50.00"])
      assert.equal(m.row(IDLE_ARCO)!.querySelector('[data-cell="balance"]')?.textContent, "Balance 50 ArcoUSD")
      assert.deepEqual(m.cells(IDLE_USDT).slice(1), ["—", "—", "—", "$20.00"])
      assert.equal(m.link(IDLE_ARCO), null)
      // Within the group only Current value sorts it: smallest first, then any other key leaves it largest first.
      await m.click("Current value", m.element.querySelector('[data-testid="portfolio-holdings"]')!)
      assert.deepEqual(m.held().slice(-2), [IDLE_USDT, IDLE_ARCO])
      await m.click("APY", m.element.querySelector('[data-testid="portfolio-holdings"]')!)
      assert.deepEqual(m.held().slice(-2), [IDLE_ARCO, IDLE_USDT])
      assert.deepEqual(m.cells("arcousd:sArcoUSD").slice(1), ["$100.00", "+$2.00", "4.5%", "$102.00"])
      // sArcoUSD in ArcoUSD, its asset; the Not earning rows keep their balance line and get no asset lines.
      assert.deepEqual(m.units("arcousd:sArcoUSD"), ["100 ArcoUSD", "+2 ArcoUSD", "102 ArcoUSD"])
      for (const idleKey of [IDLE_ARCO, IDLE_USDT]) {
        assert.deepEqual(m.units(idleKey), [null, null, null], idleKey)
        assert.ok(m.row(idleKey)!.querySelector('[data-cell="balance"]'), idleKey)
      }
      // The headline numbers are the deposited portfolio's alone: no ArcoUSD in the value, Supplied or Net APY.
      assert.match(m.part("portfolio-current-value") ?? "", /^\$102\.00/)
      assert.equal(m.part("portfolio-supplied"), "Supplied $100.00")
      assert.equal(m.part("portfolio-earned"), "+$2.00")
      assert.equal(m.part("portfolio-net-apy"), "4.5%")
      assert.match(m.text(), /Estimate only, at today's 4\.5% Net APY with nothing added or withdrawn\./)
      // The projection: 102 × 1.045³. The what-if adds the interest the $70 would earn at sArcoUSD's 4.5%.
      const { money } = await import("../lib/format")
      const { projectEarnings, whatIfOf } = await import("./portfolio-projection")
      const end = (whatIf: ReturnType<typeof whatIfOf>) => projectEarnings({ value: 102, earningUsd: 102, apyPercent: 4.5, range: "3Y", today: new Date(), whatIf })[12]!.value
      const normal = end(null), withIdle = end(whatIfOf([{ usd: 50, apyPercent: 4.5 }, { usd: 20, apyPercent: 4.5 }]))
      assert.ok(Math.abs(withIdle - normal - 70 * (1.045 ** 3 - 1)) < 0.01)
      // At rest the right slot shows the what-if at the end of the range, on phones too.
      assert.equal(m.part("portfolio-earnings-what-if"), `With idle assets in Savings${money(withIdle)}+${money(withIdle - normal)} more interest`)
      const whatIfClasses = m.element.querySelector('[data-testid="portfolio-earnings-what-if"]')!.className.split(" ")
      assert.ok(!whatIfClasses.includes("hidden"), "not desktop only any more")
      assert.ok(m.element.querySelector('[data-testid="portfolio-earnings-what-if-line"]'), "small next to the projection: drawn")
      assert.equal(m.element.querySelector('[data-testid="portfolio-earnings-compare"]'), null)
      assert.equal(m.part("portfolio-earnings-legend"), "Projected balanceWith idle assets in Savings")
      assert.equal(m.part("portfolio-earnings-cta"), "$70.00 is not earning.Move to Savings →")
      assert.equal(m.element.querySelector('[data-testid="portfolio-earnings-cta"] a')?.getAttribute("href"), "/savings")
      assert.match(m.part("portfolio-earnings-tip") ?? "", / not at zero\. The dashed line adds the interest your idle assets would earn at today's Savings rates; it is not a promise\.$/)
      // The scrubber at the end: the projected balance on the left, the what-if on the right.
      const arcoSlider = m.element.querySelector('[role="slider"]') as HTMLElement
      await act(async () => { arcoSlider.dispatchEvent(new dom.window.PointerEvent("pointermove", { bubbles: true, clientX: 624, clientY: 100, pointerType: "mouse", pointerId: 1 })) })
      assert.equal(m.part("portfolio-earnings-value"), money(normal))
      assert.equal(m.part("portfolio-earnings-what-if"), `With idle assets in Savings${money(withIdle)}+${money(withIdle - normal)} more interest`)
      assert.match(arcoSlider.getAttribute("aria-valuetext") ?? "", new RegExp(`with idle assets in savings: \\${money(withIdle)}$`))
      // "Not earning" shows under All Portfolio only.
      await m.click("Funds")
      assert.deepEqual(m.held(), [])
      await m.click("Savings")
      assert.deepEqual(m.held(), ["arcousd:sArcoUSD"])
      await m.click("All Portfolio")
      // An unread ArcoUSD balance: a quiet line in the group; the portfolio is still shown.
      boundary.balance = async (token) => { if (token === ARCO) throw new Error("rpc"); return token === SARCO ? "100" : "0" }
      await m.click("Refresh")
      assert.match(m.part("portfolio-group-idle-status") ?? "", /Your other balances could not be read\. Use Refresh to try again\./)
      assert.equal(m.group("savings"), "Savings1 holding · 100%$102.00+$2.00")
      assert.doesNotMatch(m.text(), /Holdings could not be loaded/)
    } finally { await m.close() }
  })

  await t.test("a wallet with only coins it could deposit: an empty portfolio, the Not earning group still lists them", async () => {
    reset()
    const tUSDC = products[0]!.paymentAssetAddress!
    // While the balances load the group says so without holding the rest up.
    const pending = deferred<string>()
    boundary.balance = async (token) => (token === tUSDC ? pending.promise : "0")
    const m = await mount()
    try {
      assert.match(m.part("portfolio-group-idle-status") ?? "", /Checking your wallet/)
      await act(async () => pending.resolve("250.5")); await settle()
      assert.equal(m.part("portfolio-group-idle-status"), null)
      assert.match(m.part("portfolio-current-value") ?? "", /^\$0\.00/)
      assert.equal(m.part("portfolio-supplied"), "Supplied $0.00")
      assert.match(m.part("portfolio-earnings-empty") ?? "", /Deposit into Savings or Funds to see your potential earnings/)
      assert.doesNotMatch(m.text(), /No holdings yet/)
      assert.equal(m.group("idle"), "Not earning1 asset$250.50")
      assert.equal(m.row(`idle:${tUSDC.toLowerCase()}`)!.querySelector('[data-cell="balance"]')?.textContent, "Balance 250.5 tUSDC")
      // Dust (under a cent) is not listed.
      boundary.balance = async (token) => (token === tUSDC ? "0.004" : "0")
      await m.click("Refresh")
      assert.equal(m.group("idle"), null)
      assert.match(m.text(), /No holdings yet/)
    } finally { await m.close() }
  })

  await t.test("ArcoUSD v1 reads not answered yet are loading, reads that keep failing are an error with Refresh", async () => {
    reset(); boundary.balance = async () => "0"
    const pending = await mount(null, { pending: true })
    try {
      assert.match(pending.text(), /Loading your holdings/); assert.doesNotMatch(pending.text(), /No holdings yet|\$0\.00/)
    } finally { await pending.close() }
    let retried = 0
    const failed = await mount(null, { pending: true, failed: { retry: () => { retried += 1 } } })
    try {
      assert.match(failed.text(), /Holdings could not be loaded/); assert.doesNotMatch(failed.text(), /No holdings yet/)
      await failed.click("Refresh")
      assert.equal(retried, 1)
    } finally { await failed.close() }
  })

  await t.test("ArcoGOLD: a Savings row at ounces per share × an ounce's dollars; supplied from its Zap rows, unknown without them", async () => {
    reset()
    const GOLD = "0xCfBB1da2040Bd559B2d7a96F818494d922Fb1860", GOLD_ZAP = "0x6C67403808DCDA693e5B9f2ddF543659FF3f27B4"
    // Its own coin, tPAXG (one coin is one troy ounce): what the gold Savings account names ounces.
    const PAXG = "0x6666666666666666666666666666666666666666"
    const coins = [{
      option: { key: "paxg", symbol: "PAXG", name: "PAX Gold", logo: "/logos/paxg.png", decimals: 18, chain: "giwa", chainName: "GIWA" },
      token: PAXG, symbol: "tPAXG", decimals: 18, depositEnabled: true, redeemEnabled: true, swapFeeBps: 0, instantFeeBps: 0, available: 0,
    }]
    const gold = { arcoGOLD: GOLD, zap: GOLD_ZAP, coins, sharePrice: 1.25, ounceUsd: 2400, apyPercent: 3.1, depositPaused: false, redeemPaused: false, depositsOpen: true, withdrawalsOpen: true }
    const read: string[] = []
    boundary.balance = async (token) => { read.push(token); return token === GOLD ? "2" : "0" }
    const m = await mount(null, { gold })
    try {
      // 2 ArcoGOLD × 1.25 oz × $2,400 = $6,000 under Savings, at the set 3.1%. No gold rows yet: supplied unknown.
      assert.equal(m.group("savings"), "Savings1 holding · 100%$6,000.00", "no earned total while the principal is unknown")
      assert.deepEqual(m.cells("arcogold:ArcoGOLD").slice(1), ["—", "—", "3.1%", "$6,000.00"])
      assert.equal(m.cells("arcogold:ArcoGOLD")[0], "ArcoGOLDGold")
      assert.equal(m.link("arcogold:ArcoGOLD"), null)
      assert.equal(m.part("portfolio-supplied"), "Supplied —")
      assert.ok(m.element.querySelector('img[src="/logos/arcogold.png"]'), "the ArcoGOLD mark")
      assert.ok(read.includes(GOLD))
      // The server's gold rows: 2.45 oz in through the Zap; the position is 2.5 oz now: 0.05 oz × $2,400 earned.
      giwaApi.activity = async () => [{ eventName: "ZapDeposit", txHash: "0xg", blockNumber: 1, contractAddress: GOLD_ZAP.toLowerCase(), blockTimestamp: ago(300), args: { arcoUSDIn: e18(2.45), shares: e18(2), walletAddress: A.toLowerCase() } }] as never
      await m.click("Refresh")
      assert.deepEqual(m.cells("arcogold:ArcoGOLD").slice(1), ["$5,880.00", "+$120.00", "3.1%", "$6,000.00"])
      // In ounces, named tPAXG as on the gold Savings account; up to 4 decimals.
      assert.deepEqual(m.units("arcogold:ArcoGOLD"), ["2.45 tPAXG", "+0.05 tPAXG", "2.5 tPAXG"])
      // Nothing earned yet: "$0.00" over "0 tPAXG", neither signed nor green.
      giwaApi.activity = async () => [{ eventName: "ZapDeposit", txHash: "0xg", blockNumber: 1, contractAddress: GOLD_ZAP.toLowerCase(), blockTimestamp: ago(1), args: { arcoUSDIn: e18(2.5), shares: e18(2), walletAddress: A.toLowerCase() } }] as never
      await m.click("Refresh")
      assert.deepEqual(m.cells("arcogold:ArcoGOLD").slice(1), ["$6,000.00", "$0.00", "3.1%", "$6,000.00"])
      assert.deepEqual(m.units("arcogold:ArcoGOLD"), ["2.5 tPAXG", "0 tPAXG", "2.5 tPAXG"])
      assert.match(m.row("arcogold:ArcoGOLD")!.querySelector('[data-cell="earned-units"]')!.className, /text-\[var\(--color-arco-ink\)\]/)
      // No ounce price: the holding stays (its balance shown), its value is not guessed, and no asset lines.
      await m.close()
      const unpriced = await mount(null, { gold: { ...gold, ounceUsd: null } })
      try {
        assert.deepEqual(unpriced.cells("arcogold:ArcoGOLD").slice(1), ["—", "—", "3.1%", "2 ArcoGOLD"])
        assert.doesNotMatch(unpriced.text(), /\$6,000/)
        assert.deepEqual(unpriced.units("arcogold:ArcoGOLD"), [null, null, null])
      } finally { await unpriced.close() }
    } finally { await m.close().catch(() => undefined) }
    // Before the gold deploy (no live gold): nothing is read for ArcoGOLD and no row shows.
    reset(); read.length = 0
    boundary.balance = async (token) => { read.push(token); return "0" }
    const none = await mount()
    try {
      assert.ok(!none.text().includes("ArcoGOLD"))
      assert.ok(!read.includes(GOLD))
    } finally { await none.close() }
  })

  await t.test("ArcoUSD v1 without a live Savings: ArcoUSD alone, nothing read for sArcoUSD", async () => {
    reset()
    const ARCO = "0x3d6Cb251d6aA62591ce9f6a13781a6dC590411Da"
    const read: string[] = []
    boundary.balance = async (token) => { read.push(token); return token === ARCO ? "7" : "0" }
    const m = await mount({ arcoUSD: ARCO, reserve: "0x4942711396B53df5b02fD8065E77FA2c9D27512F", assets: [], depositPaused: false, redeemPaused: false, savings: null })
    try {
      assert.deepEqual(m.held(), [`idle:${ARCO.toLowerCase()}`], "ArcoUSD is Not earning")
      assert.ok(!m.text().includes("sArcoUSD"))
      assert.ok(read.includes(ARCO))
      // Nothing deposited (ArcoUSD is not part of the portfolio): the chart's empty message, no what-if, no "?" tip.
      assert.match(m.part("portfolio-earnings-empty") ?? "", /Deposit into Savings or Funds to see your potential earnings/)
      assert.equal(m.part("portfolio-earnings-cta"), null)
      assert.equal(m.part("portfolio-earnings-tip"), null)
    } finally { await m.close() }
  })

  await t.test("not connected: the connect prompt only", async () => {
    reset(); boundary.wallet.address = null as never
    const m = await mount()
    try {
      assert.match(m.text(), /Connect your wallet/)
      assert.equal(m.part("portfolio-current-value"), null)
    } finally { await m.close() }
  })
})

test("holding asset amounts: the Not earning balance format; never a 0 for something", async () => {
  const { assetAmountText, earnedAssetText } = await import("./PortfolioHoldings")
  // Dollar coins to 2 decimals, any other coin to 4; cut, not rounded; grouped; no forced trailing zeros.
  assert.equal(assetAmountText(1_040, "tUSDC"), "1,040")
  assert.equal(assetAmountText(1_021.4999, "ArcoUSD"), "1,021.49")
  assert.equal(assetAmountText(0.05123456, "tBTC"), "0.0512")
  assert.equal(assetAmountText(3_992.93567, "tXRP"), "3,992.9356")
  assert.equal(assetAmountText(2.5, "tPAXG"), "2.5")
  // A non-zero amount the cut would show as 0.
  assert.equal(assetAmountText(0.00004, "tBTC"), "<0.0001")
  assert.equal(assetAmountText(0.004, "tUSDC"), "<0.01")
  assert.equal(assetAmountText(0, "tBTC"), "0")
  // Earned: signed once the dollars show something earned, "0" when they show $0.00.
  const known = (earned: number, earnedUnits: number) => ({ status: "known", supplied: 1, earned, deposited: 1, suppliedUnits: 1, earnedUnits }) as const
  assert.equal(earnedAssetText(known(110.4, 0.0012), "tBTC"), "+0.0012")
  assert.equal(earnedAssetText(known(0.0092, 0.0000001), "tBTC"), "+<0.0001")
  assert.equal(earnedAssetText(known(0.004, 0.00000004), "tBTC"), "0", "under half a cent: as $0.00")
  assert.equal(earnedAssetText(known(0, 0), "ArcoUSD"), "0")
})
