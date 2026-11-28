import { useCallback, useEffect, useRef, type MutableRefObject } from "react"
import { GIWA_CHAIN_ID } from "./config"
import { useGiwaWallet, type GiwaSwitchResult, type GiwaWallet } from "./wallet"

// A wallet on another network than GIWA: the one automatic switch request a new connection gets, ensureGiwa (every
// action that writes switches first, then carries on in the same press), the chip's status words, and the copy every
// place that switches shows.

export const NETWORK_COPY = {
  approve: "Approve the network switch in your wallet app.",
  chipOnGiwa: "Connected to GIWA Sepolia",
  chipElsewhere: "Wallet is on another network — it switches to GIWA when you act",
  rejected: "Network switch was rejected.",
  failed: (reason: string) => `Could not switch network: ${reason}`,
} as const

/** The line to show for a switch that did not land on GIWA. */
export function switchFailureMessage(result: Exclude<GiwaSwitchResult, { ok: true }>): string {
  return result.rejected ? NETWORK_COPY.rejected : NETWORK_COPY.failed(result.reason)
}

/** Connected on another chain than GIWA (an unknown chain counts: the wallet has not said GIWA). */
export function onWrongNetwork(wallet: Pick<GiwaWallet, "address" | "chainId">): boolean {
  return Boolean(wallet.address) && wallet.chainId !== GIWA_CHAIN_ID
}

/**
 * Waits until the wallet (read through a ref the component refreshes on each render) satisfies `ready`, polling, up to
 * `timeoutMs`; the wallet's state after a connect or a switch arrives a render later than the promise.
 */
export async function waitForWallet(ref: MutableRefObject<GiwaWallet>, ready: (wallet: GiwaWallet) => boolean, timeoutMs: number, stepMs = 50): Promise<GiwaWallet | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (ready(ref.current)) return ref.current
    if (Date.now() >= deadline) return null
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
}

/**
 * Asks the wallet to switch to GIWA once per connection, when it connects (or changes account) on another chain. Not
 * again for that address after a rejection or a failure; a disconnect or another address starts over. The wallet's
 * chain must be known first (it is read after the account on connect).
 */
export function useAutoSwitchToGiwa(wallet: Pick<GiwaWallet, "address" | "chainId" | "switchToGiwa">, enabled = true) {
  const askedFor = useRef<string | null>(null)
  const { address, chainId, switchToGiwa } = wallet
  useEffect(() => {
    if (!address) {
      askedFor.current = null
      return
    }
    if (askedFor.current !== null && askedFor.current !== address) askedFor.current = null
    if (!enabled || chainId === null || chainId === GIWA_CHAIN_ID || askedFor.current === address) return
    askedFor.current = address
    void switchToGiwa()
  }, [address, chainId, enabled, switchToGiwa])
}

/** The shell mounts this once (not in the admin console, which has its own network gate). */
export function GiwaAutoSwitch() {
  useAutoSwitchToGiwa(useGiwaWallet())
  return null
}

/** What ensureGiwa came to: ok, or why not (`message` is the line to show where the action shows its errors). */
export type EnsureGiwaResult = { ok: true } | { ok: false; rejected: boolean; reason: string; message: string }

/** How long, after the wallet says it switched, to wait for the app to see GIWA and be able to sign there. */
export const ENSURE_GIWA_SETTLE_MS = 15_000

/**
 * Makes sure the wallet is on GIWA before an action that writes: already there (and able to sign) → nothing is asked;
 * another chain → the switch is requested (the providers add GIWA to a wallet that does not know it, and share one
 * request with any other switch in flight), then this waits until the app sees GIWA and can sign. Never throws.
 * Reads never need this: they go through the app's own GIWA RPC.
 */
export async function ensureGiwaWith(ref: MutableRefObject<GiwaWallet>, settleMs = ENSURE_GIWA_SETTLE_MS): Promise<EnsureGiwaResult> {
  const now = ref.current
  if (!now.address) return { ok: false, rejected: false, reason: "No wallet is connected", message: "Connect your wallet first." }
  if (now.chainId === GIWA_CHAIN_ID && now.signingReady) return { ok: true }
  if (now.chainId !== GIWA_CHAIN_ID) {
    const result = await now.switchToGiwa()
    if (!result.ok) return { ...result, message: switchFailureMessage(result) }
  }
  const ready = await waitForWallet(ref, (next) => next.chainId === GIWA_CHAIN_ID && next.signingReady, settleMs)
  if (ready) return { ok: true }
  const reason = "the wallet did not report GIWA Sepolia."
  return { ok: false, rejected: false, reason, message: NETWORK_COPY.failed(reason) }
}

/** ensureGiwa for a component: reads the wallet as it is when called (and after each await), not as it was rendered. */
export function useEnsureGiwa(): () => Promise<EnsureGiwaResult> {
  const wallet = useGiwaWallet()
  const ref = useRef(wallet)
  ref.current = wallet
  return useCallback(() => ensureGiwaWith(ref), [])
}

/** The wallet chip's status: its dot and the words for it (title and screen readers). */
export function walletChipStatus(wallet: Pick<GiwaWallet, "chainId">): { onGiwa: boolean; label: string } {
  const onGiwa = wallet.chainId === GIWA_CHAIN_ID
  return { onGiwa, label: onGiwa ? NETWORK_COPY.chipOnGiwa : NETWORK_COPY.chipElsewhere }
}
