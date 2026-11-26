import { useContext, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react"
import { Link, useLocation } from "react-router-dom"
import { ChartCandlestick, ChartPie, House, Layers, PiggyBank, Replace, Send, ShieldCheck, type LucideIcon } from "lucide-react"
import { SAVINGS_CATEGORIES, savingsCategoryFromSearch, savingsCategoryPath } from "./savings-category"
import { ArcoGoldLiveContext } from "./arcogold-live-context"
import { investorNavItems, isNavItemActive, type InvestorNavItem, type InvestorNavItemId } from "./investor-nav"
import { GiwaFeaturesContext } from "./features"
import { useGetArcoUsd } from "./GetArcoUsd"
import { GIWA_PREPROD_ROUTE, GIWA_SAVINGS_ROUTE } from "./routes"
import { BAR_ICON_SLOT, BAR_ITEM, BAR_LABEL, NAV_DOC_LINKS, NAV_FOCUS, RAIL_TAB, RAIL_UTILITY, RailTooltip } from "./nav-ui"

// The investor shell's navigation. From xl: a 92px icon rail on the page grey (GiwaNavRail): the Arco mark, the page
// tabs with Convert after a divider (centred between the mark and the utilities), and icon-only utilities at the
// bottom. Below xl: a tab bar fixed to the bottom of the screen (GiwaBottomTabBar). Routes are real links with
// aria-current; Convert is an action (it opens Get ArcoUSD's screen), never a current page.

const ICONS: Record<InvestorNavItemId, LucideIcon> = {
  home: House,
  savings: PiggyBank,
  funds: Layers,
  stocks: ChartCandlestick,
  portfolio: ChartPie,
  send: Send,
  admin: ShieldCheck,
}

/** Pointer travel time from the Savings tab into its flyout before the flyout closes. */
const FLYOUT_GRACE_MS = 150

/**
 * Whether the Savings page has a gold account: the live ArcoGOLD account the shell's ArcoGoldLiveProvider reads from the
 * gold API (/api/v1/arcogold/reserve and /savings), the same context the Savings page builds its gold account from. The
 * gold account is never in the Vault Config catalog; it is made client-side from those reads (arcogold-live.ts). Until
 * both reads answer "live" (not deployed, unavailable, a failed read, a host with its own routes, or no provider at all)
 * the context is null and the Gold category stays hidden.
 */
function useSavingsCategories() {
  const hasGold = useContext(ArcoGoldLiveContext) !== null
  // Gold is listed only while the live gold account is (Stablecoins and Crypto always are).
  return SAVINGS_CATEGORIES.filter((category) => category.id !== "gold" || hasGold)
}

const TAB_IDLE = "text-[var(--color-arco-muted-text)] hover:bg-[var(--color-row-hover-weak)] hover:text-[var(--color-arco-text-soft)]"
const TAB_ACTIVE = "bg-[var(--color-arco-chip)] font-semibold text-[var(--color-arco-ink)]"

function TabIcon({ id, active, size }: { id: InvestorNavItemId; active: boolean; size: number }) {
  const Icon = ICONS[id]
  // The current page's icon is filled.
  return <Icon aria-hidden="true" size={size} strokeWidth={1.8} fill={active ? "currentColor" : "none"} className="shrink-0" />
}

/** Convert: the swap glyph (two offset squares with corner arrows) over its label, in ink. Opens Get ArcoUSD's screen; only where there are converters. */
function ConvertItem({ look }: { look: "rail" | "bar" }) {
  const open = useGetArcoUsd()
  if (open === null) return null
  const rail = look === "rail"
  return (
    <button
      type="button"
      aria-label="Convert to ArcoUSD"
      aria-haspopup="dialog"
      onClick={open}
      className={
        rail
          ? `${RAIL_TAB} font-medium text-[var(--color-arco-ink)] hover:bg-[var(--color-row-hover-weak)] ${NAV_FOCUS}`
          : `${BAR_ITEM} font-medium text-[var(--color-arco-ink)] ${NAV_FOCUS}`
      }
    >
      {rail ? (
        <Replace aria-hidden="true" size={20} strokeWidth={1.8} className="shrink-0" />
      ) : (
        // The tab bar's icon slot, as the page tabs have it.
        <span className={BAR_ICON_SLOT}>
          <Replace aria-hidden="true" size={20} strokeWidth={1.8} className="shrink-0" />
        </span>
      )}
      {rail ? "Convert" : <span className={BAR_LABEL}>Convert</span>}
    </button>
  )
}

/** The Savings tab with its flyout of Savings categories (pointer and keyboard; never on touch). */
function SavingsRailTab({ item, active }: { item: InvestorNavItem; active: boolean }) {
  const { pathname, search } = useLocation()
  const categories = useSavingsCategories()
  const current = pathname === GIWA_SAVINGS_ROUTE ? savingsCategoryFromSearch(new URLSearchParams(search)) : null
  const flyoutId = useId()
  const [open, setOpen] = useState(false)
  const [top, setTop] = useState(0)
  const tabRef = useRef<HTMLAnchorElement>(null)
  const flyoutRef = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<number | null>(null)
  const touched = useRef(false)
  const returning = useRef(false)
  const focusFirst = useRef(false)

  function cancelClose() {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    closeTimer.current = null
  }
  function show() {
    cancelClose()
    // The flyout is fixed (the rail's middle scrolls on a short screen and would clip it): beside the tab.
    setTop(Math.max(8, tabRef.current?.getBoundingClientRect().top ?? 0))
    setOpen(true)
  }
  function hide() {
    cancelClose()
    setOpen(false)
  }
  function hideSoon() {
    cancelClose()
    closeTimer.current = window.setTimeout(hide, FLYOUT_GRACE_MS)
  }
  const links = () => [...(flyoutRef.current?.querySelectorAll<HTMLElement>("a[href]") ?? [])]

  // Navigation closes it.
  useEffect(() => hide(), [pathname, search])
  useEffect(() => () => cancelClose(), [])
  useEffect(() => {
    if (open && focusFirst.current) {
      focusFirst.current = false
      links()[0]?.focus()
    }
  }, [open])

  function onTabKeyDown(event: ReactKeyboardEvent) {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault()
      focusFirst.current = true
      show()
      if (open) {
        focusFirst.current = false
        links()[0]?.focus()
      }
    } else if (event.key === "Escape" && open) {
      event.preventDefault()
      hide()
    }
  }
  function onFlyoutKeyDown(event: ReactKeyboardEvent) {
    const all = links()
    const index = all.indexOf(document.activeElement as HTMLElement)
    if (event.key === "Escape" || event.key === "ArrowLeft") {
      event.preventDefault()
      hide()
      // Back on the tab with the flyout closed (that focus does not reopen it).
      returning.current = true
      tabRef.current?.focus()
      returning.current = false
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      const step = event.key === "ArrowDown" ? 1 : -1
      all[(index + step + all.length) % all.length]?.focus()
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault()
      all[event.key === "Home" ? 0 : all.length - 1]?.focus()
    }
  }

  return (
    <li
      // Focus leaving both the tab and the flyout closes it.
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) hide()
      }}
    >
      <Link
        ref={tabRef}
        to={item.to}
        aria-current={active ? "page" : undefined}
        aria-expanded={open}
        aria-controls={flyoutId}
        onPointerDown={(event) => {
          touched.current = event.pointerType === "touch"
        }}
        onPointerEnter={(event) => {
          if (event.pointerType !== "touch") show()
        }}
        onPointerLeave={(event) => {
          if (event.pointerType !== "touch") hideSoon()
        }}
        onFocus={() => {
          if (!touched.current && !returning.current) show()
        }}
        onBlur={() => {
          touched.current = false
        }}
        onKeyDown={onTabKeyDown}
        className={`${RAIL_TAB} ${NAV_FOCUS} ${active ? TAB_ACTIVE : open ? "bg-[var(--color-row-hover-weak)] text-[var(--color-arco-text-soft)]" : TAB_IDLE}`}
      >
        <TabIcon id={item.id} active={active} size={20} />
        {item.label}
      </Link>
      <div
        ref={flyoutRef}
        id={flyoutId}
        hidden={!open}
        onPointerEnter={cancelClose}
        onPointerLeave={(event) => {
          if (event.pointerType !== "touch") hideSoon()
        }}
        onKeyDown={onFlyoutKeyDown}
        style={{ top }}
        className="fixed left-[100px] z-50 w-[220px] rounded-[var(--radius-strategy)] bg-[var(--color-arco-surface)] p-2 shadow-[var(--shadow-savings-popover)]"
      >
        <p aria-hidden="true" className="px-2.5 pb-1 pt-1.5 text-xs text-[var(--color-arco-muted)]">
          {item.label}
        </p>
        <ul aria-label="Savings categories" className="space-y-0.5">
          {categories.map((category) => (
            <li key={category.id}>
              <Link
                to={savingsCategoryPath(category.id)}
                aria-current={current === category.id ? "location" : undefined}
                className={`flex min-h-10 items-center rounded-[var(--radius-card)] px-2.5 text-sm ${NAV_FOCUS} ${
                  current === category.id
                    ? "bg-[var(--color-arco-chip)] font-medium text-[var(--color-arco-ink)]"
                    : "text-[var(--color-arco-text-soft)] hover:bg-[var(--color-row-hover-weak)] hover:text-[var(--color-arco-ink)]"
                }`}
              >
                {category.label}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </li>
  )
}

/** `testFunds`: Mint test assets, the rail's Mint item under Convert (the shell passes it; none in the admin console). */
export function GiwaNavRail({ isAdmin, testFunds }: { isAdmin: boolean; testFunds?: ReactNode }) {
  const { pathname } = useLocation()
  const features = useContext(GiwaFeaturesContext)
  const convert = useGetArcoUsd()
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-[92px] flex-col items-center bg-[var(--color-arco-page)] pb-4 pt-[18px] xl:flex">
      <Link
        to={GIWA_PREPROD_ROUTE}
        aria-label="Arco home"
        className={`flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-card)] ${NAV_FOCUS}`}
      >
        <img src="/arco-icon.svg" alt="" className="h-[33px] w-[35px]" />
      </Link>
      {/* The tabs, Convert and Mint sit centred between the mark and the utilities; on a screen too short for them they
          start at the top and this part scrolls (auto margins never push content above the scroll start). */}
      <div className="mt-[18px] flex min-h-0 w-full flex-1 flex-col overflow-y-auto overflow-x-hidden">
        <div className="my-auto flex flex-col items-center gap-2 py-1">
          <nav aria-label="Main">
            <ul className="flex flex-col items-center gap-2">
              {investorNavItems(isAdmin, features).map((item) => {
                const active = isNavItemActive(item, pathname)
                if (item.id === "savings") return <SavingsRailTab key={item.id} item={item} active={active} />
                return (
                  <li key={item.id}>
                    <Link to={item.to} aria-current={active ? "page" : undefined} className={`${RAIL_TAB} ${NAV_FOCUS} ${active ? TAB_ACTIVE : TAB_IDLE}`}>
                      <TabIcon id={item.id} active={active} size={20} />
                      {item.label}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </nav>
          {/* The actions after a divider: Convert, then Mint (an action each, never the current page). */}
          {(convert !== null || testFunds) && <div aria-hidden="true" className="my-1 h-px w-10 bg-[var(--color-arco-border)]" />}
          {convert !== null && <ConvertItem look="rail" />}
          {testFunds}
        </div>
      </div>
      <div className="mt-2 flex shrink-0 flex-col items-center gap-1">
        {NAV_DOC_LINKS.map(({ label, href, Icon }) => (
          <a key={label} href={href} aria-label={label} className={RAIL_UTILITY}>
            <Icon aria-hidden="true" className="size-[18px]" />
            <RailTooltip>{label}</RailTooltip>
          </a>
        ))}
      </div>
    </aside>
  )
}

/**
 * Below xl: the page tabs, Convert and Mint (`testFunds`, which the shell passes; none in the admin shell), fixed to the
 * bottom of the screen in equal columns. Admin lives in the top bar's menu.
 */
export function GiwaBottomTabBar({ testFunds }: { testFunds?: ReactNode }) {
  const { pathname } = useLocation()
  const features = useContext(GiwaFeaturesContext)
  return (
    <nav
      aria-label="Tab bar"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] xl:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <ul className="mx-auto flex h-16 max-w-[560px] items-start px-1 pt-1.5 sm:px-2">
        {investorNavItems(false, features).map((item) => {
          const active = isNavItemActive(item, pathname)
          return (
            <li key={item.id} className="min-w-0 flex-1">
              <Link
                to={item.to}
                aria-current={active ? "page" : undefined}
                className={`${BAR_ITEM} ${NAV_FOCUS} ${active ? "font-semibold text-[var(--color-arco-ink)]" : "text-[var(--color-arco-muted-text)]"}`}
              >
                <span className={`${BAR_ICON_SLOT} ${active ? "bg-[var(--color-arco-chip)]" : ""}`}>
                  <TabIcon id={item.id} active={active} size={20} />
                </span>
                <span className={BAR_LABEL}>{item.label}</span>
              </Link>
            </li>
          )
        })}
        <ConvertBarSlot />
        {testFunds && <li className="min-w-0 flex-1">{testFunds}</li>}
      </ul>
    </nav>
  )
}

function ConvertBarSlot() {
  return useGetArcoUsd() === null ? null : (
    <li className="min-w-0 flex-1">
      <ConvertItem look="bar" />
    </li>
  )
}
