// What a Savings account can pay out at once (its instant liquidity) and the coins that reserve is held in, from what
// the page already reads; nothing here is stored or estimated.
//
// - Stablecoins (sArcoUSD on ArcoUSD v1): the Reserve's free buffer in each stablecoin it pays out (USDC, USDT, RLUSD),
//   less the Instant withdrawal's fees (instantPayable, /api/v1/arcousd/reserve). Stablecoins count at $1.
// - Gold (ArcoGOLD): the gold Reserve's free buffer in each gold coin (PAXG, XAUT), less the fees, in ounces
//   (/api/v1/arcogold/reserve); dollars at the server's ounce price, unknown while it has none.
// - Any other account (Crypto Native, or the stablecoin vault before ArcoUSD v1 is read): its redemption vault's
//   balance in its own coin, valued at the coin's price (useGiwaVaultDetail's instantLiquidityUsd).
//
// Pure: no React, so the page and tests share it.

import { instantPayable, type ArcoUsdLive } from "./arcousd-live"
import type { ArcoGoldLive } from "./arcogold-live"
import type { AllocationSlice } from "./savings-backing"

export type LiquidityCoin = Readonly<{
  /** As customers know it: USDC, PAXG, BTC. */
  symbol: string
  logo: string | null
  /** What can be paid out at once in this coin, in the coin; null while unknown. */
  amount: number | null
}>

export type SavingsLiquidity = Readonly<{
  /** The whole instant liquidity in dollars, or null while unknown. */
  usd: number | null
  coins: readonly LiquidityCoin[]
}>

/** The sArcoUSD account: every Reserve stablecoin that pays out, at $1. */
export function stablecoinLiquidity(live: ArcoUsdLive): SavingsLiquidity {
  const coins = live.assets
    .filter((asset) => asset.redeemEnabled)
    .map((asset) => ({ symbol: asset.option.symbol, logo: asset.option.logo, amount: instantPayable(asset) }))
  return { usd: coins.reduce((sum, coin) => sum + coin.amount, 0), coins }
}

/** The ArcoGOLD account: every gold coin that pays out, in ounces; dollars only with an ounce price. */
export function goldLiquidity(live: ArcoGoldLive): SavingsLiquidity {
  const coins = live.coins
    .filter((coin) => coin.redeemEnabled)
    .map((coin) => ({ symbol: coin.option.symbol, logo: coin.option.logo, amount: instantPayable(coin) }))
  const ounces = coins.reduce((sum, coin) => sum + coin.amount, 0)
  return { usd: live.ounceUsd !== null ? ounces * live.ounceUsd : null, coins }
}

/** An account paid out in its own coin only: the dollars its redemption vault holds, or null while unknown. */
export function singleCoinLiquidity(symbol: string, logo: string | null, usd: number | null): SavingsLiquidity {
  return { usd: usd !== null && Number.isFinite(usd) ? usd : null, coins: [{ symbol, logo, amount: usd }] }
}

/**
 * The reserve's split by coin as tiles: each coin's share of what can be paid out (the coins of one account share a
 * unit: dollars, or ounces). One coin is all of it. Coins with nothing to pay out, or while the amounts are unknown,
 * get no tile.
 */
export function liquiditySlices(liquidity: SavingsLiquidity): AllocationSlice[] {
  if (liquidity.coins.length === 1) {
    const coin = liquidity.coins[0]!
    return [{ id: coin.symbol, label: coin.symbol, percent: 100, logo: coin.logo }]
  }
  const total = liquidity.coins.reduce((sum, coin) => sum + (coin.amount ?? 0), 0)
  if (!(total > 0)) return []
  return liquidity.coins
    .map((coin, index) => ({ coin, id: `${coin.symbol}-${index}` }))
    .filter(({ coin }) => coin.amount !== null && coin.amount > 0)
    .map(({ coin, id }) => ({ id, label: coin.symbol, percent: (coin.amount! / total) * 100, logo: coin.logo }))
}
