const dbRef = require('../util/firebase').txCollection;

async function logPayoutTx(payload) {
  const { txHash } = payload;
  try {
    await dbRef.doc(txHash).create({
      type: 'payout',
      status: 'pending',
      ts: Date.now(),
      ...payload,
    });
  } catch (err) {
    console.error('logPayoutTx():', err); // eslint-disable-line no-console
  }
}

module.exports = { logPayoutTx };
