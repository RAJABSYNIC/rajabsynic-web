const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const fs = require('fs');
const path = require('path');

// Initialize Firebase Admin
let serviceAccount;
try {
    serviceAccount = require('../serviceAccountKey.json');
} catch (e) {
    try {
         serviceAccount = require('./serviceAccountKey.json');
    } catch(err) {
        console.error("❌ serviceAccountKey.json not found.");
        process.exit(1);
    }
}

initializeApp({
    credential: cert(serviceAccount)
});

const db = getFirestore();
const DB_FILE = path.join(__dirname, '..', 'data', 'db.json');

async function migrate() {
    console.log("🚀 Starting Phase 2 Migration (Settings, Logs, Patches)...");
    
    if (!fs.existsSync(DB_FILE)) {
        console.log("❌ db.json not found!");
        process.exit(1);
    }
    
    let localData = {};
    try {
        localData = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
        console.error("❌ Error reading db.json", e);
        process.exit(1);
    }

    // 1. Migrate Settings
    if (localData.settings) {
        console.log("Migrating settings...");
        await db.collection('config').doc('settings').set(localData.settings, { merge: true });
        console.log("✅ Settings migrated.");
    }

    // 2. Migrate User Activity
    if (localData.userActivity && Array.isArray(localData.userActivity)) {
        console.log(`Migrating ${localData.userActivity.length} user activity logs...`);
        const batch = db.batch();
        let count = 0;
        for (const log of localData.userActivity) {
            const ref = db.collection('activity_logs').doc();
            batch.set(ref, log);
            count++;
            if (count % 400 === 0) {
                await batch.commit();
                console.log(`... committed ${count} logs`);
            }
        }
        if (count % 400 !== 0) await batch.commit();
        console.log(`✅ ${count} Activity logs migrated.`);
    }

    // 3. Migrate Referral Patches
    if (localData.referral_patches && Array.isArray(localData.referral_patches)) {
        console.log(`Migrating ${localData.referral_patches.length} referral patches...`);
        const batch = db.batch();
        let count = 0;
        for (const patch of localData.referral_patches) {
            const ref = db.collection('referral_patches').doc(patch.id || db.collection('referral_patches').doc().id);
            batch.set(ref, patch);
            count++;
        }
        await batch.commit();
        console.log(`✅ ${count} Referral patches migrated.`);
    }

    console.log("🎉 Phase 2 Migration Complete!");
    process.exit(0);
}

migrate();
