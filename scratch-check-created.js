const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
initializeApp({ credential: cert(require(path.join(__dirname, 'serviceAccountKey.json'))) });
const fsdb = getFirestore();
async function checkPending() {
    const snap = await fsdb.collection('payments').orderBy('createdAt', 'desc').limit(10).get();
    console.log('--- RECENT PAYMENTS BY CREATEDAT ---');
    snap.forEach(doc => {
        const p = doc.data();
        console.log(`ID: ${doc.id} | Status: ${p.status} | Amount: ${p.amount} | Date: ${p.createdAt}`);
    });
    process.exit(0);
}
checkPending().catch(console.error);
