// The Savings accounts the Savings page offers, in one place, so the page and the header search list the same accounts
// with the same rates (they cannot drift):
//   • the Vault Config's Savings accounts (savings.ts), on the full catalog, rates from the market (published, else
//     implied from price posts);
//   • on the live ArcoUSD v1 contracts, sArcoUSD in the place of the arcoUSD vault, at the rate the distributor pays
//     (arcousd-live.ts);
//   • once the live gold account is up, ArcoGOLD in the place of any gold coin the Vault Config lists (arcogold-live.ts).
import type { GiwaMarketEntry } from "./api"
import { goldSavingsMarket, goldSavingsVault, withGoldAccounts, type ArcoGoldLive } from "./arcogold-live"
import { liveSavingsMarket, liveSavingsVault, REPLACED_SAVINGS_PRODUCT_ID, type ArcoUsdLive } from "./arcousd-live"
import { tokenSymbolFor, vaultImageFor } from "./catalog"
import { marketApyText } from "./price-policy"
import { buildSavingsAccounts, type SavingsAccount } from "./savings"
import { SAVINGS_CATEGORIES, savingsAssetCategory, type SavingsCategory } from "./savings-category"
import type { GiwaCatalogItem } from "./types"

export function savingsPageAccounts(input: {
  catalog: readonly GiwaCatalogItem[]
  market: readonly GiwaMarketEntry[]
  live: ArcoUsdLive | null
  gold: ArcoGoldLive | null
}): SavingsAccount[] {
  const { catalog, market, live, gold } = input
  const built = buildSavingsAccounts([...catalog], [...market])
  const base = catalog.find((product) => product.productId === REPLACED_SAVINGS_PRODUCT_ID)
  const liveVault = live !== null && base !== undefined ? liveSavingsVault(base, live) : null
  const accounts =
    liveVault === null || live?.savings == null
      ? built
      : built.map((account) =>
          account.vault?.productId === REPLACED_SAVINGS_PRODUCT_ID ? { ...account, vault: liveVault, apy: marketApyText(liveSavingsMarket(live.savings!)) } : account,
        )
  const goldVault = gold !== null ? goldSavingsVault(gold) : null
  return withGoldAccounts(accounts, goldVault, gold, gold !== null ? marketApyText(goldSavingsMarket(gold)) : "—")
}

/** One Savings account as the page shows it: one per vault (the stablecoin account takes several coins). */
export type SavingsOffer = Readonly<{
  /** The account the page opens on for it: its first coin the page offers. */
  account: SavingsAccount
  vault: GiwaCatalogItem
  /** The token the Savings card names (sArcoUSD, arcoBTC, ArcoGOLD). */
  symbol: string
  image: string | undefined
  /** The APY its tab shows ("4%", or "—" without a rate). */
  apy: string
  category: SavingsCategory
  categoryLabel: string
  /** Every coin it takes, as the tabs list them (USDC, RLUSD…). */
  coins: readonly string[]
  /** Where the page opens on it, as its tab does: category, coin and account in the query. */
  href: string
}>

/**
 * The accounts the page offers today, one per vault in the page's order: a coming-soon coin (disabled, no vault) is left
 * out, as the tabs leave it out.
 */
export function savingsOffers(accounts: readonly SavingsAccount[]): SavingsOffer[] {
  const offers = new Map<string, SavingsAccount[]>()
  for (const account of accounts) {
    if (account.disabled || account.vault === null) continue
    const id = account.vault.productId
    offers.set(id, [...(offers.get(id) ?? []), account])
  }
  return [...offers.values()].map((group) => {
    const account = group[0]!
    const vault = account.vault!
    const category = savingsAssetCategory(account.symbol)
    const params = new URLSearchParams({ category, asset: account.symbol, account: account.key })
    return {
      account,
      vault,
      symbol: tokenSymbolFor(vault),
      image: vaultImageFor(vault),
      apy: account.apy,
      category,
      categoryLabel: SAVINGS_CATEGORIES.find((entry) => entry.id === category)?.label ?? category,
      coins: group.map((entry) => entry.symbol),
      href: `/savings?${params.toString()}`,
    }
  })
}
