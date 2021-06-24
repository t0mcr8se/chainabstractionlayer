import { WalletProvider } from '@liquality/wallet-provider'
import { Address, Network, solana } from '@liquality/types'
import { SolanaNetwork } from '@liquality/solana-network'

import { validateMnemonic, mnemonicToSeed } from 'bip39'
import { derivePath } from 'ed25519-hd-key'
import { Keypair, Transaction, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js'
import nacl from 'tweetnacl'

interface SolanaWalletProviderOptions {
  network: SolanaNetwork
  mnemonic: string
  derivationPath?: string
}

export default class SolanaWalletProvider extends WalletProvider {
  _network: SolanaNetwork
  _mnemonic: string
  _derivationPath: string
  _addressCache: { [key: string]: Address }
  _signer: Keypair

  constructor(options: SolanaWalletProviderOptions) {
    const { network, mnemonic, derivationPath } = options
    super({ network })
    this._network = network
    this._mnemonic = mnemonic
    this._derivationPath = derivationPath
    this._addressCache = {}
  }

  async isWalletAvailable(): Promise<boolean> {
    throw new Error('Method not implemented.')
  }

  async getAddresses(): Promise<Address[]> {
    if (this._addressCache[this._mnemonic]) {
      return [this._addressCache[this._mnemonic]]
    }

    const account = await this.setSigner()

    const result = new Address({
      address: account.publicKey.toString(),
      derivationPath: this._derivationPath
    })

    this._addressCache[this._mnemonic] = result

    return [result]
  }

  async getUnusedAddress(): Promise<Address> {
    const addresses = await this.getAddresses()
    return addresses[0]
  }

  async getUsedAddresses(): Promise<Address[]> {
    return this.getAddresses()
  }

  async sendTransaction(options: solana.SolanaSendOptions): Promise<Transaction> {
    await this.setSigner()

    const transaction = new Transaction({ signatures: [this._signer as any] })

    if (!options.instructions) {
      const to = new PublicKey(options.to)
      const lamports = Number(options.value)

      transaction.add(await this._sendBetweenAccounts(to, lamports))
    } else {
      options.instructions.forEach((instruction) => transaction.add(instruction))
    }

    let accounts = [this._signer]

    if (options.accounts) {
      accounts = [this._signer, ...options.accounts]
    }

    const tx = await this.getMethod('sendAndConfirmTransaction')(transaction, accounts)

    console.log('txHash', tx)

    return this.getMethod('getTransactionByHash')(tx)
  }

  // message: string, from: string
  signMessage(): Promise<string> {
    throw new Error('Method not implemented.')
  }

  async getConnectedNetwork(): Promise<Network> {
    return this._network
  }

  async _mnemonicToSeed(mnemonic: string) {
    if (!validateMnemonic(mnemonic)) {
      throw new Error('Invalid seed words')
    }

    const seed = await mnemonicToSeed(mnemonic)

    return Buffer.from(seed).toString('hex')
  }

  async getSigner(): Promise<Keypair> {
    if (!this._signer) {
      await this.setSigner()
    }

    return this._signer
  }

  async _sendBetweenAccounts(recepient: PublicKey, lamports: number): Promise<TransactionInstruction> {
    const signer = await this.getSigner()

    return SystemProgram.transfer({
      fromPubkey: signer.publicKey,
      toPubkey: recepient,
      lamports
    })
  }

  async setSigner(): Promise<Keypair> {
    const seed = await this._mnemonicToSeed(this._mnemonic)
    const derivedSeed = derivePath(this._derivationPath, seed).key

    const account = Keypair.fromSecretKey(nacl.sign.keyPair.fromSeed(derivedSeed).secretKey)

    this._signer = account

    return account
  }
}
