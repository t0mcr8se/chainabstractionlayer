/* eslint-env mocha */
/* eslint-disable no-unused-expressions */
import chai, { expect } from 'chai'
import chaiAsPromised from 'chai-as-promised'
import * as bitcoin from 'bitcoinjs-lib'
import { hash160 } from '../../../packages/crypto/lib'
import { calculateFee } from '../../../packages/bitcoin-utils/lib'
import { addressToString } from '../../../packages/utils/lib'
import { chains, importBitcoinAddresses, getNewAddress, getRandomBitcoinAddress, mineBlock, fundWallet, describeExternal } from '../common'
import config from '../config'

process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = 0

chai.use(chaiAsPromised)
chai.use(require('chai-bignumber')())

async function getTransactionFee (chain, tx) {
  const inputs = tx._raw.vin.map((vin) => ({ txid: vin.txid, vout: vin.vout }))
  const inputTransactions = await Promise.all(
    inputs.map(input => chain.client.chain.getTransactionByHash(input.txid))
  )
  const inputValues = inputTransactions.map((inputTx, index) => {
    const vout = inputs[index].vout
    const output = inputTx._raw.vout[vout]
    return output.value * 1e8
  })
  const inputValue = inputValues.reduce((a, b) => a + b, 0)

  const outputValue = tx._raw.vout.reduce((a, b) => a + b.value * 1e8, 0)

  const feeValue = inputValue - outputValue

  return feeValue
}

async function expectFee (chain, txHash, feePerByte, segwitFeeImplemented = false) {
  const tx = await chain.client.chain.getTransactionByHash(txHash)
  const fee = await getTransactionFee(chain, tx)
  const size = segwitFeeImplemented ? tx._raw.vsize : tx._raw.size
  const maxFeePerByte = (feePerByte * (size + 2)) / size // https://github.com/bitcoin/bitcoin/blob/362f9c60a54e673bb3daa8996f86d4bc7547eb13/test/functional/test_framework/util.py#L40

  expect(fee / size).gte(feePerByte)
  expect(fee / size).lte(maxFeePerByte)
}

function testTransaction (chain, segwitFeeImplemented = false) {
  it('Sent value to 1 address', async () => {
    const addr = await getRandomBitcoinAddress(chain)
    const value = config[chain.name].value

    const balBefore = await chain.client.chain.getBalance(addr)
    await chain.client.chain.sendTransaction(addr, value)
    await mineBlock(chain)
    const balAfter = await chain.client.chain.getBalance(addr)

    expect(balBefore.plus(value).toString()).to.equal(balAfter.toString())
  })

  it('Send transaction with fee', async () => {
    const addr = await getRandomBitcoinAddress(chain)
    const value = config[chain.name].value

    const balBefore = await chain.client.chain.getBalance(addr)
    const txHash = await chain.client.chain.sendTransaction(addr, value, undefined, 100)
    await mineBlock(chain)

    const balAfter = await chain.client.chain.getBalance(addr)

    expect(balBefore.plus(value).toString()).to.equal(balAfter.toString())
    await expectFee(chain, txHash, 100, segwitFeeImplemented)
  })

  it('Update transaction fee', async () => {
    const addr = await getRandomBitcoinAddress(chain)
    const value = config[chain.name].value

    const balBefore = await chain.client.chain.getBalance(addr)
    const txHash = await chain.client.chain.sendTransaction(addr, value, undefined, 100)
    await expectFee(chain, txHash, 100, segwitFeeImplemented)
    const newTxHash = await chain.client.chain.updateTransactionFee(txHash, 120)
    await expectFee(chain, newTxHash, 120, segwitFeeImplemented)
    await mineBlock(chain)

    const balAfter = await chain.client.chain.getBalance(addr)

    expect(balBefore.plus(value).toString()).to.equal(balAfter.toString())
  })
}

function testBatchTransaction (chain) {
  it('Sent value to 2 addresses', async () => {
    const addr1 = await getRandomBitcoinAddress(chain)
    const addr2 = await getRandomBitcoinAddress(chain)

    const value = config[chain.name].value

    const bal1Before = await chain.client.chain.getBalance(addr1)
    const bal2Before = await chain.client.chain.getBalance(addr2)
    await chain.client.chain.sendBatchTransaction([{ to: addr1, value }, { to: addr2, value }])
    await mineBlock(chain)
    const bal1After = await chain.client.chain.getBalance(addr1)
    const bal2After = await chain.client.chain.getBalance(addr2)

    expect(bal1Before.plus(value).toString()).to.equal(bal1After.toString())
    expect(bal2Before.plus(value).toString()).to.equal(bal2After.toString())
  })
}

function testSignP2SHTransaction (chain) {
  it('should redeem one P2SH', async () => {
    const network = chain.network
    const value = config[chain.name].value
    const OPS = bitcoin.script.OPS

    const { address: unusedAddressOne } = await getNewAddress(chain)
    await chain.client.chain.sendTransaction(unusedAddressOne, value)
    await mineBlock(chain)

    const { address: unusedAddressTwo } = await getNewAddress(chain)

    const newAddresses = [ unusedAddressOne ]

    let addresses = []
    for (const newAddress of newAddresses) {
      const address = await chain.client.getMethod('getWalletAddress')(newAddress)
      addresses.push(address)
    }

    const multisigOutput = bitcoin.script.compile([
      OPS.OP_DUP,
      OPS.OP_HASH160,
      Buffer.from(hash160(addresses[0].publicKey), 'hex'),
      OPS.OP_EQUALVERIFY,
      OPS.OP_CHECKSIG
    ])

    const paymentVariant = bitcoin.payments.p2wsh({ redeem: { output: multisigOutput, network }, network })

    const address = paymentVariant.address

    const initiationTxHash = await chain.client.chain.sendTransaction(address, value)
    await mineBlock(chain)

    const initiationTxRaw = await chain.client.getMethod('getRawTransactionByHash')(initiationTxHash)
    const initiationTx = await chain.client.getMethod('decodeRawTransaction')(initiationTxRaw)

    const multiOne = {}

    for (const voutIndex in initiationTx._raw.data.vout) {
      const vout = initiationTx._raw.data.vout[voutIndex]
      const paymentVariantEntryOne = (paymentVariant.output.toString('hex') === vout.scriptPubKey.hex)
      if (paymentVariantEntryOne) multiOne.multiVout = vout
    }

    const txb = new bitcoin.TransactionBuilder(network)
    const txfee = calculateFee(3, 3, 9)

    multiOne.multiVout.vSat = value

    txb.addInput(initiationTxHash, multiOne.multiVout.n, 0, paymentVariant.output)
    txb.addOutput(addressToString(unusedAddressTwo), value - txfee)

    const tx = txb.buildIncomplete()

    const signaturesOne = await chain.client.getMethod('signP2SHTransaction')(initiationTxRaw, tx, addresses[0].address, multiOne.multiVout, paymentVariant.redeem.output, 0, true)

    const multiOneInput = bitcoin.script.compile([
      signaturesOne,
      Buffer.from(addresses[0].publicKey, 'hex')
    ])

    multiOne.paymentParams = { redeem: { output: multisigOutput, input: multiOneInput, network }, network }

    multiOne.paymentWithInput = bitcoin.payments.p2wsh(multiOne.paymentParams)

    tx.setWitness(0, multiOne.paymentWithInput.witness)

    const claimTxHash = await chain.client.getMethod('sendRawTransaction')(tx.toHex())

    await mineBlock(chain)

    const claimTxRaw = await chain.client.getMethod('getRawTransactionByHash')(claimTxHash)
    const claimTx = await chain.client.getMethod('decodeRawTransaction')(claimTxRaw)

    const claimVouts = claimTx._raw.data.vout
    const claimVins = claimTx._raw.data.vin

    expect(claimVins.length).to.equal(1)
    expect(claimVouts.length).to.equal(1)
  })
}

function testSignBatchP2SHTransaction (chain) {
  it('Should redeem two P2SH\'s', async () => {
    const network = chain.network
    const value = config[chain.name].value
    const OPS = bitcoin.script.OPS

    const { address: unusedAddressOne } = await getNewAddress(chain)
    await chain.client.chain.sendTransaction(unusedAddressOne, value)
    await mineBlock(chain)

    const { address: unusedAddressTwo } = await getNewAddress(chain)

    const newAddresses = [ unusedAddressOne, unusedAddressTwo ]

    let addresses = []
    for (const newAddress of newAddresses) {
      const address = await chain.client.getMethod('getWalletAddress')(newAddress)
      addresses.push(address)
    }

    const multisigOutputOne = bitcoin.script.compile([
      OPS.OP_2,
      Buffer.from(addresses[0].publicKey, 'hex'),
      Buffer.from(addresses[1].publicKey, 'hex'),
      OPS.OP_2,
      OPS.OP_CHECKMULTISIG
    ])

    const multisigOutputTwo = bitcoin.script.compile([
      OPS.OP_2,
      Buffer.from(addresses[1].publicKey, 'hex'),
      Buffer.from(addresses[0].publicKey, 'hex'),
      OPS.OP_2,
      OPS.OP_CHECKMULTISIG
    ])

    const paymentVariantOne = bitcoin.payments.p2wsh({ redeem: { output: multisigOutputOne, network }, network })
    const paymentVariantTwo = bitcoin.payments.p2wsh({ redeem: { output: multisigOutputTwo, network }, network })

    const addressOne = paymentVariantOne.address
    const addressTwo = paymentVariantTwo.address

    const initiationTxHash = await chain.client.chain.sendBatchTransaction([{ to: addressOne, value }, { to: addressTwo, value }])
    await mineBlock(chain)

    const initiationTxRaw = await chain.client.getMethod('getRawTransactionByHash')(initiationTxHash)
    const initiationTx = await chain.client.getMethod('decodeRawTransaction')(initiationTxRaw)

    const multiOne = {}
    const multiTwo = {}

    for (const voutIndex in initiationTx._raw.data.vout) {
      const vout = initiationTx._raw.data.vout[voutIndex]
      const paymentVariantEntryOne = (paymentVariantOne.output.toString('hex') === vout.scriptPubKey.hex)
      const paymentVariantEntryTwo = (paymentVariantTwo.output.toString('hex') === vout.scriptPubKey.hex)
      if (paymentVariantEntryOne) multiOne.multiVout = vout
      if (paymentVariantEntryTwo) multiTwo.multiVout = vout
    }

    const txb = new bitcoin.TransactionBuilder(network)
    const txfee = calculateFee(3, 3, 9)

    multiOne.multiVout.vSat = value
    multiTwo.multiVout.vSat = value

    txb.addInput(initiationTxHash, multiOne.multiVout.n, 0, paymentVariantOne.output)
    txb.addInput(initiationTxHash, multiTwo.multiVout.n, 0, paymentVariantTwo.output)
    txb.addOutput(addressToString(unusedAddressTwo), (value * 2) - txfee)

    const tx = txb.buildIncomplete()

    const signaturesOne = await chain.client.getMethod('signBatchP2SHTransaction')(
      [
        { inputTxHex: initiationTxRaw, index: 0, vout: multiOne.multiVout, outputScript: paymentVariantOne.redeem.output },
        { inputTxHex: initiationTxRaw, index: 1, vout: multiTwo.multiVout, outputScript: paymentVariantTwo.redeem.output }
      ],
      [ addresses[0].address, addresses[0].address ],
      tx,
      0,
      true
    )

    const signaturesTwo = await chain.client.getMethod('signBatchP2SHTransaction')(
      [
        { inputTxHex: initiationTxRaw, index: 0, vout: multiOne.multiVout, outputScript: paymentVariantOne.redeem.output },
        { inputTxHex: initiationTxRaw, index: 1, vout: multiTwo.multiVout, outputScript: paymentVariantTwo.redeem.output }
      ],
      [ addresses[1].address, addresses[1].address ],
      tx,
      0,
      true
    )

    const multiOneInput = bitcoin.script.compile([
      OPS.OP_0,
      signaturesOne[0],
      signaturesTwo[0]
    ])

    const multiTwoInput = bitcoin.script.compile([
      OPS.OP_0,
      signaturesTwo[1],
      signaturesOne[1]
    ])

    multiOne.paymentParams = { redeem: { output: multisigOutputOne, input: multiOneInput, network }, network }
    multiTwo.paymentParams = { redeem: { output: multisigOutputTwo, input: multiTwoInput, network }, network }

    multiOne.paymentWithInput = bitcoin.payments.p2wsh(multiOne.paymentParams)
    multiTwo.paymentWithInput = bitcoin.payments.p2wsh(multiTwo.paymentParams)

    tx.setWitness(0, multiOne.paymentWithInput.witness)
    tx.setWitness(1, multiTwo.paymentWithInput.witness)

    const claimTxHash = await chain.client.getMethod('sendRawTransaction')(tx.toHex())

    await mineBlock(chain)

    const claimTxRaw = await chain.client.getMethod('getRawTransactionByHash')(claimTxHash)
    const claimTx = await chain.client.getMethod('decodeRawTransaction')(claimTxRaw)

    const claimVouts = claimTx._raw.data.vout
    const claimVins = claimTx._raw.data.vin

    expect(claimVins.length).to.equal(2)
    expect(claimVouts.length).to.equal(1)
  })
}

describe('Transactions', function () {
  this.timeout(config.timeout)

  describeExternal('Bitcoin - Ledger', () => {
    before(async function () {
      await importBitcoinAddresses(chains.bitcoinWithLedger)
      await fundWallet(chains.bitcoinWithLedger)
    })
    testTransaction(chains.bitcoinWithLedger)
    testBatchTransaction(chains.bitcoinWithLedger)
    testSignP2SHTransaction(chains.bitcoinWithLedger)
    testSignBatchP2SHTransaction(chains.bitcoinWithLedger)
  })

  describe('Bitcoin - Node', () => {
    testTransaction(chains.bitcoinWithNode, true)
    testBatchTransaction(chains.bitcoinWithNode)
    testSignP2SHTransaction(chains.bitcoinWithNode)
    testSignBatchP2SHTransaction(chains.bitcoinWithNode)
    testSignBatchP2SHTransaction(chains.bitcoinWithNode)
  })

  describe('Bitcoin - Js', () => {
    before(async function () {
      await importBitcoinAddresses(chains.bitcoinWithJs)
      await fundWallet(chains.bitcoinWithJs)
    })
    testTransaction(chains.bitcoinWithJs)
    testBatchTransaction(chains.bitcoinWithJs)
    testSignP2SHTransaction(chains.bitcoinWithJs)
    testSignBatchP2SHTransaction(chains.bitcoinWithJs)
    testSignBatchP2SHTransaction(chains.bitcoinWithJs)
  })
})
