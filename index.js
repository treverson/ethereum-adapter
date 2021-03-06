const { EventEmitter } = require('events')
const { mapLimit } = require('async')
const extend = require('xtend/mutable')
const omit = require('object.omit')
const debug = require('debug')('@tradle/ethereum-adapter')
const BN = require('bn.js')
const ProviderEngine = require('web3-provider-engine')
const DefaultFixture = require('web3-provider-engine/subproviders/default-fixture.js')
const NonceTrackerSubprovider = require('web3-provider-engine/subproviders/nonce-tracker.js')
const CacheSubprovider = require('web3-provider-engine/subproviders/cache.js')
const FilterSubprovider = require('web3-provider-engine/subproviders/filters.js')
const HookedWalletSubprovider = require('web3-provider-engine/subproviders/hooked-wallet.js')
const SanitizingSubprovider = require('web3-provider-engine/subproviders/sanitizer.js')
const RpcSubprovider = require('web3-provider-engine/subproviders/rpc.js')
const EtherscanSubprovider = require('web3-provider-engine/subproviders/etherscan')
const GasPriceSubprovider = require('web3-provider-engine/subproviders/gasprice.js')
// const VMSubprovider = require('web3-provider-engine/subproviders/vm.js')
const createPayload = require('web3-provider-engine/util/create-payload')
const Wallet = require('ethereumjs-wallet')
const WalletSubprovider = require('ethereumjs-wallet/provider-engine')
const ethUtil = require('ethereumjs-util')
const TxListSubprovider = require('./txlist-provider')
const networks = require('./networks')

const MAX_CONCURRENT_REQUESTS = 3
const ENGINE_READY_MAP = new WeakMap()
// see https://www.myetherwallet.com/helpers.html
const GWEI = 1000000000
const gasPriceByPriority = {
  // aim for next few minutes
  low: hexint(2 * GWEI), // 2 gwei
  mediumLow: hexint(5 * GWEI), // 5 gwei
  mediumHigh: hexint(10 * GWEI), // 10 gwei
  // aim for next few blocks
  high: hexint(20 * GWEI), // 20 gwei
  // aim for next block
  top: hexint(40 * GWEI), // 40 gwei
}

const GAS_LIMIT = 21000

module.exports = {
  networks,
  createNetwork,
  createEngine,
  createTransactor,
  createBlockchainAPI,
  gasPriceByPriority
}

function requireReady (engine, fn) {
  return function () {
    const args = arguments
    const ready = ENGINE_READY_MAP.get(engine)
    if (ready) return fn.apply(this, args)

    engine.once('block', () => {
      fn.apply(this, args)
    })
  }
}

function createNetwork ({ networkName, constants, engineOpts }) {
  let api
  let engine

  const network = {
    blockchain: 'ethereum',
    name: networkName,
    minOutputAmount: 1,
    constants: constants || networks[networkName],
    curve: 'secp256k1',
    pubKeyToAddress,
    generateKey,
    get api() {
      if (!api) {
        api = network.createBlockchainAPI({ engine: network.engine })
      }

      return api
    },
    get engine() {
      if (!engine) {
        engine = createEngine(engineOpts)
      }

      return engine
    },
    createTransactor: (opts={}) => createTransactor(extend({
      network,
      engine: network.engine
    }, opts)),
    createBlockchainAPI: (opts={}) => createBlockchainAPI(extend({
      network,
      engine: network.engine
    }, opts))
  }

  return network
}

function createBlockchainAPI ({ network, engine }) {
  const stop = engine.stop.bind(engine)
  const blockchain = extend(new EventEmitter(), {
    network,
    close: stop,
    stop: stop,
    start: engine.start.bind(engine),
    info: requireReady(engine, getLatestBlock),
    blocks: {
      latest: requireReady(engine, getLatestBlock)
    },
    transactions: {
      get: requireReady(engine, getTxs),
      propagate: requireReady(engine, sendRawTx)
    },
    addresses: {
      transactions: requireReady(engine, getTxsForAccounts),
      balance: requireReady(engine, getBalance.bind(null, engine))
    }
  })

  let blockHeight

  engine.on('block', ({ number }) => {
    blockHeight = unhexint(number)
    blockchain.emit('block', { blockHeight })
  })

  return blockchain

  function send (payload, cb) {
    return engine.sendAsync(payload, wrapCB(cb))
  }

  function getLatestBlock (cb) {
    process.nextTick(() => cb(null, { blockHeight }))
  }

  function getTxs (hashes, cb) {
    mapLimit(hashes, MAX_CONCURRENT_REQUESTS, getTx, cb)
  }

  function getTx (hash, cb) {
    send(createPayload({
      method: 'eth_getTransactionByHash',
      params: [prefixHex(hash)],
    }), cb)
  }

  function sendRawTx (txHex, cb) {
    send(createPayload({
      method: 'eth_sendRawTransaction',
      params: [txHex],
    }), cb)
  }

  function getTxsForAccounts (addresses, height, cb) {
    if (typeof height === 'function') {
      cb = height
      height = undefined
    }

    if (height && height > blockHeight) return cb(null, [])

    addresses = addresses.filter(address => {
      if (!address) {
        console.warn('undefined address passed in')
      }

      return address
    })

    mapLimit(addresses, MAX_CONCURRENT_REQUESTS, function (address, done) {
      getTxsForAccount(address, height, done)
    }, function (err, results) {
      if (err) return cb(err)

      cb(null, flatten(results))
    })
  }

  function getTxsForAccount (addressHex, height, cb) {
    send(createPayload({
      method: 'eth_listTransactions',
      params: [
        prefixHex(addressHex),
        height,
        undefined, // blockHeight,
        'asc'
      ],
    }), function (err, result) {
      if (err) {
        if (/no transactions/i.test(err.message)) {
          debug(`no transactions found for address ${addressHex}`)
          return cb(null, [])
        }

        return cb(err)
      }

      // Etherscan.io
      //
      // { result: [{ blockNumber: '1961866',
      //        timeStamp: '1469624867',
      //        hash: '0x545243f19ede50b8115e6165ffe509fde4bb1abc20f287cd8c49c97f39836efe',
      //        nonce: '22',
      //        blockHash: '0x9ba94fe0b81b32593fd547c39ccbbc2fc14b1bdde4ccc6dccb79e2a304280d50',
      //        transactionIndex: '5',
      //        from: '0xddbd2b932c763ba5b1b7ae3b362eac3e8d40121a',
      //        to: '0x1bb0ac60363e320bc45fdb15aed226fb59c88e44',
      //        value: '10600000000000000000000',
      //        gas: '127964',
      //        gasPrice: '20000000000',
      //        isError: '0',
      //        input: '0x',
      //        contractAddress: '',
      //        cumulativeGasUsed: '227901',
      //        gasUsed: '27964',
      //        confirmations: '1356689' }]}

      result = result.map(txInfo => {
        const height = Number(txInfo.blockNumber)
        blockHeight = Math.max(blockHeight, height)
        return {
          blockHeight,
          txId: unprefixHex(txInfo.hash),
          confirmations: blockHeight - height,
          from: {
            addresses: [txInfo.from].map(unprefixHex)
          },
          to: {
            addresses: [txInfo.to].map(unprefixHex)
          },
          data: unprefixHex(txInfo.input || '')
        }
      })

      cb(null, result)
    })
  }
}

function getBalance (engine, address, cb) {
  engine.sendAsync(createPayload({
    method: 'eth_getBalance',
    params: [prefixHex(address), 'latest']
  }), function (err, res) {
    if (err) return cb(err)

    // balance in wei
    cb(null, res.result)
  })
}

function createTransactor ({ network, engine, wallet, privateKey }) {

  function signAndSend ({
    to,
    data,
    gas,
    gasLimit=GAS_LIMIT,
    gasPrice=gasPriceByPriority.mediumLow,
  }, cb) {
    // if not started
    engine.start()

    if (to.length !== 1) {
      return process.nextTick(() => cb(new Error('only one recipient allowed')))
    }

    to = to.map(normalizeTo)

    debug('sending transaction')
    const params = pickNonNull({
      gas,
      gasLimit,
      gasPrice,
      from: wallet.getAddressString(),
      to: to[0].address,
      value: '0x0', //prefixHex(to.amount.toString(16)),
      // EIP 155 chainId - mainnet: 1, ropsten: 3, rinkeby: 54
      chainId: network.constants.chainId,
      data,
    })

    engine.sendAsync(createPayload({
      method: 'eth_sendTransaction',
      params: [params]
    }), wrapCB(function (err, txId) {
      if (err) {
        if (isUnderpricedError(err)) {
          debug('attempting with 10% price increase')
          return signAndSend({
            to,
            data,
            gas,
            gasLimit,
            gasPrice: gasPrice * 1.101, // 1.1 + an extra .001 for floating point math nonsense
          }, cb)
        }

        return cb(err)
      }

      cb(null, { txId })
    }))
  }

  wallet = getWallet({ wallet, privateKey })
  return {
    multipleRecipientsAllowed: false,
    send: signAndSend,
    start: engine.start.bind(engine),
    stop: engine.stop.bind(engine),
    close: engine.stop.bind(engine),
    balance: getBalance.bind(null, engine, wallet.getAddressString())
  }
}

function generateKey () {
  const key = Wallet.generate(true)
  const exported = {}

  // lazy
  Object.defineProperty(exported, 'pub', {
    get: function () {
      return key.pubKey
    }
  })

  Object.defineProperty(exported, 'priv', {
    get: function () {
      return key.privKey
    }
  })

  return exported
}

function pubKeyToAddress (pub) {
  if (pub.length === 65) pub = pub.slice(1)

  const prefixed = Wallet.fromPublicKey(pub).getAddressString()
  return unprefixHex(prefixed)
}

function createEngine (opts) {
  let { rpcUrl, maxPriceInWei } = opts
  const engine = new ProviderEngine(opts)

  // static
  const staticSubprovider = new DefaultFixture(opts.static)
  engine.addProvider(staticSubprovider)

  // nonce tracker
  engine.addProvider(new NonceTrackerSubprovider())

  // sanitization
  const sanitizer = new SanitizingSubprovider()
  engine.addProvider(sanitizer)

  // cache layer
  const cacheSubprovider = new CacheSubprovider()
  engine.addProvider(cacheSubprovider)

  // filters
  const filterSubprovider = new FilterSubprovider()
  engine.addProvider(filterSubprovider)

  let wallet
  if (opts.wallet || opts.privateKey) {
    wallet = getWallet(opts)

    const walletProvider = new WalletSubprovider(wallet, opts)
    if (maxPriceInWei) {
      maxPriceInWei = new BN(maxPriceInWei)
      const { signTransaction } = walletProvider
      walletProvider.signTransaction = (...args) => {
        const { gasPrice, gas, value } = args[0]
        // gas: "0x5208"
        // gasPrice: 19900000000
        // value: "0x1"
        const priceInWei = new BN(unhexint(gasPrice))
          .mul(new BN(unprefixHex(gas), 16))
          .add(new BN(unprefixHex(value), 16))

        if (priceInWei.cmp(maxPriceInWei) > 0) {
          return cb(new Error(`aborting, too expensive: ${priceInWei.toString()} wei`))
        }

        return signTransaction.apply(walletProvider, args)
      }
    }

    engine.addProvider(walletProvider)
    // id mgmt
    const idmgmtSubprovider = new HookedWalletSubprovider({
      // accounts
      getAccounts: opts.getAccounts,
      // transactions
      processTransaction: opts.processTransaction,
      approveTransaction: opts.approveTransaction,
      signTransaction: opts.signTransaction,
      publishTransaction: opts.publishTransaction,
      // messages
      // old eth_sign
      processMessage: opts.processMessage,
      approveMessage: opts.approveMessage,
      signMessage: opts.signMessage,
      // new personal_sign
      processPersonalMessage: opts.processPersonalMessage,
      approvePersonalMessage: opts.approvePersonalMessage,
      signPersonalMessage: opts.signPersonalMessage,
      personalRecoverSigner: opts.personalRecoverSigner,
    })

    engine.addProvider(idmgmtSubprovider)
  }

  engine.addProvider(new GasPriceSubprovider())
  // engine.addProvider(new VMSubprovider())

  // data sources
  if (rpcUrl) {
    engine.addProvider(new TxListSubprovider({ rpcUrl }))
    engine.addProvider(new RpcSubprovider({ rpcUrl }))
  }

  if (opts.etherscan) {
    engine.addProvider(new EtherscanSubprovider({ network: opts.networkName }))
  }

  if (opts.autostart !== false) {
    engine.start()
  }

  engine.setMaxListeners(Infinity)
  engine.once('block', () => {
    ENGINE_READY_MAP.set(engine, true)
  })

  return engine
}

function normalizeError (err, response) {
  if (response && response.error) {
    err = response.error
  }

  if (!(err instanceof Error)) {
    if (typeof err === 'object') err = JSON.stringify(err)
    if (typeof err === 'string') err = new Error(err)
  }

  return err
}

function wrapCB (cb) {
  return function (err, response) {
    if (err) return cb(normalizeError(err, response))

    cb(null, response.result)
  }
}

function unhexint (val) {
  if (typeof val === 'number') return val

  if (Buffer.isBuffer(val)) {
    return ethUtil.bufferToInt(val)
  }

  return parseInt(unprefixHex(val), 16)
}

function hexint (n) {
  return ethUtil.intToHex(n)
}

function unprefixHex (hex) {
  return hex.indexOf('0x') === 0 ? hex.slice(2) : hex
}

function prefixHex (hex) {
  return hex.indexOf('0x') === 0 ? hex : '0x' + hex
}

function flatten (arr) {
  return arr.reduce(function (all, some) {
    return all.concat(some)
  }, [])
}

function getWallet ({ privateKey, wallet }) {
  return wallet || Wallet.fromPrivateKey(privateKey)
}

function pickNonNull (obj) {
  const nonNull = {}
  for (let key in obj) {
    if (obj[key] != null) {
      nonNull[key] = obj[key]
    }
  }

  return nonNull
}

function isUnderpricedError (err) {
  return /underpriced/i.test(err.message)
}

function normalizeTo ({ address, amount }) {
  return {
    address: prefixHex(address),
    amount
  }
}
