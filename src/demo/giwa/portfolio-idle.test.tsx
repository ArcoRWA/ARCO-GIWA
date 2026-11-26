import assert from "node:assert/strict"
import test from "node:test"
import type { GiwaMarketEntry } from "./api"
import type { ArcoUsdLive } from "./arcousd-live"
import type { ArcoGoldLive } from "./arcogold-live"
import { idleAssetList, idleEarnings, idleHoldings } from "./portfolio-idle"
import type { GiwaCatalogItem, HexAddress } from "./types"

const addr = (n: number) => `0x${String(n).repeat(40).slice(0, 40)}` as HexAddress
const USDC = addr(1), BTC = addr(2), XRP = addr(3), ARCO = addr(4), USDT = addr(5), PAXG = addr(6), XAUT = addr(7)

function product(productId: string, symbol: string, token: string, decimals: number, kind: "saving" | "product"): GiwaCatalogItem {
  return {
    productId, symbol: productId, name: productId, paymentAssetSymbol: symbol, paymentAssetAddress: token,
    paymentAsset: { symbol, name: `Test ${symbol.slice(1)}`, decimals, tokenAddress: token }, vaultConfig: { kind },
  } as unknown as GiwaCatalogItem
}
const market = (entries: Partial<GiwaMarketEntry>[]) =>
  new Map(entries.map((entry) => [entry.productId!, { navBase: 1, baseUsd: null, navUsd: 1, apy: null, impliedApy: null, ...entry } as GiwaMarketEntry]))
const option = (symbol: string, name: string, logo: string) => ({ key: symbol, symbol, name, logo, decimals: 6, chain: "giwa", chainName: "GIWA" })

const catalog = [
  // A Fund and a Savings vault both pay in tUSDC (the address in another case: de-duplicated by address).
  product("fund-usdc", "tUSDC", USDC, 6, "product"),
  product("save-usdc", "tUSDC", USDC.toUpperCase().replace("0X", "0x"), 6, "saving"),
  product("abtc", "tBTC", BTC, 8, "saving"),
  // A Fund paying in tXRP, with no Savings vault for it and no price.
  product("xrp-fund", "tXRP", XRP, 6, "product"),
]
const live = {
  arcoUSD: ARCO, reserve: addr(8), depositPaused: false, redeemPaused: false,
  assets: [
    { option: option("USDT", "Tether USD", "/logos/usdt.png"), token: USDT, symbol: "tUSDT", decimals: 6 },
    // The Reserve takes tUSDC too: the Reserve's entry wins over the catalog's.
    { option: option("USDC", "USD Coin", "/logos/usdc.svg"), token: USDC, symbol: "tUSDC", decimals: 6 },
  ],
  savings: { sArcoUSD: addr(9), zap: addr(9), sharePrice: 1, apyPercent: 4.5, paidApyPercent: 4.5, depositsOpen: true, withdrawalsOpen: true },
} as unknown as ArcoUsdLive
const gold = {
  arcoGOLD: addr(6).replace(/6/g, "a") as HexAddress, zap: addr(9), sharePrice: 1, ounceUsd: 2400, apyPercent: 3.1,
  coins: [
    { option: option("PAXG", "PAX Gold", "/logos/paxg.png"), token: PAXG, symbol: "tPAXG", decimals: 18 },
    { option: option("XAUT", "Tether Gold", "/logos/xaut.png"), token: XAUT, symbol: "tXAUT", decimals: 6 },
  ],
} as unknown as ArcoGoldLive
const prices = market([
  { productId: "fund-usdc", baseUsd: 1 },
  { productId: "save-usdc", baseUsd: 1, apy: 3 },
  { productId: "abtc", baseUsd: 90_000, apy: null, impliedApy: 2.2 },
  { productId: "xrp-fund", baseUsd: null },
])

test("the Not earning list: ArcoUSD, the Reserve's coins, the gold coins, the catalog's payment coins, once each", () => {
  const list = idleAssetList({ catalog, market: prices, live, gold })
  assert.deepEqual(list.map((asset) => [asset.symbol, asset.source]), [
    ["ArcoUSD", "arcousd"], ["tUSDT", "reserve"], ["tUSDC", "reserve"], ["tPAXG", "gold"], ["tXAUT", "gold"], ["tBTC", "catalog"], ["tXRP", "catalog"],
  ])
  const by = (symbol: string) => list.find((asset) => asset.symbol === symbol)!
  // Prices: $1 for ArcoUSD and the Reserve's dollar coins, an ounce's dollars for gold, the market's coin price.
  assert.deepEqual(list.map((asset) => asset.priceUsd), [1, 1, 1, 2400, 2400, 90_000, null])
  // Rates: sArcoUSD's for ArcoUSD and the dollar coins (not the tUSDC vault's 3%), ArcoGOLD's for gold, a catalog
  // Savings vault's (its implied rate when none is published); none for a coin no Savings account takes.
  assert.deepEqual(list.map((asset) => asset.savingsApyPercent), [4.5, 4.5, 4.5, 3.1, 3.1, 2.2, null])
  assert.equal(by("ArcoUSD").decimals, 18)
  assert.equal(by("tBTC").decimals, 8)
  assert.equal(by("tUSDT").name, "Tether USD")
  assert.equal(by("tBTC").name, "Test BTC")
  assert.equal(by("ArcoUSD").logo, "/logos/arcousd.png")
  assert.equal(by("tBTC").logo, "/logos/bitcoin.svg")
  // Without the live reads: the catalog's coins only, tUSDC priced and rated by the catalog (its Savings vault's 3%).
  const catalogOnly = idleAssetList({ catalog, market: prices, live: null, gold: null })
  assert.deepEqual(catalogOnly.map((asset) => [asset.symbol, asset.priceUsd, asset.savingsApyPercent]), [["tUSDC", 1, 3], ["tBTC", 90_000, 2.2], ["tXRP", null, null]])
  // A dollar coin the market has no price for is still a dollar.
  const unpriced = idleAssetList({ catalog: [product("fund-usdc", "tUSDC", USDC, 6, "product")], market: new Map(), live: null, gold: null })
  assert.equal(unpriced[0]!.priceUsd, 1)
})

test("balances: valued, zero and dust left out, largest first, unpriced last; the what-if takes the rated ones", () => {
  const list = idleAssetList({ catalog, market: prices, live, gold })
  const balances = new Map<string, number>([
    [ARCO.toLowerCase(), 350_625.07], [USDT.toLowerCase(), 0.004], [USDC.toLowerCase(), 20], [PAXG.toLowerCase(), 0.5],
    [BTC.toLowerCase(), 0.01], [XRP.toLowerCase(), 12], [XAUT.toLowerCase(), 0],
  ])
  const held = idleHoldings(list, balances)
  assert.deepEqual(held.map((coin) => [coin.symbol, coin.units, coin.usd]), [
    ["ArcoUSD", 350_625.07, 350_625.07], ["tPAXG", 0.5, 1200], ["tBTC", 0.01, 900], ["tUSDC", 20, 20], ["tXRP", 12, null],
  ])
  assert.deepEqual(idleEarnings(held), [
    { usd: 350_625.07, apyPercent: 4.5 }, { usd: 1200, apyPercent: 3.1 }, { usd: 900, apyPercent: 2.2 }, { usd: 20, apyPercent: 4.5 },
  ])
  assert.deepEqual(idleHoldings(list, new Map()), [])
})
