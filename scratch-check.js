const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
initializeApp({ credential: cert(require(path.join(__dirname, 'serviceAccountKey.json'))) });
const fsdb = getFirestore();
async function checkLatest() {
    const snap = await fsdb.collection('payments').orderBy('timestamp', 'desc').limit(5).get();
    console.log('--- LATEST 5 PAYMENTS ---');
    snap.forEach(doc => {
        const p = doc.data();
        console.log(`ID: ${doc.id} | Status: ${p.status} | User: ${p.userId || p.uid} | Amount: ${p.amount} | Date: ${p.timestamp}`);
    });
    const subsSnap = await fsdb.collection('subscriptions').orderBy('createdAt', 'desc').limit(5).get();
    console.log('\n--- LATEST 5 SUBSCRIPTIONS ---');
    subsSnap.forEach(doc => {
        const s = doc.data();
        console.log(`Sub: ${doc.id} | User: ${s.userId} | Order: ${s.orderId} | Date: ${s.createdAt}`);
    });
    process.exit(0);
}
checkLatest().catch(console.error);
