// The search palette. The top bar keeps a search field (on phones, a search button) as its trigger; pressing it, or
// "/" anywhere but a field or a dialog, opens the palette: a centred modal from xl (the page behind dimmed and blurred),
// a full-screen sheet below it. One input filters every section (product-search.ts); ↑ / ↓ move a cursor through the
// rows, Enter opens the cursor's row (or the first), Escape closes. Focus stays inside while it is open and goes back
// to the trigger when it closes; the page behind does not scroll.

import { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { Link, useLocation, useNavigate } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { ArrowDown, ArrowRight, ArrowUp, ArrowUpRight, BookOpen, ChartPie, CornerDownLeft, FileText, Layers, PiggyBank, Replace, Search } from "lucide-react"
import { BrandMark } from "../components/BrandMark"
import { giwaApi } from "./api"
import { ArcoGoldLiveContext } from "./arcogold-live-context"
import { ArcoUsdLiveContext, ArcoUsdLiveFailedContext, ArcoUsdLivePendingContext } from "./arcousd-live-context"
import { GIWA_CHAIN_ID } from "./config"
import { GiwaFeaturesContext } from "./features"
import { FUNDS_LINEUP } from "./funds-lineup"
import { useGetArcoUsd } from "./GetArcoUsd"
import {
  categoryItems,
  fundItems,
  highlightParts,
  opensPalette,
  pageItems,
  paletteActions,
  paletteSections,
  savingsItems,
  SEARCH_SHORTCUT_KEY,
  stockItems,
  type PaletteIcon,
  type PaletteItem,
} from "./product-search"
import { SAVINGS_CATEGORIES } from "./savings-category"
import { savingsOffers, savingsPageAccounts } from "./savings-page-accounts"
import { createMarketClient } from "./stocks-market/client"
import { StocksPageEnvironment, usePageApiBase } from "./stocks-market/environment"
import { useOwnedRead } from "./stocks-market/useOwnedRead"

const PLACEHOLDER = "Search savings, funds, pages…"
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** A key as it is printed on the keyboard. */
export function Keycap({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <kbd
      aria-label={label}
      className="inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-md border border-b-2 border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] px-1.5 text-xs font-medium text-[var(--color-arco-text-soft)]"
    >
      {children}
    </kbd>
  )
}

export function GiwaProductSearch() {
  const [open, setOpen] = useState(false)
  const field = useRef<HTMLButtonElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const location = useLocation()
  const { stocks: withStocks } = useContext(GiwaFeaturesContext)
  const show = useCallback(() => {
    const active = document.activeElement
    opener.current = active instanceof HTMLElement && active !== document.body ? active : null
    setOpen(true)
  }, [])
  const close = useCallback(() => {
    setOpen(false)
    // Back to what opened it; after the shortcut, to the trigger the page shows.
    const back = opener.current?.isConnected ? opener.current : window.matchMedia?.("(min-width: 640px)").matches ? field.current : button.current
    window.requestAnimationFrame(() => back?.focus({ preventScroll: true }))
  }, [])
  // A new page closes it.
  useEffect(() => setOpen(false), [location.pathname, location.search])
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (!opensPalette(event, event.target as Element | null)) return
      event.preventDefault()
      show()
    }
    document.addEventListener("keydown", shortcut)
    return () => document.removeEventListener("keydown", shortcut)
  }, [show])
  const label = withStocks ? "Search savings, funds, stocks and pages" : "Search savings, funds and pages"
  return (
    <div className="relative w-full">
      <button ref={button} type="button" aria-label={label} aria-haspopup="dialog" aria-expanded={open} onClick={show} className="flex size-9 items-center justify-center rounded-lg border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] text-[var(--color-arco-ink)] sm:hidden">
        <Search aria-hidden="true" size={18} />
      </button>
      <button
        ref={field}
        type="button"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-keyshortcuts={SEARCH_SHORTCUT_KEY}
        onClick={show}
        className="hidden h-9 w-full items-center gap-2 rounded-lg border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] px-3 text-left hover:border-[var(--color-arco-muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-arco-ink)] sm:flex"
      >
        <Search aria-hidden="true" size={16} className="shrink-0 text-[var(--color-arco-muted)]" />
        <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--color-arco-muted)]">{PLACEHOLDER}</span>
        <Keycap label={`Shortcut ${SEARCH_SHORTCUT_KEY}`}>{SEARCH_SHORTCUT_KEY}</Keycap>
      </button>
      {open && <SearchPalette onClose={close} />}
    </div>
  )
}

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect

function SearchPalette({ onClose }: { onClose: () => void }) {
  const id = useId()
  const dialog = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const [query, setQuery] = useState("")
  const [fundsExpanded, setFundsExpanded] = useState(false)
  const [cursor, setCursor] = useState(0)

  // The data: the Savings page's accounts and the Funds page's lineup (the same functions those pages use), Stocks
  // while features.ts shows them, the pages and the actions.
  const catalog = useQuery({ queryKey: ["giwa", "catalog"], queryFn: giwaApi.catalog })
  const market = useQuery({ queryKey: ["giwa", "market", GIWA_CHAIN_ID], queryFn: () => giwaApi.market(GIWA_CHAIN_ID) })
  const live = useContext(ArcoUsdLiveContext)
  const livePending = useContext(ArcoUsdLivePendingContext)
  const liveFailed = useContext(ArcoUsdLiveFailedContext)
  const gold = useContext(ArcoGoldLiveContext)
  const convert = useGetArcoUsd()
  const environment = useContext(StocksPageEnvironment)
  const { stocks: withStocks } = useContext(GiwaFeaturesContext)
  const pageApiBase = usePageApiBase()
  // Hidden Stocks: nothing is read for them, and no "Stocks are temporarily unavailable" note.
  const apiBase = withStocks ? pageApiBase : null
  const client = useMemo(() => (apiBase ? createMarketClient(apiBase, environment.fetch) : null), [apiBase, environment.fetch])
  const loadCatalog = useCallback((signal: AbortSignal) => (client ? client.catalog(signal) : Promise.resolve(null)), [client])
  const stocks = useOwnedRead(apiBase ?? "disabled", loadCatalog)
  const securities = stocks.phase === "ready" ? stocks.value?.data?.securities : undefined
  const loadQuotes = useCallback((signal: AbortSignal) => (client && securities?.length ? client.quotes(securities.map((stock) => stock.symbol), signal) : Promise.resolve(null)), [client, securities])
  const quotes = useOwnedRead(apiBase ?? "disabled", loadQuotes)

  const savings = useMemo(
    () => (catalog.data && market.data ? savingsItems(savingsOffers(savingsPageAccounts({ catalog: catalog.data, market: market.data, live, gold }))) : []),
    [catalog.data, market.data, live, gold],
  )
  const funds = useMemo(() => fundItems(FUNDS_LINEUP), [])
  const stockRows = useMemo(() => stockItems(securities ?? [], quotes.phase === "ready" ? quotes.value?.data ?? [] : []), [securities, quotes])
  // The Savings page's categories: Gold only while the live gold account is (as the rail's Savings flyout).
  const categories = useMemo(() => SAVINGS_CATEGORIES.filter((category) => category.id !== "gold" || gold !== null), [gold])
  const pages = useMemo(() => pageItems(categories), [categories])
  const categoryRows = useMemo(() => categoryItems(categories), [categories])
  const actions = useMemo(() => paletteActions({ convert: convert !== null }), [convert])
  const { sections, empty } = paletteSections({ savings, funds, stocks: stockRows, pages, categories: categoryRows, actions, query, fundsExpanded })

  // The rows the cursor moves through, in order: every listed row, and "Show all N funds" after the funds.
  type Row = { key: string; item: PaletteItem | null; showAll?: number }
  const rows: Row[] = sections.flatMap((section) => [
    ...section.items.map((item) => ({ key: item.id, item })),
    ...(section.hidden > 0 ? [{ key: "show-all-funds", item: null, showAll: section.total }] : []),
  ])
  const at = rows.length ? Math.min(cursor, rows.length - 1) : -1
  useEffect(() => setCursor(0), [query])
  const optionId = (index: number) => `${id}-option-${index}`

  const loading = catalog.isLoading || market.isLoading || (livePending && liveFailed === null) || (withStocks && stocks.phase === "loading")
  const savingsError = catalog.isError || market.isError
  const stockError = withStocks && (stocks.phase === "error" || (stocks.phase === "ready" && !stocks.value?.data))

  const activate = (row: Row | undefined) => {
    if (!row) return
    if (row.showAll !== undefined) {
      setFundsExpanded(true)
      return
    }
    const target = row.item!.target
    if (target.kind === "link") {
      navigate(target.href)
      onClose()
    } else if (target.kind === "external") {
      window.open(target.href, "_blank", "noopener,noreferrer")
      onClose()
    } else if (target.action === "convert") {
      onClose()
      convert?.()
    }
  }

  // Open: focus the input; the page behind does not scroll.
  useEffect(() => {
    input.current?.focus({ preventScroll: true })
    const previous = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = previous
    }
  }, [])
  // The cursor's row stays in view.
  useIsomorphicLayoutEffect(() => {
    if (at >= 0) document.getElementById(optionId(at))?.scrollIntoView?.({ block: "nearest" })
  }, [at])
  // Escape, and Tab kept inside, in the capture phase (so the shell's own Escape handlers do not see it).
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const root = dialog.current
      if (!root) return
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        onCloseRef.current()
        return
      }
      if (event.key !== "Tab") return
      const focusable = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => element.offsetParent !== null || element === input.current)
      if (focusable.length === 0) return
      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      const active = document.activeElement
      const inside = active !== null && root.contains(active)
      if (!inside || (event.shiftKey ? active === first : active === last)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      }
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [])

  const onInputKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && rows.length) {
      event.preventDefault()
      setCursor((value) => (Math.min(value, rows.length - 1) + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length)
    } else if (event.key === "Enter" && rows.length) {
      event.preventDefault()
      activate(rows[at >= 0 ? at : 0])
    }
  }

  let index = -1
  const rowProps = (item: PaletteItem | null, showAll?: number) => {
    index += 1
    const own = index
    return { id: optionId(own), active: own === at, onHover: () => setCursor(own), onActivate: () => activate({ key: item?.id ?? "show-all-funds", item, showAll }) }
  }

  return createPortal(
    <div className="arco-demo">
      <div
        className="fixed inset-0 z-[70] bg-[var(--color-arco-surface)] xl:bg-[var(--color-arco-overlay)] xl:backdrop-blur-[5px]"
        onMouseDown={(event) => {
          if (event.target !== event.currentTarget) return
          event.preventDefault()
          onClose()
        }}
      >
        <div
          ref={dialog}
          role="dialog"
          aria-modal="true"
          aria-label="Search"
          data-testid="search-palette"
          className="flex h-full w-full flex-col bg-[var(--color-arco-surface)] pt-[env(safe-area-inset-top)] xl:absolute xl:left-1/2 xl:top-[92px] xl:h-auto xl:max-h-[calc(100dvh-132px)] xl:w-[640px] xl:max-w-[calc(100vw-32px)] xl:-translate-x-1/2 xl:overflow-hidden xl:rounded-[14px] xl:pt-0 xl:shadow-[var(--shadow-savings-popover)]"
        >
          <div className="flex shrink-0 items-center gap-2.5 border-b border-[var(--color-arco-border)] px-4 pb-2.5 pt-2.5 xl:h-[60px] xl:gap-3 xl:px-[18px] xl:py-0">
            <div className="flex h-[42px] min-w-0 flex-1 items-center gap-2 rounded-xl bg-[var(--color-arco-chip)] px-3 xl:h-auto xl:gap-3 xl:rounded-none xl:bg-transparent xl:px-0">
              <Search aria-hidden="true" className="size-[18px] shrink-0 text-[var(--color-arco-muted-text)] xl:size-5" />
              <input
                ref={input}
                role="combobox"
                aria-label={withStocks ? "Search savings, funds, stocks and pages" : "Search savings, funds and pages"}
                aria-expanded="true"
                aria-controls={`${id}-list`}
                aria-autocomplete="list"
                aria-activedescendant={at >= 0 ? optionId(at) : undefined}
                autoComplete="off"
                spellCheck={false}
                value={query}
                placeholder={PLACEHOLDER}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onInputKey}
                className="min-w-0 flex-1 bg-transparent text-base text-[var(--color-arco-ink)] outline-none placeholder:text-[var(--color-arco-muted)] xl:text-[17px]"
              />
            </div>
            <span className="hidden xl:inline-flex">
              <Keycap label={`Shortcut ${SEARCH_SHORTCUT_KEY}`}>{SEARCH_SHORTCUT_KEY}</Keycap>
            </span>
            <button type="button" onClick={onClose} className="shrink-0 px-1 text-base font-medium text-[var(--color-arco-chart-1)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-arco-ink)] xl:hidden">
              Cancel
            </button>
          </div>

          <div ref={list} id={`${id}-list`} role="listbox" aria-label="Search results" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-[calc(8px+env(safe-area-inset-bottom))] pt-1.5 xl:pb-2">
            {empty && (
              <div data-testid="search-empty" className="flex flex-col items-center gap-1.5 px-4 pb-[18px] pt-7 text-center">
                <span aria-hidden="true" className="grid size-10 place-items-center rounded-full bg-[var(--color-arco-chip)] text-[var(--color-arco-muted)]">
                  <Search size={18} />
                </span>
                <b className="text-[15.5px] font-medium text-[var(--color-arco-ink)]">No results for “{query.trim()}”</b>
                <span className="text-[13px] text-[var(--color-arco-muted-text)]">Try a coin, a fund or a fund manager, like “BTC” or “Bitwise”.</span>
              </div>
            )}
            {sections.map((section) => (
              <div key={section.id} role="group" aria-labelledby={`${id}-${section.id}`} data-section={section.id}>
                <div id={`${id}-${section.id}`} className="flex items-center gap-1.5 px-3 pb-1.5 pt-3 text-xs font-medium text-[var(--color-arco-chip-ink)]">
                  {section.label}
                  {section.counted && <span className="text-[11px] font-normal text-[var(--color-arco-muted)]">{section.total}</span>}
                </div>
                {section.items.map((item) => (
                  <PaletteRow key={item.id} item={item} query={query} {...rowProps(item)} />
                ))}
                {section.hidden > 0 && <ShowAllRow total={section.total} {...rowProps(null, section.total)} />}
              </div>
            ))}
            {(loading || savingsError || stockError) && (
              <p role="status" className="px-3 py-2 text-xs text-[var(--color-arco-muted)]">
                {loading ? "Loading products…" : [savingsError ? "Savings are temporarily unavailable." : "", stockError ? "Stocks are temporarily unavailable." : ""].filter(Boolean).join(" ")}
              </p>
            )}
          </div>

          <div data-testid="search-keys" aria-hidden="true" className="hidden h-11 shrink-0 items-center gap-4 border-t border-[var(--color-arco-border)] bg-[var(--color-arco-page)] px-4 text-[12.5px] text-[var(--color-arco-chip-ink)] xl:flex">
            <span className="inline-flex items-center gap-1">
              <Keycap><ArrowUp size={12} /></Keycap>
              <Keycap><ArrowDown size={12} /></Keycap>
              <span className="ml-1">Move</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Keycap><CornerDownLeft size={12} /></Keycap>
              Enter
            </span>
            <span className="flex-1" />
            <span className="inline-flex items-center gap-1.5">
              <Keycap>Esc</Keycap>
              Close
            </span>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

const ROW = "flex w-full items-center gap-3 rounded-[10px] px-3 text-left outline-none"
const rowTone = (active: boolean) => (active ? "bg-[var(--color-arco-chip)]" : "hover:bg-[var(--color-row-hover-weak)] active:bg-[var(--color-arco-border)]")

function Highlight({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlightParts(text, query).map((part, index) =>
        part.match ? (
          <mark key={index} className="bg-transparent font-bold text-inherit">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  )
}

// Convert carries the rail's own glyph (lucide Replace), in the same tile as the pages.
const ICONS: Record<PaletteIcon, typeof Search> = { savings: PiggyBank, funds: Layers, portfolio: ChartPie, docs: BookOpen, terms: FileText, convert: Replace }

function RowMark({ item }: { item: PaletteItem }) {
  if (item.icon) {
    const Icon = ICONS[item.icon]
    return (
      <span className="grid size-[30px] shrink-0 place-items-center rounded-lg bg-[var(--color-arco-chip)] text-[var(--color-arco-text-soft)]">
        <Icon size={18} strokeWidth={1.8} />
      </span>
    )
  }
  return <BrandMark src={item.image} label={item.title} size={30} />
}

function PaletteRow({ item, query, id, active, onHover, onActivate }: { item: PaletteItem; query: string; id: string; active: boolean; onHover: () => void; onActivate: () => void }) {
  const body = (
    <>
      <span aria-hidden="true">
        <RowMark item={item} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[15.5px] leading-5 text-[var(--color-arco-ink)]">
          <Highlight text={item.title} query={query} />
          {item.note && (
            <span className="text-[var(--color-arco-chip-ink)]">
              {" · "}
              <Highlight text={item.note} query={query} />
            </span>
          )}
        </span>
        {item.subtitle && (
          <span className="truncate text-[12.5px] leading-4 text-[var(--color-arco-muted-text)]">
            <Highlight text={item.subtitle} query={query} />
          </span>
        )}
      </span>
      {item.value !== undefined && (
        <span className="flex shrink-0 flex-col items-end gap-0.5 text-right tabular-nums">
          <span className={`text-[15px] font-medium leading-5 ${item.section === "stocks" ? "text-[var(--color-arco-ink)]" : "text-[var(--color-arco-up-text)]"}`}>{item.value}</span>
          {item.valueLabel && <span className="text-xs leading-4 text-[var(--color-arco-muted-text)]">{item.valueLabel}</span>}
          {item.change && <span className={`text-xs leading-4 ${item.negative ? "text-[var(--color-arco-down)]" : "text-[var(--color-arco-up-text)]"}`}>{item.change}</span>}
        </span>
      )}
      {item.target.kind === "external" && (
        <span aria-hidden="true" className="shrink-0 text-[var(--color-arco-muted)]">
          <ArrowUpRight size={16} />
        </span>
      )}
    </>
  )
  const common = {
    id,
    role: "option",
    "aria-selected": active,
    tabIndex: -1,
    "data-row": item.id,
    onMouseMove: onHover,
    className: `${ROW} min-h-14 py-2 ${rowTone(active)}`,
  } as const
  if (item.target.kind === "link") {
    return (
      <Link {...common} to={item.target.href} onClick={(event) => { event.preventDefault(); onActivate() }}>
        {body}
      </Link>
    )
  }
  if (item.target.kind === "external") {
    return (
      <a {...common} href={item.target.href} target="_blank" rel="noopener noreferrer" onClick={(event) => { event.preventDefault(); onActivate() }}>
        {body}
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    )
  }
  return (
    <button type="button" {...common} onClick={onActivate}>
      {body}
    </button>
  )
}

function ShowAllRow({ total, id, active, onHover, onActivate }: { total: number; id: string; active: boolean; onHover: () => void; onActivate: () => void }) {
  return (
    <button type="button" id={id} role="option" aria-selected={active} tabIndex={-1} data-row="show-all-funds" onMouseMove={onHover} onClick={onActivate} className={`${ROW} h-10 gap-2 pl-[54px] text-[13.5px] font-medium text-[var(--color-arco-chart-1)] ${rowTone(active)}`}>
      Show all {total} funds
      <ArrowRight aria-hidden="true" size={14} />
    </button>
  )
}
