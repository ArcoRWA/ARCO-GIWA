// The Portfolio's holdings list (look "2" with group headings "T4"): the Funds list's rows (FundsList.tsx), one rounded
// row per holding under a header row of column labels, grouped into Savings then Funds. Each group opens with its
// name, how many holdings and its share of the portfolio, its current value and what it has earned, and a thin bar of
// that share. Rows are plain list items: they show a holding, they do not open another page. Wide: Asset · Supplied ·
// Earned · APY · Current value, each dollar figure with the same amount in the holding's own asset under it (ArcoUSD,
// tBTC, tPAXG…). Phones: asset, APY, and the current value with its asset amount and what it earned under it.
//
// Last, under All Portfolio only, "Not earning": coins the wallet holds that it could deposit (portfolio-idle.ts). They
// are not part of the portfolio, so that group has no share of it and no earned total; each row shows "—" for
// Supplied, Earned and APY, and its token balance under the value.

import { useId } from "react"
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react"
import { GiwaBrandMark } from "./components"
import type { PrincipalUsd } from "./portfolio-principal"
import type { PortfolioCategory } from "./portfolio-view"
import type { SortDir } from "./sort"
import { savingsCoinDecimals } from "./savings-category"
import { tokenAmount } from "./savings-format"
import { money } from "../lib/format"

export type HoldingsSortKey = "supplied" | "earned" | "apy" | "value"

export type PortfolioHoldingRow = {
  key: string
  /** What the row leads with: the symbol customers know ("sArcoUSD", "auMINT"). */
  symbol: string
  /** The longer name after it, soft; null when the product has none of its own. */
  name: string | null
  imageUrl: string | undefined
  /** The kind chip under the name ("Stablecoins", "Gold", "Private Credit"); null for none. */
  tag: string | null
  /** The wallet's balance of the product's token, shown when the value is unknown. */
  units: number
  /** A "Not earning" row's token balance ("1,250.5 tUSDC"), soft under its value; null for a holding. */
  balance?: string | null
  usd: number | null
  apy: number | null
  principal: PrincipalUsd
  /**
   * The holding's own asset, which Supplied / Earned / Current value are also shown in (a smaller line under each):
   * its symbol as the app shows it (ArcoUSD, tBTC, tPAXG) and the position's worth in it now (null when no price per
   * share is known). Absent for a "Not earning" row.
   */
  asset?: Readonly<{ symbol: string; currentUnits: number | null }> | null
}

/** The "Not earning" group's id: coins the wallet could deposit, outside the portfolio. */
export const IDLE_GROUP_ID = "idle"
export const IDLE_GROUP_LABEL = "Not earning"
export const IDLE_ROW_TAG = "Not earning"

export type PortfolioHoldingGroup = {
  id: PortfolioCategory | typeof IDLE_GROUP_ID
  label: string
  rows: readonly PortfolioHoldingRow[]
  /** The group's current value; null when a holding in it has no price (never a partial sum). */
  usd: number | null
  /** Percent of the portfolio's valued total; null while unknown. */
  share: number | null
  /** What the group has earned; null when any holding's principal is unknown. */
  earned: number | null
  /** A quiet line under the group (its balances loading, or not read); null for none. */
  status?: string | null
}

// Asset · Supplied · Earned · APY · Current value. On a phone: asset, APY and current value, at fixed widths so the
// header and the rows line up; from 375px the value column is wide enough for its asset line ("36,034.4 ArcoUSD").
const COLS = "grid-cols-[minmax(0,1fr)_44px_92px] min-[375px]:grid-cols-[minmax(0,1fr)_44px_104px] sm:grid-cols-[minmax(200px,2.2fr)_1fr_1fr_0.7fr_1.1fr]"
const SOFT = "text-[var(--color-arco-chip-ink)]"
const HEAD = `whitespace-nowrap text-xs font-normal sm:text-sm ${SOFT}`
const WIDE_ONLY = "hidden sm:flex"
const GREEN = "text-[var(--color-arco-up-text)]"
const INK = "text-[var(--color-arco-ink)]"
/** The asset line under a figure. */
const MUTED = "text-[var(--color-arco-muted-text)]"
/** The share bar's fill per group: Savings in the navy bar scale, Funds in the warm gold one. */
const SHARE_FILL: Record<PortfolioCategory, string> = {
  savings: "bg-[var(--color-savings-bar-1)]",
  funds: "bg-[var(--color-savings-gold-bar-4)]",
}

export function pctLabel(n: number): string {
  return `${n.toFixed(2).replace(/\.?0+$/, "")}%`
}

/** "+$180.42" once anything is earned, "$0.00" before. */
export function earnedText(earned: number): string {
  return earned >= 0.005 ? `+${money(earned)}` : money(0)
}

function earnedCell(principal: PrincipalUsd): { text: string; tone: string } {
  if (principal.status !== "known") return { text: "—", tone: SOFT }
  return { text: earnedText(principal.earned), tone: principal.earned >= 0.005 ? GREEN : INK }
}

/**
 * An amount of a holding's asset as the "Not earning" balances show it (`tokenAmount`: cut, not rounded, to 2 decimals
 * for a dollar coin and 4 for any other, grouped, no forced trailing zeros). A non-zero amount the cut would show as 0
 * reads "<0.0001" ("<0.01" for a dollar coin), never "0".
 */
export function assetAmountText(units: number, symbol: string): string {
  const decimals = savingsCoinDecimals(symbol)
  if (!Number.isFinite(units)) return tokenAmount(units, decimals)
  // `tokenAmount`'s cut, with the scaled figure taken to 12 significant digits first: supplied and earned are float
  // differences (3 − 2.95 = 0.04999…) and 0.0012 × 10⁴ is 11.999…, which a bare cut shows one unit short.
  const factor = 10 ** decimals
  const text = (Math.trunc(Number((units * factor).toPrecision(12))) / factor).toLocaleString("en-US", { maximumFractionDigits: decimals })
  return units > 0 && Number(text.replace(/,/g, "")) === 0 ? `<${(10 ** -decimals).toFixed(decimals)}` : text
}

/** Earned in the asset: "+0.0012" once the dollars show something earned (≥ half a cent), "0" before, as "$0.00". */
export function earnedAssetText(principal: Extract<PrincipalUsd, { status: "known" }>, symbol: string): string {
  return principal.earned >= 0.005 && principal.earnedUnits > 0 ? `+${assetAmountText(principal.earnedUnits, symbol)}` : "0"
}

/** The smaller line under a figure: the number never truncates, a long symbol does. */
function AssetLine({ amount, symbol, cell, tone = MUTED, className = "" }: { amount: string; symbol: string; cell: string; tone?: string; className?: string }) {
  return (
    <span data-cell={cell} className={`flex min-w-0 max-w-full justify-end whitespace-nowrap font-mono text-xs leading-4 ${tone} ${className}`}>
      <span className="shrink-0">{amount}</span>
      <span className="min-w-0 truncate">{` ${symbol}`}</span>
    </span>
  )
}

/** An empty asset line: holds the line's height where a figure has none. */
function EmptyLine({ className = "" }: { className?: string }) {
  return <span aria-hidden="true" className={`block h-4 ${className}`} />
}

function valueText(row: PortfolioHoldingRow): string {
  if (row.usd !== null) return money(row.usd)
  // A "Not earning" row without a price: "—", its balance shows under it.
  return row.balance ? "—" : `${row.units.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${row.symbol}`
}

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  className,
}: {
  label: string
  sortKey: HoldingsSortKey
  sort: { key: HoldingsSortKey; dir: SortDir }
  onSort: (key: HoldingsSortKey) => void
  className: string
}) {
  const dir = sort.key === sortKey ? sort.dir : undefined
  const Icon = dir === "desc" ? ArrowDown : dir === "asc" ? ArrowUp : ArrowUpDown
  return (
    <span className={className}>
      <button
        type="button"
        aria-label={dir ? `${label}, sorted ${dir === "desc" ? "high to low" : "low to high"}` : `Sort by ${label}`}
        onClick={() => onSort(sortKey)}
        className={`${HEAD} inline-flex items-center gap-1 rounded-[var(--radius-control)] hover:text-[var(--color-arco-ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-arco-ink)]`}
      >
        {label}
        <Icon aria-hidden="true" className="size-3.5" />
      </button>
    </span>
  )
}

export function PortfolioHoldings({
  groups,
  sort,
  onSort,
}: {
  groups: readonly PortfolioHoldingGroup[]
  sort: { key: HoldingsSortKey; dir: SortDir }
  onSort: (key: HoldingsSortKey) => void
}) {
  const baseId = useId()
  return (
    <div data-testid="portfolio-holdings" className="w-full">
      <h2 className="sr-only">Holdings</h2>
      <div className={`grid ${COLS} items-center gap-x-2.5 border-b border-[var(--color-arco-border)] px-3 pb-3 min-[375px]:gap-x-3 min-[375px]:px-4 sm:gap-x-4 sm:px-5`}>
        <span className={HEAD}>Asset</span>
        <SortHeader label="Supplied" sortKey="supplied" sort={sort} onSort={onSort} className={`${WIDE_ONLY} justify-end`} />
        <SortHeader label="Earned" sortKey="earned" sort={sort} onSort={onSort} className={`${WIDE_ONLY} justify-end`} />
        <SortHeader label="APY" sortKey="apy" sort={sort} onSort={onSort} className="flex justify-end" />
        <SortHeader label="Current value" sortKey="value" sort={sort} onSort={onSort} className="flex justify-end" />
      </div>
      {groups.map((group) => (
        <section key={group.id} data-group={group.id} aria-labelledby={`${baseId}-${group.id}`} className="mt-5">
          <GroupHeading group={group} headingId={`${baseId}-${group.id}`} />
          {group.rows.length > 0 && (
            <ul aria-labelledby={`${baseId}-${group.id}`} className="mt-3 flex flex-col gap-2">
              {group.rows.map((row) => (
                <HoldingRow key={row.key} row={row} />
              ))}
            </ul>
          )}
          {group.status && (
            <p role="status" data-testid={`portfolio-group-${group.id}-status`} className={`mt-3 px-1 text-sm ${SOFT}`}>{group.status}</p>
          )}
        </section>
      ))}
    </div>
  )
}

function GroupHeading({ group, headingId }: { group: PortfolioHoldingGroup; headingId: string }) {
  const idle = group.id === IDLE_GROUP_ID
  const noun = idle ? "asset" : "holding"
  const count = group.rows.length === 1 ? `1 ${noun}` : `${group.rows.length} ${noun}s`
  return (
    <div data-testid={`portfolio-group-${group.id}`} className="px-1">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <h3 id={headingId} className={`text-[15px] font-semibold ${INK}`}>{group.label}</h3>
          {(group.rows.length > 0 || !group.status) && (
            <span className={`text-[13px] ${SOFT}`}>
              {count}
              {group.share !== null && !idle ? ` · ${pctLabel(group.share)}` : ""}
            </span>
          )}
        </div>
        <p className="flex items-baseline gap-2.5 font-mono text-sm">
          <span className={INK}>
            <span className="sr-only">Current value </span>
            {group.usd !== null ? money(group.usd) : "—"}
          </span>
          {group.earned !== null && (
            <span className={group.earned >= 0.005 ? GREEN : INK}>
              <span className="sr-only">Earned </span>
              {earnedText(group.earned)}
            </span>
          )}
        </p>
      </div>
      {/* The share bars are shares of the deposited portfolio, which "Not earning" is not part of. */}
      {group.id !== IDLE_GROUP_ID && (
        <span aria-hidden="true" className="mt-2 block h-[3px] w-full overflow-hidden rounded-full bg-[var(--color-arco-chip)]">
          <span className={`block h-full rounded-full ${SHARE_FILL[group.id]}`} style={{ width: `${Math.min(100, Math.max(0, group.share ?? 0))}%` }} />
        </span>
      )}
    </div>
  )
}

function HoldingRow({ row }: { row: PortfolioHoldingRow }) {
  const earned = earnedCell(row.principal)
  const known = row.principal.status === "known" ? row.principal : null
  const asset = row.balance ? null : row.asset ?? null
  const title = (
    <>
      {row.symbol}
      {row.name && (
        <>
          <span aria-hidden="true" className={`hidden px-1.5 ${SOFT} sm:inline`}>·</span>
          {/* On a phone the row is narrow: the symbol shows, the name is still read out. */}
          <span className={`sr-only sm:not-sr-only sm:whitespace-nowrap sm:font-normal ${SOFT}`}>{row.name}</span>
        </>
      )}
    </>
  )
  return (
    <li
      data-holding={row.key}
      className={`grid ${COLS} min-h-[68px] items-center gap-x-2.5 rounded-[var(--radius-funds-row)] border border-[var(--color-funds-row-line)] bg-[var(--color-arco-surface)] px-3 py-3 min-[375px]:gap-x-3 min-[375px]:px-4 sm:gap-x-4 sm:px-5`}
    >
      <div className="flex min-w-0 items-center gap-2.5 sm:gap-3">
        <GiwaBrandMark src={row.imageUrl} label={row.symbol} size={32} className="max-[374px]:!size-7 sm:!size-10" />
        <div className="min-w-0">
          <span className={`block truncate text-base font-medium leading-5 ${INK}`}>{title}</span>
          {row.tag && (
            <span className="mt-1 inline-block max-w-full truncate whitespace-nowrap rounded-full align-top bg-[var(--color-arco-chip)] px-1.5 py-0.5 text-[11px] leading-none text-[var(--color-arco-ink)] ring-[0.5px] ring-[var(--color-arco-border)]">
              {row.tag}
            </span>
          )}
        </div>
      </div>

      {/* Wide: each figure has its asset line under it, or an empty one of the same height, so the figures of a row
          (and the rows of a group) line up whether or not a line is shown. */}
      <div className={`${WIDE_ONLY} min-w-0 flex-col items-end`}>
        <span data-cell="supplied" className={`whitespace-nowrap font-mono text-base ${known ? INK : SOFT}`}>
          <span className="sr-only">Supplied </span>
          {known ? money(known.supplied) : "—"}
        </span>
        {known && asset ? <AssetLine cell="supplied-units" amount={assetAmountText(known.suppliedUnits, asset.symbol)} symbol={asset.symbol} /> : <EmptyLine />}
      </div>

      <div className={`${WIDE_ONLY} min-w-0 flex-col items-end`}>
        <span data-cell="earned" className={`whitespace-nowrap font-mono text-base ${earned.tone}`}>
          <span className="sr-only">Earned </span>
          {earned.text}
        </span>
        {known && asset ? <AssetLine cell="earned-units" amount={earnedAssetText(known, asset.symbol)} symbol={asset.symbol} tone={earned.tone} /> : <EmptyLine />}
      </div>

      <div className="flex min-w-0 flex-col items-end">
        <span data-cell="apy" className={`whitespace-nowrap font-mono text-sm sm:text-base ${row.apy !== null ? GREEN : SOFT}`}>
          <span className="sr-only">APY </span>
          {row.apy !== null ? pctLabel(row.apy) : "—"}
        </span>
        <EmptyLine className="hidden sm:block" />
      </div>

      <div className="flex min-w-0 flex-col items-end">
        <span data-cell="value" className={`whitespace-nowrap font-mono text-sm sm:text-base ${row.usd !== null ? INK : SOFT}`}>
          <span className="sr-only">Current value </span>
          {valueText(row)}
        </span>
        {row.balance ? (
          <span data-cell="balance" className={`text-right font-mono text-xs ${SOFT}`}>
            <span className="sr-only">Balance </span>
            {row.balance}
          </span>
        ) : (
          <>
            {/* Under a dollar figure only: without one the value already reads in tokens. */}
            {asset && asset.currentUnits !== null && row.usd !== null ? (
              <AssetLine cell="value-units" amount={assetAmountText(asset.currentUnits, asset.symbol)} symbol={asset.symbol} />
            ) : (
              <EmptyLine className="hidden sm:block" />
            )}
            {/* Phones have no Earned column: what it earned sits under the value (in dollars only, to stay compact). */}
            <span data-cell="earned-phone" className={`font-mono text-xs sm:hidden ${earned.tone}`}>
              <span className="sr-only">Earned </span>
              {earned.text}
            </span>
          </>
        )}
      </div>
    </li>
  )
}
