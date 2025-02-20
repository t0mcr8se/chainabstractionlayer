/* eslint-env mocha */
/* eslint-disable no-unused-expressions */
import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import { chains, describeExternal, fundAddress, TEST_TIMEOUT } from '../common'
import config from '../config'
import { testTransaction } from './common'

process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0'

chai.use(chaiAsPromised)

describeExternal('Transactions', function () {
  this.timeout(TEST_TIMEOUT)

  before(async () => {
    console.log(config.solana)
    await fundAddress(chains.solana, config.solana.receiverAddress)
  })

  describe('Solana', () => {
    testTransaction(chains.solana)
  })
})
