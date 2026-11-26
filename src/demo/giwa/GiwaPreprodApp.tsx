import { useRef } from "react"
import { Link, Outlet } from "react-router-dom"
import { GiwaHeader, TestFundsButton, useGiwaIsAdmin } from "./components"
import { ArcoUsdLiveProvider } from "./arcousd-live-context"
import { ArcoGoldLiveProvider } from "./arcogold-live-context"
import { GetArcoUsdProvider } from "./GetArcoUsd"
import { Footer } from "../components/Footer"
import { GIWA_FOOTER_LINKS } from "./footer-links"
import { INVESTOR_NAV_ADMIN_ITEM } from "./investor-nav"
import { GiwaBottomTabBar, GiwaNavRail } from "./GiwaNavRail"
import { GiwaAutoSwitch } from "./wallet-network"

// Investor shell. From xl: the 92px icon rail on the page grey and, right of it, the content panel (top bar, page,
// footer) with a rounded top-left corner. Below xl: the top bar, the page and a tab bar fixed to the bottom of the
// screen. Admin uses the same shell (no Mint test assets, no Convert).
//
// --giwa-tab-bar-space is the room the bottom tab bar takes (below xl; none from xl): kept after the footer, and read
// by a page's own fixed bottom bar (the product Invest/Redeem dock, the Stocks dock) to sit above it.
export function GiwaPreprodApp({ admin = false }: { admin?: boolean }) {
  const isAdmin = useGiwaIsAdmin()
  const mainRef = useRef<HTMLElement>(null)

  return (
    // The live ArcoUSD v1 contracts for Get ArcoUSD and the sArcoUSD Savings account (a preview's demo chain keeps its own),
    // and the live ArcoGOLD contracts for the gold Savings account (outside, so it sees a preview host's routes).
    <ArcoGoldLiveProvider enabled={!admin}>
    <ArcoUsdLiveProvider enabled={!admin}>
    <GetArcoUsdProvider enabled={!admin}>
      <div className="arco-demo min-h-screen bg-[var(--color-arco-page)] text-foreground [--giwa-tab-bar-space:calc(4rem+env(safe-area-inset-bottom))] xl:pl-[92px] xl:pt-2 xl:[--giwa-tab-bar-space:0px]">
        {/* First focusable element. A button (not an #anchor) because a hash router hosts this shell in preview. */}
        <button
          type="button"
          onClick={() => mainRef.current?.focus()}
          className="sr-only rounded-md bg-[var(--color-arco-ink)] text-sm font-medium text-[var(--color-arco-on-dark)] focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:px-4 focus:py-2"
        >
          Skip to content
        </button>
        <GiwaNavRail isAdmin={isAdmin} testFunds={admin ? undefined : <TestFundsButton look="rail" />} />
        {/* The content panel. Each page keeps its own background inside it (the page grey its white cards are drawn on);
            from xl the panel adds only its frame: the rounded top-left corner and a hairline against the rail's grey. */}
        <div
          data-shell-panel=""
          className="xl:rounded-tl-[var(--radius-funds-hero)] xl:border-l xl:border-t xl:border-[var(--color-arco-border)] xl:bg-[var(--color-arco-page)]"
        >
          {/* A page may publish --giwa-dock-space for a fixed bottom bar of its own (the Stocks NVDA dock): the room is kept
              here, after the footer, because the bar covers the bottom of the viewport and padding inside <main> would leave
              the footer under it. Unset on every other page, so the shell is unchanged. */}
          <div className="flex min-h-screen min-w-0 flex-col pb-[var(--giwa-dock-space,0px)] xl:min-h-[calc(100vh-8px)]">
            <GiwaHeader />
            <main
              ref={mainRef}
              id="giwa-main"
              tabIndex={-1}
              className="mx-auto w-full max-w-[1512px] flex-1 scroll-mt-[77px] px-4 py-8 md:px-8 focus:outline-none"
            >
              <Outlet />
            </main>
            <GiwaShellFooter isAdmin={isAdmin} />
          </div>
          <div aria-hidden="true" className="h-[var(--giwa-tab-bar-space)] xl:hidden" />
        </div>
        <GiwaBottomTabBar testFunds={admin ? undefined : <TestFundsButton look="bar" />} />
        {/* A wallet that connects on another network is asked once to switch to GIWA (the admin console keeps its own gate). */}
        {!admin && <GiwaAutoSwitch />}
      </div>
    </GetArcoUsdProvider>
    </ArcoUsdLiveProvider>
    </ArcoGoldLiveProvider>
  )
}

/**
 * The page footer with Terms of Use and Documentation, and Admin for allowlisted wallets below xl (VISIBILITY only, as
 * the rail's Admin tab; from xl that tab is the way in). Phones reach these here: the top bar has no menu.
 */
export function GiwaShellFooter({ isAdmin }: { isAdmin: boolean }) {
  return (
    <Footer
      links={GIWA_FOOTER_LINKS}
      trailing={
        isAdmin ? (
          <Link
            to={INVESTOR_NAV_ADMIN_ITEM.to}
            className="text-sm text-[var(--color-arco-muted)] transition-colors hover:text-[var(--color-arco-ink)] xl:hidden"
          >
            {INVESTOR_NAV_ADMIN_ITEM.label}
          </Link>
        ) : undefined
      }
    />
  )
}
