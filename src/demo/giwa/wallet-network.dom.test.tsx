import assert from "node:assert/strict"
import test from "node:test"
import { createRequire } from "node:module"
import { act, StrictMode, useContext, useSyncExternalStore, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { GiwaSwitchResult, GiwaWallet } from "./wallet"
// The app modules are imported inside the test, after the DOM globals and the fetch guard exist.

// The wallet chip (W2) and its menu, the Connect pill, ensureGiwa, the one automatic switch request per connection, and Mint test assets
// carrying on after a connect and a switch, against a fake wallet (GiwaWalletContext).
const runtime = process.env.GIWA_HOST_DOM_RUNTIME
async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve() }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const ACCOUNT = "0x1111111111111111111111111111111111111111" as const
const OTHER = "0x2222222222222222222222222222222222222222" as const
// A lowercase address as a wallet may report it; the chip shows and copies its checksummed form.
const MIXED = "0x3185ab2c4dd0e9f1a7b6c5d4e3f2a1b0c9d876d2" as const
const FAUCET = "0x3333333333333333333333333333333333333333"
const TOKEN = "0x4444444444444444444444444444444444444444"

type State = Pick<GiwaWallet, "address" | "chainId" | "switching" | "signingReady" | "error" | "nativeBalance" | "connecting">
function fakeWallet(initial: Partial<State>) {
  let state: State = { address: null, chainId: null, switching: false, signingReady: false, error: null, nativeBalance: null, connecting: false, ...initial }
  const listeners = new Set<() => void>()
  const calls: string[] = []
  const store = {
    calls,
    get: () => state,
    set(patch: Partial<State>) { state = { ...state, ...patch }; listeners.forEach(listener => listener()) },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    // Overridable behaviours.
    onConnect: async () => {},
    onSwitch: async (): Promise<GiwaSwitchResult> => ({ ok: true }),
  }
  return store
}
type Store = ReturnType<typeof fakeWallet>

test("wallet network UI DOM (set GIWA_HOST_DOM_RUNTIME to an existing jsdom package.json)", { skip: !runtime }, async t => {
  const { JSDOM } = createRequire(runtime!)("jsdom")
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://app.example/", pretendToBeVisual: true })
  const DYNAMIC_WALLET_BOOK = "https://dynamic-static-assets.com/wallet-book/v1/stable/wallet-book.json"
  const fetchCalls: string[] = []
  const globals: Record<string, unknown> = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: (async (input: unknown) => {
      const url = typeof input === "string" ? input : String((input as { url?: unknown })?.url ?? input)
      if (url === DYNAMIC_WALLET_BOOK) return new Response(null, { status: 503 })
      fetchCalls.push(url)
      throw new Error("network disabled")
    }) as typeof fetch,
  }
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  t.after(() => { dom.window.close(); for (const key of Object.keys(globals)) { const descriptor = previous[key]; if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) } })

  const { GiwaWalletContext, useSingleSwitch } = await import("./wallet")
  const { GiwaWalletButton, TestFundsButton } = await import("./components")
  const { useAutoSwitchToGiwa, useEnsureGiwa, NETWORK_COPY } = await import("./wallet-network")
  const { GIWA_CHAIN_ID, GIWA_EXPLORER } = await import("./config")
  const { explorerAddress } = await import("./wallet")
  const { getAddress } = await import("viem")
  const CHECKSUM = getAddress(MIXED)
  const { useNavigate } = await import("react-router-dom")
  function Elsewhere() {
    const navigate = useNavigate()
    return <button type="button" data-go-elsewhere onClick={() => navigate("/elsewhere")}>elsewhere</button>
  }

  function WalletHost({ store, children }: { store: Store; children: ReactNode }) {
    const state = useSyncExternalStore(store.subscribe, store.get)
    // The providers' single-flight switch, around the fake's behaviour.
    const { switching, switchToGiwa } = useSingleSwitch(async () => { store.calls.push("switch"); return store.onSwitch() })
    const value: GiwaWallet = {
      ...state,
      switching: state.switching || switching,
      connecting: state.connecting,
      connected: Boolean(state.address),
      sessionEpoch: "fake",
      source: null,
      phase: !state.address ? "disconnected" : state.chainId !== GIWA_CHAIN_ID ? "wrong-network" : "ready",
      connect: async () => { store.calls.push("connect"); await store.onConnect() },
      disconnect: () => { store.calls.push("disconnect"); store.set({ address: null, chainId: null }) },
      switchToGiwa,
      refreshBalance: async () => {},
    }
    return <GiwaWalletContext.Provider value={value}>{children}</GiwaWalletContext.Provider>
  }
  async function mount(store: Store, node: ReactNode) {
    const element = document.createElement("div"); document.body.append(element)
    const root = createRoot(element)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(["giwa", "catalog"], [{ productId: "p", paymentAssetAddress: TOKEN, paymentAssetSymbol: "tUSDC", paymentAsset: { name: "Test USDC", decimals: 6, faucetAddress: FAUCET } }])
    client.setQueryData(["giwa", "arcousd", "reserve"], { status: "not-deployed", reserve: null })
    client.setQueryData(["giwa", "arcogold", "reserve"], { status: "not-deployed", reserve: null })
    await act(async () => { root.render(<StrictMode><QueryClientProvider client={client}><MemoryRouter><WalletHost store={store}>{node}</WalletHost></MemoryRouter></QueryClientProvider></StrictMode>); await flush() })
    return { element, async unmount() { await act(async () => root.unmount()); element.remove() } }
  }
  // In short steps: React applies the wallet's updates when each act ends, and Mint polls the wallet in between.
  const settle = async (ms = 0) => { for (let waited = 0; waited <= ms; waited += 25) await act(async () => { await sleep(25); await flush() }) }
  const text = (node: Element | null) => node?.textContent?.replace(/\s+/g, " ").trim() ?? ""
  // Mint's 24-hour cooldown notice is the first thing it shows after it has the wallet on GIWA: proof it carried on.
  const COOLDOWN = /Today's minting is done/
  const seedCooldown = (address: string) => window.localStorage.setItem(`arco.giwa.faucetLastMint.${address.toLowerCase()}`, String(Date.now()))

  await t.test("chip (W2): a button with a dot, the short checksummed address in ink sans and a chevron; no GIWA pill, no Switch, no Disconnect icon", async () => {
    const store = fakeWallet({ address: MIXED, chainId: GIWA_CHAIN_ID, signingReady: true })
    const m = await mount(store, <GiwaWalletButton />)
    const chip = () => m.element.querySelector<HTMLButtonElement>("button[data-wallet-network]")!
    const dot = () => chip().querySelector<HTMLElement>("[data-wallet-dot]")!
    assert.equal(chip().dataset.walletNetwork, "giwa")
    assert.equal(chip().getAttribute("aria-haspopup"), "menu")
    assert.equal(chip().getAttribute("aria-expanded"), "false")
    // The search field's box (GiwaProductSearch: h-9, rounded-lg, 1px border), so the top bar's controls line up.
    assert.match(chip().className, /\bh-9\b.*rounded-lg border/)
    assert.match(chip().className, /font-medium text-\[var\(--color-arco-ink\)\]/)
    assert.match(chip().className, /border-\[var\(--color-arco-border\)\] bg-\[var\(--color-arco-surface\)\] hover:/)
    assert.match(chip().className, /shadow-\[var\(--shadow-control\)\]/)
    assert.match(chip().className, /focus-visible:outline-2/)
    assert.doesNotMatch(chip().innerHTML, /font-mono|text-\[var\(--color-arco-muted\)\][^"]*truncate/)
    assert.match(dot().className, /\bsize-2\b.*bg-\[var\(--color-arco-up\)\]/)
    assert.equal(chip().getAttribute("title"), "Connected to GIWA Sepolia")
    assert.equal(text(chip().querySelector(".sr-only")), "Connected to GIWA Sepolia")
    assert.equal(text(chip().querySelector(".truncate")), `${CHECKSUM.slice(0, 6)}...${CHECKSUM.slice(-4)}`)
    assert.ok(chip().querySelector("svg.lucide-chevron-down"))
    assert.equal(m.element.querySelector('[aria-label="Disconnect wallet"]'), null, "no Disconnect icon in the chip")
    assert.equal(m.element.querySelectorAll("button").length, 1, "the chip is the only control until the menu opens")
    assert.doesNotMatch(m.element.textContent!, /GIWA0x|Switch to GIWA|Check your wallet|Wrong network/)
    assert.doesNotMatch(m.element.innerHTML, /\bhidden sm:/, "phones show the same chip")
    // Another network: an amber dot, an amber-tinted border and a faint fill, and the words for it.
    await act(async () => { store.set({ chainId: 1, signingReady: false }); await flush() })
    assert.equal(chip().dataset.walletNetwork, "other")
    assert.match(dot().className, /bg-\[var\(--color-risk-meter-medium\)\]/)
    assert.match(chip().className, /border-\[var\(--color-risk-medium-bg\)\] bg-\[var\(--color-arco-surface-muted\)\]/)
    assert.equal(chip().getAttribute("title"), NETWORK_COPY.chipElsewhere)
    assert.equal(text(chip().querySelector(".sr-only")), "Wallet is on another network — it switches to GIWA when you act")
    assert.equal(store.calls.filter(call => call === "switch").length, 0, "the chip never asks for a switch")
    await m.unmount()
  })

  await t.test("chip menu: Copy address, the network line, View on explorer, Disconnect; never the full address; focus and keys", async () => {
    const store = fakeWallet({ address: MIXED, chainId: GIWA_CHAIN_ID, signingReady: true })
    const m = await mount(store, <><GiwaWalletButton /><Elsewhere /></>)
    const chip = () => m.element.querySelector<HTMLButtonElement>("button[data-wallet-network]")!
    const menu = () => m.element.querySelector<HTMLElement>('[role="menu"]')
    const items = () => [...menu()!.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    const key = async (target: Element, name: string) => { await act(async () => { target.dispatchEvent(new window.KeyboardEvent("keydown", { key: name, bubbles: true })); await flush() }) }
    const click = async (target: HTMLElement) => { await act(async () => { target.click(); await flush() }) }

    assert.equal(menu(), null)
    await click(chip())
    assert.equal(chip().getAttribute("aria-expanded"), "true")
    assert.match(chip().querySelector("svg.lucide-chevron-down")!.getAttribute("class")!, /rotate-180/, "the chevron flips")
    assert.deepEqual(items().map(item => text(item)), ["Copy address", "View on explorer", "Disconnect"])
    // In order: Copy, the network line (not a control), explorer, Disconnect.
    assert.deepEqual([...menu()!.children].filter(node => node.getAttribute("aria-live") === null).map(node => node.getAttribute("data-wallet-menu")), ["copy", "network", "explorer", "disconnect"])
    const network = menu()!.querySelector<HTMLElement>('[data-wallet-menu="network"]')!
    assert.equal(network.getAttribute("role"), "none")
    assert.equal(network.querySelector("button, a"), null)
    assert.deepEqual([...network.querySelectorAll("span:not([aria-hidden])")].map(text), ["GIWA Sepolia", "Connected"])
    assert.match(network.querySelector('[aria-hidden="true"]')!.className, /bg-\[var\(--color-arco-up\)\]/)
    // Owner decision: the full address appears nowhere in the menu, in any case.
    assert.doesNotMatch(menu()!.innerHTML.replace(/href="[^"]*"/, ""), new RegExp(MIXED.slice(2), "i"))
    const explorer = items()[1] as HTMLAnchorElement
    assert.equal(explorer.getAttribute("href"), `${GIWA_EXPLORER}/address/${CHECKSUM}`)
    assert.equal(explorer.getAttribute("href"), explorerAddress(CHECKSUM))
    assert.equal(explorer.getAttribute("target"), "_blank")
    assert.equal(explorer.getAttribute("rel"), "noreferrer")
    // Focus: the first item on open; arrows wrap; Home / End.
    assert.equal(document.activeElement, items()[0])
    await key(document.activeElement!, "ArrowDown")
    assert.equal(document.activeElement, items()[1])
    await key(document.activeElement!, "End")
    assert.equal(document.activeElement, items()[2])
    await key(document.activeElement!, "ArrowDown")
    assert.equal(document.activeElement, items()[0], "wraps to the top")
    await key(document.activeElement!, "ArrowUp")
    assert.equal(document.activeElement, items()[2], "wraps to the bottom")
    await key(document.activeElement!, "Home")
    assert.equal(document.activeElement, items()[0])
    // Escape closes and gives focus back to the chip.
    await key(document.activeElement!, "Escape")
    assert.equal(menu(), null)
    assert.equal(chip().getAttribute("aria-expanded"), "false")
    assert.equal(document.activeElement, chip())
    // From the chip: ArrowDown opens on the first item, ArrowUp on the last.
    await key(chip(), "ArrowDown")
    assert.equal(document.activeElement, items()[0])
    await key(document.activeElement!, "Escape")
    await key(chip(), "ArrowUp")
    assert.equal(document.activeElement, items()[2])
    // A press outside closes it.
    await act(async () => { document.body.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true })); await flush() })
    assert.equal(menu(), null)
    // A route change closes it.
    await click(chip())
    assert.ok(menu())
    await click(m.element.querySelector<HTMLButtonElement>("[data-go-elsewhere]")!)
    assert.equal(menu(), null)
    // Another network: the amber line.
    await act(async () => { store.set({ chainId: 1, signingReady: false }); await flush() })
    await click(chip())
    const amber = menu()!.querySelector<HTMLElement>('[data-wallet-menu="network"]')!
    assert.deepEqual([...amber.querySelectorAll("span:not([aria-hidden])")].map(text), ["Other network", "Switches to GIWA when you act"])
    assert.match(amber.querySelector('[aria-hidden="true"]')!.className, /bg-\[var\(--color-risk-meter-medium\)\]/)
    // Disconnect: the wallet's disconnect, the menu closes, the Connect pill returns.
    await click(items()[2]!)
    assert.deepEqual(store.calls, ["disconnect"])
    assert.equal(menu(), null)
    assert.ok(m.element.querySelector('button[aria-label="Connect wallet"]'))
    await m.unmount()
  })

  await t.test("chip menu: Copy address copies the checksummed address and says Copied for 1.5s; Could not copy when the clipboard fails or is missing", async () => {
    const written: string[] = []
    const setClipboard = (value: unknown) => Object.defineProperty(window.navigator, "clipboard", { configurable: true, value })
    const store = fakeWallet({ address: MIXED, chainId: GIWA_CHAIN_ID, signingReady: true })
    const m = await mount(store, <GiwaWalletButton />)
    const chip = () => m.element.querySelector<HTMLButtonElement>("button[data-wallet-network]")!
    const copyItem = () => m.element.querySelector<HTMLButtonElement>('[data-wallet-menu="copy"]')!
    const live = () => text(m.element.querySelector('[role="menu"] [aria-live="polite"]'))
    await act(async () => { chip().click(); await flush() })

    setClipboard({ writeText: async (value: string) => { written.push(value) } })
    await act(async () => { copyItem().click(); await flush() })
    assert.deepEqual(written, [CHECKSUM])
    assert.equal(text(copyItem()), "Copied")
    assert.ok(copyItem().querySelector("svg.lucide-check"))
    assert.equal(live(), "Copied")
    await settle(1_600)
    assert.equal(text(copyItem()), "Copy address")
    assert.ok(copyItem().querySelector("svg.lucide-copy"))
    assert.equal(live(), "")

    setClipboard({ writeText: async () => { throw new Error("denied") } })
    await act(async () => { copyItem().click(); await flush() })
    assert.equal(text(copyItem()), "Could not copy")
    assert.equal(live(), "Could not copy")
    await settle(1_600)

    setClipboard(undefined)
    await act(async () => { copyItem().click(); await flush() })
    assert.equal(text(copyItem()), "Could not copy")
    assert.deepEqual(written, [CHECKSUM])
    await m.unmount()
    Reflect.deleteProperty(window.navigator, "clipboard")
  })

  await t.test("Connect: a white button like the search field, a wallet icon and Connect Wallet; Connecting with a spinner at the same width", async () => {
    const { WALLET_CONTROL } = await import("./WalletChip")
    const store = fakeWallet({})
    const m = await mount(store, <GiwaWalletButton />)
    const button = () => m.element.querySelector<HTMLButtonElement>('button[aria-label="Connect wallet"]')!
    const shown = () => button().querySelector<HTMLElement>('[data-connect-label="shown"]')!
    const reserved = () => button().querySelector<HTMLElement>('[data-connect-label="reserved"]')!
    assert.equal(text(shown()), "Connect Wallet")
    assert.ok(shown().querySelector("svg.lucide-wallet.size-4"), "a 16px wallet icon")
    const idle = button().className
    // The search field's height, radius, border and focus ring; a surface fill; ink, 14px, medium.
    assert.ok(idle.startsWith(WALLET_CONTROL))
    assert.match(WALLET_CONTROL, /\bh-9\b/)
    assert.match(WALLET_CONTROL, /\brounded-lg border border-\[var\(--color-arco-border\)\] bg-\[var\(--color-arco-surface\)\]/)
    assert.match(WALLET_CONTROL, /focus-visible:outline-2 focus-visible:outline-\[var\(--color-arco-ink\)\]/)
    assert.match(idle, /text-sm font-medium text-\[var\(--color-arco-ink\)\]/)
    assert.match(idle, /hover:bg-\[var\(--color-arco-page\)\] active:bg-\[var\(--color-arco-chip\)\]/)
    assert.doesNotMatch(idle, /rounded-full|color-arco-on-dark|bg-\[var\(--color-arco-ink\)\]/, "no longer the ink pill")
    // The width comes from the idle row, kept invisible in the flow; the shown row sits over it.
    assert.equal(reserved().getAttribute("aria-hidden"), "true")
    assert.match(reserved().className, /\binvisible\b/)
    assert.equal(text(reserved()), "Connect Wallet")
    assert.match(shown().className, /absolute inset-0/)
    await act(async () => { button().click(); await flush() })
    assert.deepEqual(store.calls, ["connect"])
    await act(async () => { store.set({ connecting: true }); await flush() })
    assert.equal(text(shown()), "Connecting")
    assert.ok(shown().querySelector("svg.animate-spin"), "the spinner in place of the icon")
    assert.equal(shown().querySelector("svg.lucide-wallet"), null)
    assert.equal(text(reserved()), "Connect Wallet", "the same width")
    assert.equal(button().getAttribute("aria-busy"), "true")
    assert.equal(button().getAttribute("aria-label"), "Connect wallet")
    await act(async () => { store.set({ connecting: false, address: ACCOUNT, chainId: GIWA_CHAIN_ID }); await flush() })
    assert.equal(m.element.querySelector('button[aria-label="Connect wallet"]'), null)
    await m.unmount()
  })


  await t.test("ensureGiwa: nothing asked on GIWA; another chain switches then resolves ok; a rejection or failure gives the message; one request at a time", async () => {
    const results: unknown[] = []
    let ensure: () => Promise<unknown> = async () => undefined
    function Probe() {
      ensure = useEnsureGiwa()
      return null
    }
    // On GIWA, able to sign: no request.
    const ready = fakeWallet({ address: ACCOUNT, chainId: GIWA_CHAIN_ID, signingReady: true })
    let m = await mount(ready, <Probe />)
    await act(async () => { results.push(await ensure()) })
    assert.deepEqual(results.pop(), { ok: true })
    assert.deepEqual(ready.calls, [])
    await m.unmount()

    // Another chain: the switch, then a wait until the app sees GIWA and can sign, then ok.
    const other = fakeWallet({ address: ACCOUNT, chainId: 1 })
    other.onSwitch = () => new Promise(resolve => setTimeout(() => { other.set({ chainId: GIWA_CHAIN_ID, signingReady: true }); resolve({ ok: true }) }, 60))
    m = await mount(other, <Probe />)
    let pending!: Promise<unknown>
    await act(async () => { pending = ensure(); await flush() })
    // A second action while the first waits shares the one request (single flight).
    let second!: Promise<unknown>
    await act(async () => { second = ensure(); await flush() })
    await settle(150)
    assert.deepEqual(await pending, { ok: true })
    assert.deepEqual(await second, { ok: true })
    assert.deepEqual(other.calls, ["switch"], "one request")
    await m.unmount()

    // A wallet that did not know GIWA: the provider adds it (wallet.test) and the switch resolves ok the same way.
    // Rejected: the message, and no wait.
    const refused = fakeWallet({ address: ACCOUNT, chainId: 1 })
    refused.onSwitch = async () => ({ ok: false, rejected: true, reason: "User rejected the request." })
    m = await mount(refused, <Probe />)
    await act(async () => { results.push(await ensure()) })
    assert.deepEqual(results.pop(), { ok: false, rejected: true, reason: "User rejected the request.", message: "Network switch was rejected." })
    refused.onSwitch = async () => ({ ok: false, rejected: false, reason: "boom" })
    await act(async () => { results.push(await ensure()) })
    assert.deepEqual(results.pop(), { ok: false, rejected: false, reason: "boom", message: "Could not switch network: boom" })
    await m.unmount()

    // Not connected: nothing asked.
    const none = fakeWallet({})
    m = await mount(none, <Probe />)
    await act(async () => { results.push(await ensure()) })
    assert.deepEqual(results.pop(), { ok: false, rejected: false, reason: "No wallet is connected", message: "Connect your wallet first." })
    assert.deepEqual(none.calls, [])
    await m.unmount()
  })

  await t.test("auto-prompt: once per connection on another chain; not again after a rejection; again for another address or after a disconnect", async () => {
    const store = fakeWallet({})
    store.onSwitch = async () => ({ ok: false, rejected: true, reason: "User rejected" })
    function AutoInner({ enabled }: { enabled: boolean }) {
      useAutoSwitchToGiwa(useContext(GiwaWalletContext)!, enabled)
      return null
    }
    const m = await mount(store, <AutoInner enabled />)
    assert.deepEqual(store.calls, [], "nothing while disconnected")
    await act(async () => { store.set({ address: ACCOUNT, chainId: null }); await flush() })
    assert.deepEqual(store.calls, [], "waits for the chain")
    await act(async () => { store.set({ chainId: 1 }); await flush() })
    assert.deepEqual(store.calls, ["switch"], "asked once")
    // Re-renders, a balance, the rejection and another wrong chain do not ask again.
    await act(async () => { store.set({ nativeBalance: "1" }); await flush() })
    await act(async () => { store.set({ chainId: 10 }); await flush() })
    assert.deepEqual(store.calls, ["switch"], "not again after the rejection")
    // Another account on another chain: asked again.
    await act(async () => { store.set({ address: OTHER }); await flush() })
    assert.deepEqual(store.calls, ["switch", "switch"])
    // A disconnect starts over.
    await act(async () => { store.set({ address: null, chainId: null }); await flush() })
    await act(async () => { store.set({ address: OTHER, chainId: 1 }); await flush() })
    assert.deepEqual(store.calls, ["switch", "switch", "switch"])
    // On GIWA: nothing.
    await act(async () => { store.set({ address: null, chainId: null }); await flush() })
    await act(async () => { store.set({ address: ACCOUNT, chainId: GIWA_CHAIN_ID }); await flush() })
    assert.equal(store.calls.length, 3)
    await m.unmount()

    const off = fakeWallet({ address: ACCOUNT, chainId: 1 })
    const disabled = await mount(off, <AutoInner enabled={false} />)
    assert.deepEqual(off.calls, [], "the admin console's shell does not ask")
    await disabled.unmount()
  })

  await t.test("Mint after connect: connects, then carries on in the same press, with Confirm in your wallet meanwhile", async () => {
    const store = fakeWallet({})
    seedCooldown(ACCOUNT)
    store.onConnect = async () => { setTimeout(() => store.set({ address: ACCOUNT, chainId: GIWA_CHAIN_ID, signingReady: true }), 120) }
    const m = await mount(store, <TestFundsButton look="rail" />)
    const button = m.element.querySelector<HTMLButtonElement>('button[aria-label="Mint test assets"]')!
    await act(async () => { button.click(); await flush() })
    const notice = () => m.element.querySelector<HTMLElement>("[data-mint-notice]")!
    assert.equal(text(notice()), "Confirm in your wallet")
    assert.match(notice().className, /\bfixed z-50\b.*\bleft-\[100px\] w-\[280px\]/, "the rail's notice is a popover fixed beside the rail (never clipped by it)")
    assert.equal(button.getAttribute("aria-busy"), "true")
    assert.equal(text(button), "Minting", "the item's label while it works")
    assert.ok(button.querySelector(":scope > svg.animate-spin"), "a spinner in place of the icon")
    assert.equal(button.querySelector("svg.lucide-arrow-down"), null)
    assert.equal(notice().querySelector('button[aria-label="Dismiss"]'), null, "nothing to dismiss while it waits")
    await settle(300)
    assert.deepEqual(store.calls, ["connect"])
    assert.match(text(notice()), COOLDOWN, "carried on after the connect")
    assert.equal(button.hasAttribute("aria-busy"), false)
    assert.equal(text(button), "Mint")
    // Dismissible.
    await act(async () => { notice().querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!.click(); await flush() })
    assert.equal(notice().className, "sr-only")
    assert.equal(text(notice()), "")
    await m.unmount()
  })

  await t.test("Mint after a switch: asks to switch, shows the approval line, then carries on once the wallet is on GIWA", async () => {
    const store = fakeWallet({ address: OTHER, chainId: 1 })
    seedCooldown(OTHER)
    let finish: (result: GiwaSwitchResult) => void = () => {}
    store.onSwitch = () => new Promise(resolve => { finish = resolve })
    const m = await mount(store, <TestFundsButton look="bar" />)
    const button = m.element.querySelector<HTMLButtonElement>('button[aria-label="Mint test assets"]')!
    await act(async () => { button.click(); await flush() })
    const notice = () => m.element.querySelector<HTMLElement>("[data-mint-notice]")!
    assert.equal(text(notice()), NETWORK_COPY.approve)
    // The tab bar's notice: a sheet just above the bar (which clears the safe area), full width with side margins.
    assert.match(notice().className, /\bfixed z-50\b.*\binset-x-3\b/)
    assert.equal(notice().style.bottom, "calc(var(--giwa-tab-bar-space, 0px) + 0.75rem)")
    // Busy: a spinner in the icon's place, the label unchanged so the bar does not move.
    assert.equal(text(button), "Mint")
    assert.ok(button.querySelector("span.h-\\[30px\\] > svg.animate-spin"))
    await act(async () => { finish({ ok: true }); await flush() })
    await settle(80)
    assert.equal(text(notice()), NETWORK_COPY.approve, "waits until the app sees GIWA and can sign there")
    await act(async () => { store.set({ chainId: GIWA_CHAIN_ID, signingReady: true }); await flush() })
    await settle(120)
    assert.deepEqual(store.calls, ["switch"])
    assert.match(text(notice()), COOLDOWN, "carried on after the switch")
    await m.unmount()
  })

  await t.test("Mint: a rejected or failed switch says so, and mints nothing", async () => {
    for (const [result, expected] of [
      [{ ok: false, rejected: true, reason: "User rejected the request." }, "Network switch was rejected."],
      [{ ok: false, rejected: false, reason: "boom" }, "Could not switch network: boom"],
    ] as const) {
      const store = fakeWallet({ address: OTHER, chainId: 1 })
      window.localStorage.clear()
      store.onSwitch = async () => result
      const m = await mount(store, <TestFundsButton look="rail" />)
      await act(async () => { m.element.querySelector<HTMLButtonElement>('button[aria-label="Mint test assets"]')!.click(); await flush() })
      await settle(20)
      assert.equal(text(m.element.querySelector("[data-mint-notice]")), expected)
      assert.equal(fetchCalls.length, 0, "no mint was sent")
      await m.unmount()
    }
  })

  await t.test("tab bar Mint: a rejection shows above the bar, dismissible", async () => {
    const store = fakeWallet({ address: OTHER, chainId: 1 })
    window.localStorage.clear()
    store.onSwitch = async () => ({ ok: false, rejected: true, reason: "User rejected" })
    const m = await mount(store, <TestFundsButton look="bar" />)
    await act(async () => { m.element.querySelector<HTMLButtonElement>('button[aria-label="Mint test assets"]')!.click(); await flush() })
    await settle(20)
    const notice = m.element.querySelector<HTMLElement>("[data-mint-notice]")!
    assert.equal(text(notice), NETWORK_COPY.rejected)
    await act(async () => { notice.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!.click(); await flush() })
    assert.equal(notice.className, "sr-only")
    await m.unmount()
  })
})
