import { useDynamicContext } from "@dynamic-labs/sdk-react-core"
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { formatEther, getAddress, isAddress, type Hex } from "viem"
import { useAccount, useSwitchChain, useWalletClient } from "wagmi"
import { GIWA_EXPLORER, GIWA_HEX_CHAIN_ID, GIWA_PUBLIC_RPC, GIWA_CHAIN_ID, giwaSepolia } from "./config"
import { publicGiwaClient, setDynamicWalletClient, setInjectedWalletSource } from "./contracts"
import type { HexAddress, UiPhase } from "./types"
import { dynamicSigningReady, useWalletConnectionEpoch } from "./stocks-host/wallet-lifecycle"
import type { ActiveWalletSource } from "./stocks-wallet-source/types"
import { selectedDynamicInjectedProvider } from "./stocks-wallet-source/dynamic-injected"

type WalletContextValue = {
  address: HexAddress | null
  connected: boolean
  chainId: number | null
  nativeBalance: string | null
  /** SIWE scope changes even for an A→B→A or same-address reconnection. */
  sessionEpoch: string
  /** The captured source object (injected provider or Dynamic client) behind this epoch. */
  source: ActiveWalletSource | null
  signingReady: boolean
  phase: UiPhase
  error: string | null
  connect: () => Promise<void>
  disconnect: () => void
  /** Never throws; the result says whether the wallet is on GIWA afterwards, or why not. */
  switchToGiwa: () => Promise<GiwaSwitchResult>
  /** A switch to GIWA is waiting on the wallet. */
  switching: boolean
  refreshBalance: () => Promise<void>
}

const WalletContext = createContext<WalletContextValue | null>(null)

export type GiwaWallet = WalletContextValue
/** The wallet context itself, for a host or a test that supplies its own wallet. */
export const GiwaWalletContext = WalletContext

function chainIdFromHex(value: unknown) {
  return typeof value === "string" ? Number.parseInt(value, 16) : null
}

function chainIdFromNetwork(value: unknown) {
  if (typeof value === "number") return value
  if (typeof value !== "string") return null
  return value.startsWith("0x") ? Number.parseInt(value, 16) : Number.parseInt(value, 10)
}

function normalizeAccount(value: unknown) {
  if (typeof value === "string" && isAddress(value)) return getAddress(value)
  return null
}

async function requestChainId() {
  if (!window.ethereum) return null
  return chainIdFromHex(await window.ethereum.request({ method: "eth_chainId" }))
}

// ── Switching to GIWA ────────────────────────────────────────────────────────────────────────────────

/** What a switch came to. Never thrown: callers that only fire it (admin console, stocks host, product panel) ignore it. */
export type GiwaSwitchResult = { ok: true } | { ok: false; rejected: boolean; reason: string }

type RequestProvider = { request<T = unknown>(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<T> }

/** wallet_addEthereumChain parameters for GIWA Sepolia (both providers' unknown-chain fallback). */
export const GIWA_ADD_CHAIN_PARAMS = {
  chainId: GIWA_HEX_CHAIN_ID,
  chainName: "GIWA Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: [GIWA_PUBLIC_RPC],
  blockExplorerUrls: [GIWA_EXPLORER],
} as const

function errorCode(err: unknown): unknown {
  const value = err as { code?: unknown; data?: { originalError?: { code?: unknown }; orginalError?: { code?: unknown } }; cause?: { code?: unknown } } | null
  return value?.code ?? value?.data?.originalError?.code ?? value?.data?.orginalError?.code ?? value?.cause?.code
}
function errorText(err: unknown): string {
  if (typeof err === "string") return err
  const value = err as { shortMessage?: unknown; message?: unknown } | null
  const text = value?.shortMessage ?? value?.message
  return typeof text === "string" && text ? text : String(err)
}
/** The wallet does not know the chain yet (EIP-3326 4902, and the wordings wallets and SDKs use for it). */
export function isUnknownChainError(err: unknown): boolean {
  if (errorCode(err) === 4902) return true
  return /unrecognized chain|unknown chain|not been added|no chain configuration|unsupported chain|chain (?:id )?\S* ?(?:is )?not (?:supported|configured|added)|4902/i.test(errorText(err))
}
/** The user turned the request down in the wallet. */
export function isRejectionError(err: unknown): boolean {
  const code = errorCode(err)
  if (code === 4001 || code === "ACTION_REJECTED") return true
  return /rejected|denied|cancell?ed/i.test(errorText(err))
}
export function switchFailure(err: unknown): GiwaSwitchResult {
  return { ok: false, rejected: isRejectionError(err), reason: errorText(err) }
}

/** The injected wallet: switch; a chain it does not know is added (which also switches), then the chain is read back. */
export async function switchInjectedToGiwa(provider: RequestProvider | undefined): Promise<{ result: GiwaSwitchResult; chainId: number | null }> {
  try {
    if (!provider) throw new Error("No injected wallet is available")
    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: GIWA_HEX_CHAIN_ID }] })
    } catch (err) {
      if (!isUnknownChainError(err)) throw err
      await provider.request({ method: "wallet_addEthereumChain", params: [GIWA_ADD_CHAIN_PARAMS] })
    }
    const chainId = chainIdFromHex(await provider.request({ method: "eth_chainId" }))
    return chainId === GIWA_CHAIN_ID
      ? { result: { ok: true }, chainId }
      : { result: { ok: false, rejected: false, reason: "The wallet is still on another network." }, chainId }
  } catch (err) {
    return { result: switchFailure(err), chainId: null }
  }
}

type DynamicSwitchWallet = {
  switchNetwork(chainId: number): Promise<unknown>
  getNetwork?: () => Promise<unknown>
  getWalletClient?: () => unknown
}
/**
 * Dynamic: primaryWallet.switchNetwork (its EVM connector adds a chain the wallet reports as unknown, from the networks
 * the app merges in, providers.tsx), or wagmi's switchChain without a wallet. When the wallet still answers that it
 * does not know GIWA (a WalletConnect wallet whose session lacks the chain, a path that does not add it), GIWA is added
 * here, through the selected injected provider or the wallet's viem client, with the injected path's parameters, and
 * the switch is tried once more. Then the wallet's network is read back where the wallet can tell it.
 */
export async function switchDynamicToGiwa(args: {
  primaryWallet: DynamicSwitchWallet | null | undefined
  switchChainAsync: (args: { chainId: number }) => Promise<unknown>
  rawProvider: RequestProvider | null
}): Promise<GiwaSwitchResult> {
  const { primaryWallet, switchChainAsync, rawProvider } = args
  const attempt = () => (primaryWallet ? primaryWallet.switchNetwork(GIWA_CHAIN_ID) : switchChainAsync({ chainId: GIWA_CHAIN_ID }))
  try {
    try {
      await attempt()
    } catch (err) {
      if (!isUnknownChainError(err)) throw err
      if (rawProvider) {
        await rawProvider.request({ method: "wallet_addEthereumChain", params: [GIWA_ADD_CHAIN_PARAMS] })
      } else {
        const client = (await primaryWallet?.getWalletClient?.()) as { addChain?: (args: { chain: typeof giwaSepolia }) => Promise<unknown> } | undefined
        if (typeof client?.addChain !== "function") throw err
        await client.addChain({ chain: giwaSepolia })
      }
      await attempt()
    }
    if (primaryWallet?.getNetwork) {
      const network = chainIdFromNetwork(await primaryWallet.getNetwork().catch(() => GIWA_CHAIN_ID))
      if (network !== null && network !== GIWA_CHAIN_ID) return { ok: false, rejected: false, reason: "The wallet is still on another network." }
    }
    return { ok: true }
  } catch (err) {
    return switchFailure(err)
  }
}

/**
 * One switch request at a time: a second call while the wallet has one (the automatic request on connect and a press of
 * Switch to GIWA or Mint test assets) shares it instead of sending another, which wallets refuse while one is open.
 */
export function useSingleSwitch(run: () => Promise<GiwaSwitchResult>) {
  const [switching, setSwitching] = useState(false)
  const inFlight = useRef<Promise<GiwaSwitchResult> | null>(null)
  const switchToGiwa = useCallback((): Promise<GiwaSwitchResult> => {
    if (inFlight.current) return inFlight.current
    setSwitching(true)
    const request = run().finally(() => {
      inFlight.current = null
      setSwitching(false)
    })
    inFlight.current = request
    return request
  }, [run])
  return { switching, switchToGiwa }
}

export function GiwaWalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<HexAddress | null>(null)
  const [chainId, setChainId] = useState<number | null>(null)
  const [nativeBalance, setNativeBalance] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [connectionEpoch, setConnectionEpoch] = useState(0)
  const requestGeneration = useRef(0)
  const accountGeneration = useRef(0)
  const injectedProvider = typeof window === "undefined" ? undefined : window.ethereum
  const sourceEpoch = useWalletConnectionEpoch([connectionEpoch, injectedProvider])
  const retireConnection = useCallback((accountChanged = true) => {
    requestGeneration.current++
    if (accountChanged) accountGeneration.current++
    setConnectionEpoch(value => value + 1)
  }, [])

  useEffect(() => {
    setInjectedWalletSource()
    return () => { requestGeneration.current++; accountGeneration.current++; setInjectedWalletSource() }
  }, [])

  const refreshBalance = useCallback(async () => {
    if (!address) {
      setNativeBalance(null)
      return
    }
    const balance = await publicGiwaClient.getBalance({ address })
    setNativeBalance(formatEther(balance))
  }, [address])

  const connect = useCallback(async () => {
    setError(null)
    retireConnection()
    const generation = requestGeneration.current
    const accountVersion = accountGeneration.current
    setChainId(null)
    try {
      if (!window.ethereum) throw new Error("No injected wallet is available")
      const accounts = await window.ethereum.request<string[]>({ method: "eth_requestAccounts" })
      const nextAddress = normalizeAccount(accounts[0])
      if (!nextAddress) throw new Error("Wallet did not return an EVM address")
      const nextChain = await requestChainId()
      if (accountVersion !== accountGeneration.current) return
      setAddress(nextAddress)
      // A chain event during connection is newer than this RPC response.
      if (generation === requestGeneration.current) setChainId(nextChain)
    } catch (err) {
      if (accountVersion === accountGeneration.current) setError(err instanceof Error ? err.message : String(err))
    }
  }, [retireConnection])

  const disconnect = useCallback(() => {
    retireConnection()
    setChainId(null)
    setAddress(null)
    setNativeBalance(null)
    setError(null)
  }, [retireConnection])

  const { switching, switchToGiwa } = useSingleSwitch(useCallback(async (): Promise<GiwaSwitchResult> => {
    setError(null)
    const { result, chainId: next } = await switchInjectedToGiwa(window.ethereum)
    if (next !== null) setChainId(next)
    if (!result.ok) setError(result.reason)
    return result
  }, []))

  useEffect(() => {
    const provider = injectedProvider
    if (!provider?.on) return undefined
    const onAccounts = (accounts: unknown) => {
      retireConnection()
      const generation = requestGeneration.current
      const next = Array.isArray(accounts) ? normalizeAccount(accounts[0]) : null
      setAddress(next)
      setChainId(null)
      if (next) void requestChainId().then(value => {
        if (generation === requestGeneration.current) setChainId(value)
      }).catch(() => {})
    }
    const onChain = (value: unknown) => { retireConnection(false); setChainId(chainIdFromHex(value)) }
    const onDisconnect = () => { retireConnection(); setAddress(null); setChainId(null) }
    provider.on("accountsChanged", onAccounts)
    provider.on("chainChanged", onChain)
    provider.on("disconnect", onDisconnect)
    return () => {
      requestGeneration.current++
      accountGeneration.current++
      provider.removeListener?.("accountsChanged", onAccounts)
      provider.removeListener?.("chainChanged", onChain)
      provider.removeListener?.("disconnect", onDisconnect)
    }
  }, [retireConnection, injectedProvider])

  useEffect(() => {
    refreshBalance().catch(() => setNativeBalance(null))
  }, [refreshBalance])

  const source = useMemo<ActiveWalletSource>(() => ({ mode: "injected", provider: injectedProvider ?? null }), [injectedProvider])

  const phase: UiPhase = !address
    ? "disconnected"
    : chainId !== GIWA_CHAIN_ID
      ? "wrong-network"
      : nativeBalance === "0"
        ? "missing-gas"
        : "ready"

  const value = useMemo(
    () => ({
      address,
      connected: Boolean(address),
      chainId,
      nativeBalance,
      sessionEpoch: `injected:${sourceEpoch}`,
      source,
      signingReady: Boolean(injectedProvider && address && chainId === GIWA_CHAIN_ID),
      phase,
      error,
      connect,
      disconnect,
      switchToGiwa,
      switching,
      refreshBalance,
    }),
    [address, chainId, sourceEpoch, source, injectedProvider, connect, disconnect, error, nativeBalance, phase, refreshBalance, switchToGiwa, switching],
  )

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
}

export function DynamicGiwaWalletProvider({ children }: { children: ReactNode }) {
  const dynamic = useDynamicContext()
  const account = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const { data: dynamicWalletClient } = useWalletClient({ chainId: GIWA_CHAIN_ID })
  return <DynamicGiwaWalletStateProvider dynamic={dynamic} account={account} switchChainAsync={switchChainAsync} dynamicWalletClient={dynamicWalletClient}>{children}</DynamicGiwaWalletStateProvider>
}

/** The SDK boundary is kept thin so account/chain/source lifecycle can be tested without a live SDK. */
function DynamicGiwaWalletStateProvider({ children, dynamic, account, switchChainAsync, dynamicWalletClient }: {
  children: ReactNode
  dynamic: Pick<ReturnType<typeof useDynamicContext>, "handleLogOut" | "network" | "primaryWallet" | "sdkHasLoaded" | "setShowAuthFlow">
  account: Pick<ReturnType<typeof useAccount>, "address" | "chainId" | "status">
  switchChainAsync: (args: { chainId: number }) => Promise<unknown>
  dynamicWalletClient: (Parameters<typeof setDynamicWalletClient>[0] & { account?: { address?: string }; chain?: { id: number } }) | undefined
}) {
  const { handleLogOut, network, primaryWallet, sdkHasLoaded, setShowAuthFlow } = dynamic
  const [nativeBalance, setNativeBalance] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [localLogout, setLocalLogout] = useState(false)
  const [logoutEpoch, setLogoutEpoch] = useState(0)

  const selectedAddress = useMemo(
    () => normalizeAccount(account.address ?? primaryWallet?.address),
    [account.address, primaryWallet?.address],
  )
  const address = localLogout ? null : selectedAddress
  const chainId = account.chainId ?? chainIdFromNetwork(network)
  const rawProvider = localLogout ? null : selectedDynamicInjectedProvider(primaryWallet)
  const connectionEpoch = useWalletConnectionEpoch([account.address, account.chainId, account.status, primaryWallet?.id, primaryWallet?.address, network, dynamicWalletClient, rawProvider, logoutEpoch])
  const signingReady = dynamicSigningReady(address, chainId, account.status, primaryWallet?.address, dynamicWalletClient)
  useEffect(() => {
    if (!account.address && !primaryWallet?.address) setLocalLogout(false)
  }, [account.address, primaryWallet?.address])

  useEffect(() => {
    setDynamicWalletClient(address && chainId === GIWA_CHAIN_ID ? dynamicWalletClient ?? null : null, signingReady ? rawProvider : null,
      () => selectedDynamicInjectedProvider(primaryWallet))
    return () => setDynamicWalletClient(null)
  }, [address, chainId, signingReady, dynamicWalletClient, rawProvider, primaryWallet])

  const refreshBalance = useCallback(async () => {
    if (!address) {
      setNativeBalance(null)
      return
    }
    const balance = await publicGiwaClient.getBalance({ address })
    setNativeBalance(formatEther(balance))
  }, [address])

  const connect = useCallback(async () => {
    setError(null)
    if (!sdkHasLoaded) {
      setError("Dynamic wallet modal is still loading")
      return
    }
    setShowAuthFlow(true)
  }, [sdkHasLoaded, setShowAuthFlow])

  const disconnect = useCallback(() => {
    setLocalLogout(true)
    setLogoutEpoch(value => value + 1)
    setNativeBalance(null)
    setError(null)
    setDynamicWalletClient(null)
    void handleLogOut()
  }, [handleLogOut])

  const { switching, switchToGiwa } = useSingleSwitch(useCallback(async (): Promise<GiwaSwitchResult> => {
    setError(null)
    const result = await switchDynamicToGiwa({
      primaryWallet: primaryWallet as unknown as Parameters<typeof switchDynamicToGiwa>[0]["primaryWallet"],
      switchChainAsync,
      rawProvider: selectedDynamicInjectedProvider(primaryWallet) as RequestProvider | null,
    })
    if (!result.ok) setError(result.reason)
    return result
  }, [primaryWallet, switchChainAsync]))

  useEffect(() => {
    refreshBalance().catch(() => setNativeBalance(null))
  }, [refreshBalance])

  const source = useMemo<ActiveWalletSource>(() => ({ mode: "dynamic", client: signingReady ? dynamicWalletClient ?? null : null, rawProvider: signingReady ? rawProvider : null }), [signingReady, dynamicWalletClient, rawProvider])

  const phase: UiPhase = !address
    ? "disconnected"
    : chainId !== GIWA_CHAIN_ID
      ? "wrong-network"
      : nativeBalance === "0"
        ? "missing-gas"
        : "ready"

  const value = useMemo(
    () => ({
      address,
      connected: Boolean(address),
      chainId,
      nativeBalance,
      sessionEpoch: `dynamic:${connectionEpoch}`,
      source,
      signingReady,
      phase,
      error,
      connect,
      disconnect,
      switchToGiwa,
      switching,
      refreshBalance,
    }),
    [address, chainId, connectionEpoch, source, signingReady, connect, disconnect, error, nativeBalance, phase, refreshBalance, switchToGiwa, switching],
  )

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
}

export function useGiwaWallet() {
  const context = useContext(WalletContext)
  if (!context) throw new Error("useGiwaWallet must be used inside GiwaWalletProvider")
  return context
}

export function explorerTx(txHash: Hex | string) {
  return `${GIWA_EXPLORER}/tx/${txHash}`
}

export function explorerAddress(address: string) {
  return `${GIWA_EXPLORER}/address/${address}`
}
