// Pure helpers for the Portfolio page's product views (All Portfolio / Savings / Funds). No React or I/O, so they run
// under `npm run test:frontend`.
import { vaultConfigOf } from "./catalog"
import type { GiwaCatalogItem } from "./types"

export const PORTFOLIO_VIEWS = [
  { id: "all", label: "All Portfolio" },
  { id: "savings", label: "Savings" },
  { id: "funds", label: "Funds" },
] as const
export type PortfolioView = (typeof PORTFOLIO_VIEWS)[number]["id"]
export type PortfolioCategory = Exclude<PortfolioView, "all">
export const PORTFOLIO_CATEGORIES: readonly PortfolioCategory[] = ["savings", "funds"]
export const CATEGORY_LABEL: Readonly<Record<PortfolioCategory, string>> = { savings: "Savings", funds: "Funds" }

/** Savings vaults are the ones the Savings page opens (kind "saving"); every other GIWA product is a Fund. */
export function productPortfolioCategory(product: Pick<GiwaCatalogItem, "vaultConfig">): PortfolioCategory {
  return vaultConfigOf(product).kind === "saving" ? "savings" : "funds"
}
