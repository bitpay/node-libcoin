import Config from '../../../config';
import { WalletAddressStorage } from '../../../models/walletAddress';
import { CSP } from '../../../types/namespaces/ChainStateProvider';
import { InternalStateProvider } from '../internal/internal';
import { ObjectID } from 'mongodb';
import Web3 from 'web3';
import { Storage } from '../../../services/storage';
import { Readable } from 'stream';
import { ParityRPC, ParityTraceResponse } from './parityRpc';
import { EventStorage } from '../../../models/events';
import { TransactionStorage } from '../../../models/transaction';

export class ETHStateProvider extends InternalStateProvider implements CSP.IChainStateService {
  config: any;

  constructor(public chain: string = 'ETH') {
    super(chain);
    this.config = Config.chains[this.chain];
  }

  getWeb3(network: string) {
    const networkConfig = this.config[network];
    const provider = networkConfig.provider;
    const portString = provider.port ? `:${provider.port}` : '';
    const connUrl = `${provider.protocol}://${provider.host}${portString}`;
    let ProviderType;
    switch (provider.protocol) {
      case 'wss':
        ProviderType = Web3.providers.WebsocketProvider;
        break;
      default:
        ProviderType = Web3.providers.HttpProvider;
        break;
    }
    return new Web3(new ProviderType(connUrl));
  }

  async getBalanceForAddress(params: CSP.GetBalanceForAddressParams) {
    const { network, address } = params;
    const balance = Number(await this.getWeb3(network).eth.getBalance(address));
    return { confirmed: balance, unconfirmed: 0, balance };
  }

  async getBlock(params: CSP.GetBlockParams) {
    const { network, blockId } = params;
    return this.getWeb3(network).eth.getBlock(Number(blockId)) as any;
  }

  async streamBlocks(params: CSP.StreamBlocksParams) {
    const { network, blockId } = params;

    const web3 = this.getWeb3(network);

    return new Promise<Array<ParityTraceResponse>>(resolve =>
      web3.eth.currentProvider.send(
        {
          method: 'trace_block',
          params: [web3.utils.toHex(parseInt(blockId!))],
          jsonrpc: '2.0',
          id: 0
        },
        (_, data) => resolve(data.result)
      )
    );
  }

  async getTransaction(params: CSP.StreamTransactionParams) {
    const { network, txId } = params;
    const transaction = await this.getWeb3(network).eth.getTransaction(txId);
    return transaction as any;
  }

  async streamWalletTransactions(params: CSP.StreamWalletTransactionsParams) {
    const { network, wallet, req, res } = params;

    const web3 = this.getWeb3(network);
    const addresses = await this.getWalletAddresses(wallet._id!);
    const bestBlock = await web3.eth.getBlockNumber();

    Storage.stream(
      new Readable({
        objectMode: true,
        read: async function() {
          for (const walletAddress of addresses) {
            const transactions = await new ParityRPC(web3).getTransactionsForAddress(bestBlock, walletAddress.address);
            for await (const tx of transactions) {
              this.push(tx);
              TransactionStorage.collection.insertOne(tx);
            }
          }
          this.push(null);
        }
      }),
      req,
      res
    );
  }

  async broadcastTransaction(params: CSP.BroadcastTransactionParams) {
    const { network, rawTx } = params;
    const tx = await this.getWeb3(network).eth.sendSignedTransaction(rawTx);
    return tx;
  }

  async watchEtherTransfers(network: string) {
    // Instantiate web3 with WebSocket provider
    const web3Socket = new Web3(new Web3.providers.WebsocketProvider('ws://localhost:8545'));

    // Instantiate subscription object
    const subscription = web3Socket.eth.subscribe('pendingTransactions');

    // Subscribe to pending transactions
    subscription
      .subscribe((error, _result) => {
        if (error) console.log(error);
      })
      .on('data', async txHash => {
        try {
          const web3 = this.getWeb3(network);

          // Get transaction details
          const trx = await web3.eth.getTransactionReciept(txHash);
          await EventStorage.signalTx(trx);
          // Unsubscribe from pending transactions.
          subscription.unsubscribe();
        } catch (error) {
          console.log(error);
        }
      });
  }

  async getWalletAddresses(walletId: ObjectID) {
    let query = { chain: this.chain, wallet: walletId };
    return WalletAddressStorage.collection
      .find(query)
      .addCursorFlag('noCursorTimeout', true)
      .toArray();
  }

  async getWalletBalance(params: CSP.GetWalletBalanceParams) {
    const { network } = params;
    if (params.wallet._id === undefined) {
      throw new Error('Wallet balance can only be retrieved for wallets with the _id property');
    }
    let addresses = await this.getWalletAddresses(params.wallet._id);
    let addressBalancePromises = addresses.map(({ address }) =>
      this.getBalanceForAddress({ chain: this.chain, network, address })
    );
    let addressBalances = await Promise.all<{ confirmed: number; unconfirmed: number; balance: number }>(
      addressBalancePromises
    );
    let balance = addressBalances.reduce(
      (prev, cur) => ({
        unconfirmed: prev.unconfirmed + cur.unconfirmed,
        confirmed: prev.confirmed + cur.confirmed,
        balance: prev.balance + cur.balance
      }),
      { unconfirmed: 0, confirmed: 0, balance: 0 }
    );
    return balance;
  }
}
