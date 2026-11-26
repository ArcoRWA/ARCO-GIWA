import type { ReactNode } from "react"
import { BookOpen, FileText } from "lucide-react"
import { GIWA_FOOTER_LINKS } from "./footer-links"

// Shared looks of the shell nav: the desktop rail and the phone tab bar (GiwaNavRail), and Mint test assets in both
// (components.tsx). A leaf module, so none of them forms an import cycle.

export const NAV_FOCUS =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)]"

/** The footer's links (footer-links.ts, same targets) in the order the rail shows them, with icons. */
export const NAV_DOC_LINKS = [
  { label: "Documentation", Icon: BookOpen },
  { label: "Terms of Use", Icon: FileText },
].flatMap(({ label, Icon }) => {
  const link = GIWA_FOOTER_LINKS.find((entry) => entry.label === label)
  return link ? [{ ...link, Icon }] : []
})

/** A rail item: a 20px icon over a 13px label, 76×56 (the tabs, and the Convert and Mint actions). */
export const RAIL_TAB =
  "flex min-h-14 w-[76px] flex-col items-center justify-center gap-[5px] rounded-[var(--radius-card)] px-0.5 pb-[7px] pt-2 text-center text-[13px] leading-[1.15]"

/**
 * A phone tab bar item: equal-width columns (five fit from 320px), the 20px icon in a 30px-high slot (the current page's
 * pill) over a 12px label. With Home and Stocks on (six or seven items) the slot narrows with the column and a label
 * that no longer fits is cut with an ellipsis rather than pushing the bar sideways.
 */
export const BAR_ITEM = "flex min-h-[54px] w-full min-w-0 flex-col items-center gap-0.5 rounded-[var(--radius-card)] pt-1 text-xs"
export const BAR_ICON_SLOT = "flex h-[30px] w-full max-w-14 items-center justify-center rounded-[var(--radius-pill)]"
export const BAR_LABEL = "max-w-full truncate px-0.5"

/** An icon-only utility at the bottom of the desktop rail (Documentation, Terms of Use). */
export const RAIL_UTILITY = `group relative flex size-10 items-center justify-center rounded-[var(--radius-row)] text-[var(--color-arco-muted-text)] hover:bg-[var(--color-row-hover-weak)] hover:text-[var(--color-arco-ink)] ${NAV_FOCUS}`

/** The name a rail utility shows on hover or keyboard focus, to its right (the button carries the accessible name). */
export function RailTooltip({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute left-[calc(100%+12px)] top-1/2 z-50 hidden -translate-y-1/2 whitespace-nowrap rounded-[var(--radius-card)] bg-[var(--color-arco-ink)] px-2.5 py-1.5 text-[13px] font-medium text-[var(--color-arco-on-dark)] shadow-[var(--shadow-savings-popover)] group-hover:block group-focus-visible:block"
    >
      {children}
    </span>
  )
}
