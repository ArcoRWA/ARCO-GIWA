import { encodeFunctionData, formatUnits, getAddress, isAddress, type Address } from "viem"
import { surplusTransferAbi, parseTopUpAmount, type TopUpWalletReader } from "../arcousd/admin.js"
import { scrubUrls } from "../arcousd/safe-error.js"
import { unsignedAdminTransaction, type UnsignedAdminTransaction } from "../evm/admin-transactions.js"
import { deployedArcoGold, type ArcoGoldRegistryFile, type DeployedArcoGold } from "./registry.js"

// The one gold transaction the console builds: a plain transfer of a gold coin (tPAXG, tXAUT) from the signed-in
// operator's wallet to the gold Reserve. Backing rises and no ArcoXAU is minted, so it is surplus the ArcoGOLD
// distributor pays out as yield (the gold twin of ArcoUSDAdmin.addSurplusTransaction). No chain writes here: the
// operator signs in the console. A transfer needs no role, and nothing can return it.

/** The most one transfer may carry, in ounces: far above any test top-up, far below a typo's damage. */
export const MAX_GOLD_SURPLUS_OUNCES = 10_000

export type GoldAddSurplusResult =
  | {
      readonly ok: true
      readonly symbol: string
      /** The coin's address (checksummed). */
      readonly asset: string
      readonly decimals: number
      /** In the coin's base units. */
      readonly amount: string
      readonly amountHuman: string
      /** The operator wallet: it pays the coin and signs. It receives nothing back. */
      readonly from: string
      readonly balanceHuman: string
      /** The gold Reserve the coins go to (checksummed). */
      readonly reserve: string
      /**
       * Gold Reserve surplus (backing − liabilities) at the last read and with this transfer added at one ounce per
       * coin, in ounces; null when the Reserve could not be read. The distributor's margin is not taken off here.
       */
      readonly surplusBeforeOunces: string | null
      readonly surplusAfterOunces: string | null
      readonly transaction: UnsignedAdminTransaction
    }
  | { readonly ok: false; readonly status: 400 | 409 | 503; readonly error: string }

export class ArcoGoldAdmin {
  constructor(
    private readonly deps: {
      readonly chainId: number
      readonly loadRegistry: () => ArcoGoldRegistryFile | null
      readonly readWallet?: TopUpWalletReader
      /** Gold Reserve surplus (backing − liabilities), base18 ounces; null when it cannot be read. */
      readonly liveSurplus?: () => Promise<string | null>
    },
  ) {}

  async addSurplusTransaction(input: { asset?: unknown; amount?: unknown; from?: string | null }): Promise<GoldAddSurplusResult> {
    let gold: DeployedArcoGold | null
    try {
      gold = deployedArcoGold(this.deps.loadRegistry(), this.deps.chainId)
    } catch (error) {
      return { ok: false, status: 503, error: `ArcoGOLD registry is invalid: ${errorText(error)}` }
    }
    if (!gold) return { ok: false, status: 409, error: "ArcoGOLD is not deployed" }
    if (!gold.distributorAddress) {
      return { ok: false, status: 409, error: "ArcoGOLD has no distributor: surplus sent now could not be paid out as yield" }
    }
    if (typeof input.from !== "string" || !isAddress(input.from)) {
      return { ok: false, status: 400, error: "Sign in with an operator wallet: the surplus is paid from and signed by that wallet" }
    }
    const wanted = typeof input.asset === "string" ? input.asset.trim() : ""
    const asset = gold.reserveAssets.find(
      (candidate) => candidate.address !== null && (candidate.symbol === wanted || (isAddress(wanted) && candidate.address.toLowerCase() === wanted.toLowerCase())),
    )
    if (!asset || !asset.address) return { ok: false, status: 400, error: "asset must be a gold Reserve coin symbol or address from the ArcoGOLD registry" }
    const amount = parseTopUpAmount(input.amount, asset.decimals)
    if (amount === null || amount > BigInt(MAX_GOLD_SURPLUS_OUNCES) * 10n ** BigInt(asset.decimals)) {
      return {
        ok: false,
        status: 400,
        error: `amount must be a positive ${asset.symbol} amount with at most ${asset.decimals} decimals, up to ${MAX_GOLD_SURPLUS_OUNCES.toLocaleString("en-US")}`,
      }
    }
    if (!this.deps.readWallet) return { ok: false, status: 503, error: "Chain reads are unavailable on this server" }
    const from = getAddress(input.from) as Address
    const reserve = getAddress(gold.reserveAddress) as Address
    const assetAddress = getAddress(asset.address) as Address
    let wallet: { balance: bigint }
    try {
      wallet = await this.deps.readWallet({ asset: assetAddress, owner: from, spender: reserve })
    } catch (error) {
      return { ok: false, status: 503, error: `Could not read the wallet's ${asset.symbol}: ${errorText(error)}` }
    }
    const amountHuman = formatUnits(amount, asset.decimals)
    if (wallet.balance < amount) {
      return {
        ok: false,
        status: 409,
        error: `The wallet holds ${ouncesText(wallet.balance, asset.decimals)} ${asset.symbol}, less than the ${amountHuman} ${asset.symbol} of this transfer`,
      }
    }
    // Surplus is read for the preview only; an unread Reserve does not stop a transfer the wallet can make.
    let surplusBefore: bigint | null = null
    try {
      const surplus = (await this.deps.liveSurplus?.()) ?? null
      if (surplus !== null) surplusBefore = BigInt(surplus)
    } catch {
      surplusBefore = null
    }
    const added = asset.decimals <= 18 ? amount * 10n ** BigInt(18 - asset.decimals) : amount / 10n ** BigInt(asset.decimals - 18)
    const transaction = unsignedAdminTransaction(
      gold.chainId,
      assetAddress,
      encodeFunctionData({ abi: surplusTransferAbi, functionName: "transfer", args: [reserve, amount] }),
      `${asset.symbol}: send ${amountHuman} ${asset.symbol} from this wallet to the gold Reserve as surplus; nothing is minted or returned (transfer)`,
    )
    return {
      ok: true,
      symbol: asset.symbol,
      asset: assetAddress,
      decimals: asset.decimals,
      amount: amount.toString(),
      amountHuman,
      from,
      balanceHuman: formatUnits(wallet.balance, asset.decimals),
      reserve,
      surplusBeforeOunces: surplusBefore === null ? null : formatUnits(surplusBefore, 18),
      surplusAfterOunces: surplusBefore === null ? null : formatUnits(surplusBefore + added, 18),
      transaction,
    }
  }
}

/** Ounce amounts in errors: up to 4 decimals (the gold display rule), no forced zeros. */
function ouncesText(amount: bigint, decimals: number): string {
  return Number(formatUnits(amount, decimals)).toLocaleString("en-US", { maximumFractionDigits: 4 })
}

// Without RPC URLs: their path carries the provider key.
function errorText(error: unknown): string {
  return scrubUrls(error instanceof Error ? error.message : String(error))
}
