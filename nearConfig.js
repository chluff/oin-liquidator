const dotenv = require('dotenv');
dotenv.config();

function getConfig (env) {
  switch (env) {
    case 'production':
    case 'mainnet':
      return {
        networkId: 'mainnet',
        nodeUrl: process.env.NEAR_NODE_URL_MAINNET || 'https://rpc.mainnet.near.org',
        contractNames: {
          oin: "v3.oin_finance.near"
        },
        walletUrl: 'https://wallet.near.org',
        helperUrl: 'https://helper.mainnet.near.org',
        explorerUrl: 'https://explorer.mainnet.near.org',
        accountId: process.env.NEAR_ACCOUNT_MAINNET
      }
    case 'development':
    case 'testnet':
      return {
        networkId: 'testnet',
        nodeUrl: process.env.NEAR_NODE_URL_TESTNET || 'https://rpc.testnet.near.org',
        contractNames: {
          oin: ""
        },
        walletUrl: 'https://wallet.testnet.near.org',
        helperUrl: 'https://helper.testnet.near.org',
        explorerUrl: 'https://explorer.testnet.near.org',
        accountId: process.env.NEAR_ACCOUNT_TESTNET
      }
    case 'local':
      return {
        networkId: 'local',
        nodeUrl: process.env.NEAR_NODE_URL_LOCAL || 'http://localhost:3030',
        keyPath: `${process.env.HOME}/.near/validator_key.json`,
        walletUrl: 'http://localhost:4000/wallet',
        contractNames: {
          oin: ""
        },
      }
    case 'test':
    case 'ci':
      return {
        networkId: 'shared-test',
        nodeUrl: process.env.NEAR_NODE_URL_CI_TESTNET || 'https://rpc.ci-testnet.near.org',
        contractNames: {
          oin: ""
        },
        masterAccount: 'test.near'
      }
    default:
      throw Error(`Unconfigured environment '${env}'. Can be configured in src/config.js.`)
  }
}

module.exports = {
  getConfig
};
