import Provider from '@liquality/provider'
import { AddressTypes, selectCoins } from '@liquality/bitcoin-utils'
import * as bitcoin from 'bitcoinjs-lib'
import * as bitcoinMessage from 'bitcoinjs-message'
import { Address, addressToString } from '@liquality/utils'
import { mnemonicToSeed } from 'bip39'
import { fromSeed } from 'bip32'
import { BigNumber } from 'bignumber.js'

import { version } from '../package.json'

const ADDRESS_GAP = 20
const NONCHANGE_ADDRESS = 0
const CHANGE_ADDRESS = 1
const NONCHANGE_OR_CHANGE_ADDRESS = 2

const ADDRESS_TYPE_TO_LEDGER_PREFIX = {
  'legacy': 44,
  'p2sh-segwit': 49,
  'bech32': 84
}

export default class BitcoinJsWalletProvider extends Provider {
  constructor (network, mnemonic, addressType = 'bech32') {
    super()
    if (!AddressTypes.includes(addressType)) {
      throw new Error(`addressType must be one of ${AddressTypes.join(',')}`)
    }
    if (mnemonic === '') {
      throw new Error('Mnemonic should not be empty')
    }
    const derivationPath = `${ADDRESS_TYPE_TO_LEDGER_PREFIX[addressType]}'/${network.coinType}'/0'/`
    this._derivationPath = derivationPath
    this._network = network
    this._mnemonic = mnemonic
    this._addressType = addressType
  }

  async node () {
    const seed = await mnemonicToSeed(this._mnemonic)
    return fromSeed(seed, this._network)
  }

  async keyPair (derivationPath) {
    const node = await this.node()
    const wif = node.derivePath(derivationPath).toWIF()
    return bitcoin.ECPair.fromWIF(wif, this._network)
  }

  async signMessage (message, from) {
    const address = await this.getWalletAddress(from)
    const keyPair = await this.keyPair(address.derivationPath)
    const signature = bitcoinMessage.sign(message, keyPair.privateKey, keyPair.compressed)
    return signature.toString('hex')
  }

  async _buildTransaction (outputs, feePerByte, fixedInputs) {
    const network = this._network

    const unusedAddress = await this.getUnusedAddress(true)
    const { inputs, change } = await this.getInputsForAmount(outputs, feePerByte, fixedInputs)

    if (change) {
      outputs.push({
        to: unusedAddress,
        value: change.value
      })
    }

    const txb = new bitcoin.TransactionBuilder(network)

    for (const output of outputs) {
      const to = output.to.address === undefined ? output.to : addressToString(output.to) // Allow for OP_RETURN
      txb.addOutput(to, output.value)
    }

    const prevOutScriptType = this.getScriptType()

    for (let i = 0; i < inputs.length; i++) {
      const wallet = await this.getWalletAddress(inputs[i].address)
      const keyPair = await this.keyPair(wallet.derivationPath)
      const paymentVariant = this.getPaymentVariantFromPublicKey(keyPair.publicKey)

      txb.addInput(inputs[i].txid, inputs[i].vout, 0, paymentVariant.output)
    }

    for (let i = 0; i < inputs.length; i++) {
      const wallet = await this.getWalletAddress(inputs[i].address)
      const keyPair = await this.keyPair(wallet.derivationPath)
      const paymentVariant = this.getPaymentVariantFromPublicKey(keyPair.publicKey)
      const needsWitness = this._addressType === 'bech32' || this._addressType === 'p2sh-segwit'

      const signParams = { prevOutScriptType, vin: i, keyPair }

      if (needsWitness) {
        signParams.witnessValue = inputs[i].value
      }

      if (this._addressType === 'p2sh-segwit') {
        signParams.redeemScript = paymentVariant.redeem.output
      }

      txb.sign(signParams)
    }

    return txb.build().toHex()
  }

  async buildTransaction (to, value, data, feePerByte) {
    return this._buildTransaction([{ to, value, feePerByte }])
  }

  async buildBatchTransaction (transactions) {
    return this._buildTransaction(transactions)
  }

  async _sendTransaction (transactions, feePerByte) {
    const signedTransaction = await this._buildTransaction(transactions, feePerByte)
    return this.getMethod('sendRawTransaction')(signedTransaction)
  }

  async sendTransaction (to, value, data, feePerByte) {
    return this._sendTransaction([{ to, value }], feePerByte)
  }

  async updateTransactionFee (txHash, newFeePerByte) {
    const transaction = await this.getMethod('getTransactionByHash')(txHash)
    if (transaction._raw.vin.length === 1 && transaction._raw.vout.length === 1) { // TODO: better heurestic for P2SH/ P2WSH
      const inputTx = await this.getMethod('getTransactionByHash')(transaction._raw.vin[0].txid)
      const inputTxHex = inputTx._raw.hex
      const tx = bitcoin.Transaction.fromHex(transaction._raw.hex)

      // // Modify output
      // tx.outs[0]

      const address = transaction._raw.vout[0].scriptPubKey.addresses[0]
      const prevout = inputTx._raw.vout[transaction._raw.vin[0].vout]
      prevout.vSat = BigNumber(prevout.value).times(1e8).toNumber()
      const outputScript = Buffer.from(transaction._raw.vin[0].txinwitness[transaction._raw.vin[0].txinwitness.length - 1]) // TODO: this doesn't seem accurate enough
      const lockTime = 0 // TBD
      const segwit = true // TBD LOOK BELOW
      // isSegwit ? swapPaymentVariants.p2wsh.redeem.output : swapPaymentVariants.p2sh.redeem.output,
      // isRedeem ? 0 : expiration,
      // isSegwit

      const sig = await this.signP2SHTransaction(inputTxHex, tx, address, prevout, outputScript, lockTime, segwit)

      tx.setWitness(0, [sig, tx.ins[0].witness[1], tx.ins[0].witness[2], tx.ins[0].witness[3], tx.ins[0].witness[4]]) // lol???? the hell is this

      return this.getMethod('sendRawTransaction')(tx.toHex())
    }
    const fixedInputs = [transaction._raw.vin[0]] // TODO: should this pick more than 1 input? RBF doesn't mandate it
    const changeAddresses = (await this.getAddresses(0, 1000, true)).map(a => a.address)
    const nonChangeOutputs = transaction._raw.vout.filter(vout => !changeAddresses.includes(vout.scriptPubKey.addresses[0]))
    const transactions = nonChangeOutputs.map(output =>
      ({ to: output.scriptPubKey.addresses[0], value: BigNumber(output.value).times(1e8).toNumber() })
    )
    const signedTransaction = await this._buildTransaction(transactions, newFeePerByte, fixedInputs)
    return this.getMethod('sendRawTransaction')(signedTransaction)
  }

  async sendBatchTransaction (transactions) {
    return this._sendTransaction(transactions)
  }

  async signP2SHTransaction (inputTxHex, tx, address, prevout, outputScript, lockTime = 0, segwit = false) {
    const wallet = await this.getWalletAddress(address)
    const keyPair = await this.keyPair(wallet.derivationPath)

    let sigHash

    if (segwit) {
      sigHash = tx.hashForWitnessV0(0, outputScript, prevout.vSat, bitcoin.Transaction.SIGHASH_ALL) // AMOUNT NEEDS TO BE PREVOUT AMOUNT
    } else {
      sigHash = tx.hashForSignature(0, outputScript, bitcoin.Transaction.SIGHASH_ALL)
    }

    const sig = bitcoin.script.signature.encode(keyPair.sign(sigHash), bitcoin.Transaction.SIGHASH_ALL)
    return sig
  }

  // inputs consists of [{ inputTxHex, index, vout, outputScript }]
  async signBatchP2SHTransaction (inputs, addresses, tx, lockTime = 0, segwit = false) {
    let keyPairs = []
    for (const address of addresses) {
      const wallet = await this.getWalletAddress(address)
      const keyPair = await this.keyPair(wallet.derivationPath)
      keyPairs.push(keyPair)
    }

    let sigs = []
    for (let i = 0; i < inputs.length; i++) {
      const index = inputs[i].txInputIndex ? inputs[i].txInputIndex : inputs[i].index
      let sigHash
      if (segwit) {
        sigHash = tx.hashForWitnessV0(index, inputs[i].outputScript, inputs[i].vout.vSat, bitcoin.Transaction.SIGHASH_ALL) // AMOUNT NEEDS TO BE PREVOUT AMOUNT
      } else {
        sigHash = tx.hashForSignature(index, inputs[i].outputScript, bitcoin.Transaction.SIGHASH_ALL)
      }

      const sig = bitcoin.script.signature.encode(keyPairs[i].sign(sigHash), bitcoin.Transaction.SIGHASH_ALL)
      sigs.push(sig)
    }

    return sigs
  }

  async getWalletAddress (address) {
    let index = 0
    let change = false

    // A maximum number of addresses to lookup after which it is deemed
    // that the wallet does not contain this address
    const maxAddresses = 1000
    const addressesPerCall = 50

    while (index < maxAddresses) {
      const addrs = await this.getAddresses(index, addressesPerCall, change)
      const addr = addrs.find(addr => addr.equals(address))
      if (addr) return addr

      index += addressesPerCall
      if (index === maxAddresses && change === false) {
        index = 0
        change = true
      }
    }

    throw new Error('BitcoinJs: Wallet does not contain address')
  }

  getScriptType () {
    if (this._addressType === 'legacy') return 'p2pkh'
    else if (this._addressType === 'p2sh-segwit') return 'p2sh-p2wpkh'
    else if (this._addressType === 'bech32') return 'p2wpkh'
  }

  getAddressFromPublicKey (publicKey) {
    return this.getPaymentVariantFromPublicKey(publicKey).address
  }

  getPaymentVariantFromPublicKey (publicKey) {
    if (this._addressType === 'legacy') {
      return bitcoin.payments.p2pkh({ pubkey: publicKey, network: this._network })
    } else if (this._addressType === 'p2sh-segwit') {
      return bitcoin.payments.p2sh({
        redeem: bitcoin.payments.p2wpkh({ pubkey: publicKey, network: this._network }),
        network: this._network })
    } else if (this._addressType === 'bech32') {
      return bitcoin.payments.p2wpkh({ pubkey: publicKey, network: this._network })
    }
  }

  async _importAddresses () {
    const change = await this.getAddresses(0, 200, true)
    const nonChange = await this.getAddresses(0, 200, false)
    const all = [...nonChange, ...change].map(addressToString)
    await this.getMethod('importAddresses')(all)
  }

  async getAddresses (startingIndex = 0, numAddresses = 1, change = false) {
    if (numAddresses < 1) { throw new Error('You must return at least one address') }

    const node = await this.node()

    const addresses = []
    const lastIndex = startingIndex + numAddresses
    const changeVal = change ? '1' : '0'

    for (let currentIndex = startingIndex; currentIndex < lastIndex; currentIndex++) {
      const subPath = changeVal + '/' + currentIndex
      const path = this._derivationPath + subPath
      const publicKey = node.derivePath(path).publicKey
      const address = this.getAddressFromPublicKey(publicKey)

      addresses.push(new Address({
        address,
        publicKey,
        derivationPath: path,
        index: currentIndex
      }))
    }

    return addresses
  }

  async _getUsedUnusedAddresses (numAddressPerCall = 100, addressType) {
    const usedAddresses = []
    const addressCountMap = { change: 0, nonChange: 0 }
    const unusedAddressMap = { change: null, nonChange: null }

    let addrList
    let addressIndex = 0
    let changeAddresses = []
    let nonChangeAddresses = []

    /* eslint-disable no-unmodified-loop-condition */
    while (
      (addressType === NONCHANGE_OR_CHANGE_ADDRESS && (
        addressCountMap.change < ADDRESS_GAP || addressCountMap.nonChange < ADDRESS_GAP)
      ) ||
      (addressType === NONCHANGE_ADDRESS && addressCountMap.nonChange < ADDRESS_GAP) ||
      (addressType === CHANGE_ADDRESS && addressCountMap.change < ADDRESS_GAP)
    ) {
      /* eslint-enable no-unmodified-loop-condition */
      addrList = []

      if ((addressType === NONCHANGE_OR_CHANGE_ADDRESS || addressType === CHANGE_ADDRESS) &&
           addressCountMap.change < ADDRESS_GAP) {
        // Scanning for change addr
        changeAddresses = await this.getAddresses(addressIndex, numAddressPerCall, true)
        addrList = addrList.concat(changeAddresses)
      } else {
        changeAddresses = []
      }

      if ((addressType === NONCHANGE_OR_CHANGE_ADDRESS || addressType === NONCHANGE_ADDRESS) &&
           addressCountMap.nonChange < ADDRESS_GAP) {
        // Scanning for non change addr
        nonChangeAddresses = await this.getAddresses(addressIndex, numAddressPerCall, false)
        addrList = addrList.concat(nonChangeAddresses)
      }

      const transactionCounts = await this.getMethod('getAddressTransactionCounts')(addrList)

      for (let address of addrList) {
        const isUsed = transactionCounts[address] > 0
        const isChangeAddress = changeAddresses.find(a => address.equals(a))
        const key = isChangeAddress ? 'change' : 'nonChange'

        if (isUsed) {
          usedAddresses.push(address)
          addressCountMap[key] = 0
          unusedAddressMap[key] = null
        } else {
          addressCountMap[key]++

          if (!unusedAddressMap[key]) {
            unusedAddressMap[key] = address
          }
        }
      }

      addressIndex += numAddressPerCall
    }

    let firstUnusedAddress
    const indexNonChange = unusedAddressMap.nonChange ? unusedAddressMap.nonChange.index : Infinity
    const indexChange = unusedAddressMap.change ? unusedAddressMap.change.index : Infinity

    if (indexNonChange <= indexChange) firstUnusedAddress = unusedAddressMap.nonChange
    else firstUnusedAddress = unusedAddressMap.change

    return {
      usedAddresses,
      unusedAddress: unusedAddressMap,
      firstUnusedAddress
    }
  }

  async getUsedAddresses (numAddressPerCall = 100) {
    return this._getUsedUnusedAddresses(numAddressPerCall, NONCHANGE_OR_CHANGE_ADDRESS)
      .then(({ usedAddresses }) => usedAddresses)
  }

  async getUnusedAddress (change = false, numAddressPerCall = 100) {
    const addressType = change ? CHANGE_ADDRESS : NONCHANGE_ADDRESS
    const key = change ? 'change' : 'nonChange'
    return this._getUsedUnusedAddresses(numAddressPerCall, addressType)
      .then(({ unusedAddress }) => unusedAddress[key])
  }

  async getInputsForAmount (_targets, _feePerByte, fixedInputs = [], numAddressPerCall = 100) {
    let addressIndex = 0
    let changeAddresses = []
    let nonChangeAddresses = []
    let addressCountMap = {
      change: 0,
      nonChange: 0
    }

    const feePerBytePromise = this.getMethod('getFeePerByte')()
    let feePerByte = _feePerByte || false

    while (addressCountMap.change < ADDRESS_GAP || addressCountMap.nonChange < ADDRESS_GAP) {
      let addrList = []

      if (addressCountMap.change < ADDRESS_GAP) {
        // Scanning for change addr
        changeAddresses = await this.getAddresses(addressIndex, numAddressPerCall, true)
        addrList = addrList.concat(changeAddresses)
      } else {
        changeAddresses = []
      }

      if (addressCountMap.nonChange < ADDRESS_GAP) {
        // Scanning for non change addr
        nonChangeAddresses = await this.getAddresses(addressIndex, numAddressPerCall, false)
        addrList = addrList.concat(nonChangeAddresses)
      }

      let utxos = await this.getMethod('getUnspentTransactions')(addrList)
      utxos = utxos.map(utxo => {
        const addr = addrList.find(a => a.equals(utxo.address))
        return {
          ...utxo,
          value: BigNumber(utxo.amount).times(1e8).toNumber(),
          derivationPath: addr.derivationPath
        }
      })

      const transactionCounts = await this.getMethod('getAddressTransactionCounts')(addrList)

      if (feePerByte === false) feePerByte = await feePerBytePromise
      const minRelayFee = await this.getMethod('getMinRelayFee')()

      if (fixedInputs.length) {
        for (const input of fixedInputs) {
          const tx = await this.getMethod('getTransactionByHash')(input.txid)
          input.value = BigNumber(tx._raw.vout[input.vout].value).times(1e8).toNumber()
          input.address = tx._raw.vout[input.vout].scriptPubKey.addresses[0]
        }
      }

      const targets = _targets.map((target, i) => ({ id: 'main', value: target.value }))

      // TODO: does minrelayfee need to consider RBF?
      const { inputs, outputs, fee } = selectCoins(utxos, targets, Math.ceil(feePerByte), minRelayFee, fixedInputs)

      if (inputs && outputs) {
        let change = outputs.find(output => output.id !== 'main')

        if (change && change.length) {
          change = change[0].value
        }

        return {
          inputs,
          change,
          fee
        }
      }

      for (let address of addrList) {
        const isUsed = transactionCounts[address.address]
        const isChangeAddress = changeAddresses.find(a => address.equals(a))
        const key = isChangeAddress ? 'change' : 'nonChange'

        if (isUsed) {
          addressCountMap[key] = 0
        } else {
          addressCountMap[key]++
        }
      }

      addressIndex += numAddressPerCall
    }

    throw new Error('Not enough balance')
  }
}

BitcoinJsWalletProvider.version = version
