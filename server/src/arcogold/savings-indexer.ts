import type { RawEvmLog } from "../indexer/event-decoder.js"
import type { GiwaIndexerCursor, GiwaIndexerRpc } from "../indexer/giwa-indexer.js"
import type { PrismaArcoService } from "../services/prisma-arco-service.js"
import type { IndexedEventInput, JsonObject } from "../services/types.js"
import { distributorEventsAbi, savingsVaultEventsAbi, savingsZapEventsAbi } from "../arcousd/abi.js"
import { savingsEventWallet, upsertIndexedEvent, withActivityWallet, type IndexedEventDelegate } from "../arcousd/activity.js"
import { decodeWith } from "../arcousd/savings-indexer.js"
import { deployedArcoGold, type ArcoGoldRegistryFile, type DeployedArcoGold } from "./registry.js"

// ArcoGOLD Savings indexer: the gold twin of the sArcoUSD Savings indexer (server/src/arcousd/savings-indexer.ts), so a
// wallet's own ArcoGOLD deposits and withdrawals reach the portfolio Activity feed (/api/v1/activity/:wallet).
// ArcoGOLD is SArcoUSDNamed (the sArcoUSD contract under another name) over the ounce unit ArcoXAU, with its own
// ArcoSavingsZap and ArcoUSDSavingsDistributor, so the events, their names and their args are sArcoUSD's and the
// attribution rules are the same (savingsEventWallet):
//   • every ArcoGOLD vault, gold Zap and gold distributor event → EvmIndexedEvent, except ArcoGOLD Transfer and Approval
//     (every deposit and withdrawal already has its Deposit / Withdraw), `contractAddress` = the emitting contract;
//   • a saver's own action carries `walletAddress`: ZapDeposit (receiver), ZapRedeem (caller), or a direct ArcoGOLD
//     Deposit / Withdraw (owner). The vault steps the Zap makes (sender = the Zap), the seed (owner 0x…dEaD), rewards
//     and everything operational belong to nobody.
// The gold Reserve is not indexed: a Savings deposit's Reserve leg (coin → ArcoXAU) is the Zap's internal step.
// Its own cursor ("arcogold-savings") starts at the gold deploy block, so the first run backfills from the start; events
// are upserted, so a re-run (a cursor moved back) never duplicates. Inert (no RPC calls) until the gold registry file
// lists a deployed stack. No share-price snapshots here (the gold savings service reads the chain).

export type GoldSavingsIndexerStore = {
  getCursor(chainId: number, name: string): Promise<GiwaIndexerCursor | null>
  upsertCursor(input: {
    chainId: number
    name: string
    fromBlock: bigint
    lastBlock: bigint
    lastBlockHash: string | null
    confirmations: number
    lagBlocks: number
  }): Promise<unknown>
  insertIndexedEvent(input: IndexedEventInput): Promise<unknown>
}

export type GoldSavingsIndexerPollResult =
  | { readonly mode: "inert"; readonly reason: string }
  | {
      readonly mode: "poll"
      readonly indexedEvents: number
      readonly fromBlock: bigint
      readonly toBlock: bigint
      readonly latestBlock: bigint
      readonly lagBlocks: number
      readonly reorgDetected: boolean
    }

export const GOLD_SAVINGS_CURSOR = "arcogold-savings"
/** Decoded but not stored (see the header). */
const SKIPPED_VAULT_EVENTS = new Set(["Transfer", "Approval"])

type Decoded = { eventName: string; args: JsonObject }

/** A log from ArcoGOLD, the gold Zap or the gold distributor, decoded; null for anything else. */
export function decodeGoldSavingsLog(log: RawEvmLog, gold: Pick<DeployedArcoGold, "vaultAddress" | "zapAddress" | "distributorAddress">): Decoded | null {
  const address = log.address.toLowerCase()
  if (address === gold.vaultAddress.toLowerCase()) {
    const decoded = decodeWith(savingsVaultEventsAbi, log)
    return decoded && !SKIPPED_VAULT_EVENTS.has(decoded.eventName) ? decoded : null
  }
  if (address === gold.zapAddress.toLowerCase()) return decodeWith(savingsZapEventsAbi, log)
  if (gold.distributorAddress && address === gold.distributorAddress.toLowerCase()) return decodeWith(distributorEventsAbi, log)
  return null
}

/** The contracts whose logs are read: the vault, the Zap and, once there is one, the distributor (lowercase). */
export function goldSavingsAddresses(gold: Pick<DeployedArcoGold, "vaultAddress" | "zapAddress" | "distributorAddress">): `0x${string}`[] {
  return [gold.vaultAddress, gold.zapAddress, gold.distributorAddress]
    .filter((address): address is `0x${string}` => address !== null)
    .map((address) => address.toLowerCase() as `0x${string}`)
}

function toBigInt(value: bigint | number): bigint {
  return typeof value === "bigint" ? value : BigInt(value)
}

export class ArcoGoldSavingsIndexer {
  private lastGoodRegistry: ArcoGoldRegistryFile | null = null

  constructor(
    private readonly options: {
      /** Re-read each poll so a gold deploy (or its distributor) is picked up without a restart. */
      readonly loadRegistry: () => ArcoGoldRegistryFile | null
      readonly rpc: GiwaIndexerRpc
      readonly store: GoldSavingsIndexerStore
      readonly confirmations: number
      readonly maxBlockRange: bigint
      /**
       * Block ranges read in one poll while behind (default 1). Each range is stored and the cursor saved before the
       * next, so a failure midway keeps what was done. Lets the first run's backfill catch up in minutes.
       */
      readonly maxRangesPerPoll?: number
      readonly reorgDepth?: bigint
    },
  ) {}

  // Same rule as the ArcoUSD indexers: a read/parse failure keeps the last good copy; a file that reads fine but fails
  // validation throws (deployedArcoGold) so it is loud in the logs.
  private registry(): ArcoGoldRegistryFile | null {
    try {
      this.lastGoodRegistry = this.options.loadRegistry()
    } catch (error) {
      console.warn(
        `[arcogold-savings-indexer] registry reload failed; keeping last-good: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return this.lastGoodRegistry
  }

  async pollOnce(): Promise<GoldSavingsIndexerPollResult> {
    const registry = this.registry()
    if (!registry?.deployed) return { mode: "inert", reason: "ArcoGOLD registry missing or not deployed" }
    const chainId = await this.options.rpc.getChainId()
    if (chainId !== registry.chainId) {
      throw new Error(`RPC chainId ${chainId} does not match ArcoGOLD registry chainId ${registry.chainId}`)
    }
    const gold = deployedArcoGold(registry, chainId)
    if (!gold) return { mode: "inert", reason: "ArcoGOLD registry not deployed" }

    const startBlock = BigInt(gold.deploymentBlock)
    const latestBlock = await this.options.rpc.getBlockNumber()
    const confirmedBlock = latestBlock - BigInt(this.options.confirmations)
    const idle = (fromBlock: bigint, toBlock: bigint, lagBlocks: number, reorgDetected: boolean) => ({
      mode: "poll" as const,
      indexedEvents: 0,
      fromBlock,
      toBlock,
      latestBlock,
      lagBlocks,
      reorgDetected,
    })
    if (confirmedBlock < startBlock) return idle(startBlock, startBlock, 0, false)

    const cursor = await this.options.store.getCursor(chainId, GOLD_SAVINGS_CURSOR)
    let fromBlock = cursor ? toBigInt(cursor.lastBlock) + 1n : startBlock
    let reorgDetected = false
    if (cursor?.lastBlockHash) {
      const lastBlock = toBigInt(cursor.lastBlock)
      const canonical = await this.options.rpc.getBlock({ blockNumber: lastBlock })
      if (canonical.hash && canonical.hash.toLowerCase() !== cursor.lastBlockHash.toLowerCase()) {
        reorgDetected = true
        const rewound = lastBlock - (this.options.reorgDepth ?? 12n)
        fromBlock = rewound > startBlock ? rewound : startBlock
      }
    }
    if (fromBlock > confirmedBlock) return idle(fromBlock, confirmedBlock, Number(latestBlock - (fromBlock - 1n)), reorgDetected)

    const addresses = goldSavingsAddresses(gold)
    const firstBlock = fromBlock
    const maxRanges = Math.max(1, Math.floor(this.options.maxRangesPerPoll ?? 1))
    let indexedEvents = 0
    let toBlock = fromBlock
    for (let range = 0; range < maxRanges && fromBlock <= confirmedBlock; range++) {
      const span = fromBlock + this.options.maxBlockRange - 1n
      toBlock = span < confirmedBlock ? span : confirmedBlock
      indexedEvents += await this.indexRange(chainId, gold, addresses, fromBlock, toBlock)
      const last = await this.options.rpc.getBlock({ blockNumber: toBlock })
      await this.options.store.upsertCursor({
        chainId,
        name: GOLD_SAVINGS_CURSOR,
        fromBlock: startBlock,
        lastBlock: toBlock,
        lastBlockHash: last.hash,
        confirmations: this.options.confirmations,
        lagBlocks: Number(latestBlock - toBlock),
      })
      fromBlock = toBlock + 1n
    }
    return { mode: "poll", indexedEvents, fromBlock: firstBlock, toBlock, latestBlock, lagBlocks: Number(latestBlock - toBlock), reorgDetected }
  }

  private async indexRange(chainId: number, gold: DeployedArcoGold, addresses: `0x${string}`[], fromBlock: bigint, toBlock: bigint) {
    const logs = await this.options.rpc.getLogs({ addresses, fromBlock, toBlock })
    const timestamps = new Map<bigint, Date>()
    let indexed = 0
    for (const log of logs) {
      const decoded = decodeGoldSavingsLog(log, gold)
      if (!decoded) continue
      await this.options.store.insertIndexedEvent({
        chainId,
        contractAddress: log.address.toLowerCase(),
        blockNumber: log.blockNumber,
        blockHash: log.blockHash,
        txHash: log.transactionHash,
        logIndex: log.logIndex,
        eventName: decoded.eventName,
        args: withActivityWallet(decoded.args, savingsEventWallet(decoded.eventName, decoded.args, { zap: gold.zapAddress })),
        removed: log.removed ?? false,
        blockTimestamp: await this.blockTime(timestamps, log.blockNumber),
      })
      indexed++
    }
    return indexed
  }

  private async blockTime(cache: Map<bigint, Date>, blockNumber: bigint): Promise<Date> {
    const cached = cache.get(blockNumber)
    if (cached) return cached
    const block = await this.options.rpc.getBlock({ blockNumber })
    const at = new Date(Number(block.timestamp) * 1000)
    cache.set(blockNumber, at)
    return at
  }
}

// ─────────────────────────────── Prisma ───────────────────────────────

/** The cursor through the core indexer's service; events upserted (args rewritten on re-index), like the sArcoUSD store. */
export class PrismaGoldSavingsIndexerStore implements GoldSavingsIndexerStore {
  constructor(
    private readonly prisma: IndexedEventDelegate,
    private readonly arco: Pick<PrismaArcoService, "getIndexerCursor" | "upsertIndexerCursor">,
  ) {}

  getCursor(chainId: number, name: string) {
    return this.arco.getIndexerCursor(chainId, name) as ReturnType<GoldSavingsIndexerStore["getCursor"]>
  }

  upsertCursor(input: Parameters<GoldSavingsIndexerStore["upsertCursor"]>[0]) {
    return this.arco.upsertIndexerCursor(input)
  }

  insertIndexedEvent(input: IndexedEventInput) {
    return upsertIndexedEvent(this.prisma, input)
  }
}
