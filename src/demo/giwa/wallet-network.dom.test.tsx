import assert from "node:assert/strict"
import test from "node:test"
import { createRequire } from "node:module"
import { act, StrictMode, useContext, useSyncExternalStore, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { GiwaSwitchResult, GiwaWallet } from "./wallet"
// The app modules are imported inside the test, after the DOM globals and the fetch guard exist.

// The wallet chip's Switch to GIWA button, the one automatic switch request per connection, and Mint test assets
// carrying on after a connect and a switch, against a fake wallet (GiwaWalletContext).
const runtime = process.env.GIWA_HOST_DOM_RUNTIME
async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve() }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const ACCOUNT = "0x1111111111111111111111111111111111111111" as const
const OTHER = "0x2222222222222222222222222222222222222222" as const
const FAUCET = "0x3333333333333333333333333333333333333333"
const TOKEN = "0x4444444444444444444444444444444444444444"

type State = Pick<GiwaWallet, "address" | "chainId" | "switching" | "signingReady" | "error" | "nativeBalance">
function fakeWallet(initial: Partial<State>) {
  let state: State = { address: null, chainId: null, switching: false, signingReady: false, error: null, nativeBalance: null, ...initial }
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
  const { useAutoSwitchToGiwa, NETWORK_COPY } = await import("./wallet-network")
  const { GIWA_CHAIN_ID } = await import("./config")

  function WalletHost({ store, children }: { store: Store; children: ReactNode }) {
    const state = useSyncExternalStore(store.subscribe, store.get)
    // The providers' single-flight switch, around the fake's behaviour.
    const { switching, switchToGiwa } = useSingleSwitch(async () => { store.calls.push("switch"); return store.onSwitch() })
    const value: GiwaWallet = {
      ...state,
      switching: state.switching || switching,
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

  await t.test("chip: another chain shows Switch to GIWA; pressing switches; pending shows Check your wallet; GIWA afterwards", async () => {
    const store = fakeWallet({ address: ACCOUNT, chainId: 1 })
    let finish: (result: GiwaSwitchResult) => void = () => {}
    store.onSwitch = () => new Promise(resolve => { finish = resolve })
    const m = await mount(store, <GiwaWalletButton />)
    const button = () => m.element.querySelector<HTMLButtonElement>(`button[aria-label="${NETWORK_COPY.buttonName}"]`)
    assert.ok(button())
    assert.equal(text(button()), "Switch to GIWA")
    assert.ok(!m.element.textContent!.includes("Wrong network"))
    // A phone shows the button and Disconnect (the address from sm on).
    assert.match(m.element.querySelector("span.font-mono")!.className, /hidden sm:inline-flex/)
    assert.doesNotMatch(m.element.querySelector(`button[aria-label="Disconnect wallet"]`)!.className, /\bhidden\b/)
    assert.match(m.element.querySelector(`button[aria-label="Disconnect wallet"]`)!.className, /\binline-flex\b/)
    await act(async () => { button()!.click(); await flush() })
    assert.deepEqual(store.calls, ["switch"])
    assert.equal(text(button()), "Check your wallet")
    assert.equal(button()!.getAttribute("aria-busy"), "true")
    assert.equal(button()!.disabled, true)
    assert.ok(button()!.querySelector("svg.animate-spin"), "a spinner")
    assert.equal(text(m.element.querySelector('[role="status"]')), NETWORK_COPY.approve)
    // A second press while pending sends nothing more.
    await act(async () => { button()!.click(); await flush() })
    assert.deepEqual(store.calls, ["switch"])
    await act(async () => { store.set({ chainId: GIWA_CHAIN_ID }); finish({ ok: true }); await flush() })
    assert.equal(button(), null)
    assert.match(m.element.textContent!, /GIWA0x1111/)
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
