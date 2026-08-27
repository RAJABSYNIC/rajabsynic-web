const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
initializeApp({ credential: cert(require(path.join(__dirname, 'serviceAccountKey.json'))) });
const fsdb = getFirestore();
async function checkPending() {
    const snap = await fsdb.collection('payments').where('status', '==', 'pending').get();
    console.log('--- PENDING PAYMENTS ---');
    snap.forEach(doc => {
        const p = doc.data();
        console.log(`ID: ${doc.id} | Status: ${p.status} | Amount: ${p.amount} | User: ${p.userId} | TS: ${p.timestamp}`);
    });
    process.exit(0);
}
checkPending().catch(console.error);
