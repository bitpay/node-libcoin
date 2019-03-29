import logger from '../../../logger';
import { EventEmitter } from 'events';
import { EthBlockStorage, EthBlockModel } from '../../../models/block/eth/ethBlock';
import { ChainStateProvider } from '../../../providers/chain-state';
import { StateStorage } from '../../../models/state';
import { Ethereum } from '../../../types/namespaces/Ethereum';
import { EthTransactionStorage, EthTransactionModel } from '../../../models/transaction/eth/ethTransaction';
import { BitcoreP2PEth } from './p2p-lib';
import { IEthBlock } from '../../../types/Block';
import BN from 'bn.js';
import { IEthTransaction } from '../../../types/Transaction';
import { ParityRPC } from '../../../providers/chain-state/eth/parityRpc';
import { ETHStateProvider } from '../../../providers/chain-state/eth/eth';
import Web3 from 'web3';
const LRU = require('lru-cache');

if (Symbol['asyncIterator'] === undefined) (Symbol as any)['asyncIterator'] = Symbol.for('asyncIterator');

export class EthP2pWorker {
  private chain: string;
  private network: string;
  private chainConfig: any;
  private events: EventEmitter;
  private syncing: boolean;
  private messages: any;
  private invCache: any;
  private initialSyncComplete: boolean;
  private eth: BitcoreP2PEth;
  private blockModel: EthBlockModel;
  private txModel: EthTransactionModel;
  private web3: Web3;
  private rpc: ParityRPC;

  constructor({ chain, network, chainConfig, blockModel = EthBlockStorage, txModel = EthTransactionStorage }) {
    this.eth = new BitcoreP2PEth(network);
    this.chain = chain || 'ETH';
    this.network = network;
    this.chainConfig = chainConfig;
    this.events = new EventEmitter();
    this.syncing = true;
    this.initialSyncComplete = false;
    this.invCache = new LRU({ max: 10000 });
    this.blockModel = blockModel;
    this.txModel = txModel;
    this.web3 = new ETHStateProvider().getWeb3(network);
    this.rpc = new ParityRPC(this.web3);
  }

  setupListeners() {
    this.eth.on('peerready', peer => {
      logger.info(`Connected to peer ${peer.host}`, {
        chain: this.chain,
        network: this.network
      });
    });

    this.eth.on('peerdisconnect', peer => {
      logger.warn(`Not connected to peer ${peer.host}`, {
        chain: this.chain,
        network: this.network,
        port: peer.port
      });
    });

    this.eth.on('peertx', (peer, message) => {
      const hash = message.transaction.hash;
      logger.debug('peer tx received', {
        peer: `${peer.host}:${peer.port}`,
        chain: this.chain,
        network: this.network,
        hash
      });
      if (!this.syncing && !this.invCache.get(hash)) {
        this.processTransaction(message.transaction);
        this.events.emit('transaction', message.transaction);
      }
      this.invCache.set(hash);
    });

    this.eth.on('peerblock', async (peer, message) => {
      const { block } = message;
      const { hash } = block;
      const { chain, network } = this;
      logger.debug('peer block received', {
        peer: `${peer.host}:${peer.port}`,
        chain: this.chain,
        network: this.network,
        hash
      });

      if (!this.syncing && !this.invCache.get(hash)) {
        this.invCache.set(hash);
        this.events.emit(hash, message.block);
        if (!this.syncing) {
          try {
            const { convertedTxs, convertedBlock } = this.convertBlock(block);
            await this.processBlock(convertedBlock, convertedTxs);
            this.events.emit('block', message.block);
          } catch (err) {
            logger.error(`Error syncing ${chain} ${network}`, err);
            return this.sync();
          }
        }
      }
    });

    this.eth.on('peerheaders', (peer, message) => {
      logger.debug('peerheaders message received', {
        peer: `${peer.host}:${peer.port}`,
        chain: this.chain,
        network: this.network,
        count: message.headers.length
      });
      this.events.emit('headers', message.headers);
    });

    this.eth.on('peerinv', (peer, message) => {
      if (!this.syncing) {
        const filtered = message.inventory.filter(inv => {
          const hash = inv.hash().toString('hex');
          return !this.invCache.get(hash);
        });

        if (filtered.length) {
          peer.sendMessage(this.messages.GetData(filtered));
        }
      }
    });
  }

  async connect() {
    this.eth.connect();
    return new Promise<void>(resolve => {
      this.eth.once('peerready', () => resolve());
    });
  }

  public async getHeaders(bestHeight: number) {
    return this.eth.getHeaders(bestHeight);
  }

  public async getBlock(header: Ethereum.Header) {
    return this.eth.getBlock(header);
  }

  async processBlock(block: IEthBlock, transactions: IEthTransaction[]): Promise<any> {
    if (transactions.length > 1) {
      console.log('Block has ', transactions.length, 'transactions');
    }
    await this.blockModel.addBlock({
      chain: this.chain,
      network: this.network,
      forkHeight: this.chainConfig.forkHeight,
      parentChain: this.chainConfig.parentChain,
      initialSyncComplete: this.initialSyncComplete,
      block,
      transactions
    });
    if (!this.syncing) {
      logger.info(`Added block ${block.hash}`, {
        chain: this.chain,
        network: this.network
      });
    }
  }

  async processTransaction(tx: Ethereum.Transaction) {
    const now = new Date();
    const convertedTx = this.convertTx(tx);
    this.txModel.batchImport({
      chain: this.chain,
      network: this.network,
      txs: [convertedTx],
      height: -1,
      mempoolTime: now,
      blockTime: now,
      blockTimeNormalized: now,
      initialSyncComplete: true
    });
  }

  async sync() {
    const { chain, chainConfig, network } = this;
    const { parentChain, forkHeight } = chainConfig;
    this.syncing = true;
    const state = await StateStorage.collection.findOne({});
    this.initialSyncComplete =
      state && state.initialSyncComplete && state.initialSyncComplete.includes(`${chain}:${network}`);
    let tip = await ChainStateProvider.getLocalTip({ chain, network });
    if (parentChain && (!tip || tip.height < forkHeight)) {
      let parentTip = await ChainStateProvider.getLocalTip({ chain: parentChain, network });
      while (!parentTip || parentTip.height < forkHeight) {
        logger.info(`Waiting until ${parentChain} syncs before ${chain} ${network}`);
        await new Promise(resolve => {
          setTimeout(resolve, 5000);
        });
        parentTip = await ChainStateProvider.getLocalTip({ chain: parentChain, network });
      }
    }

    const getHeaders = async (tip: number) => {
      return this.getHeaders(tip);
    };

    let headers;
    while (!headers || headers.length > 0) {
      tip = await ChainStateProvider.getLocalTip({ chain, network });
      let currentHeight = tip ? tip.height : 0;
      headers = await getHeaders(currentHeight);
      let lastLog = 0;
      logger.info(`Syncing ${headers.length} blocks for ${chain} ${network}`);
      for (const header of headers) {
        try {
          const hash = header.hash();
          const hashStr = hash.toString('hex');
          const block = await this.getBlock(header);
          let { convertedBlock, convertedTxs } = this.convertBlock(block);
          const height = new BN(block.header.number).toNumber();
          let internalTxs = await this.rpc.getTransactionsFromBlock(height);
          for await (const tx of internalTxs) {
            if (tx.type === 'reward') {
              const rewardIndex = [convertedBlock].findIndex(
                t => t.hash === tx.blockHash && t.height === tx.blockNumber
              );
              if (tx.action.rewardType && tx.action.rewardType === 'block') {
                [convertedBlock][rewardIndex].reward = Number.parseInt(tx.action.value, 16);
              }
              if (tx.action.rewardType && tx.action.rewardType === 'uncle') {
                [convertedBlock][rewardIndex].uncleReward = Number.parseInt(tx.action.value, 16);
              }
            }
            if (tx && tx.action) {
              const foundIndex = convertedTxs.findIndex(
                t => t.txid === tx.transactionHash && t.from !== tx.action.from && t.to !== tx.action.to
              );
              if (foundIndex > -1) {
                convertedTxs[foundIndex].internal.push(tx);
              }
              if (tx.error) {
                const errorIndex = convertedTxs.findIndex(t => t.txid === tx.transactionHash);
                if (errorIndex && errorIndex > -1) {
                  convertedTxs[errorIndex].error = tx.error;
                }
              }
            }
          }

          await this.processBlock(convertedBlock, convertedTxs);
          currentHeight++;
          if (Date.now() - lastLog > 100) {
            logger.info(`Sync `, {
              chain,
              network,
              height: currentHeight,
              hash: hashStr
            });
            lastLog = Date.now();
          }
        } catch (err) {
          logger.error(`Error syncing ${chain} ${network}`, err);
          return this.sync();
        }
      }
    }
    logger.info(`${chain}:${network} up to date.`);
    this.syncing = false;
    StateStorage.collection.findOneAndUpdate(
      {},
      { $addToSet: { initialSyncComplete: `${chain}:${network}` } },
      { upsert: true }
    );
    return true;
  }

  convertBlock(block: Ethereum.Block) {
    const { header } = block;
    const blockTime = Number.parseInt(header.timestamp.toString('hex') || '0', 16) * 1000;
    const hash = `0x${block.header.hash().toString('hex')}`;
    const height = new BN(header.number).toNumber();
    const convertedBlock: IEthBlock = {
      chain: this.chain,
      network: this.network,
      height,
      hash,
      coinbase: `0x${block.header.coinbase.toString('hex')}`,
      merkleRoot: `0x${block.header.transactionsTrie.toString('hex')}`,
      time: new Date(blockTime),
      timeNormalized: new Date(blockTime),
      nonce: header.nonce.toString('hex'),
      previousBlockHash: `0x${header.parentHash.toString('hex')}`,
      nextBlockHash: '',
      transactionCount: block.transactions.length,
      size: block.raw.length,
      reward: 0,
      processed: false,
      gasLimit: Number.parseInt(header.gasLimit.toString('hex'), 16) || 0,
      gasUsed: Number.parseInt(header.gasUsed.toString('hex'), 16) || 0,
      stateRoot: header.stateRoot
    };
    const convertedTxs = block.transactions.map(t => this.convertTx(t, convertedBlock));
    return { convertedBlock, convertedTxs };
  }

  convertTx(tx: Ethereum.Transaction, block?: IEthBlock): IEthTransaction {
    if (!block) {
      const txid = '0x' + tx.hash().toString('hex');
      const to = '0x' + tx.to.toString('hex');
      const from = '0x' + tx.from.toString('hex');
      const fee = Number(tx.getUpfrontCost().toString());
      const abiType = this.rpc.abiDecode('0x' + tx.data.toString('hex'));
      const nonce = tx.nonce.toString('hex');
      const convertedTx: IEthTransaction = {
        chain: this.chain,
        network: this.network,
        blockHeight: -1,
        data: tx.data,
        txid,
        blockHash: undefined,
        blockTime: new Date(),
        blockTimeNormalized: new Date(),
        fee,
        size: tx.data.length,
        value: Number.parseInt(tx.value.toString('hex'), 16) || 0,
        wallets: [],
        to,
        from,
        gasLimit: Number.parseInt(tx.gasLimit.toString('hex'), 16),
        gasPrice: Number.parseInt(tx.gasPrice.toString('hex'), 16),
        nonce: Number.parseInt(nonce || '0x0', 16),
        internal: []
      };
      if (abiType) {
        convertedTx.abiType = abiType;
      }
      return convertedTx;
    } else {
      const { hash: blockHash, time: blockTime, timeNormalized: blockTimeNormalized, height } = block;
      const noBlockTx = this.convertTx(tx);
      return {
        ...noBlockTx,
        blockHeight: height,
        blockHash,
        blockTime,
        blockTimeNormalized
      };
    }
  }

  async start() {
    logger.debug(`Started worker for chain ${this.chain}`);
    this.setupListeners();
    await this.connect();
    this.sync();
  }
}
