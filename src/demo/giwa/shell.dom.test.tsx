import assert from "node:assert/strict"
import test from "node:test"
import { createRequire } from "node:module"
import { act, StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { MemoryRouter, Route, Routes, useLocation, useNavigate, type NavigateFunction } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
// GiwaPreprodApp and ./wallet are imported inside the test, after the fetch guard below is installed (see there).

// No dependency added: opt into the already-installed DOM runtime for this integration gate.
// jsdom has no media queries, so both the xl rail and the below-xl tab bar and menu are in the DOM; the assertions cover
// behaviour (focus, keyboard, pointer, routing) and the breakpoint classes that decide which one CSS shows.
const runtime = process.env.GIWA_HOST_DOM_RUNTIME
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve() }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test("investor shell DOM (set GIWA_HOST_DOM_RUNTIME to an existing jsdom package.json)", { skip: !runtime }, async t => {
  const { JSDOM } = createRequire(runtime!)("jsdom")
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://app.example/", pretendToBeVisual: true })
  // Everything this shell renders comes from the seeded query cache: any app network read is a failure (fetchCalls).
  // One third-party request is expected and answered offline: loading the Dynamic SDK (./wallet imports it) starts a
  // wallet-book CDN fetch at module evaluation (@dynamic-labs/wallet-book hooks/useWalletBookCdn.js: "Initiate wallet
  // book fetch immediately"), retries it and then uses its bundled fallback list. Only that exact URL gets a 503 stub and
  // is counted apart (sdkAssetCalls); nothing leaves the process. The app modules are imported after this guard is
  // installed, so the request can no longer reach the real network or land at an arbitrary point of a leaf test.
  const DYNAMIC_WALLET_BOOK = "https://dynamic-static-assets.com/wallet-book/v1/stable/wallet-book.json"
  const fetchCalls: string[] = []
  const sdkAssetCalls: string[] = []
  const globals: Record<string, unknown> = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: (async (input: unknown) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : String((input as { url?: unknown })?.url ?? input)
      if (url === DYNAMIC_WALLET_BOOK) { sdkAssetCalls.push(url); return new Response(null, { status: 503, statusText: "offline test stub" }) }
      fetchCalls.push(url)
      throw new Error("network disabled in shell DOM test")
    }) as typeof fetch,
  }
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  t.after(() => { dom.window.close(); for (const key of Object.keys(globals)) { const descriptor = previous[key]; if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) } })

  const { GiwaPreprodApp } = await import("./GiwaPreprodApp")
  const { GiwaWalletProvider } = await import("./wallet")
  const { ArcoUsdConvertContext } = await import("./savings-routes")
  // The nav mechanics are tested over every tab; the shipped switch (features.ts) is tested in investor-nav.test.tsx.
  const { GiwaFeaturesContext } = await import("./features")
  t.after(() => { t.diagnostic(`Dynamic wallet-book requests answered offline: ${sdkAssetCalls.length}; other requests: ${fetchCalls.length}`) })

  // `convert`: Get ArcoUSD's converters, as the preview's demo wallet provides them (none by default here).
  async function mount(path: string, convert: import("./arcousd-convert").ArcoUsdConvert | null = null, admin = false) {
    const element = document.createElement("div"); document.body.append(element)
    const root = createRoot(element)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(["giwa", "catalog"], [])
    // The live ArcoUSD v1 reads the shell makes for Get ArcoUSD and Savings (arcousd-live-context.tsx): not deployed here.
    client.setQueryData(["giwa", "arcousd", "reserve"], { status: "not-deployed", chainId: 91342, contracts: null, readAt: "", reserve: null, gate: { status: "inactive", reason: "not-deployed" } })
    client.setQueryData(["giwa", "arcousd", "savings"], { status: "not-deployed", chainId: 91342, contracts: null, readAt: "", savings: null })
    // The live ArcoGOLD reads (arcogold-live-context.tsx) for the gold Savings account and Mint test assets: not deployed here.
    client.setQueryData(["giwa", "arcogold", "reserve"], { status: "not-deployed", chainId: 91342, contracts: null, readAt: "", reserve: null })
    client.setQueryData(["giwa", "arcogold", "savings"], { status: "not-deployed", chainId: 91342, contracts: null, readAt: "", savings: null, apyPercent: 3.1, ounceUsd: null })
    const probe: { pathname: string; search: string; navigate: NavigateFunction | null } = { pathname: "", search: "", navigate: null }
    function Probe() { const location = useLocation(); probe.pathname = location.pathname; probe.search = location.search; probe.navigate = useNavigate(); return null }
    await act(async () => {
      root.render(<StrictMode><QueryClientProvider client={client}><GiwaWalletProvider><ArcoUsdConvertContext.Provider value={convert}><GiwaFeaturesContext.Provider value={{ home: true, stocks: true }}><MemoryRouter initialEntries={[path]}>
        <Probe />
        <Routes><Route element={<GiwaPreprodApp admin={admin} />}><Route path="*" element={<p>page body</p>} /></Route></Routes>
      </MemoryRouter></GiwaFeaturesContext.Provider></ArcoUsdConvertContext.Provider></GiwaWalletProvider></QueryClientProvider></StrictMode>)
      await flush()
    })
    const rail = () => element.querySelector<HTMLElement>("aside")!
    return {
      element, probe, rail,
      nav: () => rail().querySelector<HTMLElement>('nav[aria-label="Main"]')!,
      bar: () => element.querySelector<HTMLElement>('nav[aria-label="Tab bar"]')!,
      savingsTab: () => rail().querySelector<HTMLAnchorElement>('a[href="/savings"]')!,
      flyout: () => document.getElementById(rail().querySelector<HTMLAnchorElement>('a[href="/savings"]')!.getAttribute("aria-controls")!)!,
      async go(to: string) { await act(async () => { probe.navigate!(to); await flush() }) },
      async unmount() { await act(async () => root.unmount()); element.remove() },
    }
  }
  function key(target: Element, name: string, shiftKey = false) {
    const event = new dom.window.KeyboardEvent("keydown", { key: name, shiftKey, bubbles: true, cancelable: true })
    act(() => { target.dispatchEvent(event) })
    return event
  }
  async function pointer(target: Element, type: "pointerover" | "pointerout" | "pointerdown", pointerType = "mouse", relatedTarget: Element | null = document.body) {
    await act(async () => { target.dispatchEvent(new dom.window.PointerEvent(type, { bubbles: true, cancelable: true, pointerType, relatedTarget })); await flush() })
  }
  async function focus(target: HTMLElement) { await act(async () => { target.focus(); await flush() }) }
  function currentLabels(scope: Element) {
    return [...scope.querySelectorAll('[aria-current="page"]')].map(node => node.textContent?.trim())
  }

  await t.test("rail: one tab per page with aria-current on the active route; the skip link comes first", async () => {
    const m = await mount("/funds")
    assert.deepEqual([...m.nav().querySelectorAll("a")].filter(a => !a.closest("[id]")).map(a => a.textContent), ["Home", "Savings", "Funds", "Stocks", "Portfolio"])
    const cases: Array<[string, string]> = [["/funds", "Funds"], ["/product/abc", "Funds"], ["/stocks", "Stocks"], ["/admin/stocks", "Stocks"], ["/home", "Home"], ["/savings", "Savings"], ["/portfolio", "Portfolio"]]
    for (const [path, label] of cases) {
      await m.go(path)
      assert.deepEqual(currentLabels(m.nav()), [label], path)
      assert.equal(m.nav().querySelector('[aria-current="page"]')!.tagName, "A", path)
    }
    assert.equal(m.rail().querySelector('a[href="/admin"]'), null, "Admin only for allowlisted wallets")
    assert.equal(m.rail().querySelector('a[href="/send"]'), null, "Send stays out of the menu until it exists")
    // The rail is the xl nav; nothing of the old sidebar is left.
    assert.match(m.rail().className, /\bhidden\b.*\bxl:flex\b/)
    assert.equal(m.element.querySelector('[aria-label="Collapse sidebar"], [aria-label="Expand sidebar"], [data-sidebar-state]'), null)

    const first = m.element.querySelector<HTMLElement>(FOCUSABLE)!
    assert.equal(first.textContent, "Skip to content")
    await act(async () => { first.click() })
    assert.equal(document.activeElement?.id, "giwa-main")
    assert.equal(fetchCalls.length, 0)
    await m.unmount()
  })

  await t.test("rail: Mint under the tabs' divider (an action, never current); Documentation and Terms of Use alone at the bottom; the footer stays", async () => {
    const m = await mount("/savings")
    const utilities = [...m.rail().querySelectorAll<HTMLElement>(":scope > div:last-child a, :scope > div:last-child button")]
    assert.deepEqual(utilities.map(node => node.getAttribute("aria-label")), ["Documentation", "Terms of Use"], "no Mint at the bottom any more")
    for (const node of utilities) {
      const tip = node.querySelector('span[aria-hidden="true"]')!
      assert.equal(tip.textContent, node.getAttribute("aria-label"))
      assert.match(tip.className, /\bhidden\b.*group-hover:block group-focus-visible:block/)
    }
    assert.deepEqual(utilities.map(node => node.getAttribute("href")), ["#", "#"])
    const mint = m.rail().querySelector<HTMLButtonElement>('button[aria-label="Mint test assets"]')!
    assert.ok(mint, "the Mint item")
    assert.equal(mint.textContent, "Mint")
    assert.equal(mint.hasAttribute("aria-current"), false)
    assert.ok(mint.querySelector(":scope > svg.lucide-arrow-down[width=\"20\"]"), "a plain 20px arrow over the label")
    assert.equal(mint.querySelector("span"), null, "no disc")
    assert.match(mint.className, /font-medium text-\[var\(--color-arco-ink\)\] hover:bg-\[var\(--color-row-hover-weak\)\]/)
    // No converters here: Mint right after the divider, in the centred group.
    assert.ok(mint.parentElement!.previousElementSibling?.matches('div[aria-hidden="true"].h-px'), "after the divider")
    assert.equal(mint.closest(".my-auto"), m.nav().closest(".my-auto"), "in the centred group with the tabs")
    // Not in the top bar; the page footer still carries the links.
    assert.equal([...m.element.querySelector("header")!.querySelectorAll("button")].some(node => node.textContent?.includes("Mint")), false)
    assert.ok(m.element.querySelector("footer")?.textContent?.includes("Terms of Use"))
    assert.equal(fetchCalls.length, 0)
    await m.unmount()

    // The admin shell has no Mint (as before) and so no divider without Convert.
    const admin = await mount("/admin/operations", null, true)
    assert.equal(admin.rail().querySelector('button[aria-label="Mint test assets"]'), null)
    assert.equal(admin.rail().querySelector('div[aria-hidden="true"].h-px'), null)
    await admin.unmount()
  })

  await t.test("Savings flyout: pointer opens it, the pointer can travel into it, leaving closes it after a grace delay", async () => {
    const m = await mount("/funds")
    const tab = m.savingsTab()
    assert.equal(m.flyout().hidden, true)
    assert.equal(tab.getAttribute("aria-expanded"), "false")
    await pointer(tab, "pointerover")
    assert.equal(m.flyout().hidden, false)
    assert.equal(tab.getAttribute("aria-expanded"), "true")
    assert.deepEqual([...m.flyout().querySelectorAll("a")].map(a => [a.textContent, a.getAttribute("href")]), [["Stablecoins", "/savings?category=stablecoins"], ["Crypto", "/savings?category=crypto-native"]])
    assert.equal(m.flyout().querySelector('ul')!.getAttribute("aria-label"), "Savings categories")
    // Out of the tab and into the flyout within the grace delay: it stays.
    await pointer(tab, "pointerout", "mouse", m.flyout())
    await pointer(m.flyout(), "pointerover", "mouse", tab)
    await act(async () => { await sleep(220) })
    assert.equal(m.flyout().hidden, false, "stays open while the pointer is on it")
    await pointer(m.flyout(), "pointerout")
    assert.equal(m.flyout().hidden, false, "a short grace delay first")
    await act(async () => { await sleep(220) })
    assert.equal(m.flyout().hidden, true, "closes once the pointer has left")
    // A category link navigates (and closes it).
    await pointer(tab, "pointerover")
    await act(async () => { m.flyout().querySelector<HTMLAnchorElement>('a[href="/savings?category=crypto-native"]')!.click(); await flush() })
    assert.equal(`${m.probe.pathname}${m.probe.search}`, "/savings?category=crypto-native")
    assert.equal(m.flyout().hidden, true)
    assert.equal(m.flyout().querySelector('[aria-current="location"]')?.textContent, "Crypto")
    // Touch never opens it: a tap on the tab goes to Savings.
    await m.go("/funds")
    await pointer(tab, "pointerover", "touch")
    await pointer(tab, "pointerdown", "touch")
    await focus(tab)
    assert.equal(m.flyout().hidden, true, "no flyout on touch")
    await act(async () => { tab.blur(); await flush() })
    assert.equal(fetchCalls.length, 0)
    await m.unmount()
  })

  await t.test("Savings flyout: focus opens it, ArrowRight/Down moves into it, arrows move, Escape and blur close it; click goes to Savings", async () => {
    const m = await mount("/funds")
    const tab = m.savingsTab()
    await focus(tab)
    assert.equal(m.flyout().hidden, false, "focus opens it")
    key(tab, "Escape")
    assert.equal(m.flyout().hidden, true, "Escape on the tab closes it")
    key(tab, "ArrowDown")
    await act(async () => { await flush() })
    assert.equal(m.flyout().hidden, false)
    const links = [...m.flyout().querySelectorAll<HTMLAnchorElement>("a")]
    assert.equal(document.activeElement, links[0], "ArrowDown moves into the flyout")
    key(links[0]!, "ArrowDown")
    assert.equal(document.activeElement, links[1])
    key(links[1]!, "ArrowDown")
    assert.equal(document.activeElement, links[0], "wraps")
    key(links[0]!, "ArrowUp")
    assert.equal(document.activeElement, links[1])
    key(links[1]!, "Escape")
    await act(async () => { await flush() })
    assert.equal(document.activeElement, tab, "Escape returns to the tab")
    assert.equal(m.flyout().hidden, true)
    key(tab, "ArrowRight")
    await act(async () => { await flush() })
    assert.equal(document.activeElement, links[0], "ArrowRight moves into it as well")
    // Focus leaving both the tab and the flyout closes it.
    await focus(m.element.querySelector<HTMLElement>('a[href="/portfolio"]')!)
    assert.equal(m.flyout().hidden, true, "blur closes it")
    // Pressing the tab itself goes to Savings, and closes the flyout.
    await focus(tab)
    await act(async () => { tab.click(); await flush() })
    assert.equal(m.probe.pathname, "/savings")
    assert.equal(m.flyout().hidden, true)
    assert.deepEqual(currentLabels(m.nav()), ["Savings"])
    assert.equal(fetchCalls.length, 0)
    await m.unmount()
  })

  await t.test("tab bar below xl: the page tabs then Mint in equal columns, the current one marked, absent from xl; content keeps room for it", async () => {
    const m = await mount("/portfolio")
    const bar = m.bar()
    assert.match(bar.className, /\bfixed inset-x-0 bottom-0\b.*\bxl:hidden\b/)
    assert.equal(bar.style.paddingBottom, "env(safe-area-inset-bottom)")
    assert.deepEqual([...bar.querySelectorAll("a")].map(a => a.textContent), ["Home", "Savings", "Funds", "Stocks", "Portfolio"])
    assert.deepEqual(currentLabels(bar), ["Portfolio"])
    // Mint (no converters here, so no Convert): last, an action, its icon in the same slot, label "Mint".
    const items = [...bar.querySelectorAll(":scope > ul > li")]
    assert.deepEqual(items.map(li => li.textContent), ["Home", "Savings", "Funds", "Stocks", "Portfolio", "Mint"])
    for (const li of items) assert.match(li.className, /\bmin-w-0 flex-1\b/, "equal columns")
    const mint = items[items.length - 1]!.querySelector<HTMLButtonElement>("button")!
    assert.equal(mint.getAttribute("aria-label"), "Mint test assets")
    assert.equal(mint.hasAttribute("aria-current"), false)
    assert.ok(mint.querySelector("span.h-\\[30px\\] > svg.lucide-arrow-down"))
    for (const label of bar.querySelectorAll(":scope > ul > li span.truncate")) assert.match(label.className, /max-w-full truncate/)
    await act(async () => { bar.querySelector<HTMLAnchorElement>('a[href="/funds"]')!.click(); await flush() })
    assert.equal(m.probe.pathname, "/funds")
    assert.deepEqual(currentLabels(bar), ["Funds"])
    // The room after the footer, below xl only.
    const spacer = m.element.querySelector<HTMLElement>("[data-shell-panel] > div[aria-hidden]")!
    assert.match(spacer.className, /h-\[var\(--giwa-tab-bar-space\)\] xl:hidden/)
    assert.equal(fetchCalls.length, 0)
    await m.unmount()

    // The admin shell: no Mint, the rest still in equal columns.
    const admin = await mount("/admin/operations", null, true)
    assert.equal(admin.bar().querySelector('[aria-label="Mint test assets"]'), null)
    assert.deepEqual([...admin.bar().querySelectorAll(":scope > ul > li")].map(li => li.textContent), ["Home", "Savings", "Funds", "Stocks", "Portfolio"])
    await admin.unmount()
  })

  await t.test("phones: no menu button or menu; Documentation, Terms of Use (and Admin for allowlisted wallets) in the footer, clear of the tab bar", async () => {
    const m = await mount("/funds")
    assert.equal(m.element.querySelector('button[aria-label="Open menu"]'), null)
    assert.equal(document.querySelector('[role="dialog"][aria-label="Menu"]'), null)
    // The top bar below xl: the logo, the search and the wallet only.
    const header = m.element.querySelector("header")!
    assert.deepEqual([...header.querySelectorAll("a[aria-label], button")].map(node => node.getAttribute("aria-label") ?? node.textContent?.trim()).filter(Boolean).slice(0, 1), ["Arco home"])
    const footer = m.element.querySelector("footer")!
    assert.deepEqual([...footer.querySelectorAll("nav a")].map(a => [a.textContent, a.getAttribute("href")]), [["Terms of Use", "#"], ["Documentation", "#"]], "no Admin for this wallet")
    // The footer sits before the room the tab bar takes, so the bar never covers it.
    const spacer = m.element.querySelector<HTMLElement>("[data-shell-panel] > div[aria-hidden]")!
    assert.ok(footer.compareDocumentPosition(spacer) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING)
    assert.equal(fetchCalls.length, 0)
    await m.unmount()
  })

  await t.test("footer Admin: for allowlisted wallets only, below xl (the rail's Admin tab from xl), to /admin", async () => {
    const { GiwaShellFooter } = await import("./GiwaPreprodApp")
    const element = document.createElement("div"); document.body.append(element)
    const root = createRoot(element)
    await act(async () => { root.render(<MemoryRouter><GiwaShellFooter isAdmin /></MemoryRouter>); await flush() })
    const links = [...element.querySelectorAll("footer nav a")]
    assert.deepEqual(links.map(a => a.textContent), ["Terms of Use", "Documentation", "Admin"])
    const admin = links[2]!
    assert.equal(admin.getAttribute("href"), "/admin")
    assert.match(admin.className, /\bxl:hidden\b/)
    await act(async () => { root.render(<MemoryRouter><GiwaShellFooter isAdmin={false} /></MemoryRouter>); await flush() })
    assert.equal(element.querySelector('footer a[href="/admin"]'), null)
    await act(async () => root.unmount()); element.remove()
  })

  await t.test("Convert: in the rail after a divider and in the tab bar where there are converters; opens Get ArcoUSD's screen; the top bar has no Get ArcoUSD", async () => {
    const none = await mount("/savings")
    assert.equal(none.element.querySelector('[aria-label="Convert to ArcoUSD"]'), null, "no converters, no Convert (the app without the Reserve)")
    assert.equal(none.element.querySelector("header")!.textContent?.includes("Get ArcoUSD"), false)
    await none.unmount()

    const converter = { option: "usdc-giwa", token: "0x0000000000000000000000000000000000000010", converter: "0x0000000000000000000000000000000000000020" } as const
    const m = await mount("/savings", { token: "0x00000000000000000000000000000000000000a1", priceFeed: "0x00000000000000000000000000000000000000a2", converters: [converter] })
    assert.equal(m.element.querySelector("header")!.textContent?.includes("Get ArcoUSD"), false, "the top bar's button is gone")
    assert.equal(m.element.querySelector("header")!.querySelector("button[aria-haspopup=\"dialog\"]"), null)
    const inRail = m.rail().querySelector<HTMLButtonElement>('button[aria-label="Convert to ArcoUSD"]')!
    assert.ok(inRail)
    assert.equal(inRail.textContent, "Convert")
    assert.equal(inRail.getAttribute("aria-haspopup"), "dialog")
    assert.equal(inRail.hasAttribute("aria-current"), false, "an action, never the current page")
    assert.ok(inRail.previousElementSibling?.matches('div[aria-hidden="true"].h-px'), "after a divider")
    assert.ok(m.nav().compareDocumentPosition(inRail) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, "after the tabs")
    assert.ok(inRail.querySelector(":scope > svg.lucide-replace[width=\"20\"]"), "the swap glyph at 20px, no disc")
    assert.equal(inRail.querySelector("span"), null)
    assert.match(inRail.className, /font-medium text-\[var\(--color-arco-ink\)\] hover:bg-\[var\(--color-row-hover-weak\)\]/)
    assert.equal(inRail.nextElementSibling?.querySelector("button")?.getAttribute("aria-label"), "Mint test assets", "Mint right under Convert")
    const inBar = m.bar().querySelector<HTMLButtonElement>('button[aria-label="Convert to ArcoUSD"]')!
    assert.ok(inBar, "and in the tab bar, last")
    assert.ok(inBar.querySelector("span.h-\\[30px\\] > svg.lucide-replace"), "in the tab bar's icon slot")
    assert.doesNotMatch(inBar.innerHTML, /hero-deco-2|color-arco-cream/)
    assert.equal(inBar.closest("li")!.nextElementSibling?.querySelector("button")?.getAttribute("aria-label"), "Mint test assets", "Mint after Convert")
    assert.equal(m.bar().querySelectorAll(":scope > ul > li").length, 7, "Home and Stocks are on in this test: seven columns")
    assert.equal(fetchCalls.length, 0, "nothing is read before the first press")

    assert.equal(document.querySelector('[role="dialog"]'), null)
    await act(async () => { inRail.click(); await flush() })
    let screen: Element | null = null
    for (let i = 0; i < 50 && !screen; i++) {
      await act(async () => { await sleep(40); await flush() })
      screen = [...document.querySelectorAll('[role="dialog"]')].find(node => node.textContent?.includes("Convert")) ?? null
    }
    assert.ok(screen, "Get ArcoUSD's Convert screen opens, as the top bar button did")
    assert.equal(m.probe.pathname, "/savings", "no navigation")
    await m.unmount()
  })
})
