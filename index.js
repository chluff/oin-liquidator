const { connect, transactions, keyStores, Contract, utils } = require('near-api-js');
const { sha256 } = require("js-sha256");
const { getConfig } = require('./nearConfig.js');
const dotenv = require('dotenv');
const fs = require('fs');
dotenv.config();

// size of watchlist
const list_size = 5;
// watchlist update interval length (5 mn)
const watchlist_freq = 300_000;
// bot logic interval length (1 s)
const bot_freq = 1000;
// access key info refresh interval length (10 mn)
const access_key_freq = 600_000;
// don't update watchlist immediately after liquidation. wait (10 s)
// RPC returns old data for some time, leads to double liquidations
const post_liquidation_watchlist_update_delay = 10_000;

// log data to JSON file
let data = JSON.stringify({
  watchlist: {
    last_update: "",
    list: []
  },
  liquidations: {
    last_update: "",
    list: []
  }
}, null, 2);
fs.writeFileSync('status-logs.json', data);


// Directory where NEAR credentials are stored
const credentialsPath = "./credentials";

// Configure the keyStore to be used with the NEAR Javascript API
const UnencryptedFileSystemKeyStore = keyStores.UnencryptedFileSystemKeyStore;
const keyStore = new UnencryptedFileSystemKeyStore(credentialsPath);

// Setup default client options
const nearConfig = getConfig(process.env.NEAR_ENV || "development");
const options = {
	networkId:   	nearConfig.networkId,
	nodeUrl:     	nearConfig.nodeUrl,
	walletUrl:   	nearConfig.walletUrl,
	helperUrl:   	nearConfig.helperUrl,
	explorerUrl: 	nearConfig.explorerUrl,
	accountId:   	nearConfig.accountId,
	deps: 			{ keyStore: keyStore }
}

let watchlist = [], oinContract, min_ratio;
let watchlist_interval, bot_interval, access_key_interval;
let client, provider, account, keyPair, publicKey, accessKey, nonce, recentBlockHash;

// return [user, ratio] for a given user, ratio as BigInt
function getUserWithRatio(account_name) {
	return new Promise(async (resolve) => {
		let account_ratio = await oinContract.get_user_ratio({ account: account_name });
    resolve([account_name, BigInt(account_ratio)]);
	});
}

function customInsertInSorted(el, arr) {
  // for smol array, insertion sort is better
  // for long array, use binary search to find insertion index
  // 1) find index
  let i = arr.length;
  while ((i > 0) && (el[1] < arr[i-1][1]) ) {
    i--;
  }
  // 2) insert in array
  arr.splice(i, 0, el);
}

// liquidate an account
// manually construct the transaction
function liquidate(account_id) {
  nonce += 1;
  const actions = [transactions.functionCall(
    "liquidation",
    { account: account_id },
    300_000_000_000_000, // attached GAS
    0 // attached deposit in yoctoNEAR
  )];
  const transaction = transactions.createTransaction(
    options.accountId,
    publicKey,
    nearConfig.contractNames.oin,
    nonce,
    actions,
    recentBlockHash
  );
  // Before we can sign the transaction we must perform three steps
  // 1) Serialize the transaction in Borsh
  const serializedTx = utils.serialize.serialize(
    transactions.SCHEMA,
    transaction
  );
  // 2) Hash the serialized transaction using sha256
  const serializedTxHash = new Uint8Array(sha256.array(serializedTx));
  // 3) Create a signature using the hashed transaction
  const signature = keyPair.sign(serializedTxHash);
  // Sign the transaction
  const signedTransaction = new transactions.SignedTransaction({
    transaction,
    signature: new transactions.Signature({
      keyType: transaction.publicKey.keyType,
      data: signature.signature
    })
  });
  // Send the transaction
  provider.sendTransaction(signedTransaction);
}


async function nearSetup() {
	
	// Configure the client with options and our local key store
	client = await connect(options);
  provider = client.connection.provider;
	account = await client.account(options.accountId);
  keyPair = await keyStore.getKey(options.networkId, options.accountId);
  publicKey =  keyPair.getPublicKey();
  // Get access key information
  await getAccessKeyInfo();

	oinContract = new Contract(account, nearConfig.contractNames.oin, {
		viewMethods: ["list_liqutations", "get_user_ratio", "get_liquidation_line"],
		changeMethods: ["liquidation"],
		sender: options.accountId,
	});

}


/**
 * Get access key information from the node
 */
async function getAccessKeyInfo() {
  accessKey = await provider.query(
    `access_key/${options.accountId}/${publicKey.toString()}`, ""
  );
  nonce = accessKey.nonce;
  recentBlockHash = utils.serialize.base_decode(accessKey.block_hash);
}

/**
 * 1- get list of all depositors
 * 2- sort by c-ratio
 * 3- watch n accounts with lowest c-ratio
 */
async function getWatchlist() {

  // min c-ration
  min_ratio = await oinContract.get_liquidation_line();

  // list of all accounts
  const acc_list = await oinContract.list_liqutations();
  let acc_info_list = [], internal_watchlist = [];
  // retrieve account ratio
  for (let i = 0; i < acc_list.length; i++) {
    acc_info_list.push( getUserWithRatio(acc_list[i]) );
  }
  acc_info_list = await Promise.all(acc_info_list);

  // put the n worst accounts on watchlist, n defined by "list_size"
  for (let i = 0; i < acc_info_list.length; i++) {
    // ignore accounts with ratio <= 0
    if (acc_info_list[i][1] <= BigInt("0")) continue;
    // logic for adding to wathlist
    if (internal_watchlist.length === 0) {
      internal_watchlist.push( acc_info_list[i] );
    }
    else if (internal_watchlist.length < list_size) {
      customInsertInSorted(acc_info_list[i], internal_watchlist);
    }
    else if (acc_info_list[i][1] < internal_watchlist[internal_watchlist.length - 1][1]) {
      // remove old "account with biggest ratio" on watchlist
      internal_watchlist.pop();
      customInsertInSorted(acc_info_list[i], internal_watchlist);
    }
  }

  // update watchlist
  watchlist = internal_watchlist.map( el => { return el[0] });

  // log data to JSON file
  let status = JSON.parse(fs.readFileSync('status-logs.json'));
  status.watchlist.last_update = new Date().toLocaleString();
  status.watchlist.list = watchlist;
	fs.writeFileSync('status-logs.json', JSON.stringify(status, null, 2));

}

async function botLogic() {
  // list for logging last liquidations
  let liquidations_list = [];

  await Promise.all(watchlist.map(async (curr) => {
    // query ratio for watchlist accounts
    let ratio = await oinContract.get_user_ratio({ account: curr });

    // liquidate if ratio less than minimum and more than 0
    // ratio 0 is for accounts that repaid their debt
    if ((BigInt(ratio) < BigInt(min_ratio)) && (BigInt(ratio) > BigInt("0")) && (watchlist.indexOf(curr) > -1)) {

      // Remove liquidated accounts from watchlist
      let curr_index = watchlist.indexOf(curr);
      if (curr_index > -1) {
        watchlist.splice(curr_index, 1);
      }

      // liquidate
      liquidate(curr);

      // add to liquidation logs
      liquidations_list.push(curr);
    }
  }));

  // log to status if liquidation attempted
  if (liquidations_list.length > 0) {
    let status = JSON.parse(fs.readFileSync('status-logs.json'));
    status.liquidations.last_update = new Date().toLocaleString();
    status.liquidations.list = liquidations_list;
    fs.writeFileSync('status-logs.json', JSON.stringify(status, null, 2));

    // trigger new watchlist update cycle
    clearInterval(watchlist_interval);
    setTimeout(() => {
      getWatchlist();
      watchlist_interval = setInterval(getWatchlist, watchlist_freq);
    }, post_liquidation_watchlist_update_delay);
  }

}


// main function
async function main() {
	await nearSetup();

	getWatchlist();

  // regularly refresh watchlist entries
  watchlist_interval = setInterval(getWatchlist, watchlist_freq);
  //clearInterval(watchlist_interval);

  // regularly monitor accounts on the watchlist and
  // liquidate them if possible
  bot_interval = setInterval(botLogic, bot_freq);
  //clearInterval(bot_interval);

  // regularly refresh accessKey info
  access_key_interval = setInterval(getAccessKeyInfo, access_key_freq);
  //clearInterval(access_key_interval);
}

main();
