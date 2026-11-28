import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import {
  AdminSessionContractError,
  accessOf,
  accessRoles,
  CONSOLE_NAV,
  defaultPath,
  gateView,
  groupOfPath,
  parseAdminSession,
  READ_ONLY_VAULT_REASON,
  ADMIN_SESSION_MAX_MS,
  inExtendWindow,
  minutesLeft,
  visibleNav,
  type AdminSessionInfo,
  type GateInput,
} from "./console-model"
import { ConsoleGate, ConsoleShell, ExtendNotice, ForbiddenNotice, ForbiddenPanel, formatClockLocal, ReadOnlyNotice, sessionTimeText, type ExtendControl, type GateActions } from "./ConsoleViews"
import { StocksTabView, explorerTxUrl } from "./StocksSection"

const here = path.dirname(fileURLToPath(import.meta.url))
const WALLET = "0x00000000000000000000000000000000000000a1"
const noop = () => {}
const actions: GateActions = { connect: noop, switchNetwork: noop, signIn: noop, retry: noop, signOut: noop, disconnect: noop }
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ")

const info = (vault: string[] | null, stocks: string[] | null, signerWallet = false): AdminSessionInfo => ({
  wallet: WALLET,
  vault: vault ? { operatorId: "vault-op", permissions: vault } : null,
  stocks: stocks ? { operatorId: "stocks-op", permissions: stocks } : null,
  signerWallet,
})

const signedOut: GateInput = {
  walletConnected: true,
  walletOnGiwa: true,
  walletCanSign: true,
  hostStatus: "signed-out",
  hostError: null,
  hasSession: false,
  permissions: { status: "idle" },
}

// ── Before sign-in ──────────────────────────────────────────────────────────

test("before sign-in: connect, switch network, then sign in; nothing is offered without a session", () => {
  assert.deepEqual(gateView({ ...signedOut, walletConnected: false }), { kind: "connect-wallet" })
  assert.deepEqual(gateView({ ...signedOut, walletOnGiwa: false }), { kind: "wrong-network" })
  assert.deepEqual(gateView({ ...signedOut, walletCanSign: false }), { kind: "wallet-unavailable" })
  assert.deepEqual(gateView(signedOut), { kind: "sign-in", notice: null })
  assert.deepEqual(gateView({ ...signedOut, hostStatus: "signing-in" }), { kind: "signing-in" })

  const connect = text(renderToStaticMarkup(<ConsoleGate view={{ kind: "connect-wallet" }} wallet={null} actions={actions} />))
  assert.match(connect, /Connect an operator wallet/)
  assert.match(connect, /Connect wallet/)
  assert.doesNotMatch(connect, /Operator token|Vault Config|Trading control/)

  const signIn = renderToStaticMarkup(<ConsoleGate view={{ kind: "sign-in", notice: null }} wallet={WALLET} actions={actions} />)
  assert.match(text(signIn), /Sign in with wallet/)
  assert.match(text(signIn), /does not authorize a transaction/)
  assert.match(text(signIn), /memory only/)
  assert.match(text(signIn), /The session lasts up to 60 minutes/)
  assert.doesNotMatch(text(signIn), /15 minutes/)
  assert.doesNotMatch(signIn, /type="password"|Operator token/)
})

test("an expired session or a 401 returns to sign-in with the reason", () => {
  const expired = gateView({ ...signedOut, hostError: "SESSION_EXPIRED" })
  assert.deepEqual(expired, { kind: "sign-in", notice: { kind: "expired", code: "SESSION_EXPIRED" } })
  // A 401 from /api/v1/admin/session or any admin request invalidates the session in the host.
  const rejected = gateView({ ...signedOut, hostError: "SESSION_REJECTED" })
  assert.deepEqual(rejected, { kind: "sign-in", notice: { kind: "rejected", code: "SESSION_REJECTED" } })
  const failed = gateView({ ...signedOut, hostStatus: "error", hostError: "AUTH_REJECTED" })
  assert.deepEqual(failed, { kind: "sign-in", notice: { kind: "failed", code: "AUTH_REJECTED" } })

  const expiredHtml = renderToStaticMarkup(<ConsoleGate view={expired as never} wallet={WALLET} actions={actions} />)
  assert.match(expiredHtml, /data-testid="console-notice-expired"/)
  assert.match(text(expiredHtml), /Your operator session expired\. Sign in again to continue\./)
  assert.doesNotMatch(text(expiredHtml), /15 minutes/)
  const rejectedHtml = renderToStaticMarkup(<ConsoleGate view={rejected as never} wallet={WALLET} actions={actions} />)
  assert.match(rejectedHtml, /role="alert"/)
  assert.match(text(rejectedHtml), /did not accept your session \(401\)\. Sign in again/)
  assert.match(text(renderToStaticMarkup(<ConsoleGate view={failed as never} wallet={WALLET} actions={actions} />)), /CORS_ALLOWED_ORIGINS/)
})

test("with a session the console waits for the server's answer; errors offer a retry", () => {
  const session = { ...signedOut, hostStatus: "authenticated" as const, hasSession: true }
  assert.deepEqual(gateView({ ...session, permissions: { status: "loading" } }), { kind: "checking" })
  assert.deepEqual(gateView({ ...session, permissions: { status: "error", message: "Failed to fetch" } }), { kind: "session-error", message: "Failed to fetch" })
  const html = text(renderToStaticMarkup(<ConsoleGate view={{ kind: "session-error", message: "Failed to fetch" }} wallet={WALLET} actions={actions} />))
  assert.match(html, /Could not read operator permissions/)
  assert.match(html, /Try again/)
})

test("a signed-in wallet in neither directory gets the 403 notice, not the console", () => {
  const view = gateView({ ...signedOut, hostStatus: "authenticated", hasSession: true, permissions: { status: "ok", info: info(null, null) } })
  assert.deepEqual(view, { kind: "no-access", wallet: WALLET })
  // Write-only or control-only grants cannot read any page either.
  assert.equal(gateView({ ...signedOut, hasSession: true, permissions: { status: "ok", info: info(["vault:write"], ["stocks:control"]) } }).kind, "no-access")
  const html = text(renderToStaticMarkup(<ConsoleGate view={view as never} wallet={WALLET} actions={actions} />))
  assert.match(html, /No admin access \(403\)/)
  assert.match(html, /ADMIN_OPERATORS/)
})

// ── The server's answer ────────────────────────────────────────────────────

test("GET /api/v1/admin/session is parsed strictly; a malformed answer grants nothing", () => {
  assert.deepEqual(parseAdminSession({ wallet: WALLET, vault: { operatorId: "ops", permissions: ["vault:read"] }, stocks: null }), {
    wallet: WALLET,
    vault: { operatorId: "ops", permissions: ["vault:read"] },
    stocks: null,
    signerWallet: false,
  })
  // The signer-wallet flag: only a literal true counts (older servers omit it).
  assert.equal(parseAdminSession({ wallet: WALLET, vault: null, stocks: null, signerWallet: true }).signerWallet, true)
  for (const flag of ["true", 1, null, undefined]) {
    assert.equal(parseAdminSession({ wallet: WALLET, vault: null, stocks: null, signerWallet: flag }).signerWallet, false, String(flag))
  }
  for (const body of [null, [], {}, { wallet: "nope", vault: null, stocks: null }, { wallet: WALLET, vault: {}, stocks: null }, { wallet: WALLET, vault: null, stocks: { operatorId: "", permissions: [] } },
    { wallet: WALLET, vault: { operatorId: "ops", permissions: "vault:read" }, stocks: null }, { wallet: WALLET, vault: undefined, stocks: null }]) {
    assert.throws(() => parseAdminSession(body), AdminSessionContractError, JSON.stringify(body))
  }
})

test("tabs follow the permissions: each group needs its read permission; / opens the first permitted tab", () => {
  const labels = (vault: string[] | null, stocks: string[] | null) => visibleNav(accessOf(info(vault, stocks))).map((group) => [group.label, group.tabs.map((tab) => tab.label)])
  assert.deepEqual(labels(["vault:read", "vault:write"], ["stocks:read", "stocks:control"]), [
    ["Vaults", ["Operations", "Prices", "Vault Config", "Featured", "Monitoring", "ArcoUSD", "Gold"]],
    ["Stocks", ["Limits", "Trading control", "Overview", "Orders", "Reconciliation", "Audit", "Held payments"]],
  ])
  assert.deepEqual(labels(["vault:read"], null).map(([group]) => group), ["Vaults"])
  assert.deepEqual(labels(null, ["stocks:read"]).map(([group]) => group), ["Stocks"])
  assert.deepEqual(labels(["vault:write"], ["stocks:read"]).map(([group]) => group), ["Stocks"])
  assert.equal(defaultPath(accessOf(info(["vault:read"], ["stocks:read"]))), "/vaults/operations")
  assert.equal(defaultPath(accessOf(info(null, ["stocks:read"]))), "/stocks/limits")
  assert.equal(defaultPath(accessOf(info(null, null))), null)
  assert.equal(groupOfPath("/vaults/prices"), "vaults")
  assert.equal(groupOfPath("/stocks/held"), "stocks")
  assert.equal(groupOfPath("/"), null)
  assert.equal(CONSOLE_NAV.flatMap((group) => group.tabs).length, 14)
})

const EXPIRES = Date.UTC(2026, 8, 26, 3, 15)
const idleExtend: ExtendControl = { status: "idle", run: noop }

function shell(vault: string[] | null, stocks: string[] | null, path = "/", signerWallet = false, now = EXPIRES - 42 * 60_000, extend = idleExtend, expiresAt = EXPIRES) {
  const session = info(vault, stocks, signerWallet)
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <ConsoleShell info={session} access={accessOf(session)} expiresAt={expiresAt} now={now} extend={extend} forbidden={false} onDismissForbidden={noop} onSignOut={noop}>
        <p>page</p>
      </ConsoleShell>
    </MemoryRouter>,
  )
}

test("the signed-in shell shows only the permitted groups, the operator identity and the session end", () => {
  const both = shell(["vault:read", "vault:write"], ["stocks:read"], "/stocks/held")
  for (const href of ["/vaults/operations", "/vaults/prices", "/vaults/config", "/vaults/featured", "/vaults/monitoring", "/vaults/arcousd", "/vaults/gold", "/stocks/limits", "/stocks/trading-control", "/stocks/overview", "/stocks/orders", "/stocks/reconciliation", "/stocks/audit", "/stocks/held"]) {
    assert.match(both, new RegExp(`href="${href}"`), href)
  }
  assert.match(both, /href="\/stocks\/held"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/stocks\/held"/)
  assert.match(text(both), /Vaults: vault-op · vault:read vault:write/)
  assert.match(text(both), /Stocks: stocks-op · stocks:read/)
  assert.match(text(both), new RegExp(`0x0000…00a1 · 42m left \\(until ${formatClockLocal(EXPIRES)}\\)`))
  assert.doesNotMatch(both, /UTC/)

  const vaultsOnly = shell(["vault:read"], null)
  assert.match(vaultsOnly, /href="\/vaults\/operations"/)
  assert.doesNotMatch(vaultsOnly, /href="\/stocks\//)
  const stocksOnly = shell(null, ["stocks:read"])
  assert.match(stocksOnly, /href="\/stocks\/held"/)
  assert.doesNotMatch(stocksOnly, /href="\/vaults\//)

  // Signed in with the Stocks signer's wallet: a standing notice on every page; none otherwise.
  assert.doesNotMatch(both, /console-signer-wallet/)
  const signer = shell(["vault:read", "vault:write"], ["stocks:read"], "/vaults/arcousd", true)
  assert.match(signer, /data-testid="console-signer-wallet"/)
  assert.match(text(signer), /This wallet is the Stocks signer Do not send transactions from it here\. Any transaction from this wallet stops Stocks/)
})

test("the header says what the signed-in wallet can do, in words, from the server's permissions only", () => {
  assert.deepEqual(accessRoles(accessOf(info(["vault:read", "vault:write"], ["stocks:read", "stocks:control"]))), ["Vault operator", "Stocks operator"])
  assert.deepEqual(accessRoles(accessOf(info(["vault:read"], ["stocks:read"]))), ["Vaults read-only", "Stocks read-only"])
  assert.deepEqual(accessRoles(accessOf(info(["vault:read", "vault:write"], null))), ["Vault operator"])
  assert.deepEqual(accessRoles(accessOf(info(null, ["stocks:read"]))), ["Stocks read-only"])
  assert.deepEqual(accessRoles(accessOf(info(["something:else"], null))), [])

  const operator = shell(["vault:read", "vault:write"], ["stocks:read"])
  assert.match(operator, /data-testid="console-access"[^>]*>Vault operator · Stocks read-only</)
  assert.match(text(operator), /Vaults: vault-op · vault:read vault:write/) // the raw grants stay beside it
  assert.match(shell(["vault:read"], null), /data-testid="console-access"[^>]*>Vaults read-only</)
})

test("the header shows the minutes left and the local end time; the time text is never a live region", () => {
  assert.equal(minutesLeft(EXPIRES, EXPIRES - 41 * 60_000 - 1), 42)
  assert.equal(minutesLeft(EXPIRES, EXPIRES - 60 * 60_000), 60)
  assert.equal(minutesLeft(EXPIRES, EXPIRES - 30_000), 1)
  assert.equal(minutesLeft(EXPIRES, EXPIRES + 1), 0)
  // The viewer's own time zone: 03:15 UTC reads 12:15 in Seoul and 23:15 the day before in New York.
  const zone = process.env.TZ
  try {
    process.env.TZ = "Asia/Seoul"
    assert.equal(sessionTimeText(EXPIRES, EXPIRES - 42 * 60_000), "42m left (until 12:15)")
    process.env.TZ = "America/New_York"
    assert.equal(formatClockLocal(EXPIRES), "23:15")
  } finally {
    if (zone === undefined) delete process.env.TZ
    else process.env.TZ = zone
  }
  assert.equal(formatClockLocal(NaN), "—")
  const html = shell(["vault:read"], null)
  assert.match(html, /<span data-testid="console-session-time">42m left/)
  assert.doesNotMatch(html, /aria-live/)
  assert.doesNotMatch(html, /console-extend/, "no extend notice with 42 minutes left")
})

test("a 15-minute server session reads 15 minutes, not the 60-minute maximum", () => {
  assert.equal(ADMIN_SESSION_MAX_MS, 3_600_000)
  const now = EXPIRES - 15 * 60_000
  assert.match(text(shell(["vault:read"], null, "/", false, now)), /15m left \(until /)
})

test("in the last 5 minutes the header offers Extend session; the notice text does not change with the minutes", () => {
  assert.equal(inExtendWindow(EXPIRES, EXPIRES - 5 * 60_000 - 1), false)
  assert.equal(inExtendWindow(EXPIRES, EXPIRES - 5 * 60_000), true)
  assert.equal(inExtendWindow(EXPIRES, EXPIRES - 1), true)
  assert.equal(inExtendWindow(EXPIRES, EXPIRES), false)
  const at = (minutes: number, extend = idleExtend) => shell(["vault:read"], null, "/", false, EXPIRES - minutes * 60_000, extend)
  assert.doesNotMatch(at(6), /console-extend/)
  const four = at(4)
  assert.match(four, /data-testid="console-extend"/)
  assert.match(four, /role="status"[^>]*data-testid="console-extend"|data-testid="console-extend"[^>]*role="status"/)
  assert.match(text(four), /4m left .* Your session ends soon\. Extend session/)
  // The live region holds no minute count, so it is not re-announced as the minutes change.
  const notice = (extend: ExtendControl) => renderToStaticMarkup(<ExtendNotice extend={extend} />)
  assert.equal(notice(idleExtend), renderToStaticMarkup(<ExtendNotice extend={idleExtend} />))
  assert.doesNotMatch(text(notice(idleExtend)), /\d+m/)
  const pending = notice({ status: "pending", run: noop })
  assert.match(pending, /disabled=""/)
  assert.match(text(pending), /Waiting for the wallet/)
  assert.match(text(notice({ status: "failed", run: noop })), /Not extended\. This session continues until it ends\. Extend session/)
})

test("403: a refused request shows a notice, and an unpermitted group shows a panel instead of the page", () => {
  const notice = renderToStaticMarkup(<ForbiddenNotice onDismiss={noop} />)
  assert.match(notice, /role="alert"/)
  assert.match(text(notice), /refused a request \(403\)/)
  const vaults = text(renderToStaticMarkup(<ForbiddenPanel group="vaults" />))
  assert.match(vaults, /No Vaults permission \(403\)/)
  assert.match(vaults, /vault:read/)
  assert.match(text(renderToStaticMarkup(<ForbiddenPanel group="stocks" />)), /No Stocks permission \(403\).*stocks:read/)
  assert.match(text(renderToStaticMarkup(<ReadOnlyNotice />)), new RegExp(READ_ONLY_VAULT_REASON.replace(/[.:]/g, "\\$&")))
})

test("Stocks tabs pass the one console session to the reused features and link held payments to the explorer", () => {
  const session = { id: "session-1", accessToken: "header.payload.signature" }
  const render = (tab: Parameters<typeof StocksTabView>[0]["tab"], canControl = true) =>
    renderToStaticMarkup(<StocksTabView tab={tab} apiBase="https://api.example.test" session={session} canControl={canControl} onSignInRequired={noop} onNavigate={noop} />)
  assert.match(render("trading-control"), /data-testid="stocks-trading-control"/)
  // Limits is the first Stocks page; before the first read it shows the loading row (the rows and buttons: stocks-limits tests).
  const limits = render("limits")
  assert.match(limits, /data-testid="stocks-limits"/)
  assert.match(limits, /Reading the limits/)
  assert.match(render("held"), /data-testid="stocks-held"|Loading held payments|Held payments/)
  const orders = render("orders")
  assert.match(orders, /Stocks operations/)
  // A host-owned section: the feature's own section tabs are not repeated.
  assert.doesNotMatch(orders, /role="tablist"/)
  assert.equal(explorerTxUrl(`0x${"a".repeat(64)}`).endsWith(`/tx/0x${"a".repeat(64)}`), true)
})

// ── Static guards ──────────────────────────────────────────────────────────

test("console sources keep the session in memory and never use the legacy token or the browser allowlist", () => {
  const sources = readdirSync(here).filter((name) => /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name))
  assert.ok(sources.includes("AdminConsoleApp.tsx") && sources.includes("main.tsx"))
  for (const name of sources) {
    const source = readFileSync(path.join(here, name), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
    assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|document\.cookie/, name)
    assert.doesNotMatch(source, /x-operator-token|operatorTokenAuth|GIWA_ADMIN_ADDRESSES|RequireGiwaAdmin|GiwaAdminLayout|admin-access/, name)
  }
  const html = readFileSync(path.join(here, "../../admin/index.html"), "utf8")
  assert.match(html, /<meta name="robots" content="noindex,nofollow" \/>/)
  assert.match(html, /src="\/src\/admin\/main\.tsx"/)
})
