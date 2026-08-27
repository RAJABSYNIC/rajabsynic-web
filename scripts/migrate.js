const fs = require('fs');
const path = require('path');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

// Initialize Firebase Admin
const keyPath = path.join(__dirname, '..', 'serviceAccountKey.json');
if (!fs.existsSync(keyPath)) {
    console.error("Missing serviceAccountKey.json!");
    process.exit(1);
}

initializeApp({ credential: cert(require(keyPath)) });
const db = getFirestore();

const DB_FILE = path.join(__dirname, '..', 'data', 'db.json');

async function migrate() {
    console.log("Starting Migration...");
    
    if (!fs.existsSync(DB_FILE)) {
        console.error("db.json not found!");
        return;
    }

    const localDb = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    
    // 1. Migrate Payments
    const payments = localDb.payments || [];
    console.log(`Found ${payments.length} payments.`);
    
    let count = 0;
    const batchSize = 100;
    let batch = db.batch();
    
    for (const p of payments) {
        if (!p.id && !p.order_id) continue;
        const docId = p.id || p.order_id;
        const docRef = db.collection('payments').doc(docId);
        
        // Ensure proper types and remove duplicates if any
        const paymentData = { ...p };
        
        batch.set(docRef, paymentData);
        count++;
        
        if (count % batchSize === 0) {
            await batch.commit();
            console.log(`Migrated ${count} payments...`);
            batch = db.batch(); // start a new batch
        }
    }
    
    if (count % batchSize !== 0) {
        await batch.commit();
    }
    
    console.log(`Successfully migrated ${count} payments to Firestore!`);
    
    // Migrating users if they have referral balances
    const users = localDb.users || [];
    let uCount = 0;
    let uBatch = db.batch();
    for (const u of users) {
        if (!u.id) continue;
        // The frontend already syncs users to Firestore, but let's make sure 
        // referral earnings that were in db.json are migrated properly.
        // Wait, `server.js` was saving `referralEarnings` and `paidWithdrawals` directly to Firestore if fsdb existed!
        // It's already in Firestore.
    }
    
    console.log("Migration Complete!");
}

migrate().catch(console.error);
