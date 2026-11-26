// The Savings account tabs, in liquid glass inside the top of the Savings card (SavingsPage hands them to the card):
// Stablecoins (one account, the coins it takes stacked), Crypto (one tab for all its coins: their marks stacked, the
// lowest to the highest APY, and a menu to pick one) and Gold (one account, ArcoGOLD, the gold coins it takes stacked,
// no menu). Only the coins that can be saved today are shown: a coming-soon account has no mark, no part in the range
// and no row in the menu.
//
// The tabs share a glass track in equal columns; the selected one is a single glass lens that slides over to it
// (theme.css, .savings-glass-lens). Where the track is too narrow for one line each (phones), each tab takes two lines:
// its name, then its marks and APY (theme.css, .savings-tab), so every tab is in view with no sideways swipe.
//
// The Crypto menu: a glass list under the Crypto tab (drawn in a portal, since the card clips what overflows it), as
// wide as the tab, or as the whole track where the tabs take two lines. Each row is a coin's mark, symbol and APY; the
// open account's row is a brighter piece of glass. A coin added to the Vault Config gets a row with no change here.

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react"
import { createPortal } from "react-dom"
import { ChevronDown } from "lucide-react"
import { BrandMark } from "../components/BrandMark"
import { SAVINGS_COINS } from "./savings-assets"
import { SAVINGS_GOLD_COINS, savingsAssetCategory, savingsGoldCoin, savingsMarkIsRound } from "./savings-category"
import type { SavingsAccount } from "./savings"

type CoinMark = { symbol: string; logo: string | null }

/**
 * The coins the stablecoin account takes, one mark per coin: every coin its deposit and withdraw screens offer, with
 * the marks they show (savings-assets.ts), then any other stablecoin the Vault Config lists for it.
 */
function stablecoinMarks(accounts: readonly SavingsAccount[]): CoinMark[] {
  const marks: CoinMark[] = SAVINGS_COINS.map((coin) => ({ symbol: coin.symbol, logo: coin.logo }))
  const listed = new Set(marks.map((mark) => mark.symbol.toUpperCase()))
  for (const account of accounts) {
    const coin = account.symbol.toUpperCase()
    if (listed.has(coin)) continue
    listed.add(coin)
    marks.push({ symbol: account.symbol, logo: account.icon })
  }
  return marks
}

/**
 * The gold coins the gold account takes, one mark per coin (PAXG, then XAUT): the coins the Vault Config lists for it
 * (PAXG or tPAXG alike), each with its own mark. Also the coins beside "Available Gold" on the card (SavingsPage.tsx).
 */
export function savingsGoldMarks(accounts: readonly Pick<SavingsAccount, "symbol" | "icon">[]): CoinMark[] {
  return SAVINGS_GOLD_COINS.filter((coin) => accounts.some((account) => savingsGoldCoin(account.symbol)?.symbol === coin.symbol)).map(
    (coin) => ({ symbol: coin.symbol, logo: coin.logo }),
  )
}

// A tab: name left, marks and APY right (theme.css .savings-tab; two lines on a narrow track). The selected tab's
// text is the card's own colour over the lens; the others the card's muted text. The focus ring follows the tab's
// shape, in the card's text colour (so it reads on all three cards).
const TAB =
  "savings-tab transition-colors duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--color-arco-on-dark)] disabled:opacity-50 motion-reduce:transition-none"
const TAB_ON = "text-[var(--color-arco-on-dark)]"
const TAB_OFF = "text-[var(--color-savings-on-hero-muted)] hover:text-[var(--color-arco-on-dark)]"
const NAME_ON = "font-semibold"
const NAME_OFF = "font-medium"
const APY = "savings-tab-apy tabular-nums"
const MARK_OVERLAP = "-ml-1.5"

/** A tab's coins, overlapping as they are, with no ring around them, the first on top (as the card's coin stack). */
function StackedMarks({ coins }: { coins: readonly CoinMark[] }) {
  return (
    <span className="flex shrink-0 items-center" aria-hidden="true">
      {coins.map((coin, index) => (
        <span key={coin.symbol} className={`relative inline-flex${index > 0 ? ` ${MARK_OVERLAP}` : ""}`} style={{ zIndex: coins.length - index }}>
          {/* A mark that is not a disc (XAUT's gem) is not cropped round, as on the card's coin stack. */}
          <BrandMark src={coin.logo ?? undefined} label={coin.symbol} size={20} shape={savingsMarkIsRound(coin.symbol) ? "round" : "rounded"} className="savings-tab-mark" />
        </span>
      ))}
    </span>
  )
}

/**
 * The lowest to the highest APY among the accounts, as they are written ("3.86% ~ 4.57%"); one figure when they are
 * the same or there is one account; null when no account has a figure (an APY shown as a dash has no part in it).
 */
export function savingsApyRange(accounts: readonly Pick<SavingsAccount, "apy">[]): string | null {
  const rated = accounts
    .map((account) => ({ text: account.apy, value: Number.parseFloat(account.apy) }))
    .filter((entry) => Number.isFinite(entry.value))
  if (rated.length === 0) return null
  const low = rated.reduce((a, b) => (b.value < a.value ? b : a))
  const high = rated.reduce((a, b) => (b.value > a.value ? b : a))
  return low.value === high.value ? low.text : `${low.text} ~ ${high.text}`
}

/** The range written short for a two-line tab: "3.86% ~ 4.57%" → "3.86~4.57%" (one figure as it is). */
export function savingsApyRangeShort(range: string): string {
  return range.replace(/%\s*~\s*/, "~")
}

// useLayoutEffect warns when rendered on the server (the static-markup tests); there it has nothing to place anyway.
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect

const MENU_GAP = 6
const ROW =
  "flex min-h-11 w-full items-center justify-between gap-3 rounded-[16px] px-3.5 text-left text-[13px] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--color-arco-on-dark)]"
const ROW_ON = "savings-glass-piece font-semibold text-[var(--color-arco-on-dark)]"
const ROW_OFF = "text-[var(--color-savings-on-hero-muted)] hover:bg-[var(--color-savings-glass-lens)] hover:text-[var(--color-arco-on-dark)]"

function CoinRows({
  accounts,
  selectedKey,
  onPick,
}: {
  accounts: readonly SavingsAccount[]
  selectedKey: string | null
  onPick: (account: SavingsAccount) => void
}) {
  return (
    <>
      {accounts.map((account) => {
        const selected = account.key === selectedKey
        return (
          <button
            key={account.key}
            type="button"
            role="menuitemradio"
            aria-checked={selected}
            data-coin={account.symbol}
            onClick={() => onPick(account)}
            className={`${ROW} ${selected ? ROW_ON : ROW_OFF}`}
          >
            <span className="flex min-w-0 items-center gap-2.5">
              <BrandMark src={account.icon ?? undefined} label={account.symbol} size={22} />
              <span className="truncate">{account.symbol}</span>
            </span>
            <span className="tabular-nums">{account.apy}</span>
          </button>
        )
      })}
    </>
  )
}

function CryptoTab({
  accounts,
  selectedKey,
  onSelect,
}: {
  accounts: readonly SavingsAccount[]
  selectedKey: string | null
  onSelect: (account: SavingsAccount, fromMenu: boolean) => void
}) {
  const id = useId()
  const menuId = `${id}-menu`
  const [open, setOpen] = useState(false)
  const [place, setPlace] = useState<{ left: number; top: number; width: number; tone: string } | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const selected = accounts.find((account) => account.key === selectedKey) ?? null
  const range = savingsApyRange(accounts)

  const close = (refocus: boolean) => {
    setOpen(false)
    if (refocus) buttonRef.current?.focus()
  }
  const pick = (account: SavingsAccount) => {
    close(true)
    onSelect(account, true)
  }

  // Under the track: as wide as the tab, or as the whole track where the tabs take two lines (a column tab). The menu
  // takes the card's look (its tone), since the portal is outside the card.
  const anchorPlace = () => {
    const button = buttonRef.current
    if (!button) return
    const track = button.closest("[data-savings-tabs-track]") ?? button
    const tab = button.getBoundingClientRect()
    const row = track.getBoundingClientRect()
    const column = typeof window.getComputedStyle === "function" && window.getComputedStyle(button).flexDirection === "column"
    const box = column ? row : tab
    const tone = button.closest("[data-savings-tone]")?.getAttribute("data-savings-tone") ?? "blue"
    const next = { left: box.left, top: row.bottom + MENU_GAP, width: box.width, tone }
    setPlace((current) =>
      current && current.left === next.left && current.top === next.top && current.width === next.width && current.tone === next.tone ? current : next,
    )
  }
  // Before the open list is painted: placed; then focus on the open account's row (or the first).
  useIsomorphicLayoutEffect(() => {
    if (open) anchorPlace()
    else setPlace(null)
  }, [open])
  const placed = place !== null
  useEffect(() => {
    if (!open || !placed) return
    const rows = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]')
    const current = menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')
    ;(current ?? rows?.[0])?.focus({ preventScroll: true })
  }, [open, placed])

  // While the list is open: a press elsewhere closes it; a scroll or a resize keeps it under the tab.
  useEffect(() => {
    if (!open) return
    const onPress = (event: Event) => {
      const target = event.target as Node
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) setOpen(false)
    }
    document.addEventListener("pointerdown", onPress)
    window.addEventListener("resize", anchorPlace)
    window.addEventListener("scroll", anchorPlace, true)
    return () => {
      document.removeEventListener("pointerdown", onPress)
      window.removeEventListener("resize", anchorPlace)
      window.removeEventListener("scroll", anchorPlace, true)
    }
  }, [open])

  // Arrow keys, Home and End move between the rows; Escape and Tab close the list. Focus goes back to the tab first,
  // so Tab moves on from the tab and not from the end of the page, where the list's portal is.
  const onListKeys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]'))
    const at = rows.indexOf(document.activeElement as HTMLElement)
    const go = (index: number) => {
      event.preventDefault()
      rows[(index + rows.length) % rows.length]?.focus()
    }
    if (event.key === "ArrowDown") go(at + 1)
    else if (event.key === "ArrowUp") go(at - 1)
    else if (event.key === "Home") go(0)
    else if (event.key === "End") go(rows.length - 1)
    else if (event.key === "Escape") {
      event.preventDefault()
      close(true)
    } else if (event.key === "Tab") close(true)
  }

  const chevron = (where: "name" | "meta") => (
    <ChevronDown
      aria-hidden="true"
      className={`savings-tab-chevron-${where} shrink-0 transition-transform duration-150 motion-reduce:transition-none ${where === "name" ? "size-3.5" : "size-4"}${open ? " rotate-180" : ""}`}
    />
  )

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-savings-tab=""
        data-crypto-tab=""
        data-selected={selected !== null}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault()
            setOpen(true)
          }
        }}
        className={`${TAB} ${selected ? TAB_ON : TAB_OFF}`}
      >
        {/* The name is in the read-out below. */}
        <span aria-hidden="true" className={`savings-tab-name ${selected ? NAME_ON : NAME_OFF}`}>
          Crypto
          {chevron("name")}
        </span>
        {/* Read out in full; the figures on show are for the eye ("~" reads poorly). */}
        <span className="sr-only">
          {`Crypto: ${accounts.map((account) => account.symbol).join(", ")}`}
          {range ? `, ${range.replace(" ~ ", " to ")} APY` : ""}
          {selected ? `; ${selected.symbol} selected` : ""}
        </span>
        <span aria-hidden="true" className="savings-tab-meta">
          {/* Stacked as the Stablecoins tab stacks its coins: no ring, the first on top. */}
          <StackedMarks coins={accounts.map((account) => ({ symbol: account.symbol, logo: account.icon }))} />
          {range && (
            <>
              <span className={`savings-tab-full ${APY}`}>{range}</span>
              <span className={`savings-tab-short ${APY}`}>{savingsApyRangeShort(range)}</span>
            </>
          )}
          {chevron("meta")}
        </span>
      </button>

      {open &&
        typeof document !== "undefined" &&
        createPortal(
          // .arco-demo: the portal is outside the app's root, where the tokens are set; the card's tone re-scopes them.
          <div className="arco-demo">
            <div data-savings-tone={place?.tone ?? "blue"}>
              <div
                ref={menuRef}
                id={menuId}
                role="menu"
                aria-label="Crypto"
                onKeyDown={onListKeys}
                style={{ left: place?.left ?? 0, top: place?.top ?? 0, width: place?.width ?? 0, visibility: place ? "visible" : "hidden" }}
                className="savings-glass-menu fixed z-50 flex max-h-[60vh] flex-col gap-0.5 overflow-y-auto rounded-[22px] p-1.5"
              >
                <CoinRows accounts={accounts} selectedKey={selectedKey} onPick={pick} />
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}

// SavingsPage mounts the card afresh, these tabs inside it, when the account moves to another vault (it keys the
// card by vault). So that the lens still slides over from the tab it was on, and focus stays on the tabs, the tab
// pressed leaves word here and the new tabs take it up on mount (only just after a press).
let handoff: { index: number; focus: boolean; at: number } | null = null
const HANDOFF_MS = 1500

/** The lens's place: where it was before a remount at first, then (once drawn there, so it slides) the selected tab. */
function useLensIndex(selectedIndex: number, tabs: RefObject<HTMLDivElement>): number {
  const [index, setIndex] = useState(selectedIndex)
  useIsomorphicLayoutEffect(() => {
    const word = handoff
    if (word === null || Date.now() - word.at > HANDOFF_MS) return
    if (word.index !== selectedIndex && selectedIndex >= 0) setIndex(word.index)
    if (word.focus) tabs.current?.querySelectorAll<HTMLElement>("[data-savings-tab]")[selectedIndex]?.focus({ preventScroll: true })
  }, [])
  useEffect(() => {
    if (index === selectedIndex) return
    // Two frames: the first paints the lens where it was (a freshly mounted lens has no place to slide from until it
    // has been drawn once), the second moves it.
    let frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(() => setIndex(selectedIndex))
    })
    return () => window.cancelAnimationFrame(frame)
  }, [index, selectedIndex])
  return index
}

/** The SVG filter that bends the light behind the glass (theme.css, .savings-glass): drawn once, takes no room. */
function GlassRefraction() {
  return (
    <svg aria-hidden="true" focusable="false" width="0" height="0" className="pointer-events-none absolute size-0 overflow-hidden">
      <filter id="savings-glass-refraction" x="-10%" y="-10%" width="120%" height="120%" colorInterpolationFilters="sRGB">
        <feTurbulence type="fractalNoise" baseFrequency="0.006 0.012" numOctaves={2} seed={7} result="noise" />
        <feGaussianBlur in="noise" stdDeviation="2" result="soft" />
        <feDisplacementMap in="SourceGraphic" in2="soft" scale={38} xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>
  )
}

export function SavingsTabs({
  accounts,
  selectedKey,
  onSelect,
}: {
  accounts: readonly SavingsAccount[]
  selectedKey: string | null
  onSelect: (account: SavingsAccount) => void
}) {
  const stable = accounts.filter((account) => savingsAssetCategory(account.symbol) === "stablecoins")
  // Only what can be saved today: a coming-soon coin is left out until it is supported.
  const crypto = accounts.filter((account) => savingsAssetCategory(account.symbol) === "crypto-native" && !account.disabled)
  const stableDefault = stable.find((account) => !account.disabled) ?? null
  const stableCoins = stablecoinMarks(stable)
  // The gold account: one vault (ArcoGOLD) whichever gold coin pays in, so one tab like Stablecoins.
  const gold = accounts.filter((account) => savingsAssetCategory(account.symbol) === "gold")
  const goldDefault = gold.find((account) => !account.disabled) ?? null
  const goldCoins = savingsGoldMarks(gold)

  // The tabs shown, in order, and which is selected (-1: none, no lens).
  const groups = [
    stable.length > 0 ? stable : null,
    crypto.length > 0 ? crypto : null,
    gold.length > 0 ? gold : null,
  ].filter((group): group is SavingsAccount[] => group !== null)
  const selectedIndex = groups.findIndex((group) => group.some((account) => account.key === selectedKey))
  const stableSelected = stable.some((account) => account.key === selectedKey)
  const cryptoIndex = groups.indexOf(crypto)
  const goldSelected = gold.some((account) => account.key === selectedKey)

  const trackRef = useRef<HTMLDivElement>(null)
  const lensIndex = useLensIndex(selectedIndex, trackRef)
  const select = (account: SavingsAccount, fromMenu = false) => {
    const index = groups.findIndex((group) => group.includes(account))
    const focus = fromMenu || (typeof document !== "undefined" && trackRef.current?.contains(document.activeElement) === true)
    handoff = { index: selectedIndex >= 0 ? selectedIndex : index, focus, at: Date.now() }
    onSelect(account)
  }

  return (
    <div className="savings-tabs w-full">
      <GlassRefraction />
      <nav aria-label="Savings accounts">
        <div
          ref={trackRef}
          data-savings-tabs-track=""
          className="savings-tabs-track savings-glass"
          style={{ "--savings-tab-count": groups.length, "--savings-tab-index": Math.max(lensIndex, 0) } as CSSProperties}
        >
          {selectedIndex >= 0 && <span aria-hidden="true" data-savings-lens="" className="savings-glass-lens" />}
          {stable.length > 0 && (
            <button
              type="button"
              data-savings-tab=""
              aria-pressed={stableSelected}
              disabled={stableDefault === null}
              onClick={() => stableDefault && select(stableDefault)}
              className={`${TAB} ${stableSelected ? TAB_ON : TAB_OFF}`}
            >
              <span className={`savings-tab-name ${stableSelected ? NAME_ON : NAME_OFF}`}>Stablecoins</span>
              <span className="savings-tab-meta">
                <StackedMarks coins={stableCoins} />
                <span className="sr-only">{stableCoins.map((coin) => coin.symbol).join(", ")}</span>
                {stableDefault && <span className={APY}>{stableDefault.apy}</span>}
              </span>
            </button>
          )}
          {cryptoIndex >= 0 && <CryptoTab accounts={crypto} selectedKey={selectedKey} onSelect={select} />}
          {gold.length > 0 && (
            <button
              type="button"
              data-savings-tab=""
              data-gold-tab=""
              aria-pressed={goldSelected}
              disabled={goldDefault === null}
              onClick={() => goldDefault && select(goldDefault)}
              className={`${TAB} ${goldSelected ? TAB_ON : TAB_OFF}`}
            >
              <span className={`savings-tab-name ${goldSelected ? NAME_ON : NAME_OFF}`}>Gold</span>
              <span className="savings-tab-meta">
                <StackedMarks coins={goldCoins} />
                <span className="sr-only">{goldCoins.map((coin) => coin.symbol).join(", ")}</span>
                {goldDefault && <span className={APY}>{goldDefault.apy}</span>}
              </span>
            </button>
          )}
        </div>
      </nav>
    </div>
  )
}
