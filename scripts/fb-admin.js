/**
 * Firebase Admin CLI — create admins & users directly in Firebase.
 *
 * Requires a service account key JSON. Get it from:
 *   Firebase Console → Project Settings → Service accounts → Generate new private key
 * Save it in the project root as  serviceAccountKey.json  (already gitignored),
 * or set SERVICE_ACCOUNT_PATH in .env to its path.
 *
 * Usage:
 *   node scripts/fb-admin.js create-admin <email> <password> [role]
 *   node scripts/fb-admin.js create-user  <phone> <username> [password]
 *   node scripts/fb-admin.js make-admin    <email> [role]     (promote an existing Auth user)
 *   node scripts/fb-admin.js list-admins
 *   node scripts/fb-admin.js set-password  <email> <newPassword>
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
// firebase-admin v13+ uses a modular API (no admin.credential / admin.auth()).
const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');

const KEY_PATH = process.env.SERVICE_ACCOUNT_PATH || path.join(__dirname, '..', 'serviceAccountKey.json');

if (!fs.existsSync(KEY_PATH)) {
    console.error(`\n❌ Service account key not found at: ${KEY_PATH}`);
    console.error('   Firebase Console → Project Settings → Service accounts → Generate new private key');
    console.error('   Save it as serviceAccountKey.json in the project root (or set SERVICE_ACCOUNT_PATH in .env).\n');
    process.exit(1);
}

initializeApp({ credential: cert(require(KEY_PATH)) });
const auth = getAuth();
const db = getFirestore();

// Get an existing Auth user by email, or create one.
async function getOrCreateAuthUser(email, password) {
    try {
        return await auth.getUserByEmail(email);
    } catch (e) {
        if (e.code === 'auth/user-not-found') {
            if (!password) throw new Error('User does not exist and no password was provided to create it.');
            return await auth.createUser({ email, password });
        }
        throw e;
    }
}

async function createAdmin(email, password, role = 'admin') {
    if (!email || !password) throw new Error('Usage: create-admin <email> <password> [role]');
    email = email.toLowerCase().trim();
    const user = await getOrCreateAuthUser(email, password);
    await db.collection('admins').doc(user.uid).set({
        email,
        role,
        uid: user.uid,
        createdAt: new Date().toISOString()
    }, { merge: true });
    console.log(`✅ Admin ready: ${email} (uid=${user.uid}, role=${role})`);
}

async function makeAdmin(email, role = 'admin') {
    if (!email) throw new Error('Usage: make-admin <email> [role]');
    email = email.toLowerCase().trim();
    const user = await auth.getUserByEmail(email); // must already exist
    await db.collection('admins').doc(user.uid).set({
        email,
        role,
        uid: user.uid,
        createdAt: new Date().toISOString()
    }, { merge: true });
    console.log(`✅ Promoted to admin: ${email} (uid=${user.uid}, role=${role})`);
}

async function createUser(phone, username, password) {
    if (!phone || !username) throw new Error('Usage: create-user <phone> <username> [password]');
    phone = String(phone).replace(/[^0-9]/g, '');
    const email = `${phone}@rajabsynic.com`;
    const pass = password && password.length >= 6 ? password : `pass${phone}`;
    const user = await getOrCreateAuthUser(email, pass);
    await db.collection('users').doc(user.uid).set({
        username: username.trim(),
        phone,
        email,
        uid: user.uid,
        role: 'user',
        joinedAt: new Date().toISOString(),
        createdByAdmin: true
    }, { merge: true });
    console.log(`✅ User ready: ${username} (${phone}) email=${email}`);
    console.log(`   Login: phone ${phone}${password ? ` + password you set` : ' (phone-only, default password)'}`);
}

async function setPassword(email, newPassword) {
    if (!email || !newPassword) throw new Error('Usage: set-password <email> <newPassword>');
    const user = await auth.getUserByEmail(email.toLowerCase().trim());
    await auth.updateUser(user.uid, { password: newPassword });
    console.log(`✅ Password updated for ${email}`);
}

async function listAdmins() {
    const snap = await db.collection('admins').get();
    if (snap.empty) { console.log('No admins found.'); return; }
    console.log(`Admins (${snap.size}):`);
    snap.forEach(d => {
        const a = d.data();
        console.log(`  • ${a.email || '(no email)'}  role=${a.role || '-'}  uid=${d.id}`);
    });
}

(async () => {
    const [cmd, ...args] = process.argv.slice(2);
    try {
        switch (cmd) {
            case 'create-admin': await createAdmin(args[0], args[1], args[2]); break;
            case 'make-admin':   await makeAdmin(args[0], args[1]); break;
            case 'create-user':  await createUser(args[0], args[1], args[2]); break;
            case 'set-password': await setPassword(args[0], args[1]); break;
            case 'list-admins':  await listAdmins(); break;
            default:
                console.log('Commands:');
                console.log('  node scripts/fb-admin.js create-admin <email> <password> [role]');
                console.log('  node scripts/fb-admin.js make-admin   <email> [role]');
                console.log('  node scripts/fb-admin.js create-user  <phone> <username> [password]');
                console.log('  node scripts/fb-admin.js set-password <email> <newPassword>');
                console.log('  node scripts/fb-admin.js list-admins');
        }
    } catch (err) {
        console.error('❌', err.message);
        process.exit(1);
    }
    process.exit(0);
})();
