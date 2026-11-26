// The Crypto tab's glass menu: opening it lists the supported coins (mark, symbol, APY) with the open account checked;
// picking a row selects that account and closes the menu; Escape closes it. The same list on a phone (no bottom
// sheet). Across a remount of the tabs (the page remounts the card when the account changes vault) focus stays on the
// tabs and the lens slides over from where it was. Gated like the other DOM tests (GIWA_HOST_DOM_RUNTIME = a jsdom
// package.json).

import assert from "node:assert/strict"
import { createRequire } from "node:module"
import test from "node:test"

type AnyModule = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const runtime = process.env.GIWA_HOST_DOM_RUNTIME

test("savings tabs: the Crypto menu lists supported coins and picks one (set GIWA_HOST_DOM_RUNTIME)", { skip: !runtime }, async () => {
  const { JSDOM } = createRequire(runtime!)("jsdom")
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost/", pretendToBeVisual: true })
  const w = dom.window
  const globals: Record<string, unknown> = {
    window: w, document: w.document, navigator: w.navigator, HTMLElement: w.HTMLElement, SVGElement: w.SVGElement, Element: w.Element,
    Node: w.Node, Event: w.Event, MouseEvent: w.MouseEvent, KeyboardEvent: w.KeyboardEvent, MutationObserver: w.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true,
  }
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  try {
    const React = (await import("react")) as AnyModule
    const { createRoot } = (await import("react-dom/client")) as AnyModule
    const { SavingsTabs } = (await import("./SavingsTabs")) as AnyModule
    const account = (symbol: string, apy: string, disabled = false) => ({
      key: `real:v-${symbol}:${symbol}`, symbol, icon: `/accept/${symbol}.png`, apy, disabled, vault: null, vaultId: `v-${symbol}`, sortOrder: null,
    })
    const accounts = [account("USDC", "3.92%"), account("ETH", "3.86%"), account("XRP", "4.57%"), account("SOL", "9%", true)]
    const picked: string[] = []
    const element = w.document.getElementById("root")!
    const root = createRoot(element)
    const render = async (selectedKey: string) =>
      React.act(async () => root.render(React.createElement(SavingsTabs, { accounts, selectedKey, onSelect: (a: { symbol: string }) => picked.push(a.symbol) })))
    const act = async (run: () => void) => React.act(async () => run())
    const tab = () => element.querySelector("[data-crypto-tab]") as HTMLButtonElement
    const menu = () => w.document.querySelector('[role="menu"]')

    await render(accounts[1]!.key)
    assert.equal(menu(), null)
    assert.equal(tab().getAttribute("aria-expanded"), "false")

    // Open: one row per supported coin (no SOL), each with its symbol and APY; ETH is checked (a brighter piece of
    // glass) and focused. The chevron points up while open.
    assert.equal(tab().querySelectorAll("svg.rotate-180").length, 0)
    await act(() => tab().click())
    assert.equal(tab().getAttribute("aria-expanded"), "true")
    assert.equal(tab().querySelectorAll("svg.rotate-180").length, 2, "both chevrons (one line, two lines) point up")
    const rows = Array.from(menu()!.querySelectorAll('[role="menuitemradio"]')) as HTMLElement[]
    assert.deepEqual(rows.map((row) => row.textContent), ["ETH3.86%", "XRP4.57%"])
    assert.deepEqual(rows.map((row) => row.getAttribute("aria-checked")), ["true", "false"])
    assert.deepEqual(rows.map((row) => row.classList.contains("savings-glass-piece")), [true, false])
    assert.deepEqual(rows.map((row) => row.querySelector("img")?.getAttribute("src")), ["/accept/ETH.png", "/accept/XRP.png"])
    assert.equal(w.document.activeElement, rows[0])
    assert.ok(menu()!.classList.contains("savings-glass-menu"))
    assert.ok(menu()!.closest(".arco-demo"), "the portal carries the theme scope")
    // Outside a card (no tone around the tabs) the menu takes the navy card's look.
    assert.equal(menu()!.closest("[data-savings-tone]")?.getAttribute("data-savings-tone"), "blue")

    // Arrow down moves to XRP; picking it selects the account and closes the menu, focus back on the tab.
    await act(() => rows[0]!.dispatchEvent(new w.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })))
    assert.equal(w.document.activeElement, rows[1])
    await act(() => rows[1]!.click())
    assert.deepEqual(picked, ["XRP"])
    assert.equal(menu(), null)
    assert.equal(w.document.activeElement, tab())

    // Home / End move to the first and last row; Tab closes the list with focus back on the tab (Tab then moves on from it).
    await act(() => tab().click())
    const again = Array.from(menu()!.querySelectorAll('[role="menuitemradio"]')) as HTMLElement[]
    await act(() => again[1]!.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Home", bubbles: true })))
    assert.equal(w.document.activeElement, again[0])
    await act(() => again[0]!.dispatchEvent(new w.KeyboardEvent("keydown", { key: "End", bubbles: true })))
    assert.equal(w.document.activeElement, again[1])
    await act(() => again[1]!.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Tab", bubbles: true })))
    assert.equal(menu(), null)
    assert.equal(w.document.activeElement, tab())

    // Escape closes without picking; a press elsewhere closes too.
    await act(() => tab().click())
    await act(() => menu()!.querySelector("button")!.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true })))
    assert.equal(menu(), null)
    await act(() => tab().click())
    await act(() => w.document.body.dispatchEvent(new w.Event("pointerdown", { bubbles: true })))
    assert.equal(menu(), null)
    assert.deepEqual(picked, ["XRP"])

    // On a phone (below sm) the tab opens the same glass list (no bottom sheet); a second press closes it.
    ;(w as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
    await act(() => tab().click())
    const menus = w.document.querySelectorAll('[role="menu"]')
    assert.equal(menus.length, 1)
    assert.equal(w.document.querySelector('[role="dialog"]'), null, "no bottom sheet")
    const phoneRows = Array.from(menus[0]!.querySelectorAll('[role="menuitemradio"]')) as HTMLElement[]
    assert.deepEqual(phoneRows.map((row) => row.getAttribute("data-coin")), ["ETH", "XRP"])
    await act(() => phoneRows[0]!.dispatchEvent(new w.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })))
    assert.equal(w.document.activeElement, phoneRows[1])
    await act(() => tab().click())
    assert.equal(menu(), null)
    await act(() => tab().click())
    await act(() => (menu()!.querySelector('[data-coin="ETH"]') as HTMLElement).click())
    assert.deepEqual(picked, ["XRP", "ETH"])

    // The Gold tab: one button for both gold coins; a press picks the gold account straight away, with no menu.
    const gold = [account("PAXG", "3.1%"), account("XAUT", "3.1%")].map((a) => ({ ...a, key: `real:arcogold:${a.symbol}`, vaultId: "arcogold" }))
    await React.act(async () => root.render(React.createElement(SavingsTabs, { accounts: [...accounts, ...gold], selectedKey: accounts[0]!.key, onSelect: (a: { symbol: string }) => picked.push(a.symbol) })))
    // Arrow down on the Crypto tab opens the list too.
    await act(() => tab().dispatchEvent(new w.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })))
    assert.ok(menu())
    await act(() => w.document.body.dispatchEvent(new w.Event("pointerdown", { bubbles: true })))
    const goldTabs = element.querySelectorAll("[data-gold-tab]")
    assert.equal(goldTabs.length, 1)
    const goldTab = goldTabs[0] as HTMLButtonElement
    assert.equal(goldTab.getAttribute("aria-pressed"), "false")
    assert.equal(goldTab.hasAttribute("aria-haspopup"), false)
    assert.equal(goldTab.querySelectorAll("img").length, 2)
    const menusBefore = w.document.querySelectorAll('[role="menu"]').length
    await act(() => goldTab.click())
    assert.deepEqual(picked, ["XRP", "ETH", "PAXG"])
    assert.equal(w.document.querySelectorAll('[role="menu"]').length, menusBefore, "no menu opens")

    // A press with focus on the tabs, then the tabs mounted afresh on the new account (as the page does): focus is on
    // the selected tab, and the lens starts where it was (Stablecoins, 0) and then slides to Gold (2).
    const all = [...accounts, ...gold]
    const lens = () => (element.querySelector("[data-savings-tabs-track]") as HTMLElement).style.getPropertyValue("--savings-tab-index")
    // (The lens follows a re-render a couple of frames later.)
    await React.act(async () => new Promise((resolve) => setTimeout(resolve, 80)))
    assert.equal(lens(), "0")
    await act(() => goldTab.focus())
    await act(() => goldTab.click())
    await React.act(async () => root.unmount())
    // The track's style as it changes (each change's previous value).
    const seen: string[] = []
    const watch = new w.MutationObserver((records: { oldValue: string | null }[]) => records.forEach((record) => seen.push(record.oldValue ?? "")))
    watch.observe(element, { subtree: true, attributes: true, attributeFilter: ["style"], attributeOldValue: true })
    const fresh = createRoot(element)
    await React.act(async () => fresh.render(React.createElement(SavingsTabs, { accounts: all, selectedKey: gold[0]!.key, onSelect: () => undefined })))
    const newGold = element.querySelector("[data-gold-tab]") as HTMLElement
    assert.notEqual(newGold, goldTab)
    assert.equal(w.document.activeElement, newGold, "focus stays on the tabs")
    assert.equal(newGold.getAttribute("aria-pressed"), "true")
    await React.act(async () => new Promise((resolve) => w.requestAnimationFrame(() => resolve(undefined))))
    await React.act(async () => new Promise((resolve) => setTimeout(resolve, 50)))
    assert.equal(lens(), "2", "the lens ends on the selected tab")
    assert.ok(seen.some((value) => value.includes("--savings-tab-index: 0") || value.includes("--savings-tab-index:0")), `it started where it was: ${JSON.stringify(seen)}`)
    watch.disconnect()
    // Later (no press just before), a fresh mount puts the lens straight on the selected tab.
    await React.act(async () => fresh.unmount())
    await new Promise((resolve) => setTimeout(resolve, 1600))
    const later = createRoot(element)
    await React.act(async () => later.render(React.createElement(SavingsTabs, { accounts: all, selectedKey: gold[0]!.key, onSelect: () => undefined })))
    assert.equal(lens(), "2")
    assert.notEqual(w.document.activeElement, element.querySelector("[data-gold-tab]"))

    await React.act(async () => later.unmount())
  } finally {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
    dom.window.close()
  }
})
