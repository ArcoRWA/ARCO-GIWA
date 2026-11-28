import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { GIWA_CHAIN_ID, GIWA_HEX_CHAIN_ID, giwaSepolia } from "./config"
import { GIWA_ADD_CHAIN_PARAMS, isRejectionError, isUnknownChainError, switchDynamicToGiwa, switchInjectedToGiwa } from "./wallet"
import { NETWORK_COPY, switchFailureMessage } from "./wallet-network"

// Switching to GIWA in both wallet providers, with fake wallets: a chain the wallet does not know is added (with the
// same parameters either way) and the switch lands; a rejection says so; the callers that only fire it are unchanged.

type Call = { method: string; params?: unknown }
function injected(script: Record<string, (call: Call) => unknown>, chain = { id: "0x1" }) {
  const calls: Call[] = []
  return {
    calls,
    async request<T>(call: Call): Promise<T> {
      calls.push(call)
      if (call.method === "eth_chainId") return chain.id as T
      const reply = script[call.method]?.(call)
      if (reply instanceof Error || (reply && typeof reply === "object" && "code" in reply)) throw reply
      if (call.method === "wallet_switchEthereumChain" || call.method === "wallet_addEthereumChain") chain.id = GIWA_HEX_CHAIN_ID
      return reply as T
    },
  }
}
const coded = (code: number, message: string) => Object.assign(new Error(message), { code })

test("GIWA's add-chain parameters: the injected path's, chain 91342", () => {
  assert.deepEqual(GIWA_ADD_CHAIN_PARAMS, {
    chainId: GIWA_HEX_CHAIN_ID,
    chainName: "GIWA Sepolia",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: [giwaSepolia.rpcUrls.default.http[0]],
    blockExplorerUrls: [giwaSepolia.blockExplorers.default.url],
  })
  assert.equal(GIWA_HEX_CHAIN_ID, `0x${(91342).toString(16)}`)
})

test("error reading: an unknown chain (4902 and its wordings) and a rejection (4001 and its wordings)", () => {
  for (const err of [coded(4902, "x"), { data: { originalError: { code: 4902 } } }, new Error("Unrecognized chain ID 0x164ce"), new Error("Chain 0x164ce has not been added to MetaMask"), new Error("Unsupported chainId"), new Error("No chain configuration found")]) {
    assert.equal(isUnknownChainError(err), true, String((err as Error).message ?? JSON.stringify(err)))
  }
  for (const err of [coded(4001, "x"), new Error("User rejected the request."), "User denied", { code: "ACTION_REJECTED" }]) assert.equal(isRejectionError(err), true)
  assert.equal(isUnknownChainError(coded(4001, "User rejected")), false)
  assert.equal(isRejectionError(new Error("timeout")), false)
})

test("injected: switch; an unknown chain is added; the chain is read back; a rejection adds nothing", async () => {
  const plain = injected({})
  assert.deepEqual(await switchInjectedToGiwa(plain), { result: { ok: true }, chainId: GIWA_CHAIN_ID })
  assert.deepEqual(plain.calls.map((call) => call.method), ["wallet_switchEthereumChain", "eth_chainId"])

  for (const unknown of [coded(4902, "Unrecognized chain"), new Error("Unrecognized chain ID")]) {
    const fresh = injected({ wallet_switchEthereumChain: () => unknown })
    assert.deepEqual(await switchInjectedToGiwa(fresh), { result: { ok: true }, chainId: GIWA_CHAIN_ID })
    assert.deepEqual(fresh.calls.map((call) => call.method), ["wallet_switchEthereumChain", "wallet_addEthereumChain", "eth_chainId"])
    assert.deepEqual(fresh.calls[1]!.params, [GIWA_ADD_CHAIN_PARAMS])
  }

  const refused = injected({ wallet_switchEthereumChain: () => coded(4001, "User rejected the request.") })
  const { result } = await switchInjectedToGiwa(refused)
  assert.deepEqual(result, { ok: false, rejected: true, reason: "User rejected the request." })
  assert.deepEqual(refused.calls.map((call) => call.method), ["wallet_switchEthereumChain"])
  assert.equal(switchFailureMessage(result as Exclude<typeof result, { ok: true }>), NETWORK_COPY.rejected)

  const broken = injected({ wallet_addEthereumChain: () => coded(-32603, "boom"), wallet_switchEthereumChain: () => coded(4902, "x") })
  assert.deepEqual((await switchInjectedToGiwa(broken)).result, { ok: false, rejected: false, reason: "boom" })
  assert.equal(switchFailureMessage({ ok: false, rejected: false, reason: "boom" }), "Could not switch network: boom")

  // Still elsewhere after the wallet answered: not a success.
  const stuck = { calls: [] as Call[], async request<T>(call: Call): Promise<T> { return (call.method === "eth_chainId" ? "0x1" : null) as T } }
  assert.equal((await switchInjectedToGiwa(stuck)).result.ok, false)
  assert.deepEqual((await switchInjectedToGiwa(undefined)).result, { ok: false, rejected: false, reason: "No injected wallet is available" })
})

test("Dynamic: switchNetwork; a chain it still does not know is added (injected provider, else the wallet's viem client) and switched again", async () => {
  const noWagmi = async () => { throw new Error("wagmi should not be used with a wallet") }
  // Plain switch, the wallet reports GIWA.
  let attempts = 0
  const ok = await switchDynamicToGiwa({ primaryWallet: { switchNetwork: async (id) => { assert.equal(id, GIWA_CHAIN_ID); attempts++ }, getNetwork: async () => GIWA_CHAIN_ID }, switchChainAsync: noWagmi, rawProvider: null })
  assert.deepEqual(ok, { ok: true })
  assert.equal(attempts, 1)

  // Unknown chain through the selected injected provider: wallet_addEthereumChain with the shared parameters, then again.
  attempts = 0
  const provider = injected({})
  const viaProvider = await switchDynamicToGiwa({
    primaryWallet: { switchNetwork: async () => { if (attempts++ === 0) throw coded(4902, "Unrecognized chain ID") } },
    switchChainAsync: noWagmi,
    rawProvider: provider,
  })
  assert.deepEqual(viaProvider, { ok: true })
  assert.equal(attempts, 2)
  assert.deepEqual(provider.calls, [{ method: "wallet_addEthereumChain", params: [GIWA_ADD_CHAIN_PARAMS] }])

  // A WalletConnect wallet (no injected provider): the wallet's viem client adds GIWA.
  attempts = 0
  const added: unknown[] = []
  const viaClient = await switchDynamicToGiwa({
    primaryWallet: {
      switchNetwork: async () => { if (attempts++ === 0) throw new Error("Unsupported chainId 91342") },
      getWalletClient: async () => ({ addChain: async ({ chain }: { chain: unknown }) => { added.push(chain) } }),
    },
    switchChainAsync: noWagmi,
    rawProvider: null,
  })
  assert.deepEqual(viaClient, { ok: true })
  assert.deepEqual(added, [giwaSepolia])

  // Nothing to add it with: the reason comes back; a rejection is a rejection, with no add.
  const unknownOnly = await switchDynamicToGiwa({ primaryWallet: { switchNetwork: async () => { throw coded(4902, "Unrecognized chain ID") } }, switchChainAsync: noWagmi, rawProvider: null })
  assert.deepEqual(unknownOnly, { ok: false, rejected: false, reason: "Unrecognized chain ID" })
  const refusedProvider = injected({})
  const refused = await switchDynamicToGiwa({ primaryWallet: { switchNetwork: async () => { throw new Error("User rejected the wallet's request to switch network") } }, switchChainAsync: noWagmi, rawProvider: refusedProvider })
  assert.equal(refused.ok, false)
  assert.equal(!refused.ok && refused.rejected, true)
  assert.deepEqual(refusedProvider.calls, [])

  // The wallet still on another network afterwards.
  assert.equal((await switchDynamicToGiwa({ primaryWallet: { switchNetwork: async () => {}, getNetwork: async () => "1" }, switchChainAsync: noWagmi, rawProvider: null })).ok, false)

  // No wallet object: wagmi's switchChain, with the same fallback.
  let wagmi = 0
  const wagmiProvider = injected({})
  assert.deepEqual(await switchDynamicToGiwa({ primaryWallet: null, switchChainAsync: async ({ chainId }) => { assert.equal(chainId, GIWA_CHAIN_ID); if (wagmi++ === 0) throw coded(4902, "x") }, rawProvider: wagmiProvider }), { ok: true })
  assert.equal(wagmi, 2)
  assert.equal(wagmiProvider.calls.length, 1)
})

test("every wallet write switches first: the product operation (Savings, product page, Convert), Mint; the admin console and the Stocks host unchanged", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
  const hook = read("./useGiwaProductOperation.ts")
  // One helper, from wallet-network.tsx.
  assert.match(hook, /const ensureGiwa = useEnsureGiwa\(\)/)
  // The modal flow (deposit, withdraw, invest, redeem, requests, conversions, with their approvals) switches first.
  assert.match(hook, /void runOperationFlow\(\{\s*ensureNetwork,\s*network: \(pending\) => updateFlow\(id, \(current\) => \(\{ \.\.\.current, switchingNetwork: pending \}\)\),/)
  // The writes outside the modal too: claims, the panel's own approve / submit / request buttons.
  assert.match(hook, /void onGiwa\(\(\) => submitOperation\("claimRedeem", nextRequestId\)\)/)
  assert.match(hook, /onApprove: \(\) => void onGiwa\(\(\) => approveDepositVault\(\)\)/)
  assert.match(hook, /onSubmit: \(\) => void onGiwa\(\(\) => submitOperation\(\)\)/)
  assert.match(hook, /onRequestRedeem: \(\) => void onGiwa\(\(\) => submitOperation\("requestRedeem"\)\)/)
  assert.match(hook, /onSwitchNetwork: \(\) => void ensureNetwork\(\)/)
  // Another network no longer holds the action back ("Switch to GIWA" / "Switch GIWA" on the panels' buttons).
  assert.doesNotMatch(hook, /wallet\.phase === "wrong-network"/)
  // Every page that writes uses this hook: Savings, the product page, the Convert screen.
  for (const file of ["./SavingsPage.tsx", "./useGiwaVaultDetail.ts", "./ArcoUsdConvertScreen.tsx"]) assert.match(read(file), /useGiwaProductOperation\(/, file)
  // Mint test assets: the same helper.
  assert.match(read("./components.tsx"), /const ensured = await ensureGiwa\(\)/)
  // Unchanged: the admin console keeps its own gate, the Stocks host its own switch command.
  assert.match(read("../../admin/AdminConsoleApp.tsx"), /switchNetwork: \(\) => void switchToGiwa\(\)\.catch\(\(\) => \{\}\)/)
  assert.match(read("./stocks-host/GiwaStocksHost.tsx"), /switchNetwork: \(\) => void switchToGiwa\(\)\.catch\(\(\) => \{\}\)/)
  // The admin console keeps its own gate: the automatic request is the customer shell's only.
  assert.match(read("./GiwaPreprodApp.tsx"), /\{!admin && <GiwaAutoSwitch \/>\}/)
  assert.doesNotMatch(read("../../admin/AdminConsoleApp.tsx"), /GiwaAutoSwitch|useAutoSwitchToGiwa/)
})
