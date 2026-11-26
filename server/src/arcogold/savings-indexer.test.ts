import assert from "node:assert/strict"
import { join } from "node:path"
import test from "node:test"
import { encodeAbiParameters, encodeEventTopics, type AbiEvent, type Hex } from "viem"
import { distributorEventsAbi, SAVINGS_SEED_HOLDER, savingsVaultEventsAbi, savingsZapEventsAbi } from "../arcousd/abi.js"
import type { RawEvmLog } from "../indexer/event-decoder.js"
import type { GiwaIndexerCursor, GiwaIndexerRpc } from "../indexer/giwa-indexer.js"
import type { IndexedEventInput } from "../services/types.js"
import { ARCOGOLD_REGISTRY_DEFAULT_PATH } from "./config.js"
import { deployedArcoGold, readArcoGoldRegistry, type ArcoGoldRegistryFile } from "./registry.js"
import {
  ArcoGoldSavingsIndexer,
  decodeGoldSavingsLog,
  GOLD_SAVINGS_CURSOR,
  goldSavingsAddresses,
  PrismaGoldSavingsIndexerStore,
  type GoldSavingsIndexerStore,
} from "./savings-indexer.js"

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`
const ONE = 10n ** 18n
const UNIT = A(1)
const RESERVE = A(2)
const VAULT = A(4)
const ZAP = A(5)
const DISTRIBUTOR = A(6)
const PAXG = A(0xa1)
const XAUT = A(0xa2)
const ALICE = A(0xa11ce)
const BOB = A(0xb0b)
const DEPLOYER = A(0xde9)
const DEAD = SAVINGS_SEED_HOLDER.toLowerCase()
const START = 150

function registry(overrides: Partial<ArcoGoldRegistryFile> = {}, distributor: boolean = true): ArcoGoldRegistryFile {
  const contract = (address: `0x${string}`) => ({ proxy: address, implementation: A(0x100), bytecodeHash: "0x01" as const, blockNumber: START })
  return {
    schemaVersion: 1,
    product: "arcogold",
    chainId: 91342,
    network: "giwa-sepolia",
    deployed: true,
    deploymentBlock: START,
    unit: { name: "Arco Gold Ounce", symbol: "ArcoXAU", contract: contract(UNIT) },
    reserve: contract(RESERVE),
    lens: { address: A(3), bytecodeHash: "0x02" },
    testAssets: [],
    reserveAssets: [
      { symbol: "tPAXG", address: PAXG, decimals: 18, instantFeeBps: 0, swapFeeBps: 0, minQueued: "10000000000000000" },
      { symbol: "tXAUT", address: XAUT, decimals: 6, instantFeeBps: 0, swapFeeBps: 0, minQueued: "10000" },
    ],
    params: { mintCap: "1", mmfTargetBps: 0, bufferFloorBps: 10000, queueMinDelay: 600 },
    savings: {
      name: "ArcoGOLD",
      symbol: "ArcoGOLD",
      vault: contract(VAULT),
      zap: { address: ZAP, bytecodeHash: "0x03" },
      distributor: distributor ? { address: DISTRIBUTOR, bytecodeHash: "0x04" } : null,
      seeded: true,
    },
    ...overrides,
  }
}

function log(abi: readonly unknown[], address: string, eventName: string, args: Record<string, unknown>, blockNumber: bigint, logIndex: number): RawEvmLog {
  const event = (abi as AbiEvent[]).find((item) => item.name === eventName) as AbiEvent
  const topics = encodeEventTopics({ abi: [event], eventName, args } as never) as Hex[]
  const data = encodeAbiParameters(
    event.inputs.filter((input) => !input.indexed),
    event.inputs.filter((input) => !input.indexed).map((input) => args[input.name!]),
  )
  return {
    address: address as `0x${string}`,
    blockNumber,
    blockHash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
    transactionHash: `0x${(blockNumber * 1000n + BigInt(logIndex)).toString(16).padStart(64, "0")}`,
    logIndex,
    data,
    topics,
  }
}

class FakeRpc implements GiwaIndexerRpc {
  latest = 300n
  logs: RawEvmLog[] = []
  requested: { addresses: readonly string[]; fromBlock: bigint; toBlock: bigint }[] = []
  calls = 0
  async getChainId() {
    this.calls++
    return 91342
  }
  async getBlockNumber() {
    this.calls++
    return this.latest
  }
  async getBlock({ blockNumber }: { blockNumber: bigint }) {
    this.calls++
    return { number: blockNumber, hash: `0x${blockNumber.toString(16)}`.padEnd(66, "0") as `0x${string}`, timestamp: 1_760_000_000n + blockNumber }
  }
  async getLogs(args: { addresses: readonly `0x${string}`[]; fromBlock: bigint; toBlock: bigint }) {
    this.calls++
    this.requested.push(args)
    const wanted = new Set(args.addresses.map((address) => address.toLowerCase()))
    return this.logs.filter((entry) => wanted.has(entry.address.toLowerCase()) && entry.blockNumber >= args.fromBlock && entry.blockNumber <= args.toBlock)
  }
}

/** Keyed like the table's unique index (chainId, txHash, logIndex): an upsert, so a re-index never duplicates. */
class FakeStore implements GoldSavingsIndexerStore {
  cursors = new Map<string, GiwaIndexerCursor>()
  rows = new Map<string, IndexedEventInput>()
  writes = 0
  get events() {
    return [...this.rows.values()].sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || a.logIndex - b.logIndex)
  }
  async getCursor(chainId: number, name: string) {
    return this.cursors.get(`${chainId}:${name}`) ?? null
  }
  async upsertCursor(input: { chainId: number; name: string; fromBlock: bigint; lastBlock: bigint; lastBlockHash: string | null }) {
    this.cursors.set(`${input.chainId}:${input.name}`, input)
  }
  async insertIndexedEvent(input: IndexedEventInput) {
    this.writes++
    this.rows.set(`${input.chainId}:${input.txHash}:${input.logIndex}`, input)
  }
}

function indexer(file: () => ArcoGoldRegistryFile | null, rpc: FakeRpc, store: FakeStore, maxRangesPerPoll?: number, maxBlockRange = 1000n) {
  return new ArcoGoldSavingsIndexer({ loadRegistry: file, rpc, store, confirmations: 5, maxBlockRange, maxRangesPerPoll })
}

const wallet = (event: IndexedEventInput) => (event.args as Record<string, unknown>).walletAddress ?? null

test("gold savings indexer: inert (no RPC call) without a deployed registry", async () => {
  const rpc = new FakeRpc()
  const store = new FakeStore()
  for (const file of [null, registry({ deployed: false })]) {
    const result = await indexer(() => file, rpc, store).pollOnce()
    assert.equal(result.mode, "inert")
  }
  assert.equal(rpc.calls, 0)
  assert.equal(store.cursors.size, 0)
  // A registry that reads fine but is invalid is loud (throws), like the ArcoUSD indexers.
  const broken = registry({ savings: { ...registry().savings, zap: { address: null, bytecodeHash: null } } })
  await assert.rejects(indexer(() => broken, rpc, store).pollOnce(), /Invalid ArcoGOLD registry/)
})

test("gold savings indexer: its own cursor from the gold deploy block; the vault, Zap and distributor; no Transfer / Approval", async () => {
  const rpc = new FakeRpc()
  const store = new FakeStore()
  rpc.logs = [
    // The seed (deploy script): Deposit to 0x…dEaD and Seeded — nobody's.
    log(savingsVaultEventsAbi, VAULT, "Transfer", { from: A(0), to: DEAD, value: ONE }, 160n, 0),
    log(savingsVaultEventsAbi, VAULT, "Deposit", { sender: DEPLOYER, owner: DEAD, assets: ONE, shares: ONE }, 160n, 1),
    log(savingsVaultEventsAbi, VAULT, "Seeded", { caller: DEPLOYER, holder: DEAD, assets: ONE }, 160n, 2),
    log(savingsVaultEventsAbi, VAULT, "Approval", { owner: ALICE, spender: ZAP, value: ONE }, 165n, 0),
    log(savingsZapEventsAbi, ZAP, "ZapDeposit", { caller: ALICE, receiver: ALICE, asset: PAXG, amount: 2n * ONE, arcoUSDIn: 2n * ONE, shares: 2n * ONE }, 170n, 0),
    log(distributorEventsAbi, DISTRIBUTOR, "Distributed", { caller: A(8), amount: ONE / 100n, backing: 3n * ONE, liabilities: 2n * ONE, surplus: ONE, rateCap: ONE }, 180n, 0),
    log(savingsVaultEventsAbi, VAULT, "RewardsAdded", { caller: DISTRIBUTOR, amount: ONE / 100n, vestingAmount: ONE / 100n, vestingPeriod: 86_400n }, 180n, 1),
    // Another contract's (the sArcoUSD vault, the gold Reserve): not read, not stored.
    log(savingsVaultEventsAbi, A(0x99), "Deposit", { sender: ALICE, owner: ALICE, assets: ONE, shares: ONE }, 175n, 0),
    log(savingsVaultEventsAbi, RESERVE, "Deposit", { sender: ALICE, owner: ALICE, assets: ONE, shares: ONE }, 175n, 1),
  ]
  const result = await indexer(() => registry(), rpc, store).pollOnce()
  assert.ok(result.mode === "poll")
  assert.deepEqual([result.fromBlock, result.toBlock, result.indexedEvents, result.lagBlocks], [150n, 295n, 5, 5])
  assert.deepEqual(rpc.requested[0], { addresses: [VAULT, ZAP, DISTRIBUTOR], fromBlock: 150n, toBlock: 295n })
  assert.deepEqual(
    store.events.map((event) => [event.eventName, event.contractAddress, wallet(event)]),
    [
      ["Deposit", VAULT, null],
      ["Seeded", VAULT, null],
      ["ZapDeposit", ZAP, ALICE],
      ["Distributed", DISTRIBUTOR, null],
      ["RewardsAdded", VAULT, null],
    ],
  )
  const cursor = store.cursors.get(`91342:${GOLD_SAVINGS_CURSOR}`)!
  assert.deepEqual([cursor.fromBlock, cursor.lastBlock], [150n, 295n])
  // Next poll continues after the cursor.
  rpc.latest = 320n
  const next = await indexer(() => registry(), rpc, store).pollOnce()
  assert.ok(next.mode === "poll" && next.fromBlock === 296n && next.toBlock === 315n)
})

test("gold savings indexer: decoded args are sArcoUSD's ERC-4626 / Zap args, bigints as decimal strings, addresses lowercase", async () => {
  const gold = deployedArcoGold(registry(), 91342)!
  const MiXeD = "0x00000000000000000000000000000000000aBCdE" as const
  const deposit = decodeGoldSavingsLog(log(savingsVaultEventsAbi, VAULT, "Deposit", { sender: MiXeD, owner: MiXeD, assets: 1234n * ONE + 5n, shares: 1200n * ONE }, 200n, 0), gold)
  assert.deepEqual(deposit, {
    eventName: "Deposit",
    args: { sender: MiXeD.toLowerCase(), owner: MiXeD.toLowerCase(), assets: "1234000000000000000005", shares: "1200000000000000000000" },
  })
  const withdraw = decodeGoldSavingsLog(log(savingsVaultEventsAbi, VAULT, "Withdraw", { sender: ALICE, receiver: BOB, owner: ALICE, assets: ONE, shares: ONE / 2n }, 200n, 1), gold)
  assert.deepEqual(withdraw, { eventName: "Withdraw", args: { sender: ALICE, receiver: BOB, owner: ALICE, assets: String(ONE), shares: String(ONE / 2n) } })
  const zapRedeem = decodeGoldSavingsLog(
    log(savingsZapEventsAbi, ZAP, "ZapRedeem", { caller: ALICE, receiver: ALICE, asset: XAUT, shares: ONE, arcoUSDOut: ONE, assetOut: 1_000_000n }, 200n, 2),
    gold,
  )
  assert.deepEqual(zapRedeem, {
    eventName: "ZapRedeem",
    args: { caller: ALICE, receiver: ALICE, asset: XAUT, shares: String(ONE), arcoUSDOut: String(ONE), assetOut: "1000000" },
  })
  // Not ours, or not an event we know: skipped.
  assert.equal(decodeGoldSavingsLog(log(savingsVaultEventsAbi, A(0x99), "Deposit", { sender: ALICE, owner: ALICE, assets: ONE, shares: ONE }, 1n, 0), gold), null)
  assert.equal(decodeGoldSavingsLog(log(savingsZapEventsAbi, VAULT, "ZapDeposit", { caller: ALICE, receiver: ALICE, asset: PAXG, amount: 1n, arcoUSDIn: 1n, shares: 1n }, 1n, 0), gold), null)
})

test("gold savings activity: one row per action — Zap deposit → receiver, Zap redeem → caller, direct vault calls → owner", async () => {
  const rpc = new FakeRpc()
  const store = new FakeStore()
  rpc.logs = [
    // Alice saves through the Zap for Bob (what the app does, with receiver = the wallet itself): the vault step
    // (sender = the Zap) is nobody's, ZapDeposit is the receiver's.
    log(savingsVaultEventsAbi, VAULT, "Deposit", { sender: ZAP, owner: BOB, assets: ONE, shares: ONE }, 200n, 3),
    log(savingsZapEventsAbi, ZAP, "ZapDeposit", { caller: ALICE, receiver: BOB, asset: PAXG, amount: ONE, arcoUSDIn: ONE, shares: ONE }, 200n, 4),
    // Bob leaves through the Zap in tXAUT: the vault's Withdraw (sender = the Zap) is nobody's, ZapRedeem is the caller's.
    log(savingsVaultEventsAbi, VAULT, "Withdraw", { sender: ZAP, receiver: ZAP, owner: BOB, assets: ONE, shares: ONE }, 210n, 0),
    log(savingsZapEventsAbi, ZAP, "ZapRedeem", { caller: BOB, receiver: ALICE, asset: XAUT, shares: ONE, arcoUSDOut: ONE, assetOut: 1_000_000n }, 210n, 5),
    // Zap redeem straight to ArcoXAU: the vault pays the receiver directly, still sender = the Zap.
    log(savingsVaultEventsAbi, VAULT, "Withdraw", { sender: ZAP, receiver: BOB, owner: BOB, assets: ONE, shares: ONE }, 215n, 0),
    log(savingsZapEventsAbi, ZAP, "ZapRedeem", { caller: BOB, receiver: BOB, asset: UNIT, shares: ONE, arcoUSDOut: ONE, assetOut: ONE }, 215n, 1),
    // Straight to the vault in ArcoXAU: the owner's, whoever sent it.
    log(savingsVaultEventsAbi, VAULT, "Deposit", { sender: ALICE, owner: BOB, assets: ONE, shares: ONE }, 220n, 0),
    log(savingsVaultEventsAbi, VAULT, "Withdraw", { sender: BOB, receiver: ALICE, owner: BOB, assets: ONE, shares: ONE }, 230n, 0),
  ]
  await indexer(() => registry(), rpc, store).pollOnce()
  assert.deepEqual(
    store.events.map((event) => [event.eventName, event.contractAddress, wallet(event)]),
    [
      ["Deposit", VAULT, null],
      ["ZapDeposit", ZAP, BOB],
      ["Withdraw", VAULT, null],
      ["ZapRedeem", ZAP, BOB],
      ["Withdraw", VAULT, null],
      ["ZapRedeem", ZAP, BOB],
      ["Deposit", VAULT, BOB],
      ["Withdraw", VAULT, BOB],
    ],
  )
  // Timestamps from the block.
  assert.deepEqual(store.events[0].blockTimestamp, new Date((1_760_000_000 + 200) * 1000))
})

test("gold savings indexer: re-indexing from the deploy block upserts the same rows (no duplicates); the Prisma store rewrites args", async () => {
  const rpc = new FakeRpc()
  const store = new FakeStore()
  rpc.logs = [
    log(savingsZapEventsAbi, ZAP, "ZapDeposit", { caller: ALICE, receiver: ALICE, asset: PAXG, amount: ONE, arcoUSDIn: ONE, shares: ONE }, 170n, 0),
    log(savingsVaultEventsAbi, VAULT, "Deposit", { sender: ALICE, owner: ALICE, assets: ONE, shares: ONE }, 171n, 0),
  ]
  await indexer(() => registry(), rpc, store).pollOnce()
  const first = store.events
  store.cursors.clear() // the cursor moved back (or deleted): the next poll starts at the deploy block again
  const again = await indexer(() => registry(), rpc, store).pollOnce()
  assert.ok(again.mode === "poll" && again.fromBlock === 150n && again.indexedEvents === 2)
  assert.equal(store.writes, 4)
  assert.equal(store.rows.size, 2)
  assert.deepEqual(store.events, first)

  const upserts: Record<string, any>[] = []
  const cursorCalls: unknown[] = []
  const prismaStore = new PrismaGoldSavingsIndexerStore(
    { evmIndexedEvent: { upsert: async (args: unknown) => void upserts.push(args as Record<string, any>) } },
    { getIndexerCursor: async (...args: unknown[]) => (cursorCalls.push(args), null), upsertIndexerCursor: async (input: unknown) => (cursorCalls.push(input), input) } as never,
  )
  await prismaStore.insertIndexedEvent(first[0])
  assert.deepEqual(upserts[0].where, { chainId_txHash_logIndex: { chainId: 91342, txHash: first[0].txHash, logIndex: 0 } })
  assert.deepEqual(upserts[0].update, { args: first[0].args })
  assert.equal(upserts[0].create.contractAddress, ZAP)
  assert.equal(await prismaStore.getCursor(91342, GOLD_SAVINGS_CURSOR), null)
  assert.deepEqual(cursorCalls[0], [91342, GOLD_SAVINGS_CURSOR])
})

test("gold savings indexer: backfill catches up several ranges a poll, saving the cursor after each", async () => {
  const rpc = new FakeRpc()
  const store = new FakeStore()
  rpc.latest = 1_205n // confirmed 1200: 1051 blocks from 150
  rpc.logs = [
    log(savingsZapEventsAbi, ZAP, "ZapDeposit", { caller: ALICE, receiver: ALICE, asset: PAXG, amount: ONE, arcoUSDIn: ONE, shares: ONE }, 160n, 0),
    log(savingsZapEventsAbi, ZAP, "ZapRedeem", { caller: ALICE, receiver: ALICE, asset: PAXG, shares: ONE, arcoUSDOut: ONE, assetOut: ONE }, 900n, 0),
  ]
  const first = await indexer(() => registry(), rpc, store, 3, 100n).pollOnce()
  assert.ok(first.mode === "poll")
  assert.deepEqual([first.fromBlock, first.toBlock, first.indexedEvents], [150n, 449n, 1])
  assert.deepEqual(rpc.requested.map((r) => [r.fromBlock, r.toBlock]), [[150n, 249n], [250n, 349n], [350n, 449n]])
  assert.equal(store.cursors.get(`91342:${GOLD_SAVINGS_CURSOR}`)!.lastBlock, 449n)
  // One range a poll by default (the sArcoUSD pattern).
  rpc.requested = []
  const single = await indexer(() => registry(), rpc, store, undefined, 100n).pollOnce()
  assert.ok(single.mode === "poll" && single.toBlock === 549n && rpc.requested.length === 1)
  // Many ranges, stopping at the confirmed head.
  const rest = await indexer(() => registry(), rpc, store, 50, 100n).pollOnce()
  assert.ok(rest.mode === "poll" && rest.toBlock === 1200n && rest.indexedEvents === 1 && rest.lagBlocks === 5)
  assert.deepEqual(store.events.map((event) => event.eventName), ["ZapDeposit", "ZapRedeem"])
})

test("gold savings indexer: without a distributor it reads the vault and Zap; before the deploy block is confirmed it waits", async () => {
  const rpc = new FakeRpc()
  const store = new FakeStore()
  const file = registry({}, false)
  assert.deepEqual(goldSavingsAddresses(deployedArcoGold(file, 91342)!), [VAULT, ZAP])
  await indexer(() => file, rpc, store).pollOnce()
  assert.deepEqual(rpc.requested[0].addresses, [VAULT, ZAP])

  const early = new FakeRpc()
  early.latest = 152n // confirmed 147 < 150
  const result = await indexer(() => registry(), early, new FakeStore()).pollOnce()
  assert.ok(result.mode === "poll" && result.indexedEvents === 0 && early.requested.length === 0)
})

test("gold savings indexer: a reorged cursor block rewinds (not before the deploy block), and a chain mismatch throws", async () => {
  const rpc = new FakeRpc()
  const store = new FakeStore()
  store.cursors.set(`91342:${GOLD_SAVINGS_CURSOR}`, { chainId: 91342, name: GOLD_SAVINGS_CURSOR, fromBlock: 150n, lastBlock: 280n, lastBlockHash: "0xdifferent" } as GiwaIndexerCursor)
  const result = await indexer(() => registry(), rpc, store).pollOnce()
  assert.ok(result.mode === "poll" && result.reorgDetected && result.fromBlock === 268n)
  store.cursors.set(`91342:${GOLD_SAVINGS_CURSOR}`, { chainId: 91342, name: GOLD_SAVINGS_CURSOR, fromBlock: 150n, lastBlock: 155n, lastBlockHash: "0xdifferent" } as GiwaIndexerCursor)
  const shallow = await indexer(() => registry(), rpc, store).pollOnce()
  assert.ok(shallow.mode === "poll" && shallow.fromBlock === 150n)
  await assert.rejects(indexer(() => ({ ...registry(), chainId: 1 }), rpc, store).pollOnce(), /does not match/)
})

test("gold savings indexer: the live registry file gives the ArcoGOLD vault, gold Zap and distributor, from deploymentBlock", () => {
  const file = readArcoGoldRegistry(join(process.cwd(), ARCOGOLD_REGISTRY_DEFAULT_PATH))
  if (!file?.deployed) return // not deployed in this checkout: nothing to check
  const gold = deployedArcoGold(file, 91342)!
  assert.equal(gold.vaultAddress, file.savings.vault.proxy)
  assert.equal(gold.zapAddress, file.savings.zap.address)
  assert.equal(gold.distributorAddress, file.savings.distributor?.address ?? null)
  assert.equal(gold.deploymentBlock, file.deploymentBlock)
  // The deploy block is at or before every contract whose logs are read.
  for (const block of [file.savings.vault.blockNumber, file.savings.zap.blockNumber, file.savings.distributor?.blockNumber]) {
    if (typeof block === "number") assert.ok(gold.deploymentBlock <= block)
  }
  assert.equal(goldSavingsAddresses(gold).length, gold.distributorAddress ? 3 : 2)
})
