import { useEffect, useRef, type MutableRefObject } from "react"
import { Loader2 } from "lucide-react"
import { GIWA_CHAIN_ID } from "./config"
import { useGiwaWallet, type GiwaSwitchResult, type GiwaWallet } from "./wallet"

// A wallet on another network than GIWA: the wallet chip's "Switch to GIWA" button, the one automatic switch request a
// new connection gets, and the copy every place that switches shows.

export const NETWORK_COPY = {
  button: "Switch to GIWA",
  buttonName: "Switch wallet to GIWA Sepolia",
  pending: "Check your wallet",
  approve: "Approve the network switch in your wallet app.",
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

/**
 * The wallet chip's network pill on another chain: a button that asks the wallet to switch, its spinner and
 * "Check your wallet" while the wallet has the request. Same height and type size as the "GIWA" pill it replaces.
 */
export function SwitchToGiwaButton({ wallet }: { wallet: Pick<GiwaWallet, "switching" | "switchToGiwa"> }) {
  const pending = wallet.switching
  return (
    <>
      <button
        type="button"
        aria-label={NETWORK_COPY.buttonName}
        aria-busy={pending || undefined}
        disabled={pending}
        onClick={() => void wallet.switchToGiwa()}
        className="inline-flex min-w-[9rem] shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-full bg-[var(--color-arco-ink)] px-2 py-0.5 text-xs font-medium text-[var(--color-arco-on-dark)] hover:bg-[var(--color-arco-text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)] disabled:cursor-progress"
      >
        {pending && <Loader2 aria-hidden="true" className="size-3 animate-spin" />}
        {pending ? NETWORK_COPY.pending : NETWORK_COPY.button}
      </button>
      <span role="status" className="sr-only">{pending ? NETWORK_COPY.approve : ""}</span>
    </>
  )
}
