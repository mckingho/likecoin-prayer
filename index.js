/* eslint-disable no-await-in-loop */
const BigNumber = require('bignumber.js');
const LIKECOIN = require('./constant/contract/likecoin');
const { web3, sendTransactionWithLoop } = require('./util/web3');
const {
  db,
  userCollection: userRef,
  payoutCollection: payoutRef,
} = require('./util/firebase');
const { logPayoutTx } = require('./util/logger');
const publisher = require('./util/gcloudPub');
const config = require('./config/config.js');
const { startPoller } = require('./util/poller');

const PUBSUB_TOPIC_MISC = 'misc';
const ONE_LIKE = new BigNumber(10).pow(18);
const LikeCoin = new web3.eth.Contract(LIKECOIN.LIKE_COIN_ABI, LIKECOIN.LIKE_COIN_ADDRESS);

function timeout(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function makeNewRecevier(wallet, user) {
  return {
    wallet,
    user,
    payoutIds: [],
    payoutDatas: [],
    value: new BigNumber(0),
  };
}

async function handleQuery(docs) {
  const senderMap = {};
  docs.forEach((ref) => {
    const d = ref.data();
    if (!d.to) {
      return; // wait for user to bind wallet
    }
    if (!d.value) {
      console.error(`handleQuery(): ${ref.id} has no value`); // eslint-disable-line no-console
      return;
    }
    if (!senderMap[d.to]) {
      senderMap[d.to] = makeNewRecevier(d.to, d.toId);
    }
    senderMap[d.to].payoutIds.push(ref.id);
    senderMap[d.to].payoutDatas.push(d);
    senderMap[d.to].value = senderMap[d.to].value.plus(new BigNumber(d.value));
  });
  const receivers = Object.keys(senderMap);
  for (let i = 0; i < receivers.length; i += 1) {
    try {
      const wallet = receivers[i];
      const data = senderMap[wallet];
      const {
        user,
        payoutIds,
        payoutDatas,
        value,
        delegatorAccount,
      } = data;
      await db.runTransaction(t => Promise.all(payoutIds.map(async (payoutId) => {
        const ref = payoutRef.doc(payoutId);
        const d = await t.get(ref);
        if (d.data().txHash) throw new Error('set claim fail');
      })).then(() => Promise.all(payoutIds.map(async (payoutId) => {
        const ref = payoutRef.doc(payoutId);
        await t.update(ref, {
          txHash: 'pending',
        });
      }))));
      const methodCall = LikeCoin.methods.transfer(wallet, value);
      const txData = methodCall.encodeABI();
      const {
        tx,
        txHash,
        pendingCount,
        gasPrice,
        delegatorAddress,
      } = await sendTransactionWithLoop(
        LIKECOIN.LIKE_COIN_ADDRESS,
        txData,
      );
      const batch = db.batch();
      payoutIds.forEach((payoutId) => {
        const ref = payoutRef.doc(payoutId);
        batch.update(ref, { txHash });
      });
      batch.commit();
      const currentBlock = await web3.eth.getBlockNumber();
      const remarks = payoutDatas.map(d => d.remarks).filter(r => !!r);
      await logPayoutTx({
        txHash,
        from: delegatorAddress,
        to: wallet,
        value: value.toString(),
        fromId: delegatorAccount || delegatorAddress,
        toId: user,
        currentBlock,
        nonce: pendingCount,
        rawSignedTx: tx.rawTransaction,
        delegatorAddress: web3.utils.toChecksumAddress(delegatorAddress),
        remarks: (remarks && remarks.length) ? remarks : 'Bonus',
      });
      const receiverDoc = await userRef.doc(user).get();
      const {
        referrer: toReferrer,
        timestamp: toRegisterTime,
      } = receiverDoc.data();
      publisher.publish(PUBSUB_TOPIC_MISC, null, {
        logType: 'eventPayout',
        fromUser: delegatorAccount || delegatorAddress,
        fromWallet: delegatorAddress,
        toUser: user,
        toWallet: wallet,
        toReferrer,
        toRegisterTime,
        likeAmount: value.dividedBy(ONE_LIKE).toNumber(),
        likeAmountUnitStr: value.toString(),
        txHash,
        txStatus: 'pending',
        txNonce: pendingCount,
        gasPrice,
        currentBlock,
        delegatorAddress: web3.utils.toChecksumAddress(delegatorAddress),
      });
    } catch (err) {
      console.error('handleQuery()', err); // eslint-disable-line no-console
    }
  }
}

async function loop() {
  while (true) { // eslint-disable-line no-constant-condition
    try {
      const query = await payoutRef.where('waitForClaim', '==', false)
        .where('effectiveTs', '<', Date.now())
        .where('txHash', '==', null)
        .limit(250)
        .get();
      await handleQuery(query.docs);
    } catch (err) {
      console.error('loop():', err); // eslint-disable-line no-console
    } finally {
      await timeout(config.POLLING_DELAY || 10000);
    }
  }
}

startPoller();
loop();
