import assert from "node:assert/strict"
import test from "node:test"
import { createRequire } from "node:module"
import { act, StrictMode, useEffect, useState, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { parseSiweMessage } from "viem/siwe"
import type { GiwaWallet } from "../demo/giwa/wallet"
import type { HostDependencies } from "../demo/giwa/stocks-host/session"
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
// The app modules are imported inside the test, after the DOM globals exist.

// The admin console's session length and "Extend session", against a fake wallet, a fake API and the real
// session host: the header's remaining time, the extend notice in the last 5 minutes, a renewal that keeps
// the page mounted, a rejected renewal that keeps the session, and a 15-minute server.
const runtime = process.env.GIWA_HOST_DOM_RUNTIME
const WALLET = "0x1111111111111111111111111111111111111111" as const
const SIG = `0x${"11".repeat(65)}`
const ORIGIN = "https://admin.example.test"
async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve() }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

test("admin console session length and Extend session (set GIWA_HOST_DOM_RUNTIME to an existing jsdom package.json)", { skip: !runtime }, async t => {
  const { JSDOM } = createRequire(runtime!)("jsdom")
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: `${ORIGIN}/`, pretendToBeVisual: true })
  const adminCalls: string[] = []
  const globals: Record<string, unknown> = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
    // GET /api/v1/admin/session: records the bearer token each call carried.
    fetch: (async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (!url.endsWith("/api/v1/admin/session")) throw new Error(`unexpected request ${url}`)
      adminCalls.push(String((init?.headers as Record<string, string>)?.authorization ?? ""))
      return Response.json({ wallet: WALLET, vault: { operatorId: "vault-op", permissions: ["vault:read"] }, stocks: null })
    }) as typeof fetch,
  }
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  t.after(() => { dom.window.close(); for (const key of Object.keys(globals)) { const descriptor = previous[key]; if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) } })

  const { GiwaWalletContext } = await import("../demo/giwa/wallet")
  const { StocksHostProvider } = await import("../demo/giwa/stocks-host/StocksHostProvider")
  const { AdminConsoleApp } = await import("./AdminConsoleApp")
  const { useConsoleSession } = await import("./console-session")
  const { ADMIN_SESSION_MAX_MS } = await import("./console-model")

  const wallet: GiwaWallet = {
    address: WALLET, connected: true, chainId: 91342, nativeBalance: null, sessionEpoch: "fake", source: null, signingReady: true, phase: "ready", error: null,
    connect: async () => {}, disconnect: () => {}, switchToGiwa: async () => ({ ok: true }), switching: false, connecting: false, refreshBalance: async () => {},
  }

  // A page with local state: proof the view stays mounted across a renewal.
  let mounts = 0
  function Probe() {
    const { session } = useConsoleSession()
    const [clicks, setClicks] = useState(0)
    useEffect(() => { mounts++ }, [])
    return <button type="button" data-testid="probe" data-token={session.accessToken} onClick={() => setClicks(n => n + 1)}>clicks {clicks}</button>
  }

  // Real clocks. Each sign-in's token can be issued "aged" (iat in the past) to land near its end.
  function mount(options: { lifetime: number }) {
    const server = { age: 0, sign: async () => SIG }
    const dependencies: HostDependencies = {
      maxSessionMs: ADMIN_SESSION_MAX_MS,
      signMessage: () => server.sign(),
      fetch: (async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body))
        if (url.endsWith("/nonce")) return Response.json({ walletAddress: body.walletAddress, domain: body.domain, nonce: "abcdefgh12345678", expiresAt: new Date(Date.now() + 60_000).toISOString() })
        const message = parseSiweMessage(body.message)
        const iat = Math.floor(Date.now() / 1000) - server.age
        const claims = { sub: message.address, domain: message.domain, chainId: 91342, iat, exp: iat + options.lifetime, jti: Math.random() }
        return Response.json({ walletAddress: message.address, chainId: 91342, expiresIn: options.lifetime, token: `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture` })
      }) as typeof fetch,
    }
    const element = document.createElement("div"); document.body.append(element)
    const root = createRoot(element)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const tree = (node: ReactNode) => (
      <StrictMode>
        <QueryClientProvider client={client}>
          <GiwaWalletContext.Provider value={wallet}>
            <StocksHostProvider context={{ walletAddress: WALLET, chainId: 91342, frontendOrigin: ORIGIN, apiBase: "https://api.example.test", walletEpoch: "fake" }} dependencies={dependencies}>
              <MemoryRouter initialEntries={["/vaults/probe"]}>{node}</MemoryRouter>
            </StocksHostProvider>
          </GiwaWalletContext.Provider>
        </QueryClientProvider>
      </StrictMode>
    )
    return {
      element, server,
      async render() {
        await act(async () => {
          root.render(tree(<Routes><Route path="/" element={<AdminConsoleApp />}><Route path="vaults/probe" element={<Probe />} /></Route></Routes>))
          await flush()
        })
      },
      async unmount() { await act(async () => root.unmount()); element.remove() },
    }
  }
  const text = (node: Element | null) => node?.textContent?.replace(/\s+/g, " ").trim() ?? ""
  const q = (root: Element, selector: string) => root.querySelector(selector)
  const buttonNamed = (root: Element, name: RegExp) => [...root.querySelectorAll("button")].find(button => name.test(text(button))) ?? null
  const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await sleep(5); await flush() }) }
  const click = async (button: Element | null) => { assert.ok(button, "button present"); await act(async () => { (button as HTMLButtonElement).click(); await flush() }); await settle() }
  const probe = (m: { element: Element }) => q(m.element, '[data-testid="probe"]')
  const sessionTime = (m: { element: Element }) => text(q(m.element, '[data-testid="console-session-time"]'))
  const notice = (m: { element: Element }) => q(m.element, '[data-testid="console-extend"]')
  const clock = (ms: number) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` }
  async function signedIn(m: ReturnType<typeof mount>) {
    await m.render()
    assert.match(text(m.element), /The session lasts up to 60 minutes/)
    await click(buttonNamed(m.element, /Sign in with wallet/))
    assert.ok(probe(m), "the page is shown after sign-in")
  }

  await t.test("60 minutes: the header shows the time left and the local end; no extend notice yet", async () => {
    const m = mount({ lifetime: 3600 })
    const before = Date.now()
    await signedIn(m)
    assert.match(sessionTime(m), /^60m left \(until \d\d:\d\d\)$/)
    assert.ok([clock(before + 3_600_000), clock(Date.now() + 3_600_000)].some(end => sessionTime(m).endsWith(`(until ${end})`)), sessionTime(m))
    assert.equal(notice(m), null)
    assert.equal(adminCalls.length > 0, true)
    await m.unmount()
  })

  await t.test("the last 5 minutes: Extend session renews without leaving or remounting the page", async () => {
    const m = mount({ lifetime: 3600 })
    m.server.age = 3600 - 270 // 4m30s left
    await signedIn(m)
    assert.match(sessionTime(m), /^5m left/)
    const status = notice(m)
    assert.ok(status); assert.equal(status.getAttribute("role"), "status")
    assert.equal(q(m.element, '[data-testid="console-session-time"]')!.closest("[role=status],[aria-live]"), null, "the minutes are not in a live region")
    await click(probe(m)); await click(probe(m))
    assert.equal(text(probe(m)), "clicks 2")
    const mountsBefore = mounts
    const firstToken = probe(m)!.getAttribute("data-token")

    const signature = deferred<string>()
    m.server.sign = () => signature.promise
    m.server.age = 0
    await click(buttonNamed(m.element, /Extend session/))
    assert.match(text(notice(m)), /Waiting for the wallet/)
    assert.ok(probe(m), "still on the page while the wallet signs")
    signature.resolve(SIG)
    await settle()
    assert.ok(probe(m), "still on the page after the renewal")
    assert.equal(text(probe(m)), "clicks 2", "local page state survived")
    assert.equal(mounts, mountsBefore, "the page was not remounted")
    const token = probe(m)!.getAttribute("data-token")
    assert.notEqual(token, firstToken, "the page now holds the new session")
    assert.equal(adminCalls[adminCalls.length - 1], `Bearer ${token}`, "the new session's permissions were asked for")
    assert.match(sessionTime(m), /^60m left/)
    assert.equal(notice(m), null)
    await m.unmount()
  })

  await t.test("a rejected renewal signature keeps the current session and the page", async () => {
    const m = mount({ lifetime: 3600 })
    m.server.age = 3600 - 200
    await signedIn(m)
    const token = probe(m)!.getAttribute("data-token")
    m.server.sign = async () => { throw Object.assign(new Error("User rejected the request."), { code: 4001 }) }
    await click(buttonNamed(m.element, /Extend session/))
    assert.match(text(notice(m)), /Not extended\. This session continues until it ends\./)
    assert.equal(probe(m)!.getAttribute("data-token"), token)
    assert.match(sessionTime(m), /^4m left/)
    assert.ok(buttonNamed(m.element, /Extend session/), "it can be tried again")
    await m.unmount()
  })

  await t.test("at the end the sign-in gate says the session expired (today's behaviour: the page is replaced)", async () => {
    const m = mount({ lifetime: 3600 })
    m.server.age = 3600 - 2
    await signedIn(m)
    await act(async () => { await sleep(2_500); await flush() })
    await settle()
    assert.equal(probe(m), null)
    assert.match(text(m.element), /Your operator session expired\. Sign in again to continue\./)
    await m.unmount()
  })

  await t.test("a server that issues 15 minutes: the header says 15 minutes left", async () => {
    const m = mount({ lifetime: 900 })
    await signedIn(m)
    assert.match(sessionTime(m), /^15m left \(until /)
    assert.equal(notice(m), null)
    await m.unmount()
  })
})
