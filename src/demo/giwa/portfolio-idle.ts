// The Portfolio's "Not earning" group: coins the wallet holds that it could deposit into an Arco product, but has not.
// They are not part of the deposited portfolio (Current value, Supplied, Lifetime Earned, Net APY, the ticker and the
// projection leave them out); the chart's what-if line shows the interest they would earn in Savings. Pure: no React,
// no I/O.
//
// The list comes from what the app already reads, never a list of symbols, de-duplicated by token address (the first
// source to name a token wins, in this order):
//   1. ArcoUSD itself (the live ArcoUSD v1 read): $1; earns sArcoUSD's rate in Savings.
//   2. The ArcoUSD Reserve's dollar coins (the live read's `assets`, the coins ArcoUSD is bought with): $1; sArcoUSD.
//   3. The gold Reserve's coins (the live ArcoGOLD read's `coins`): an ounce each, at `ounceUsd`; ArcoGOLD's rate.
//   4. The catalog products' payment assets (the coins their deposit vaults take, the test faucet's coins): the price
//      the market read gives for the coin (`baseUsd` of a product paying in it; $1 for a dollar coin it has none for);
//      a catalog Savings vault paying in the coin gives the rate (its APY, or the one implied by its price posts).
import type { GiwaMarketEntry } from "./api"
import type { ArcoUsdLive } from "./arcousd-live"
import { goldSavingsMarket, type ArcoGoldLive } from "./arcogold-live"
import { paymentAssetIcon } from "./components"
import { ARCOUSD_DECIMALS } from "./portfolio-principal"
import { productPortfolioCategory } from "./portfolio-view"
import { SAVINGS_COINS } from "./savings-assets"
import { savingsAssetCategory } from "./savings-category"
import type { GiwaCatalogItem, HexAddress } from "./types"

/** Below a cent a priced balance is dust and is not listed. */
export const IDLE_DUST_USD = 0.01

export type IdleAssetSource = "arcousd" | "reserve" | "gold" | "catalog"

export type IdleAsset = Readonly<{
  token: HexAddress
  /** The token's symbol as the app shows it (tUSDC, ArcoUSD, tPAXG). */
  symbol: string
  /** The coin's longer name, when the app knows one. */
  name: string | null
  logo: string | undefined
  decimals: number
  source: IdleAssetSource
  /** Dollars per coin; null when no price is known (the row then shows its balance, and totals leave it out). */
  priceUsd: number | null
  /** The rate it would earn in its Savings account (sArcoUSD, ArcoGOLD, a catalog Savings vault); null for none. */
  savingsApyPercent: number | null
}>

const positive = (n: number | null | undefined): number | null => (n !== null && n !== undefined && Number.isFinite(n) && n > 0 ? n : null)
const coinOf = (symbol: string) => symbol.replace(/^t(?=[A-Z])/, "")
const sameToken = (a: string | null | undefined, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase()

/** A coin's mark: its Savings coin mark (USDC, USDT, RLUSD, ArcoUSD), else the payment-asset marks (tBTC, tPAXG…). */
function logoOf(symbol: string): string | undefined {
  return SAVINGS_COINS.find((coin) => coin.symbol.toLowerCase() === coinOf(symbol).toLowerCase())?.logo ?? paymentAssetIcon(symbol)
}

function catalogToken(product: GiwaCatalogItem): string | null {
  const address = product.paymentAssetAddress ?? product.paymentAsset?.tokenAddress ?? null
  return typeof address === "string" && address.length > 0 ? address : null
}

/** Every coin the wallet could deposit into an Arco product, each once (by token address). */
export function idleAssetList(input: {
  catalog: readonly GiwaCatalogItem[]
  market: ReadonlyMap<string, GiwaMarketEntry>
  live: ArcoUsdLive | null
  gold: ArcoGoldLive | null
}): IdleAsset[] {
  const list: IdleAsset[] = []
  const add = (asset: IdleAsset) => {
    if (!list.some((known) => sameToken(known.token, asset.token))) list.push(asset)
  }
  const sArcoUsdApy = positive(input.live?.savings?.apyPercent)
  if (input.live) {
    add({
      token: input.live.arcoUSD, symbol: "ArcoUSD", name: SAVINGS_COINS.find((coin) => coin.symbol === "ArcoUSD")?.name ?? null,
      logo: logoOf("ArcoUSD"), decimals: ARCOUSD_DECIMALS, source: "arcousd", priceUsd: 1, savingsApyPercent: sArcoUsdApy,
    })
    for (const asset of input.live.assets) {
      add({
        token: asset.token, symbol: asset.symbol, name: asset.option.name, logo: asset.option.logo ?? logoOf(asset.symbol),
        decimals: asset.decimals, source: "reserve", priceUsd: 1, savingsApyPercent: sArcoUsdApy,
      })
    }
  }
  if (input.gold) {
    const goldApy = positive(goldSavingsMarket(input.gold).apy)
    for (const coin of input.gold.coins) {
      add({
        token: coin.token, symbol: coin.symbol, name: coin.option.name, logo: coin.option.logo ?? logoOf(coin.symbol),
        decimals: coin.decimals, source: "gold", priceUsd: positive(input.gold.ounceUsd), savingsApyPercent: goldApy,
      })
    }
  }
  for (const product of input.catalog) {
    const token = catalogToken(product)
    const decimals = product.paymentAsset?.decimals
    if (token === null || typeof decimals !== "number" || !Number.isFinite(decimals)) continue
    if (list.some((known) => sameToken(known.token, token))) continue
    const payingInIt = input.catalog.filter((other) => sameToken(catalogToken(other), token))
    const price =
      payingInIt.map((other) => positive(input.market.get(other.productId)?.baseUsd)).find((usd) => usd !== null) ??
      (savingsAssetCategory(coinOf(product.paymentAssetSymbol)) === "stablecoins" ? 1 : null)
    const savingsApy = payingInIt
      .filter((other) => productPortfolioCategory(other) === "savings")
      .map((other) => {
        const entry = input.market.get(other.productId)
        return positive(entry?.apy ?? entry?.impliedApy ?? null)
      })
      .find((apy) => apy !== null) ?? null
    add({
      token: token as HexAddress, symbol: product.paymentAssetSymbol, name: product.paymentAsset?.name ?? null, logo: logoOf(product.paymentAssetSymbol),
      decimals, source: "catalog", priceUsd: price, savingsApyPercent: savingsApy,
    })
  }
  return list
}

export type IdleHolding = IdleAsset & Readonly<{ units: number; usd: number | null }>

/**
 * The wallet's balances of those coins, valued; zero and dust left out (a priced balance under a cent, an unpriced
 * balance of zero). Largest value first, unpriced last.
 */
export function idleHoldings(assets: readonly IdleAsset[], balances: ReadonlyMap<string, number>): IdleHolding[] {
  return assets
    .map((asset) => {
      const units = balances.get(asset.token.toLowerCase()) ?? 0
      const safe = Number.isFinite(units) && units > 0 ? units : 0
      return { ...asset, units: safe, usd: asset.priceUsd !== null ? safe * asset.priceUsd : null }
    })
    .filter((holding) => (holding.usd !== null ? holding.usd >= IDLE_DUST_USD : holding.units > 0))
    .sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1))
}

/** The priced idle holdings with a Savings rate above 0: what the what-if line puts in Savings. */
export function idleEarnings(holdings: readonly IdleHolding[]): { usd: number; apyPercent: number }[] {
  return holdings.flatMap((holding) =>
    holding.usd !== null && holding.usd > 0 && holding.savingsApyPercent !== null && holding.savingsApyPercent > 0
      ? [{ usd: holding.usd, apyPercent: holding.savingsApyPercent }]
      : [],
  )
}
