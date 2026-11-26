import { type ComponentProps, useEffect, useRef, useState } from "react"
import { X } from "lucide-react"
import { GiwaInvestPanel } from "./components"

// Mobile-only (lg:hidden) Invest/Redeem dock for the product detail: a sticky bottom bar whose
// two buttons open a slide-up bottom sheet hosting the SAME GiwaInvestPanel (single hook/logic
// source — no duplicated invest/redeem logic). The desktop side panel (>= lg) is unchanged.
//
// Props mirror GiwaInvestPanel exactly (spread the same `panel` object + instantLiquidityUsd +
// baseUsd the aside receives); `variant` is fixed to "sheet" here.
type GiwaInvestDockProps = Omit<ComponentProps<typeof GiwaInvestPanel>, "variant">

const SLIDE_MS = 300
// calc(env(...)) needs real spaces, so it is applied via inline style rather than a Tailwind
// arbitrary value (which would collapse/escape the spaces).
const SAFE_AREA_PB = "calc(env(safe-area-inset-bottom) + 0.75rem)"
// The room the shell's bottom tab bar takes below xl (none outside the shell).
const TAB_BAR_SPACE = "var(--giwa-tab-bar-space, 0px)"
// The bar's own height (its buttons, padding and the safe area), kept after the shell's footer while it shows.
const DOCK_SPACE_PROPERTY = "--giwa-dock-space"
const DOCK_SPACE = "calc(env(safe-area-inset-bottom) + 4.5rem)"
const DOCK_QUERY = "(max-width: 1023.98px)"

export function GiwaInvestDock(props: GiwaInvestDockProps) {
  // `open` = sheet mounted; `visible` drives the slide/fade (flipped one frame after mount so
  // the transition runs). Closed by default => SSR renders no second panel (detail-page tests
  // stay green), and the desktop aside remains the only rendered panel until a tap.
  const [open, setOpen] = useState(false)
  const [visible, setVisible] = useState(false)
  const closeTimer = useRef<number | null>(null)

  useEffect(() => {
    if (!open) return
    const raf = requestAnimationFrame(() => setVisible(true))
    return () => cancelAnimationFrame(raf)
  }, [open])

  // While the bar shows (below lg) it covers the bottom of the viewport: tell the shell to keep its room after the page
  // footer (--giwa-dock-space, as the Stocks dock does), so the footer's links are never under it.
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return
    const style = document.documentElement.style
    const before = style.getPropertyValue(DOCK_SPACE_PROPERTY)
    const query = window.matchMedia(DOCK_QUERY)
    const apply = () => {
      if (query.matches) style.setProperty(DOCK_SPACE_PROPERTY, DOCK_SPACE)
      else if (before) style.setProperty(DOCK_SPACE_PROPERTY, before)
      else style.removeProperty(DOCK_SPACE_PROPERTY)
    }
    apply()
    query.addEventListener?.("change", apply)
    return () => {
      query.removeEventListener?.("change", apply)
      if (before) style.setProperty(DOCK_SPACE_PROPERTY, before)
      else style.removeProperty(DOCK_SPACE_PROPERTY)
    }
  }, [])

  // Body-scroll lock while the sheet is mounted.
  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = previous
    }
  }, [open])

  useEffect(
    () => () => {
      if (closeTimer.current) window.clearTimeout(closeTimer.current)
    },
    [],
  )

  // Preset the tab through the panel's EXISTING operation control (no new tab logic), then open.
  function openWith(operation: "deposit" | "redeemInstant") {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
    props.onOperationChange(operation)
    setOpen(true)
  }

  function close() {
    setVisible(false) // slide down + fade
    closeTimer.current = window.setTimeout(() => {
      setOpen(false)
      closeTimer.current = null
    }, SLIDE_MS)
  }

  return (
    <div className="lg:hidden">
      {/* Sticky bottom bar, above the shell's bottom tab bar (--giwa-tab-bar-space, GiwaPreprodApp). */}
      <div
        className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--color-arco-border)] bg-[var(--color-arco-page-80)] px-4 pt-3 backdrop-blur"
        style={{ bottom: TAB_BAR_SPACE, paddingBottom: SAFE_AREA_PB }}
      >
        <div className="mx-auto flex w-full max-w-[var(--container-page)] gap-3">
          <button
            type="button"
            onClick={() => openWith("deposit")}
            className="flex-1 rounded-[var(--radius-card)] border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] py-3 text-sm font-medium text-[var(--color-arco-ink)]"
          >
            Invest
          </button>
          <button
            type="button"
            onClick={() => openWith("redeemInstant")}
            className="flex-1 rounded-[var(--radius-card)] bg-[var(--color-arco-ink)] py-3 text-sm font-medium text-[var(--color-arco-on-dark)]"
          >
            Redeem
          </button>
        </div>
      </div>

      {open && (
        <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Invest or redeem">
          {/* Backdrop — tap to dismiss */}
          <button
            type="button"
            aria-label="Close"
            onClick={close}
            className={`absolute inset-0 bg-[var(--color-arco-overlay)] transition-opacity duration-300 ${visible ? "opacity-100" : "opacity-0"}`}
          />
          {/* Sheet */}
          <div
            className={`absolute inset-x-0 bottom-0 flex max-h-[90vh] flex-col rounded-t-[var(--radius-strategy)] bg-[var(--color-arco-page)] transition-transform duration-300 ${
              visible ? "translate-y-0" : "translate-y-full"
            }`}
            style={{ boxShadow: "var(--shadow-control)" }}
          >
            {/* Drag handle + close */}
            <div className="relative flex shrink-0 items-center justify-center pb-1 pt-3">
              <span className="h-1 w-10 rounded-[var(--radius-pill)] bg-[var(--color-arco-border)]" />
              <button
                type="button"
                onClick={close}
                aria-label="Close"
                className="absolute right-3 top-2 inline-flex size-8 items-center justify-center rounded-[var(--radius-pill)] text-[var(--color-arco-muted)] hover:bg-[var(--color-arco-chip)] hover:text-[var(--color-arco-ink)]"
              >
                <X className="size-4" />
              </button>
            </div>
            {/* Scrollable panel host — the SAME GiwaInvestPanel, sheet variant */}
            <div className="overflow-y-auto px-3" style={{ paddingBottom: SAFE_AREA_PB }}>
              <GiwaInvestPanel {...props} variant="sheet" />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
