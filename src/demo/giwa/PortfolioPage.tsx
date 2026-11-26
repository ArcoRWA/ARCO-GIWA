import { useContext, useState, type ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { Wallet } from "lucide-react"
import { giwaApi, type GiwaMarketEntry } from "./api"
import { readShareSupply, readTokenBalance } from "./contracts"
import { ArcoUsdLiveContext, ArcoUsdLiveFailedContext, ArcoUsdLivePendingContext } from "./arcousd-live-context"
import { goldSavingsMarket, goldSavingsVault } from "./arcogold-live"
import { ArcoGoldLiveContext } from "./arcogold-live-context"
import { positionUsdValue } from "./usd-prices"
import { buildActivityFeed } from "./activity-feed"
import { PortfolioActivity } from "./PortfolioActivity"
import { activityAssetUsd, activitySummary } from "./portfolio-activity"
import { vaultConfigOf, vaultDisplayName, vaultImageFor } from "./catalog"
import { categoryTitle } from "./fund-categories"
import { CATEGORY_LABEL, PORTFOLIO_CATEGORIES, PORTFOLIO_VIEWS, productPortfolioCategory, type PortfolioCategory, type PortfolioView } from "./portfolio-view"
import {
  arcoGoldPrincipalFlows, catalogPrincipalFlows, principalFromFlows, principalTotals, principalUsd, sArcoUsdPrincipalFlows,
  type PrincipalFlow, type PrincipalUsd,
} from "./portfolio-principal"
import { idleAssetList, idleEarnings, idleHoldings } from "./portfolio-idle"
import { PortfolioHero } from "./PortfolioHero"
import { PortfolioEarningsChart } from "./PortfolioEarningsChart"
import {
  earnedText, IDLE_GROUP_ID, IDLE_GROUP_LABEL, IDLE_ROW_TAG, pctLabel, PortfolioHoldings,
  type HoldingsSortKey, type PortfolioHoldingGroup, type PortfolioHoldingRow,
} from "./PortfolioHoldings"
import { SAVINGS_CATEGORIES, savingsAssetCategory, savingsCoinDecimals, type SavingsCategory } from "./savings-category"
import { tokenAmount } from "./savings-format"
import { nextSort, sortByNumericKey } from "./sort"
import { GIWA_CHAIN_ID } from "./config"
import { GIWA_FUNDS_ROUTE, GIWA_SAVINGS_ROUTE } from "./routes"
import type { GiwaActivity, GiwaCatalogItem, GiwaRedemption, HexAddress } from "./types"
import { useGiwaWallet } from "./wallet"
import { money } from "../lib/format"

const TABS = [
  { id: "portfolio", label: "Portfolio" },
  { id: "activity", label: "Activity" },
] as const
type Tab = (typeof TABS)[number]["id"]

type RawHolding = { product: GiwaCatalogItem; shares: number }

// One holdings row (PortfolioHoldings) with the category it is listed under.
type PortfolioRow = PortfolioHoldingRow & { category: PortfolioCategory }

// ArcoUSD v1 (arcousd-live.ts): the wallet's sArcoUSD is not a catalog product, so its row names itself, under Savings.
// ArcoUSD itself earns nothing: it is listed under "Not earning" (portfolio-idle.ts), outside the portfolio.
const SARCOUSD_ROW = { id: "arcousd:sArcoUSD", symbol: "sArcoUSD", name: null, tag: savingsKindLabel("stablecoins"), imageUrl: "/logos/sarcousd.png" } as const
/** sArcoUSD's asset, the unit its principal is counted in, as the "Not earning" group names it. */
const SARCOUSD_ASSET_SYMBOL = "ArcoUSD"
// ArcoGOLD (arcogold-live.ts), the gold Savings account's token: not a catalog product either.
const ARCOGOLD_ROW = { id: "arcogold:ArcoGOLD", symbol: "ArcoGOLD", name: null, tag: savingsKindLabel("gold"), imageUrl: "/logos/arcogold.png" } as const
const SEGMENT_ACTIVE = "bg-[var(--color-arco-surface)] font-medium text-[var(--color-arco-ink)] shadow-[var(--shadow-control)]"
const SEGMENT_IDLE = "text-[var(--color-arco-muted-text)]"
const LINK_BUTTON =
  "mt-1 inline-flex items-center justify-center rounded-[var(--radius-control)] border border-[var(--color-arco-border)] px-4 py-2 text-sm font-medium text-[var(--color-arco-ink)]"
const LOADING: PrincipalUsd = { status: "loading" }
const UNKNOWN: PrincipalUsd = { status: "unknown" }
const IDLE_LOADING = "Checking your wallet for coins you could deposit…"
const IDLE_ERROR = "Your other balances could not be read. Use Refresh to try again."

// Backend positions aren't indexed (services/evm-portfolio-service returns []), so the held
// products + share counts are derived on-chain (balanceOf, formatUnits by token decimals).
// Pricing/APY come live from the backend market endpoint so operator updates flow through.
async function readHoldings(products: GiwaCatalogItem[], account: HexAddress): Promise<RawHolding[]> {
  const candidates = products.filter((p) => p.productTokenAddress)
  const withBalance = await Promise.all(
    candidates.map(async (product) => {
      const { decimals } = await readShareSupply(product.productTokenAddress as HexAddress)
      const shares = Number(await readTokenBalance(product.productTokenAddress as HexAddress, account, decimals))
      return { product, shares }
    }),
  )
  return withBalance.filter((h) => Number.isFinite(h.shares) && h.shares > 0)
}

/** "Stablecoins", "Crypto", "Gold": a Savings account kind as the Savings tabs name it. */
function savingsKindLabel(kind: SavingsCategory): string {
  return SAVINGS_CATEGORIES.find((entry) => entry.id === kind)?.label ?? ""
}

/** A catalog product's chip: a Savings vault's coin kind, or a Fund's category (as the Funds list shows it). */
function catalogRowTag(product: GiwaCatalogItem, category: PortfolioCategory): string | null {
  if (category === "funds") {
    const fundCategory = vaultConfigOf(product).category
    return fundCategory ? categoryTitle(fundCategory) : null
  }
  return savingsKindLabel(savingsAssetCategory((product.paymentAssetSymbol ?? "").replace(/^t(?=[A-Z])/, "")))
}

export default function GiwaPortfolioPage() {
  const wallet = useGiwaWallet()
  const [tab, setTab] = useState<Tab>("portfolio")
  const [view, setView] = useState<PortfolioView>("all")
  const [now] = useState(() => Date.now())
  // Holdings list sort: numeric, null-last; default Current value, largest first.
  const [holdingsSort, setHoldingsSort] = useState<{ key: HoldingsSortKey; dir: "asc" | "desc" }>({ key: "value", dir: "desc" })

  const catalogQuery = useQuery({ queryKey: ["giwa", "catalog"], queryFn: giwaApi.catalog })
  const products = catalogQuery.data ?? []

  // Live: refetch keeps NAV/APY current and reflects operator price updates.
  const marketQuery = useQuery({
    queryKey: ["giwa", "market", GIWA_CHAIN_ID],
    queryFn: () => giwaApi.market(GIWA_CHAIN_ID),
    refetchInterval: 45_000,
  })
  const marketByProduct = new Map<string, GiwaMarketEntry>((marketQuery.isSuccess ? marketQuery.data : []).map((m) => [m.productId, m]))

  const holdingsQuery = useQuery({
    queryKey: ["giwa", "portfolio-holdings", wallet.address, products.map((p) => p.productId).join(",")],
    queryFn: () => readHoldings(products, wallet.address as HexAddress),
    enabled: Boolean(wallet.address && products.length),
  })
  // ArcoUSD v1, when the app reads it live: the wallet's sArcoUSD (18 decimals). Until the ArcoUSD v1 state and that
  // read have answered the holdings are not known (no confirmed zero); reads that keep failing are a holdings error.
  const live = useContext(ArcoUsdLiveContext)
  const livePending = useContext(ArcoUsdLivePendingContext)
  const liveFailed = useContext(ArcoUsdLiveFailedContext)
  const liveSavings = live?.savings ?? null
  const arcoUSDQuery = useQuery({
    queryKey: ["giwa", "portfolio-sarcousd", wallet.address, liveSavings?.sArcoUSD ?? null],
    queryFn: async () => ({ sArcoUSD: Number(await readTokenBalance(liveSavings!.sArcoUSD, wallet.address as HexAddress, 18)) }),
    enabled: Boolean(wallet.address && liveSavings),
  })
  // ArcoGOLD, once the gold stack is live: the wallet's ArcoGOLD (18 decimals) at its share price in ounces × an ounce's
  // dollars. Before the gold deploy nothing is read and nothing changes here.
  const gold = useContext(ArcoGoldLiveContext)
  const arcoGoldQuery = useQuery({
    queryKey: ["giwa", "portfolio-arcogold", wallet.address, gold?.arcoGOLD ?? null],
    queryFn: async () => Number(await readTokenBalance(gold!.arcoGOLD, wallet.address as HexAddress, 18)),
    enabled: Boolean(wallet.address && gold),
  })

  const arcoUSDKnown = !livePending && (liveSavings === null || arcoUSDQuery.isSuccess)
  const arcoGoldKnown = gold === null || arcoGoldQuery.isSuccess
  const holdingsKnown = catalogQuery.isSuccess && (products.length === 0 || holdingsQuery.isSuccess) && arcoUSDKnown && arcoGoldKnown
  const holdingsError =
    catalogQuery.isError ||
    (products.length > 0 && holdingsQuery.isError) ||
    (livePending && liveFailed !== null) ||
    (liveSavings !== null && arcoUSDQuery.isError) ||
    (gold !== null && arcoGoldQuery.isError)
  const rawHoldings = holdingsKnown ? holdingsQuery.data ?? [] : []
  const sArcoUSDUnits = holdingsKnown && liveSavings !== null ? positive(arcoUSDQuery.data?.sArcoUSD) : 0
  const arcoGoldUnits = holdingsKnown && gold !== null ? positive(arcoGoldQuery.data) : 0

  // The wallet's indexed events and its request-based redemptions: the Activity tab's two streams, and the records
  // that say how much of each holding was supplied (portfolio-principal.ts).
  const activityQuery = useQuery({
    queryKey: ["giwa", "activity", wallet.address],
    queryFn: () => giwaApi.activity(wallet.address!),
    enabled: Boolean(wallet.address),
  })
  const redemptionsQuery = useQuery({
    queryKey: ["giwa", "redemptions", wallet.address],
    queryFn: () => giwaApi.redemptions(wallet.address!),
    enabled: Boolean(wallet.address),
  })

  const activityError = catalogQuery.isError || activityQuery.isError || redemptionsQuery.isError
  const activityKnown = catalogQuery.isSuccess && activityQuery.isSuccess && redemptionsQuery.isSuccess
  const activityRows = activityKnown
    ? buildActivityFeed(activityQuery.data, redemptionsQuery.data, products, {
        sArcoUSD: liveSavings !== null ? { vault: liveSavings.sArcoUSD, zap: liveSavings.zap } : null,
        arcoGold: gold !== null ? { vault: gold.arcoGOLD, zap: gold.zap } : null,
      })
    : []
  const recordsError = activityQuery.isError || redemptionsQuery.isError
  const events: GiwaActivity[] = activityQuery.isSuccess ? activityQuery.data : []
  const redemptions: GiwaRedemption[] = redemptionsQuery.isSuccess ? redemptionsQuery.data : []
  // A holding's supplied / earned in dollars: loading until the records answer, unknown when they could not be read.
  const principalOf = (flows: () => PrincipalFlow[] | null, currentUnits: number | null, apy: number | null, assetUsd: number | null): PrincipalUsd => {
    if (recordsError) return UNKNOWN
    if (!activityQuery.isSuccess || !redemptionsQuery.isSuccess) return LOADING
    if (currentUnits === null) return UNKNOWN
    return principalUsd(principalFromFlows({ flows: flows(), currentUnits, apyPercent: apy, now }), assetUsd)
  }

  // "Not earning": the coins the wallet could deposit (portfolio-idle.ts), read in one batch apart from the holdings,
  // so a slow or failed read never holds the portfolio up.
  const idleAssets = catalogQuery.isSuccess ? idleAssetList({ catalog: products, market: marketByProduct, live, gold }) : []
  const idleQuery = useQuery({
    queryKey: ["giwa", "portfolio-idle", wallet.address, idleAssets.map((asset) => `${asset.token}:${asset.decimals}`).join(",")],
    queryFn: async () => {
      const account = wallet.address as HexAddress
      const units = await Promise.all(idleAssets.map((asset) => readTokenBalance(asset.token, account, asset.decimals)))
      return new Map(idleAssets.map((asset, index) => [asset.token.toLowerCase(), Number(units[index])]))
    },
    enabled: Boolean(wallet.address && idleAssets.length && !livePending),
  })
  const idle = idleQuery.isSuccess ? idleHoldings(idleAssets, idleQuery.data) : []
  const idleStatus = idleQuery.isError ? IDLE_ERROR : !catalogQuery.isSuccess || livePending || (idleAssets.length > 0 && !idleQuery.isSuccess) ? IDLE_LOADING : null

  const refreshing =
    [catalogQuery, holdingsQuery, marketQuery, activityQuery, redemptionsQuery, arcoUSDQuery, arcoGoldQuery, idleQuery].some(query => query.isFetching)
  const refresh = () => {
    void Promise.allSettled([
      catalogQuery.refetch(), marketQuery.refetch(), activityQuery.refetch(), redemptionsQuery.refetch(),
      ...(products.length ? [holdingsQuery.refetch()] : []),
      ...(liveSavings !== null && wallet.address ? [arcoUSDQuery.refetch()] : []),
      ...(idleAssets.length && wallet.address ? [idleQuery.refetch()] : []),
      ...(liveFailed !== null ? [Promise.resolve(liveFailed.retry())] : []),
      ...(gold !== null && wallet.address ? [arcoGoldQuery.refetch()] : []),
    ])
  }

  const sArcoUSDPrice = liveSavings?.sharePrice ?? null
  const arcoGoldMarket = gold !== null ? goldSavingsMarket(gold) : null
  const rows: PortfolioRow[] = [
    ...rawHoldings.map((h): PortfolioRow => {
      const entry = marketByProduct.get(h.product.productId)
      const navUsd = entry?.navUsd ?? null
      const navBase = entry?.navBase ?? null
      // Resolved current APY per vault: published rate, else implied-from-posts (matches the vault list/detail).
      const apy = entry?.apy ?? entry?.impliedApy ?? null
      const category = productPortfolioCategory(h.product)
      // Counted in the payment asset (navBase per share); a unit of it is worth navUsd / navBase dollars today.
      const assetUsd = navUsd != null && navBase != null && navBase > 0 ? navUsd / navBase : null
      const symbol = vaultDisplayName(h.product)
      return {
        key: h.product.productId,
        category,
        symbol,
        name: h.product.name && h.product.name !== symbol ? h.product.name : null,
        imageUrl: vaultImageFor(h.product),
        tag: catalogRowTag(h.product, category),
        units: h.shares,
        usd: navUsd != null ? positionUsdValue({ shares: h.shares, navUsd }) : null,
        apy,
        principal: principalOf(() => catalogPrincipalFlows(h.product, events, redemptions), navBase != null ? h.shares * navBase : null, apy, assetUsd),
        // Its payment asset (tUSDC, tBTC, tXRP), the unit the principal is counted in.
        asset: { symbol: h.product.paymentAssetSymbol, currentUnits: navBase != null ? h.shares * navBase : null },
      }
    }),
    // sArcoUSD at its share price (ArcoUSD per share, a dollar each) and the rate the distributor pays now.
    ...(sArcoUSDUnits > 0 && liveSavings !== null
      ? [{
          key: SARCOUSD_ROW.id,
          category: "savings" as const,
          symbol: SARCOUSD_ROW.symbol,
          name: SARCOUSD_ROW.name,
          imageUrl: SARCOUSD_ROW.imageUrl,
          tag: SARCOUSD_ROW.tag,
          units: sArcoUSDUnits,
          usd: sArcoUSDPrice !== null ? sArcoUSDUnits * sArcoUSDPrice : null,
          apy: liveSavings.apyPercent ?? null,
          principal: principalOf(
            () => sArcoUsdPrincipalFlows(events, { vault: liveSavings.sArcoUSD, zap: liveSavings.zap }),
            sArcoUSDPrice !== null ? sArcoUSDUnits * sArcoUSDPrice : null,
            liveSavings.apyPercent ?? null,
            1,
          ),
          asset: { symbol: SARCOUSD_ASSET_SYMBOL, currentUnits: sArcoUSDPrice !== null ? sArcoUSDUnits * sArcoUSDPrice : null },
        }]
      : []),
    // ArcoGOLD at its share price in dollars (ounces per share × an ounce's price) and the set rate. Without an ounce
    // price its value is unknown, never a guess.
    ...(arcoGoldUnits > 0 && gold !== null
      ? [{
          key: ARCOGOLD_ROW.id,
          category: "savings" as const,
          symbol: ARCOGOLD_ROW.symbol,
          name: ARCOGOLD_ROW.name,
          imageUrl: ARCOGOLD_ROW.imageUrl,
          tag: ARCOGOLD_ROW.tag,
          units: arcoGoldUnits,
          usd: arcoGoldMarket?.navUsd != null ? arcoGoldUnits * arcoGoldMarket.navUsd : null,
          apy: arcoGoldMarket?.apy ?? null,
          principal: principalOf(
            () => arcoGoldPrincipalFlows(events, { vault: gold.arcoGOLD, zap: gold.zap }),
            arcoGoldUnits * gold.sharePrice,
            arcoGoldMarket?.apy ?? null,
            gold.ounceUsd,
          ),
          // Ounces, named as the gold Savings account names them: its own coin (tPAXG; one coin is one troy ounce). No
          // coin read yet: no name for them, so no line.
          asset: gold.coins.length > 0 ? { symbol: goldSavingsVault(gold).paymentAssetSymbol, currentUnits: arcoGoldUnits * gold.sharePrice } : null,
        }]
      : []),
  ]

  const valued = rows.filter((row) => row.usd != null)
  const totalUsd = valued.reduce((sum, row) => sum + (row.usd as number), 0)
  const valueKnown = holdingsKnown && marketQuery.isSuccess && (rows.length === 0 || valued.length > 0)
  const currentValue = valueKnown ? totalUsd : null
  const pricesPartial = valueKnown && rows.some((row) => row.usd == null)

  // Two rates from the same holdings (portfolio-projection.ts):
  //  • earningApy: the rate of the part that earns (`earningUsd`, the holdings with an APY). The ticker and the
  //    projection grow that part at it and carry the rest (a holding without a rate) flat.
  //  • netApy, what the page shows as "Net APY": the same interest over the whole priced value, every holding without a
  //    yield counted at 0%. It is the rate the whole balance grows at — a year of the projection earns exactly
  //    netApy × value — so the Net APY, the chart's fine print and its numbers agree. "—" while nothing is priced.
  const apyHoldings = rows.filter((h) => h.apy != null && h.usd != null)
  const earningUsd = apyHoldings.reduce((sum, h) => sum + (h.usd as number), 0)
  const yearlyInterest = apyHoldings.reduce((sum, h) => sum + (h.apy as number) * (h.usd as number), 0)
  const earningApy = apyHoldings.length > 0 && earningUsd > 0 ? yearlyInterest / earningUsd : null
  const netApy = valueKnown && totalUsd > 0 ? yearlyInterest / totalUsd : null

  const totals = principalTotals(rows.map((row) => row.principal))
  const principalShown = valueKnown && !totals.loading
  const suppliedLabel = principalShown && totals.supplied !== null ? money(totals.supplied) : "—"
  const earnedLabel = principalShown && totals.earned !== null ? earnedText(totals.earned) : "—"
  const heroNotes = [
    ...(pricesPartial ? ["Partial — some asset prices are unavailable"] : []),
    ...(principalShown && totals.partial && totals.supplied !== null ? ["Partial — some holdings have no deposit record, so Supplied and Lifetime Earned leave them out"] : []),
  ]
  // The Activity summary: Net supplied is the hero's Supplied, from the same totals (portfolio-activity.ts).
  const activityTotals = principalShown && totals.supplied !== null && totals.deposited !== null ? activitySummary({ supplied: totals.supplied, deposited: totals.deposited }) : null
  const activityNotes = activityTotals === null ? [] : [
    ...(totals.partial ? ["Partial — some holdings have no deposit record, so these totals leave them out."] : []),
    ...(activityRows.some((row) => !rows.some((held) => held.key === row.holding)) ? ["Totals cover what you hold now; activity for positions you have closed is listed but not counted."] : []),
  ]
  // The chart's "Earned so far" and "Supplied" only when they are the whole portfolio's (no partial sums there).
  const chartPrincipal = principalShown && !totals.partial && totals.supplied !== null ? totals : null
  const chartEmpty = holdingsError
    ? "Your holdings could not be loaded."
    : !holdingsKnown || marketQuery.isPending
      ? "Loading your potential earnings…"
      : marketQuery.isError || currentValue === null
        ? "Current valuations are unavailable."
        : rows.length === 0
          ? "Deposit into Savings or Funds to see your potential earnings."
          : null

  const viewRows = view === "all" ? rows : rows.filter((row) => row.category === view)
  const sortValue = (row: PortfolioRow): number | null => {
    const known = row.principal.status === "known" ? row.principal : null
    return holdingsSort.key === "supplied" ? known?.supplied ?? null
      : holdingsSort.key === "earned" ? known?.earned ?? null
        : holdingsSort.key === "apy" ? row.apy
          : row.usd
  }
  // Savings then Funds (only those the view shows and the wallet holds), each sorted on its own. A group's value, share
  // and earned are shown only when every holding in it is known: never a partial sum or an inflated share.
  const groups: PortfolioHoldingGroup[] = PORTFOLIO_CATEGORIES.filter((category) => view === "all" || view === category).flatMap((category) => {
    const own = rows.filter((row) => row.category === category)
    if (own.length === 0) return []
    const priced = valueKnown && own.every((row) => row.usd != null)
    const usd = priced ? own.reduce((sum, row) => sum + (row.usd as number), 0) : null
    const earnedKnown = own.every((row) => row.principal.status === "known")
    return [{
      id: category,
      label: CATEGORY_LABEL[category],
      rows: sortByNumericKey(own, sortValue, holdingsSort.dir, (row) => row.symbol),
      usd,
      share: usd !== null && !pricesPartial && totalUsd > 0 ? (usd / totalUsd) * 100 : null,
      earned: earnedKnown ? own.reduce((sum, row) => sum + (row.principal.status === "known" ? row.principal.earned : 0), 0) : null,
    }]
  })
  // "Not earning", last and under All Portfolio only: sorted by Current value alone (largest first unless that column is
  // sorted the other way), its total over the priced coins. No share of the portfolio, no earned total.
  const idleRows: PortfolioHoldingRow[] = idle.map((coin) => ({
    key: `idle:${coin.token.toLowerCase()}`,
    symbol: coin.symbol,
    name: coin.name,
    imageUrl: coin.logo,
    tag: IDLE_ROW_TAG,
    units: coin.units,
    balance: `${tokenAmount(coin.units, savingsCoinDecimals(coin.symbol))} ${coin.symbol}`,
    usd: coin.usd,
    apy: null,
    principal: UNKNOWN,
  }))
  if (view === "all" && (idleRows.length > 0 || idleStatus !== null)) {
    groups.push({
      id: IDLE_GROUP_ID,
      label: IDLE_GROUP_LABEL,
      rows: sortByNumericKey(idleRows, (row) => row.usd, holdingsSort.key === "value" ? holdingsSort.dir : "desc", (row) => row.symbol),
      usd: idleQuery.isSuccess ? idle.reduce((sum, coin) => sum + (coin.usd ?? 0), 0) : null,
      share: null,
      earned: null,
      status: idleStatus,
    })
  }
  const table = <PortfolioHoldings groups={groups} sort={holdingsSort} onSort={(key) => setHoldingsSort((current) => nextSort(current, key))} />

  if (!wallet.address) {
    return (
      <EmptyState
        title="Connect your wallet"
        body="Connect the GIWA wallet to see your portfolio and holdings valued in USD."
        action={
          <button
            type="button"
            onClick={() => void wallet.connect()}
            className="mt-1 inline-flex items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-arco-ink)] px-4 py-2 text-sm font-medium text-[var(--color-arco-on-dark)]"
          >
            <Wallet className="size-4" />
            Connect wallet
          </button>
        }
      />
    )
  }

  const holdingsContent = (): ReactNode => {
    if (holdingsError) return <EmptyState title="Holdings could not be loaded" body="Your balance has not been confirmed. Use Refresh to try again." />
    if (!holdingsKnown) return <EmptyState title="Loading your holdings…" body="Checking your connected wallet on GIWA." />
    if (view === "savings" && viewRows.length === 0) {
      return <EmptyState title="No Savings holdings yet" body="Deposit into a Savings account to see it here." action={<Link to={GIWA_SAVINGS_ROUTE} className={LINK_BUTTON}>Open Savings</Link>} />
    }
    if (view === "funds" && viewRows.length === 0) {
      return <EmptyState title="No Funds holdings yet" body="Invest in a Fund to see it here." action={<Link to={GIWA_FUNDS_ROUTE} className={LINK_BUTTON}>Browse Funds</Link>} />
    }
    if (view === "all" && rows.length === 0 && idleRows.length === 0 && idleStatus === null) {
      return (
        <EmptyState
          title="No holdings yet"
          body="Deposit into Savings or Funds to start building your portfolio."
          action={<Link to={GIWA_FUNDS_ROUTE} className={LINK_BUTTON}>Browse products</Link>}
        />
      )
    }
    return table
  }

  const statusLines = [
    ...(marketQuery.isError ? ["Current valuations are unavailable. Use Refresh to try again."] : []),
    ...(recordsError ? ["Your deposit history could not be loaded, so Supplied and Lifetime Earned are not shown. Use Refresh to try again."] : []),
  ]

  return (
    <div className="w-full space-y-4">
      <PortfolioHero
        value={currentValue}
        earningUsd={earningUsd}
        apyPercent={earningApy}
        supplied={suppliedLabel}
        earned={earnedLabel}
        apy={netApy != null ? pctLabel(netApy) : "—"}
        notes={heroNotes}
      />
      <PortfolioEarningsChart
        value={currentValue}
        earningUsd={earningUsd}
        apyPercent={earningApy}
        netApyPercent={netApy}
        earned={chartPrincipal?.earned ?? null}
        supplied={chartPrincipal?.supplied ?? null}
        idleAssets={idleEarnings(idle)}
        emptyLabel={chartEmpty}
        today={new Date(now)}
      />
      {statusLines.map((line) => (
        <p key={line} role="status" className="text-sm text-[var(--color-arco-text-soft)]">{line}</p>
      ))}

      <section className="space-y-4 pt-4">
        <nav aria-label="Portfolio sections" className="flex items-center gap-6 border-b border-[var(--color-arco-border)]">
          {TABS.map((t) => {
            const active = tab === t.id
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                aria-current={active ? "true" : undefined}
                className={`relative -mb-px py-2.5 text-sm ${
                  active ? "font-semibold text-[var(--color-arco-ink)]" : "text-[var(--color-arco-text)]"
                }`}
              >
                {t.label}
                {active && <span className="absolute inset-x-0 bottom-0 h-[2px] bg-[var(--color-arco-ink)]" />}
              </button>
            )
          })}
          <button type="button" onClick={refresh} disabled={refreshing} className="ml-auto py-2.5 text-sm text-[var(--color-arco-text-soft)] disabled:opacity-50">{refreshing ? "Refreshing…" : "Refresh"}</button>
        </nav>

        {tab === "portfolio" ? (
          <>
            <div role="group" aria-label="Portfolio products" className="inline-flex max-w-full flex-wrap rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] p-0.5 text-sm">
              {PORTFOLIO_VIEWS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={view === option.id}
                  onClick={() => setView(option.id)}
                  className={`rounded-[var(--radius-pill)] px-3 py-1.5 sm:px-4 ${view === option.id ? SEGMENT_ACTIVE : SEGMENT_IDLE}`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            {holdingsContent()}
          </>
        ) : (
          activityError ? <EmptyState title="Activity could not be loaded" body="Your transaction history has not been confirmed. Use Refresh to try again." />
            : (
              <PortfolioActivity
                status={activityKnown ? "ready" : "loading"}
                rows={activityRows}
                assetUsdOf={activityAssetUsd({ market: marketByProduct, sArcoUsdLive: liveSavings !== null, ounceUsd: gold?.ounceUsd ?? null })}
                summary={activityTotals}
                notes={activityNotes}
              />
            )
        )}
      </section>
    </div>
  )
}

/** A balance read as a number, or 0 when it is not a positive finite one. */
function positive(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0
}

function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div
      className="flex w-full flex-col items-center gap-3 rounded-[var(--radius-strategy)] bg-[var(--color-arco-surface)] p-10 text-center"
      style={{ boxShadow: "var(--shadow-control)" }}
    >
      <Wallet className="size-6 text-[var(--color-arco-muted)]" />
      <h2 className="text-lg font-semibold text-[var(--color-arco-ink)]">{title}</h2>
      <p className="max-w-[420px] text-sm text-[var(--color-arco-text-soft)]">{body}</p>
      {action}
    </div>
  )
}
