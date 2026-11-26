import {
  GIWA_ADMIN_ROUTE,
  GIWA_ADMIN_STOCKS_ROUTE,
  GIWA_FUNDS_ROUTE,
  GIWA_HOME_ROUTE,
  GIWA_PORTFOLIO_ROUTE,
  GIWA_SAVINGS_ROUTE,
  GIWA_STOCKS_ROUTE,
} from "./routes"
import { GIWA_FEATURES, type GiwaFeatures } from "./features"

// Investor shell navigation model, shared by the desktop icon rail and the phone tab bar. Pure (no React) so ordering,
// labels and active matching are unit-tested without rendering.

export type InvestorNavItemId = "home" | "savings" | "funds" | "stocks" | "portfolio" | "send" | "admin"

export type InvestorNavItem = {
  id: InvestorNavItemId
  label: string
  to: string
}

// The tabs in order. Home has its own route (the root opens Savings, where a visit starts); Send stays out of the
// menu until the feature and its route exist.
export const INVESTOR_NAV_ITEMS: readonly InvestorNavItem[] = [
  { id: "home", label: "Home", to: GIWA_HOME_ROUTE },
  { id: "savings", label: "Savings", to: GIWA_SAVINGS_ROUTE },
  { id: "funds", label: "Funds", to: GIWA_FUNDS_ROUTE },
  { id: "stocks", label: "Stocks", to: GIWA_STOCKS_ROUTE },
  { id: "portfolio", label: "Portfolio", to: GIWA_PORTFOLIO_ROUTE },
]

// VISIBILITY only (allowlisted wallets); the admin routes keep their own guard.
export const INVESTOR_NAV_ADMIN_ITEM: InvestorNavItem = { id: "admin", label: "Admin", to: GIWA_ADMIN_ROUTE }

/** The tabs as shown: a hidden section (features.ts) leaves them; Admin comes last, for allowlisted wallets only. */
export function investorNavItems(isAdmin: boolean, features: GiwaFeatures = GIWA_FEATURES): InvestorNavItem[] {
  const shown = (item: InvestorNavItem) => (item.id !== "home" || features.home) && (item.id !== "stocks" || features.stocks)
  return [...INVESTOR_NAV_ITEMS.filter(shown), ...(isAdmin ? [INVESTOR_NAV_ADMIN_ITEM] : [])]
}

function within(pathname: string, base: string) {
  return pathname === base || pathname.startsWith(`${base}/`)
}

export function isNavItemActive(item: Pick<InvestorNavItem, "id">, pathname: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname
  switch (item.id) {
    case "home":
      return path === GIWA_HOME_ROUTE
    case "savings":
      return within(path, GIWA_SAVINGS_ROUTE)
    case "funds":
      return path === GIWA_FUNDS_ROUTE || path.startsWith("/product/")
    case "stocks":
      return path === GIWA_STOCKS_ROUTE || path === GIWA_ADMIN_STOCKS_ROUTE
    case "portfolio":
      return within(path, GIWA_PORTFOLIO_ROUTE)
    case "admin":
      return within(path, GIWA_ADMIN_ROUTE) && !within(path, GIWA_ADMIN_STOCKS_ROUTE)
    case "send":
      return false
  }
}
