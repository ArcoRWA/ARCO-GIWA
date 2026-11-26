import assert from "node:assert/strict"
import test from "node:test"
import { PORTFOLIO_CATEGORIES, PORTFOLIO_VIEWS, productPortfolioCategory } from "./portfolio-view"
import type { GiwaCatalogItem } from "./types"

const product = (kind: "saving" | "product" | null) => ({ vaultConfig: kind === null ? null : { kind } }) as unknown as Pick<GiwaCatalogItem, "vaultConfig">

test("the views are All Portfolio, Savings and Funds: no Stocks", () => {
  assert.deepEqual(PORTFOLIO_VIEWS.map((view) => view.id), ["all", "savings", "funds"])
})

test("Savings are the saving vaults; every other GIWA product, including unconfigured ones, is a Fund", () => {
  assert.equal(productPortfolioCategory(product("saving")), "savings")
  assert.equal(productPortfolioCategory(product("product")), "funds")
  assert.equal(productPortfolioCategory(product(null)), "funds")
})

test("holdings are grouped Savings first, then Funds", () => {
  assert.deepEqual(PORTFOLIO_CATEGORIES, ["savings", "funds"])
})
