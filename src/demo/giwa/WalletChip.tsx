import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react"
import { useInRouterContext, useLocation } from "react-router-dom"
import { Check, ChevronDown, Copy, ExternalLink, LogOut } from "lucide-react"
import { getAddress } from "viem"
import { explorerAddress } from "./wallet"

// The top bar's connected wallet (mock W2): a 32px rounded chip — status dot, the short address, a chevron — that opens a
// small menu: Copy address, the network line, View on explorer, Disconnect. The full address is never shown (it is only
// copied). On another network the dot turns amber and the chip takes a faint amber tint; every action switches to GIWA
// when pressed (ensureGiwa), so there is no Switch button here.

export const WALLET_MENU_COPY = {
  copy: "Copy address",
  copied: "Copied",
  copyFailed: "Could not copy",
  explorer: "View on explorer",
  disconnect: "Disconnect",
  giwa: "GIWA Sepolia",
  giwaState: "Connected",
  other: "Other network",
  otherState: "Switches to GIWA when you act",
} as const

export const COPY_RESET_MS = 1_500

/** Checksummed where the address parses; as given otherwise. */
export function checksummed(address: string): string {
  try {
    return getAddress(address)
  } catch {
    return address
  }
}

/** "0x3185...76D2" — the chip's short form of the checksummed address. */
export function chipAddress(address: string): string {
  const value = checksummed(address)
  return `${value.slice(0, 6)}...${value.slice(-4)}`
}

// The top bar's three controls share one box: the search field's height (h-9, 36px), radius (rounded-lg, 8px), 1px border
// and focus ring (GiwaProductSearch), so their top and bottom edges line up.
const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-arco-ink)]"
export const WALLET_CONTROL = `inline-flex h-9 items-center rounded-lg border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] ${FOCUS}`
// Amber: no warning token in the palette, so the nearest — the risk meter's medium (dot), its badge fill (border); the
// faint chip fill is the muted surface. (Token wanted: a warning/amber status colour with a soft tint.)
const DOT_GIWA = "bg-[var(--color-arco-up)]"
const DOT_OTHER = "bg-[var(--color-risk-meter-medium)]"
const ITEM = `flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] font-medium text-[var(--color-arco-ink)] hover:bg-[var(--color-arco-chip)] focus:bg-[var(--color-arco-chip)] focus:outline-none`

type CopyState = "idle" | "copied" | "failed"

function CloseOnRouteChange({ onChange }: { onChange: () => void }) {
  const { pathname } = useLocation()
  const seen = useRef(pathname)
  useEffect(() => {
    if (seen.current === pathname) return
    seen.current = pathname
    onChange()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname])
  return null
}

export function WalletChip({
  address,
  onGiwa,
  label,
  onDisconnect,
}: {
  address: string
  onGiwa: boolean
  label: string
  onDisconnect: () => void
}) {
  const [open, setOpen] = useState(false)
  const [copy, setCopy] = useState<CopyState>("idle")
  const inRouter = useInRouterContext()
  const rootRef = useRef<HTMLDivElement>(null)
  const chipRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const focusOnOpen = useRef<"first" | "last">("first")
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const items = () => Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
  const close = (refocus: boolean) => {
    setOpen(false)
    if (refocus) chipRef.current?.focus()
  }

  // Focus moves into the menu when it opens (the first item; the last from ArrowUp on the chip).
  useEffect(() => {
    if (!open) return
    const list = items()
    ;(focusOnOpen.current === "last" ? list[list.length - 1] : list[0])?.focus()
  }, [open])

  // A press outside closes it.
  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent | MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener("pointerdown", onPointer)
    document.addEventListener("mousedown", onPointer)
    return () => {
      document.removeEventListener("pointerdown", onPointer)
      document.removeEventListener("mousedown", onPointer)
    }
  }, [open])

  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current)
  }, [])

  const openWith = (where: "first" | "last") => {
    focusOnOpen.current = where
    setOpen(true)
  }

  const onChipKey = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      openWith(event.key === "ArrowUp" ? "last" : "first")
    }
  }

  const onMenuKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const list = items()
    const at = list.indexOf(document.activeElement as HTMLElement)
    const go = (index: number) => {
      event.preventDefault()
      list[(index + list.length) % list.length]?.focus()
    }
    if (event.key === "ArrowDown") go(at + 1)
    else if (event.key === "ArrowUp") go(at < 0 ? list.length - 1 : at - 1)
    else if (event.key === "Home") go(0)
    else if (event.key === "End") go(list.length - 1)
    else if (event.key === "Escape") {
      event.preventDefault()
      close(true)
    } else if (event.key === "Tab") setOpen(false)
  }

  const copyAddress = async () => {
    let next: CopyState = "failed"
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(checksummed(address))
        next = "copied"
      }
    } catch {
      next = "failed"
    }
    setCopy(next)
    if (copyTimer.current) clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopy("idle"), COPY_RESET_MS)
  }

  const copyLabel = copy === "copied" ? WALLET_MENU_COPY.copied : copy === "failed" ? WALLET_MENU_COPY.copyFailed : WALLET_MENU_COPY.copy

  return (
    <div ref={rootRef} className="relative min-w-0">
      {inRouter && <CloseOnRouteChange onChange={() => setOpen(false)} />}
      <button
        ref={chipRef}
        type="button"
        title={label}
        data-wallet-network={onGiwa ? "giwa" : "other"}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? "giwa-wallet-menu" : undefined}
        onClick={() => (open ? close(false) : openWith("first"))}
        onKeyDown={onChipKey}
        className={`inline-flex h-9 min-w-0 max-w-full items-center gap-2 whitespace-nowrap rounded-lg border py-0 pl-3 pr-2.5 text-[13px] font-medium text-[var(--color-arco-ink)] shadow-[var(--shadow-control)] ${FOCUS} ${
          onGiwa
            ? open
              ? "border-[var(--color-arco-border)] bg-[var(--color-arco-chip)]"
              : "border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] hover:bg-[var(--color-arco-page)]"
            : "border-[var(--color-risk-medium-bg)] bg-[var(--color-arco-surface-muted)] hover:bg-[var(--color-arco-page)]"
        }`}
      >
        <span aria-hidden="true" data-wallet-dot className={`size-2 shrink-0 rounded-full ${onGiwa ? DOT_GIWA : DOT_OTHER}`} />
        <span className="sr-only">{label}</span>
        <span className="min-w-0 truncate tabular-nums">{chipAddress(address)}</span>
        <ChevronDown
          aria-hidden="true"
          className={`size-3.5 shrink-0 text-[var(--color-arco-muted)] motion-safe:transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div
          ref={menuRef}
          id="giwa-wallet-menu"
          role="menu"
          aria-label="Wallet"
          onKeyDown={onMenuKey}
          className="absolute right-0 top-full z-50 mt-1.5 w-[15rem] max-w-[calc(100vw-2rem)] rounded-xl border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] p-1.5 shadow-[var(--shadow-savings-popover)]"
        >
          <button type="button" role="menuitem" tabIndex={-1} data-wallet-menu="copy" onClick={() => void copyAddress()} className={ITEM}>
            {copy === "copied" ? (
              <Check aria-hidden="true" className="size-4 shrink-0 text-[var(--color-arco-up)]" />
            ) : (
              <Copy aria-hidden="true" className="size-4 shrink-0 text-[var(--color-arco-muted)]" />
            )}
            <span>{copyLabel}</span>
          </button>
          <span aria-live="polite" className="sr-only">
            {copy === "copied" ? WALLET_MENU_COPY.copied : copy === "failed" ? WALLET_MENU_COPY.copyFailed : ""}
          </span>

          <div role="none" data-wallet-menu="network" className="my-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 border-y border-[var(--color-arco-border)] px-2.5 py-2.5 text-[13px]">
            <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${onGiwa ? DOT_GIWA : DOT_OTHER}`} />
            <span className="shrink-0 whitespace-nowrap font-medium text-[var(--color-arco-ink)]">{onGiwa ? WALLET_MENU_COPY.giwa : WALLET_MENU_COPY.other}</span>
            <span className="ml-auto whitespace-nowrap text-right text-xs text-[var(--color-arco-muted)]">{onGiwa ? WALLET_MENU_COPY.giwaState : WALLET_MENU_COPY.otherState}</span>
          </div>

          <a
            role="menuitem"
            tabIndex={-1}
            data-wallet-menu="explorer"
            href={explorerAddress(checksummed(address))}
            target="_blank"
            rel="noreferrer"
            onClick={() => setOpen(false)}
            className={ITEM}
          >
            <ExternalLink aria-hidden="true" className="size-4 shrink-0 text-[var(--color-arco-muted)]" />
            <span>{WALLET_MENU_COPY.explorer}</span>
          </a>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            data-wallet-menu="disconnect"
            onClick={() => {
              setOpen(false)
              onDisconnect()
            }}
            className={ITEM}
          >
            <LogOut aria-hidden="true" className="size-4 shrink-0 text-[var(--color-arco-muted)]" />
            <span>{WALLET_MENU_COPY.disconnect}</span>
          </button>
        </div>
      )}
    </div>
  )
}
