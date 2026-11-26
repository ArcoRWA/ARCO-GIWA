import assert from "node:assert/strict"
import { createRequire } from "node:module"
import test from "node:test"
const runtime = process.env.GIWA_MARKET_DOM_RUNTIME

test("search palette: opens from the field or '/', lists sections, filters, moves a cursor, traps focus and closes", { skip: !runtime }, async (t) => {
  const { JSDOM } = createRequire(runtime!)("jsdom")
  const dom = new JSDOM('<html><body><div id="root"></div><input id="elsewhere" /><button id="outside">Outside</button></body></html>', { url: "https://fixture.invalid", pretendToBeVisual: true })
  const w = dom.window
  w.matchMedia = () => ({ matches: true })
  const globals: Record<string, unknown> = { window: w, document: w.document, navigator: w.navigator, HTMLElement: w.HTMLElement, Element: w.Element, Node: w.Node, Event: w.Event, KeyboardEvent: w.KeyboardEvent, MouseEvent: w.MouseEvent, MutationObserver: w.MutationObserver, requestAnimationFrame: w.requestAnimationFrame.bind(w), cancelAnimationFrame: w.cancelAnimationFrame.bind(w), IS_REACT_ACT_ENVIRONMENT: true }
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value })
  t.after(() => {
    dom.window.close()
    for (const key of Object.keys(globals)) { if (previous[key]) Object.defineProperty(globalThis, key, previous[key]!); else Reflect.deleteProperty(globalThis, key) }
  })
  const { act, createElement: h } = await import("react")
  const { createRoot } = await import("react-dom/client")
  const { MemoryRouter, useLocation, useNavigate } = await import("react-router-dom")
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query")
  const { GiwaProductSearch } = await import("../../GiwaProductSearch")
  const { StocksPageEnvironment } = await import("../../stocks-market/environment")
  const { GiwaFeaturesContext } = await import("../../features")
  const { fixtureTop40MarketFetch } = await import("../../stocks-market/fixtures")
  const { giwaApi } = await import("../../api")
  const { default: snapshot } = await import("./deployed-giwa.snapshot.json")
  const original = { catalog: giwaApi.catalog, market: giwaApi.market }
  t.after(() => Object.assign(giwaApi, original))
  giwaApi.catalog = async () => snapshot.catalog as unknown as Awaited<ReturnType<typeof giwaApi.catalog>>
  giwaApi.market = async () => snapshot.market
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  t.after(() => client.clear())
  const fetcher = fixtureTop40MarketFetch()
  let failStocks = false
  let stockReads = 0
  const environment = { apiBase: "https://fixture.invalid", fetch: (url: string, init: RequestInit) => { stockReads += 1; return failStocks ? Promise.reject(new Error("offline")) : fetcher(url, init) } }
  const tick = async () => { await new Promise(resolve => setTimeout(resolve, 30)) }
  const doc = w.document
  const fire = async (el: EventTarget, event: Event) => { await act(async () => { el.dispatchEvent(event); await tick() }) }
  const key = (el: EventTarget, value: string, init: KeyboardEventInit = {}) => fire(el, new w.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...init }))
  const click = async (el: Element | null) => { assert.ok(el); await act(async () => { (el as HTMLElement).click(); await tick() }) }
  const palette = () => doc.querySelector('[role="dialog"][aria-label="Search"]') as HTMLElement | null
  const input = () => palette()!.querySelector("input")!
  const type = async (value: string) => { await act(async () => { Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value")!.set!.call(input(), value); input().dispatchEvent(new w.Event("input", { bubbles: true })); await tick() }) }
  const options = (): HTMLElement[] => Array.from(palette()?.querySelectorAll('[role="option"]') ?? [])
  const sections = () => Array.from(palette()!.querySelectorAll("[data-section]")).map(el => [el.getAttribute("data-section"), el.firstElementChild!.textContent])
  const field = () => doc.querySelector('button[aria-keyshortcuts="/"]') as HTMLElement
  const route = { path: "", navigate: null as null | ((to: string) => void) }
  function Route() { const location = useLocation(); route.path = location.pathname + location.search; route.navigate = useNavigate(); return null }
  async function mount(stocks: boolean) {
    const root = createRoot(doc.getElementById("root")!)
    await act(async () => root.render(h(QueryClientProvider, { client }, h(GiwaFeaturesContext.Provider, { value: { home: true, stocks } }, h(StocksPageEnvironment.Provider, { value: environment }, h(MemoryRouter, { initialEntries: ["/portfolio"] }, h(GiwaProductSearch), h(Route)))))))
    await act(tick)
    return root
  }

  // ── As the app ships: Stocks hidden. ──
  let root = await mount(false)
  try {
    // The field: the placeholder and the "/" keycap; closed, no palette.
    assert.match(field().textContent!, /Search savings, funds, pages…\//)
    assert.equal(field().getAttribute("aria-haspopup"), "dialog")
    assert.equal(palette(), null)
    await click(field())
    await act(tick)
    const dialog = palette()!
    assert.equal(dialog.getAttribute("aria-modal"), "true")
    assert.equal(doc.activeElement, input(), "focus in the input")
    assert.equal(doc.body.style.overflow, "hidden", "the page behind does not scroll")
    assert.equal(input().getAttribute("placeholder"), "Search savings, funds, pages…")
    assert.equal(input().getAttribute("role"), "combobox")
    assert.equal(input().getAttribute("aria-controls"), palette()!.querySelector('[role="listbox"]')!.id)
    // Sections in order with their counts (products always; pages and actions only while filtering). No converters
    // here, so no Convert; no Stocks.
    assert.deepEqual(sections(), [["savings", "Savings3"], ["funds", "Funds3"], ["pages", "Pages"], ["actions", "Actions"]])
    assert.deepEqual(options().map(el => el.getAttribute("data-row")), ["savings:arcousd", "savings:aeth", "savings:axrp", "fund:nuva-home", "fund:digift-jx", "fund:bitwise-pplus", "page:savings", "page:funds", "page:portfolio", "action:docs", "action:terms"])
    assert.equal(stockReads, 0, "hidden Stocks: nothing read")
    // Rows: Savings as "Savings · <category>" with the APY in the up colour over "APY"; funds with the table's text.
    const sArco = options()[0]!
    assert.match(sArco.textContent!, /^sArcoUSDSavings · Stablecoins4\.79%APY$/)
    assert.match(sArco.querySelector(".text-\\[var\\(--color-arco-up-text\\)\\]")!.textContent!, /^4\.79%$/)
    assert.equal(options()[3]!.textContent, "HOME · NUVA HOME VaultFund7%Target APY")
    // External links open in a new tab.
    const docs = palette()!.querySelector<HTMLAnchorElement>('[data-row="action:docs"]')!
    assert.equal(docs.tagName, "A")
    assert.equal(docs.getAttribute("target"), "_blank")
    assert.equal(docs.getAttribute("rel"), "noopener noreferrer")
    assert.match(docs.textContent!, /Documentation/)
    // The keys bar: desktop only; the phone sheet: full screen below xl, its Cancel below xl only.
    assert.match(palette()!.querySelector('[data-testid="search-keys"]')!.className, /hidden .*xl:flex/)
    assert.match(dialog.className, /h-full w-full .*xl:absolute .*xl:top-\[92px\] .*xl:w-\[640px\]/)
    assert.match(dialog.className, /pt-\[env\(safe-area-inset-top\)\]/)
    assert.match(dialog.parentElement!.className, /fixed inset-0 z-\[70\] .*xl:bg-\[var\(--color-arco-overlay\)\] xl:backdrop-blur/)
    const cancel = Array.from(dialog.querySelectorAll("button")).find(el => el.textContent === "Cancel")!
    assert.match(cancel.className, /xl:hidden/)

    // Keyboard: the cursor starts on the first row, moves, wraps both ways; Enter opens the cursor's row.
    const active = () => input().getAttribute("aria-activedescendant")
    assert.equal(active(), options()[0]!.id)
    assert.equal(options()[0]!.getAttribute("aria-selected"), "true")
    await key(input(), "ArrowUp")
    assert.equal(active(), options().slice(-1)[0]!.id, "wraps to the last")
    await key(input(), "ArrowDown")
    assert.equal(active(), options()[0]!.id, "and back to the first")
    await key(input(), "ArrowDown"); await key(input(), "ArrowDown"); await key(input(), "ArrowDown")
    assert.equal(active(), options()[3]!.id)
    // Tab stays inside.
    await key(input(), "Tab")
    assert.ok(palette()!.contains(doc.activeElement))
    await key(input(), "Enter")
    assert.equal(route.path, "/product/nuva-home")
    assert.equal(palette(), null, "a new page closes it")
    assert.equal(doc.body.style.overflow, "")

    // Filtering: across sections, matched text bold, counts while filtering; Enter with no cursor move opens the first.
    await click(field())
    await type("home")
    assert.deepEqual(sections(), [["funds", "Funds1"]])
    assert.equal(palette()!.querySelector('[data-row="fund:nuva-home"] mark')!.textContent, "HOME")
    await type("crypto")
    assert.deepEqual(sections(), [["savings", "Savings2"], ["pages", "Pages1"]])
    assert.deepEqual(options().map(el => el.getAttribute("data-row")), ["savings:aeth", "savings:axrp", "page:savings:crypto-native"])
    assert.equal(palette()!.querySelector('[data-row="page:savings:crypto-native"]')!.textContent, "Savings › CryptoSavings category")
    assert.equal(palette()!.querySelector('[data-row="page:savings:crypto-native"] mark')!.textContent, "Crypto")
    await type("portfolio")
    assert.deepEqual(sections(), [["pages", "Pages1"]])
    await type("terms")
    assert.deepEqual(sections(), [["actions", "Actions1"]])
    // Gold: no live gold account here, so neither the account nor the Gold category; no results then.
    await type("xyz")
    assert.equal(palette()!.querySelector('[data-testid="search-empty"]')!.textContent, "No results for “xyz”Try a coin, a fund or a fund manager, like “BTC” or “Bitwise”.")
    assert.deepEqual(sections(), [["pages", "Pages"], ["actions", "Actions"]], "pages and actions still listed")
    await type("gold")
    assert.ok(palette()!.querySelector('[data-testid="search-empty"]'))
    await type("savings")
    await key(input(), "Enter")
    assert.equal(route.path, "/savings?category=stablecoins&asset=USDC&account=real%3Aarcousd%3AUSDC", "Enter opens the first row")

    // Escape closes and gives focus back to the field.
    await click(field())
    assert.ok(palette())
    await key(input(), "Escape")
    assert.equal(palette(), null)
    await act(tick)
    assert.equal(doc.activeElement, field())
    // A press on the dimmed page closes it too.
    await click(field())
    await fire(palette()!.parentElement!, new w.MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    assert.equal(palette(), null)
    // The route changing under it closes it.
    await click(field())
    await act(async () => { route.navigate!("/funds"); await tick() })
    assert.equal(palette(), null)

    // "/" opens it from the page; never while typing in a field, never with ⌘ / Ctrl / Alt, and no ⌘ or Ctrl shortcut.
    ;(doc.activeElement as HTMLElement | null)?.blur()
    await key(doc.body, "/", { ctrlKey: true })
    await key(doc.body, "/", { metaKey: true })
    await key(doc.body, "/", { altKey: true })
    for (const other of ["k", "a"]) { await key(doc.body, other, { metaKey: true }); await key(doc.body, other, { ctrlKey: true }) }
    assert.equal(palette(), null)
    const elsewhere = doc.getElementById("elsewhere")!
    elsewhere.focus()
    await key(elsewhere, "/")
    assert.equal(palette(), null, "typing / in a field types it")
    elsewhere.blur()
    await key(doc.body, "/")
    assert.ok(palette(), "/ opens it")
    // Inside the palette "/" is typed, not a new palette.
    await key(input(), "/")
    assert.equal(doc.querySelectorAll('[role="dialog"]').length, 1)
    await key(input(), "Escape")
  } finally { await act(async () => root.unmount()) }

  // ── With Stocks shown: a Stocks section after Funds; a Stocks failure keeps Savings and Funds. ──
  root = await mount(true)
  try {
    await click(field())
    await act(tick)
    assert.deepEqual(sections(), [["savings", "Savings3"], ["funds", "Funds3"], ["stocks", "Stocks40"], ["pages", "Pages"], ["actions", "Actions"]])
    await type("tesla")
    assert.deepEqual(options().map(el => el.getAttribute("data-row")), ["stock:TSLA"])
    await key(input(), "Enter")
    assert.equal(route.path, "/stocks?symbol=TSLA")
  } finally { await act(async () => root.unmount()) }
  failStocks = true
  client.removeQueries()
  root = await mount(true)
  try {
    await click(field())
    for (let i = 0; i < 10 && !/Stocks are temporarily unavailable/.test(palette()!.textContent!); i++) await act(tick)
    assert.match(palette()!.textContent!, /Stocks are temporarily unavailable/)
    assert.deepEqual(sections().map(([id]) => id), ["savings", "funds", "pages", "actions"])
  } finally { await act(async () => root.unmount()) }
})
