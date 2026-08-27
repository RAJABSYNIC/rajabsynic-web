const fs = require('fs');
const path = require('path');

const SERVER_FILE = path.join(__dirname, '..', 'server.js');
let code = fs.readFileSync(SERVER_FILE, 'utf8');

// 1. Add getAuth
if (!code.includes("require('firebase-admin/auth')")) {
    code = code.replace("require('firebase-admin/firestore');", "require('firebase-admin/firestore');\nconst { getAuth } = require('firebase-admin/auth');");
}

// 2. Add requireAdmin middleware
const requireAdminCode = `
// ─── API Security Middleware (JWT) ─────────────────────────────────────────────
async function requireAdmin(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'Unauthorized: Missing or invalid token' });
    }
    const token = authHeader.split('Bearer ')[1];
    try {
        const decodedToken = await getAuth().verifyIdToken(token);
        if (!fsdb) throw new Error('Firestore not initialized');
        const adminDoc = await fsdb.collection('admins').doc(decodedToken.uid).get();
        if (!adminDoc.exists) {
            return res.status(403).json({ success: false, error: 'Forbidden: You are not an admin' });
        }
        req.user = decodedToken;
        next();
    } catch (err) {
        console.error('API Security Error:', err.message);
        return res.status(401).json({ success: false, error: 'Unauthorized: Invalid token' });
    }
}
`;
if (!code.includes('function requireAdmin')) {
    code = code.replace('// ─── Utility Functions ────────────────────────────────────────────────────────', requireAdminCode + '\n// ─── Utility Functions ────────────────────────────────────────────────────────');
}

// 3. Remove DB functions & local db.json dependencies
code = code.replace(/let memoryDB = null;[\s\S]*?function writeDB\(data\) \{[\s\S]*?\n\}/m, '');
code = code.replace("const DB_FILE = path.join(__dirname, 'data', 'db.json');\n", "");

// 4. Remove Dead Code Endpoints
const endpointsToRemove = [
    /app\.post\('\/api\/login'[\s\S]*?\}\);\n/g,
    /app\.get\('\/api\/content'[\s\S]*?\}\);\n/g,
    /app\.post\('\/api\/content'[\s\S]*?\}\);\n/g,
    /app\.delete\('\/api\/content\/:id'[\s\S]*?\}\);\n/g,
    /app\.get\('\/api\/users'[\s\S]*?\}\);\n/g,
    /app\.delete\('\/api\/users\/:id'[\s\S]*?\}\);\n/g,
    /app\.get\('\/api\/admins'[\s\S]*?\}\);\n/g,
    /app\.post\('\/api\/admins'[\s\S]*?\}\);\n/g,
    /app\.delete\('\/api\/admins\/:id'[\s\S]*?\}\);\n/g
];

endpointsToRemove.forEach(regex => {
    code = code.replace(regex, '');
});

// 5. Update Endpoints to Firestore and add requireAdmin
// GET /api/dashboard-stats
code = code.replace("app.get('/api/dashboard-stats', (req, res) => {", "app.get('/api/dashboard-stats', requireAdmin, async (req, res) => {");
code = code.replace(/const db = readDB\(\);[\s\S]*?res\.json\(stats\);/m, `
    if (!fsdb) return res.json({ users: 0, revenue: 0, movies: 0, pendingWithdrawals: 0 });
    const stats = { users: 0, revenue: 0, movies: 0, pendingWithdrawals: 0 };
    try {
        const usersSnap = await fsdb.collection('users').count().get();
        stats.users = usersSnap.data().count;
        
        const contentSnap = await fsdb.collection('content').count().get();
        stats.movies = contentSnap.data().count;

        const paymentsSnap = await fsdb.collection('payments').where('status', 'in', ['completed', 'success', 'complete']).get();
        let total = 0;
        paymentsSnap.forEach(d => total += (Number(d.data().amount) || 0));
        stats.revenue = total;

        const wSnap = await fsdb.collection('withdrawals').where('status', '==', 'pending').count().get();
        stats.pendingWithdrawals = wSnap.data().count;

        res.json(stats);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
`);

// GET /api/payments
code = code.replace("app.get('/api/payments', async (req, res) => {", "app.get('/api/payments', requireAdmin, async (req, res) => {");

// GET /api/revenue
code = code.replace("app.get('/api/revenue', async (req, res) => {", "app.get('/api/revenue', requireAdmin, async (req, res) => {");

// GET /api/settings
code = code.replace("app.get('/api/settings', (req, res) => {", "app.get('/api/settings', async (req, res) => {");
code = code.replace(/const db = readDB\(\);[\s\S]*?res\.json\(db\.settings \|\| \{\}\);/, `
    if (!fsdb) return res.json({});
    const doc = await fsdb.collection('config').doc('settings').get();
    res.json(doc.exists ? doc.data() : {});
`);

// PUT /api/settings
code = code.replace("app.put('/api/settings', (req, res) => {", "app.put('/api/settings', requireAdmin, async (req, res) => {");
code = code.replace(/const db = readDB\(\);[\s\S]*?res\.json\(\{ success: true, settings: db\.settings \}\);/, `
    if (!fsdb) return res.status(500).json({ success: false, error: 'Database disconnected' });
    await fsdb.collection('config').doc('settings').set(req.body, { merge: true });
    res.json({ success: true, settings: req.body });
`);

// GET /api/public-config
code = code.replace("app.get('/api/public-config', (req, res) => {", "app.get('/api/public-config', async (req, res) => {");
code = code.replace(/const db = readDB\(\);[\s\S]*?\}\);/m, `
    let onesignal = process.env.ONESIGNAL_APP_ID || '';
    if (fsdb) {
        try {
            const doc = await fsdb.collection('config').doc('settings').get();
            if (doc.exists && doc.data().onesignal_app_id) {
                onesignal = doc.data().onesignal_app_id;
            }
        } catch(e) {}
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.json({
        firebase: {
            apiKey: process.env.FIREBASE_API_KEY,
            authDomain: process.env.FIREBASE_AUTH_DOMAIN,
            projectId: process.env.FIREBASE_PROJECT_ID,
            storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
            messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
            appId: process.env.FIREBASE_APP_ID
        },
        oneSignalAppId: onesignal
    });
`);

// POST /api/referral/patch
code = code.replace("app.post('/api/referral/patch', (req, res) => {", "app.post('/api/referral/patch', requireAdmin, async (req, res) => {");
code = code.replace(/const db = readDB\(\);[\s\S]*?res\.json\(\{ success: true \}\);/, `
    if (!fsdb) return res.status(500).json({ success: false });
    const patch = { id: Date.now().toString(), uid, phone, referredBy, date: new Date().toISOString() };
    await fsdb.collection('referral_patches').doc(patch.id).set(patch);
    res.json({ success: true });
`);

// GET /api/referral/patches
code = code.replace("app.get('/api/referral/patches', (req, res) => {", "app.get('/api/referral/patches', requireAdmin, async (req, res) => {");
code = code.replace(/const db = readDB\(\);[\s\S]*?res\.json\(db\.referral_patches \|\| \[\]\);/, `
    if (!fsdb) return res.json([]);
    const snap = await fsdb.collection('referral_patches').get();
    const patches = [];
    snap.forEach(d => patches.push(d.data()));
    res.json(patches);
`);

// POST /api/user-ping
code = code.replace("app.post('/api/user-ping', (req, res) => {", "app.post('/api/user-ping', async (req, res) => {");
code = code.replace(/const db = readDB\(\);[\s\S]*?res\.json\(\{ success: true \}\);/m, `
    if (!fsdb) return res.json({ success: true });
    const now = Date.now();
    try {
        await fsdb.collection('activity_logs').doc(req.body.uid || req.body.phone || 'anonymous').set({
            ...req.body,
            lastPing: now,
            timestamp: new Date().toISOString()
        }, { merge: true });
    } catch(e) {}
    res.json({ success: true });
`);

// GET /api/user-activity
code = code.replace("app.get('/api/user-activity', (req, res) => {", "app.get('/api/user-activity', requireAdmin, async (req, res) => {");
code = code.replace(/const db = readDB\(\);[\s\S]*?res\.json\(db\.userActivity \|\| \[\]\);/m, `
    if (!fsdb) return res.json([]);
    const snap = await fsdb.collection('activity_logs').orderBy('lastPing', 'desc').limit(500).get();
    const logs = [];
    snap.forEach(d => logs.push(d.data()));
    res.json(logs);
`);

// GET /api/withdrawals
code = code.replace("app.get('/api/withdrawals', async (req, res) => {", "app.get('/api/withdrawals', requireAdmin, async (req, res) => {");

// POST /api/withdrawals/:id/approve
code = code.replace("app.post('/api/withdrawals/:id/approve', async (req, res) => {", "app.post('/api/withdrawals/:id/approve', requireAdmin, async (req, res) => {");

// POST /api/withdrawals/:id/reject
code = code.replace("app.post('/api/withdrawals/:id/reject', async (req, res) => {", "app.post('/api/withdrawals/:id/reject', requireAdmin, async (req, res) => {");

// GET /api/paid-withdrawals
code = code.replace("app.get('/api/paid-withdrawals', async (req, res) => {", "app.get('/api/paid-withdrawals', requireAdmin, async (req, res) => {");

// POST /api/send-notification
code = code.replace("app.post('/api/send-notification', async (req, res) => {", "app.post('/api/send-notification', requireAdmin, async (req, res) => {");

// Add basic validation to POST /api/withdrawals
code = code.replace("app.post('/api/withdrawals', async (req, res) => {", `app.post('/api/withdrawals', async (req, res) => {
    const { amount, phone, name } = req.body;
    if (!amount || !phone || isNaN(amount)) return res.status(400).json({ success: false, error: 'Data si sahihi' });
`);

// Save refactored server.js
fs.writeFileSync(SERVER_FILE, code, 'utf8');
console.log("✅ server.js successfully refactored for Security & Firebase Migration!");
