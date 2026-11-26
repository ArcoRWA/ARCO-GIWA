import { formatUnits } from "viem"
import { tokenSymbolFor, vaultConfigOf, vaultDisplayName, vaultImageFor } from "./catalog"
import {
  ARCOGOLD_ASSET_DECIMALS, ARCOUSD_DECIMALS, arcoGoldFlowRules, catalogFlowRules, flowRuleUnits, matchFlowRule, sArcoUsdFlowRules,
  type FlowRule,
} from "./portfolio-principal"
import type { GiwaActivity, GiwaCatalogItem, GiwaRedemption } from "./types"

// Builds the personal-portfolio Activity feed. Two streams merge into ONE time-ordered list,
// de-duplicated so a redemption never appears twice:
//   • deposits + INSTANT redeems come from indexed on-chain events (EvmIndexedEvent);
//   • request-based redemptions come from IndexedRedemptionRequest ONLY — the matching
//     ProductRedeemRequested/Fulfilled/Claimed events are intentionally excluded.
//   • the wallet's own ArcoUSD Savings (sArcoUSD) and ArcoGOLD actions: ZapDeposit / ZapRedeem on each Zap and the
//     vault's own ERC-4626 Deposit / Withdraw, told apart ONLY by contractAddress with portfolio-principal.ts's rules
//     (the same rows, args and decimals Supplied counts). The server attributes a row to a wallet only for the
//     wallet's own action (server/src/arcousd/activity.ts): a Zap's inner vault step carries no walletAddress and is
//     never returned, so one app deposit is one row.
//   • left out: ArcoUSD Reserve mint / redeem rows (Deposited, RedeemedInstant, RedeemQueued…: ArcoUSD itself is no
//     Savings position, and an ArcoUSD minted then put into sArcoUSD would be counted twice), FaucetDrip, and
//     everything operational.
// Every Amount is the product-token share count (18-dec); every vault is resolved config-first
// via the shared catalog resolver so identity matches the vault list / holdings table.
// `assetUnits` is what moved in the product's own asset (payment asset, ArcoUSD, ounces): the unit Supplied counts in,
// valued at today's price by the Activity tab.

const SHARE_DECIMALS = 18

export type ActivityKind = "deposit" | "withdraw" | "request" | "pending" | "complete"
/** Which way the money moved: into a product, out of it, or on its way out (a redemption not yet paid). */
export type ActivityDirection = "in" | "out" | "pending"

// Figma-verbatim labels + token tone classes (mirror redemptionBadge in components.tsx).
const TYPE_LABEL: Record<ActivityKind, string> = {
  deposit: "Deposit",
  withdraw: "Withdraw",
  request: "Redemption request",
  pending: "Pending",
  complete: "Redemption complete",
}
const TYPE_TONE: Record<ActivityKind, string> = {
  deposit: "text-[var(--color-arco-text-soft)]",
  withdraw: "text-[var(--color-arco-up)]",
  request: "text-[var(--color-arco-text-soft)]",
  pending: "text-[var(--color-arco-text-soft)]",
  complete: "text-[var(--color-arco-up)]",
}
const DIRECTION: Record<ActivityKind, ActivityDirection> = {
  deposit: "in",
  withdraw: "out",
  complete: "out",
  request: "pending",
  pending: "pending",
}

// A redemption request whose status is one of these has paid out → "Redemption complete".
// Otherwise: REQUESTED → "Redemption request" (awaiting operator action), SETTLING (and any
// unknown status) → "Pending" (payout in flight).
const COMPLETE_STATUSES = new Set(["SETTLED", "FULFILLED", "CLAIMED", "COMPLETED"])

/** The Portfolio holdings' keys for the two Savings positions that are not catalog products (PortfolioPage rows). */
export const SARCOUSD_HOLDING = "arcousd:sArcoUSD"
export const ARCOGOLD_HOLDING = "arcogold:ArcoGOLD"

/** The live Savings contracts whose rows the feed lists; null while that stack is not live. */
export type ActivitySavingsContracts = Readonly<{
  sArcoUSD: Readonly<{ vault: string; zap: string | null }> | null
  arcoGold: Readonly<{ vault: string; zap: string | null }> | null
}>

export type ActivityProduct = {
  productId: string | null
  symbol: string
  name: string
  imageUrl: string | undefined
  category: string | null
}

export type ActivityRow = {
  key: string
  kind: ActivityKind
  typeLabel: string
  typeTone: string
  direction: ActivityDirection
  date: string // "2026-07-11 12:33:12" (UTC), or "—" when unknown
  sortTs: number // ms epoch for ordering; 0 when unknown (sinks to the bottom until backfilled)
  product: ActivityProduct
  amount: string // human token count + symbol, e.g. "1.5 bEQTY"
  /** The product-token count moved (what `amount` shows). */
  tokenAmount: number
  /** What moved in the product's own asset (unsigned); null when it cannot be read. */
  assetUnits: number | null
  /** The Portfolio holding this row belongs to (catalog productId, SARCOUSD_HOLDING, ARCOGOLD_HOLDING); null when unresolved. */
  holding: string | null
  txHash: string | null
}

function toBigIntSafe(value: unknown): bigint {
  if (typeof value === "bigint") return value
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value))
  if (typeof value === "string" && value.trim() !== "") {
    try {
      return BigInt(value)
    } catch {
      return 0n
    }
  }
  return 0n
}

function argString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined
}

// Human product-token count from a raw base-unit amount (18-dec shares), trimmed to <=6 places.
function shareCount(raw: unknown): number {
  return Number(formatUnits(toBigIntSafe(raw), SHARE_DECIMALS))
}
function trimShares(n: number): string {
  if (!Number.isFinite(n)) return "0"
  return n.toFixed(6).replace(/\.?0+$/, "") || "0"
}

// Full datetime "YYYY-MM-DD HH:MM:SS" in UTC. Block timestamps are UTC, and ISO slicing keeps
// the rendered value stable across viewer locales/timezones (toLocale* would not). Unknown → "—".
function formatDate(iso: string | null | undefined): { text: string; ts: number } {
  if (!iso) return { text: "—", ts: 0 }
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return { text: "—", ts: 0 }
  return { text: date.toISOString().slice(0, 19).replace("T", " "), ts: date.getTime() }
}

/** A payment asset's decimals, or null when the catalog does not give them. */
function paymentDecimals(item: GiwaCatalogItem | null): number | null {
  const decimals = item?.paymentAsset?.decimals
  return typeof decimals === "number" && Number.isInteger(decimals) && decimals >= 0 ? decimals : null
}

/** An unsigned raw base-unit amount in whole units, or null when it is not one. */
function unitsOf(raw: unknown, decimals: number | null): number | null {
  if (decimals === null) return null
  const text = typeof raw === "string" ? raw.trim() : typeof raw === "number" && Number.isSafeInteger(raw) ? String(raw) : null
  return text !== null && /^\d+$/.test(text) ? Number(formatUnits(BigInt(text), decimals)) : null
}

// Resolve a vault config-first (admin displayName/image → legacy symbol/icon), matching an
// event's contractAddress against catalog vault/token addresses or a productId.
function resolveProduct(
  products: GiwaCatalogItem[],
  opts: { contractAddress?: string; productId?: string; fallbackSymbol?: string },
): { product: ActivityProduct; item: GiwaCatalogItem | null } {
  const addr = (opts.contractAddress ?? "").toLowerCase()
  const item = products.find((candidate) => {
    if (opts.productId && candidate.productId === opts.productId) return true
    if (!addr) return false
    return [candidate.depositVaultAddress, candidate.redemptionVaultAddress, candidate.productTokenAddress].some(
      (address) => typeof address === "string" && address.toLowerCase() === addr,
    )
  })
  if (!item) {
    const symbol = opts.fallbackSymbol ?? "GIWA"
    return { product: { productId: opts.productId ?? null, symbol, name: symbol, imageUrl: undefined, category: null }, item: null }
  }
  return {
    product: {
      productId: item.productId,
      symbol: tokenSymbolFor(item),
      name: vaultDisplayName(item),
      imageUrl: vaultImageFor(item),
      category: vaultConfigOf(item).category ?? null,
    },
    item,
  }
}

function row(kind: ActivityKind, base: Omit<ActivityRow, "kind" | "typeLabel" | "typeTone" | "direction">): ActivityRow {
  return { ...base, kind, typeLabel: TYPE_LABEL[kind], typeTone: TYPE_TONE[kind], direction: DIRECTION[kind] }
}

// The two Savings positions that are not catalog products: their identity in the feed and their rows' rules.
type SavingsSource = Readonly<{ holding: string; product: ActivityProduct; rules: FlowRule[]; decimals: number }>

function savingsSources(savings: ActivitySavingsContracts | undefined): SavingsSource[] {
  const sources: SavingsSource[] = []
  if (savings?.sArcoUSD) {
    sources.push({
      holding: SARCOUSD_HOLDING,
      product: { productId: null, symbol: "sArcoUSD", name: "sArcoUSD", imageUrl: "/logos/sarcousd.png", category: null },
      rules: sArcoUsdFlowRules(savings.sArcoUSD),
      decimals: ARCOUSD_DECIMALS,
    })
  }
  if (savings?.arcoGold) {
    sources.push({
      holding: ARCOGOLD_HOLDING,
      product: { productId: null, symbol: "ArcoGOLD", name: "ArcoGOLD", imageUrl: "/logos/arcogold.png", category: null },
      rules: arcoGoldFlowRules(savings.arcoGold),
      decimals: ARCOGOLD_ASSET_DECIMALS,
    })
  }
  return sources
}

// An sArcoUSD / ArcoGOLD row (matched by its emitting contract): a deposit in, a withdrawal out. `shares` is the
// vault token moved (ZapDeposit / ZapRedeem / Deposit / Withdraw all carry it).
function rowFromSavingsEvent(event: GiwaActivity, index: number, sources: readonly SavingsSource[]): ActivityRow | null {
  for (const source of sources) {
    const rule = matchFlowRule(event, source.rules)
    if (!rule) continue
    const tokenAmount = shareCount(event.args.shares)
    const date = formatDate(event.blockTimestamp)
    return row(rule.sign > 0 ? "deposit" : "withdraw", {
      key: `evt:${event.txHash}:${index}`,
      date: date.text,
      sortTs: date.ts,
      product: source.product,
      amount: `${trimShares(tokenAmount)} ${source.product.symbol}`,
      tokenAmount,
      assetUnits: flowRuleUnits(event, rule, source.decimals),
      holding: source.holding,
      txHash: event.txHash || null,
    })
  }
  return null
}

// Deposits + instant redeems from indexed events. Every other eventName (including
// ProductRedeemRequested/Fulfilled/Claimed) is skipped so redemptions come solely from the
// request stream below — no double-appearance.
function rowFromEvent(event: GiwaActivity, index: number, products: GiwaCatalogItem[]): ActivityRow | null {
  const kind: ActivityKind | null =
    event.eventName === "ProductDeposit" ? "deposit" : event.eventName === "ProductRedeemInstant" ? "complete" : null
  if (!kind) return null
  const { product, item } = resolveProduct(products, {
    contractAddress: event.contractAddress,
    productId: argString(event.args, "productId"),
    fallbackSymbol: argString(event.args, "symbol"),
  })
  // Deposit → shares minted (sharesOut); instant redeem → shares burned (sharesIn).
  const tokenAmount = shareCount(kind === "deposit" ? event.args.sharesOut : event.args.sharesIn)
  // The asset moved, read by the same rule Supplied uses (paymentAssets in, assetsOut out).
  const rule = item ? matchFlowRule(event, catalogFlowRules(item)) : undefined
  const decimals = paymentDecimals(item)
  const date = formatDate(event.blockTimestamp)
  return row(kind, {
    key: `evt:${event.txHash}:${index}`,
    date: date.text,
    sortTs: date.ts,
    product,
    amount: `${trimShares(tokenAmount)} ${product.symbol}`,
    tokenAmount,
    assetUnits: rule && decimals !== null ? flowRuleUnits(event, rule, decimals) : null,
    holding: item?.productId ?? null,
    txHash: event.txHash || null,
  })
}

// Request-based redemptions: REQUESTED → Redemption request, SETTLING (or unknown) → Pending,
// SETTLED (and legacy FULFILLED/CLAIMED) → Redemption complete; dated by createdAt/settledAt.
function rowFromRedemption(redemption: GiwaRedemption, products: GiwaCatalogItem[]): ActivityRow {
  const status = String(redemption.status).toUpperCase()
  const complete = COMPLETE_STATUSES.has(status)
  const kind: ActivityKind = complete ? "complete" : status === "REQUESTED" ? "request" : "pending"
  const { product, item } = resolveProduct(products, { productId: redemption.productId, fallbackSymbol: undefined })
  const date = formatDate(complete ? redemption.settledAt ?? redemption.createdAt : redemption.createdAt)
  const txHash = complete ? redemption.settledTxHash ?? redemption.requestedTxHash : redemption.requestedTxHash
  const tokenAmount = shareCount(redemption.sharesIn)
  return row(kind, {
    key: `redeem:${redemption.redemptionVaultAddress}:${redemption.requestId}`,
    date: date.text,
    sortTs: date.ts,
    product,
    amount: `${trimShares(tokenAmount)} ${product.symbol}`,
    tokenAmount,
    // The assets locked for the payout when requested: what Supplied takes out for it.
    assetUnits: unitsOf(redemption.lockedAssetsOut, paymentDecimals(item)),
    holding: item?.productId ?? null,
    txHash: txHash ?? null,
  })
}

export function buildActivityFeed(
  events: GiwaActivity[],
  redemptions: GiwaRedemption[],
  products: GiwaCatalogItem[],
  savings?: ActivitySavingsContracts,
): ActivityRow[] {
  const sources = savingsSources(savings)
  const fromEvents = events
    .map((event, index) => rowFromSavingsEvent(event, index, sources) ?? rowFromEvent(event, index, products))
    .filter((r): r is ActivityRow => r !== null)
  const fromRedemptions = redemptions.map((redemption) => rowFromRedemption(redemption, products))
  // Newest first. Rows with an unknown date (sortTs 0 — un-backfilled events) sink to the bottom.
  return [...fromEvents, ...fromRedemptions].sort((a, b) => b.sortTs - a.sortTs)
}
