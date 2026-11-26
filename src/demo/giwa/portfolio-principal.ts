// Supplied and earned per Portfolio holding, from the wallet's own records. Pure: no React, no I/O.
//
// Rule: count in the asset's own units, value at today's price. For each holding
//   suppliedUnits = Σ deposits − Σ withdrawals            (in the product's asset: dollars, BTC, ounces…)
//   currentUnits  = what the position is worth in that asset now (shares × price per share in the asset)
//   earnedUnits   = currentUnits − suppliedUnits          (the interest / yield)
// and in dollars both are multiplied by today's price of one asset unit, so supplied + earned = current value
// always, and a move in the price of gold or BTC is never counted as "earned".
//
// The records cannot see everything: tokens received by a plain transfer have no deposit, tokens sent away no
// withdrawal. Rather than guess, a holding the records cannot explain is "unknown" (the page shows "—"):
//   • nothing supplied on record while the wallet holds the product;
//   • less in the position than was supplied, beyond rounding dust (sent away, or a loss we cannot tell apart);
//   • more in the position than the plausible yield on what was supplied (see `plausibleEarnedUnits`).
//
// Sources (the args are the indexed events' as the server stores them: bigints as decimal strings):
//   • Funds and catalog Savings vaults: ProductDeposit (deposit vault, `paymentAssets`), ProductDepositRequested
//     (`paymentAssets`) once a ProductDepositFulfilled with the same `requestId` is on record, ProductRedeemInstant
//     (redemption vault, `assetsOut`), and every request-based redemption (`lockedAssetsOut`, any status: the
//     shares are burned when the request is made). Amounts in the payment asset's decimals.
//   • sArcoUSD: ZapDeposit (`arcoUSDIn`) / ZapRedeem (`arcoUSDOut`) on the Savings Zap, and the vault's own
//     ERC-4626 Deposit / Withdraw (`assets`); ArcoUSD, 18 decimals.
//   • ArcoGOLD: see `arcoGoldPrincipalFlows` (provisional until the server indexes it).
import { formatUnits } from "viem"
import type { GiwaActivity, GiwaCatalogItem, GiwaRedemption } from "./types"

/** One movement of principal in the product's own asset: positive in, negative out. `at`: ms epoch, null when unknown. */
export type PrincipalFlow = Readonly<{ units: number; at: number | null }>

export type Principal =
  // depositedUnits: the inflows behind suppliedUnits (Σ deposits); what was withdrawn is depositedUnits − suppliedUnits.
  | Readonly<{ status: "known"; suppliedUnits: number; earnedUnits: number; depositedUnits: number }>
  | Readonly<{ status: "unknown"; reason: "unreadable" | "no-records" | "below-supplied" | "unexplained-balance" }>

/**
 * A holding's principal in dollars, with the same figures in the holding's own asset (`suppliedUnits` + `earnedUnits`
 * = what the position is worth in that asset now, as the dollars add up to its value).
 */
export type PrincipalUsd =
  | Readonly<{ status: "known"; supplied: number; earned: number; deposited: number; suppliedUnits: number; earnedUnits: number }>
  | Readonly<{ status: "unknown" }>
  | Readonly<{ status: "loading" }>

const YEAR_MS = 365 * 24 * 60 * 60 * 1000
/** Rounding dust: on-chain integer math and a rounded posted price can leave a hair either side of exact. */
const DUST_RELATIVE = 1e-4
const DUST_ABSOLUTE = 1e-6
/** The plausible yield: twice today's APY, and never under this floor (percent a year). */
const PLAUSIBLE_RATE_FLOOR_PCT = 20
/** A fresh deposit is given at least this long of plausible yield, so a price posted the day after is not "unknown". */
const MIN_PLAUSIBLE_WINDOW_YEARS = 0.25

// ── Reading the indexed args ──

function rawAmount(value: unknown): bigint | null {
  if (typeof value === "bigint") return value >= 0n ? value : null
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return BigInt(value.trim())
  return null
}

/** A raw base-unit amount in whole units, or null when the arg is missing or not an amount. */
function amountOf(args: Readonly<Record<string, unknown>>, key: string, decimals: number): number | null {
  const raw = rawAmount(args[key])
  return raw === null ? null : Number(formatUnits(raw, decimals))
}

function timeOf(event: GiwaActivity): number | null {
  if (!event.blockTimestamp) return null
  const ms = new Date(event.blockTimestamp).getTime()
  return Number.isFinite(ms) ? ms : null
}

const sameAddress = (a: unknown, b: string | null | undefined) =>
  typeof a === "string" && typeof b === "string" && b !== "" && a.toLowerCase() === b.toLowerCase()

function requestKey(event: GiwaActivity): string | null {
  const id = rawAmount(event.args.requestId)
  return id === null ? null : `${(event.contractAddress ?? "").toLowerCase()}:${id}`
}

/** Which indexed rows move a holding's principal: the event, the contract that emits it, its amount arg, in (+1) or out (−1). */
export type FlowRule = Readonly<{ eventName: string; contract: string | null | undefined; amountArg: string; sign: 1 | -1 }>

/** The rule an indexed row matches (event name and emitting contract, case-insensitive), or undefined. */
export function matchFlowRule(event: GiwaActivity, rules: readonly FlowRule[]): FlowRule | undefined {
  return rules.find((r) => r.eventName === event.eventName && sameAddress(event.contractAddress, r.contract))
}

/** A matched row's amount in whole asset units (unsigned), or null when it cannot be read. */
export function flowRuleUnits(event: GiwaActivity, rule: FlowRule, decimals: number): number | null {
  return amountOf(event.args, rule.amountArg, decimals)
}

/** The flows `rules` pick out of `events`, or null when a matching row's amount cannot be read. */
function flowsByRules(events: readonly GiwaActivity[], rules: readonly FlowRule[], decimals: number): PrincipalFlow[] | null {
  const flows: PrincipalFlow[] = []
  for (const event of events) {
    const rule = matchFlowRule(event, rules)
    if (!rule) continue
    const units = flowRuleUnits(event, rule, decimals)
    if (units === null) return null
    flows.push({ units: rule.sign * units, at: timeOf(event) })
  }
  return flows
}

// ── Sources ──

/** A catalog vault's instant rows: ProductDeposit on its deposit vault (in), ProductRedeemInstant on its redemption vault (out). */
export function catalogFlowRules(product: Pick<GiwaCatalogItem, "depositVaultAddress" | "redemptionVaultAddress">): FlowRule[] {
  return [
    { eventName: "ProductDeposit", contract: product.depositVaultAddress, amountArg: "paymentAssets", sign: 1 },
    { eventName: "ProductRedeemInstant", contract: product.redemptionVaultAddress, amountArg: "assetsOut", sign: -1 },
  ]
}

/**
 * A catalog vault's (Funds, and the catalog Savings vaults) principal flows in its payment asset, or null when its
 * payment asset's decimals are not known or a record cannot be read.
 */
export function catalogPrincipalFlows(
  product: Pick<GiwaCatalogItem, "productId" | "paymentAsset" | "depositVaultAddress" | "redemptionVaultAddress">,
  events: readonly GiwaActivity[],
  redemptions: readonly GiwaRedemption[],
): PrincipalFlow[] | null {
  const decimals = product.paymentAsset?.decimals
  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0) return null
  const flows = flowsByRules(events, catalogFlowRules(product), decimals)
  if (flows === null) return null
  // A deposit request takes the payment at once but mints the shares only when fulfilled: an open request is not in
  // the position yet, so it is not counted until its ProductDepositFulfilled is on record.
  const fulfilled = new Set(
    events
      .filter((e) => e.eventName === "ProductDepositFulfilled" && sameAddress(e.contractAddress, product.depositVaultAddress))
      .map(requestKey)
      .filter((key): key is string => key !== null),
  )
  for (const event of events) {
    if (event.eventName !== "ProductDepositRequested" || !sameAddress(event.contractAddress, product.depositVaultAddress)) continue
    const key = requestKey(event)
    if (key === null || !fulfilled.has(key)) continue
    const units = amountOf(event.args, "paymentAssets", decimals)
    if (units === null) return null
    flows.push({ units, at: timeOf(event) })
  }
  // Request-based redemptions burn the shares when requested, whatever their status now.
  for (const redemption of redemptions) {
    if (redemption.productId !== product.productId) continue
    const raw = rawAmount(redemption.lockedAssetsOut)
    if (raw === null) return null
    flows.push({ units: -Number(formatUnits(raw, decimals)), at: null })
  }
  return flows
}

/** ArcoUSD has 18 decimals; it is sArcoUSD's asset. */
export const ARCOUSD_DECIMALS = 18

/** sArcoUSD's rows: Zap deposits / redeems and the vault's own ERC-4626 Deposit / Withdraw, amounts in ArcoUSD. */
export function sArcoUsdFlowRules(contracts: Readonly<{ vault: string; zap: string | null }>): FlowRule[] {
  return [
    { eventName: "ZapDeposit", contract: contracts.zap, amountArg: "arcoUSDIn", sign: 1 },
    { eventName: "ZapRedeem", contract: contracts.zap, amountArg: "arcoUSDOut", sign: -1 },
    { eventName: "Deposit", contract: contracts.vault, amountArg: "assets", sign: 1 },
    { eventName: "Withdraw", contract: contracts.vault, amountArg: "assets", sign: -1 },
  ]
}

/** sArcoUSD's principal flows in ArcoUSD: Zap deposits / redeems and the vault's own ERC-4626 Deposit / Withdraw. */
export function sArcoUsdPrincipalFlows(
  events: readonly GiwaActivity[],
  contracts: Readonly<{ vault: string; zap: string | null }>,
): PrincipalFlow[] | null {
  return flowsByRules(events, sArcoUsdFlowRules(contracts), ARCOUSD_DECIMALS)
}

// ── ArcoGOLD adapter ──
// ArcoGOLD is the sArcoUSD stack again, in troy ounces (vault asset ArcoXAU, 18 decimals, 1e18 = one ounce), and the
// server stores its wallet rows with the sArcoUSD event and arg names, so gold is told apart ONLY by contractAddress:
//   ZapDeposit (gold Zap; `arcoUSDIn` = ArcoXAU into the vault after the swap fee) · ZapRedeem (gold Zap; `arcoUSDOut`)
//   Deposit / Withdraw (the ArcoGOLD vault, direct and rare; `assets`).
// The Zap's inner vault Deposit carries no walletAddress, so one app deposit is one row. The addresses are the live
// gold reads' own (ArcoGoldLiveContext: /api/v1/arcogold/savings `contracts.arcoGOLD` / `contracts.zap`), matched
// case-insensitively. Should the server shape change, adjust the names and decimals HERE ONLY.
export const ARCOGOLD_ASSET_DECIMALS = 18
const ARCOGOLD_RULES = {
  vaultDeposit: { eventName: "Deposit", amountArg: "assets" },
  vaultWithdraw: { eventName: "Withdraw", amountArg: "assets" },
  zapDeposit: { eventName: "ZapDeposit", amountArg: "arcoUSDIn" },
  zapRedeem: { eventName: "ZapRedeem", amountArg: "arcoUSDOut" },
} as const

/** ArcoGOLD's rows (gold Zap and the ArcoGOLD vault), amounts in ounces. */
export function arcoGoldFlowRules(contracts: Readonly<{ vault: string; zap: string | null }>): FlowRule[] {
  return [
    { ...ARCOGOLD_RULES.vaultDeposit, contract: contracts.vault, sign: 1 },
    { ...ARCOGOLD_RULES.vaultWithdraw, contract: contracts.vault, sign: -1 },
    { ...ARCOGOLD_RULES.zapDeposit, contract: contracts.zap, sign: 1 },
    { ...ARCOGOLD_RULES.zapRedeem, contract: contracts.zap, sign: -1 },
  ]
}

/** ArcoGOLD's principal flows in ounces. With no gold rows on record the holding comes out "unknown", never zero. */
export function arcoGoldPrincipalFlows(
  events: readonly GiwaActivity[],
  contracts: Readonly<{ vault: string; zap: string | null }>,
): PrincipalFlow[] | null {
  return flowsByRules(events, arcoGoldFlowRules(contracts), ARCOGOLD_ASSET_DECIMALS)
}

// ── Principal ──

/**
 * The most yield `suppliedUnits` could plausibly have earned since `firstDepositAt`: compounding at twice today's APY
 * (at least 20% a year) for at least a quarter of a year; a year when no deposit carries a date. More than this is
 * not yield the records can explain: tokens arrived some other way.
 */
export function plausibleEarnedUnits(suppliedUnits: number, apyPercent: number | null, firstDepositAt: number | null, now: number): number {
  const ratePct = Math.max(PLAUSIBLE_RATE_FLOOR_PCT, 2 * (apyPercent !== null && Number.isFinite(apyPercent) ? apyPercent : 0))
  const years = firstDepositAt === null ? 1 : Math.max(MIN_PLAUSIBLE_WINDOW_YEARS, (now - firstDepositAt) / YEAR_MS)
  return suppliedUnits * (Math.pow(1 + ratePct / 100, years) - 1)
}

export function principalFromFlows(input: {
  flows: readonly PrincipalFlow[] | null
  /** What the position is worth now, in the product's asset. */
  currentUnits: number
  apyPercent: number | null
  now: number
}): Principal {
  const { flows, currentUnits } = input
  if (flows === null || !Number.isFinite(currentUnits) || currentUnits < 0) return { status: "unknown", reason: "unreadable" }
  const supplied = flows.reduce((sum, flow) => sum + flow.units, 0)
  const deposited = flows.reduce((sum, flow) => sum + Math.max(0, flow.units), 0)
  const dust = Math.max(DUST_RELATIVE * Math.max(Math.abs(supplied), currentUnits), DUST_ABSOLUTE)
  if (supplied <= dust) return { status: "unknown", reason: "no-records" }
  const earned = currentUnits - supplied
  if (earned < -dust) return { status: "unknown", reason: "below-supplied" }
  // Within dust below: the position is what was supplied, nothing earned yet.
  if (earned < 0) return { status: "known", suppliedUnits: currentUnits, earnedUnits: 0, depositedUnits: deposited }
  const dated = flows.filter((flow) => flow.units > 0 && flow.at !== null).map((flow) => flow.at as number)
  const firstDepositAt = dated.length > 0 ? Math.min(...dated) : null
  if (earned > plausibleEarnedUnits(supplied, input.apyPercent, firstDepositAt, input.now) + dust) {
    return { status: "unknown", reason: "unexplained-balance" }
  }
  return { status: "known", suppliedUnits: supplied, earnedUnits: earned, depositedUnits: deposited }
}

/** A principal in dollars at today's price of one asset unit; unknown without a price. */
export function principalUsd(principal: Principal, assetUsd: number | null): PrincipalUsd {
  if (principal.status !== "known" || assetUsd === null || !Number.isFinite(assetUsd) || !(assetUsd > 0)) return { status: "unknown" }
  return {
    status: "known",
    supplied: principal.suppliedUnits * assetUsd,
    earned: principal.earnedUnits * assetUsd,
    deposited: principal.depositedUnits * assetUsd,
    suppliedUnits: principal.suppliedUnits,
    earnedUnits: principal.earnedUnits,
  }
}

export type PrincipalTotals = Readonly<{
  /** Sum over the holdings whose principal is known; null when none is (or any is still loading). */
  supplied: number | null
  earned: number | null
  /** The deposits behind `supplied` (same holdings, today's prices); withdrawn = deposited − supplied. */
  deposited: number | null
  /** Some holdings are left out of the sums (unknown principal). */
  partial: boolean
  loading: boolean
}>

export function principalTotals(rows: readonly PrincipalUsd[]): PrincipalTotals {
  if (rows.some((row) => row.status === "loading")) return { supplied: null, earned: null, deposited: null, partial: false, loading: true }
  if (rows.length === 0) return { supplied: 0, earned: 0, deposited: 0, partial: false, loading: false }
  const known = rows.filter((row): row is Extract<PrincipalUsd, { status: "known" }> => row.status === "known")
  if (known.length === 0) return { supplied: null, earned: null, deposited: null, partial: false, loading: false }
  return {
    supplied: known.reduce((sum, row) => sum + row.supplied, 0),
    earned: known.reduce((sum, row) => sum + row.earned, 0),
    deposited: known.reduce((sum, row) => sum + row.deposited, 0),
    partial: known.length < rows.length,
    loading: false,
  }
}
