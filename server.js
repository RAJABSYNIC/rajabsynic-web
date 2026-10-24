require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

// ─── PressoPay Configuration ──────────────────────────────────────────────────
// Requests are signed with HMAC-SHA256 using the secret. The key/secret must
// only ever be used server-side (never sent to the browser).
const PRESSSO_API_KEY    = process.env.PRESSSO_API_KEY;
const PRESSSO_API_SECRET = process.env.PRESSSO_API_SECRET;
const PRESSSO_BASE_URL   = process.env.PRESSSO_BASE_URL || 'https://pressopay.com';

const compression = require('compression');

// Enhanced CORS configuration
app.use(cors({
    origin: '*', // Allow all origins for development
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'Accept'],
    credentials: true
}));

app.use(compression()); // Compress all responses
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve static files (ensure HTML and JS are revalidated so code updates apply immediately)
app.use(express.static(__dirname, {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html') || filePath.endsWith('.js')) {
            res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        } else {
            res.setHeader('Cache-Control', 'public, max-age=86400');
        }
    }
}));


// Route to serve admin panel at /admin and /admin/
app.get(['/admin', '/admin/'], (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// Service Worker — must be served from root with correct headers
app.get('/sw.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Service-Worker-Allowed', '/');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(__dirname, 'sw.js'));
});

// Web App Manifest
app.get('/manifest.json', (req, res) => {
    res.setHeader('Content-Type', 'application/manifest+json');
    res.sendFile(path.join(__dirname, 'manifest.json'));
});

// ─── API Security Middleware (JWT) ─────────────────────────────────────────────
async function requireAdmin(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'Unauthorized: Missing or invalid token' });
    }
    const token = authHeader.split('Bearer ')[1].trim();
    if (!token || token === 'null' || token === 'undefined') {
        return res.status(401).json({ success: false, error: 'Unauthorized: No token provided' });
    }

    try {
        // 1. If Firebase Admin SDK is fully initialized with serviceAccount credentials
        if (fsdb) {
            try {
                const decodedToken = await require('firebase-admin/auth').getAuth().verifyIdToken(token);
                const adminDoc = await fsdb.collection('admins').doc(decodedToken.uid).get();
                if (adminDoc.exists) {
                    req.user = decodedToken;
                    return next();
                }
            } catch (fbErr) {
                console.warn('Firebase Admin verify failed:', fbErr.message);
            }
        }

        // 2. Serverless fallback: Validate Google Firebase Auth JWT structure & audience
        const parts = token.split('.');
        if (parts.length === 3) {
            const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
            const expectedAud = process.env.FIREBASE_PROJECT_ID || 'rajabsynicmob';
            const isAudMatch = payload.aud === expectedAud;
            const isIssMatch = payload.iss && payload.iss.includes('securetoken.google.com/' + expectedAud);
            const isNotExpired = !payload.exp || (payload.exp * 1000 > Date.now());

            if (isAudMatch && isIssMatch && isNotExpired && (payload.user_id || payload.sub)) {
                req.user = payload;
                return next();
            }
        }

        return res.status(401).json({ success: false, error: 'Unauthorized: Invalid token' });
    } catch (err) {
        console.error('API Security Error:', err.message);
        return res.status(401).json({ success: false, error: 'Unauthorized: Invalid token' });
    }
}

// ── Firebase Admin (Firestore) ───────────────────────────────────────────────
// Referral earnings & withdrawals are stored in Firestore (like the rest of the
// app). Falls back to local db.json only if the service account key is missing.
let fsdb = null;
try {
    const { initializeApp, cert, getApps } = require('firebase-admin/app');
    const { getFirestore } = require('firebase-admin/firestore');
    
    let serviceAccount = null;
    if (process.env.FIREBASE_SERVICE_ACCOUNT_B64) {
        try {
            const decoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8');
            serviceAccount = JSON.parse(decoded);
        } catch (b64Err) {
            console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT_B64:', b64Err.message);
        }
    } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        try {
            serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        } catch (jsonErr) {
            console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT:', jsonErr.message);
        }
    }
    
    if (!serviceAccount) {
        const keyPath = process.env.SERVICE_ACCOUNT_PATH || path.join(__dirname, 'serviceAccountKey.json');
        if (fs.existsSync(keyPath)) {
            serviceAccount = require(keyPath);
        }
    }
    
    if (serviceAccount) {
        if (!getApps().length) {
            initializeApp({ credential: cert(serviceAccount) });
        }
        fsdb = getFirestore();
        console.log('✅ Firebase Admin initialized — full Firestore access enabled (project: ' + (serviceAccount.project_id || 'rajabsynicmob') + ')');
    } else {
        console.warn('⚠️ serviceAccountKey not found — referral data falls back to local db.json');
    }
} catch (e) {
    console.warn('⚠️ Firebase Admin init failed, using local db.json for referral data:', e.message);
}

// --- API ROUTES ---

// GET /api/dashboard-stats
app.get('/api/dashboard-stats', requireAdmin, async (req, res) => {
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
});

// Get Payments
app.get('/api/payments', requireAdmin, async (req, res) => {
    if (fsdb) {
        try {
            const snap = await fsdb.collection('payments').get();
            const payments = [];
            snap.forEach(d => payments.push(d.data()));
            return res.json(payments);
        } catch(e) {
            console.error(e);
            return res.json([]);
        }
    }
    
    if (!fsdb) return res.status(500).json({ success: false, error: 'Database disconnected' });

});

// ─── Access / Subscription helpers ────────────────────────────────────────────
// Resolve subscription duration (days) for a given content, from settings.
function getDurationDays(db, contentId) {
    const settings = deepMerge(DEFAULT_SETTINGS, (db && db.settings) || {});
    if (contentId === 'adult-section-access') return (settings.adultSubscription && settings.adultSubscription.durationDays) || 30;
    if (contentId === 'live-tv-access')       return (settings.liveSubscription && settings.liveSubscription.durationDays) || 30;
    if (contentId === 'movies-package-mikumi')     return 1;
    if (contentId === 'movies-package-ngorongoro') return 7;
    if (contentId === 'movies-package-serengeti')  return 30;
    if (contentId === 'movies-access')             return 30;
    return 14; // default for individual content
}

// Grant access by creating a server-side subscription tied to a completed payment.
// ── Referral commission ──────────────────────────────────────────────────────
// When a referred user's purchase completes, credit 35% of the amount to the
// referrer's code. Idempotent per order so retries/webhooks don't double-credit.
const REFERRAL_RATE = 0.35;
async function creditReferralEarning(payment) {
    if (!payment) return false;
    const code = (payment.referredBy || '').trim();
    if (!code) return false; // buyer wasn't referred by anyone
    const orderId = payment.order_id || payment.id;
    if (!orderId) return false;

    const amount = parseInt(payment.amount) || 0;
    const commission = Math.floor(amount * REFERRAL_RATE);
    if (commission <= 0) return false;

    const record = {
        referralCode: code,
        fromUserId: payment.userId || '',
        fromPhone: payment.phone || '',
        fromUsername: payment.username || '',
        orderId,
        purchaseAmount: amount,
        commission,
        createdAt: new Date().toISOString()
    };

    try {
        if (!fsdb) return false;
        // Firestore — idempotent: use orderId as the document id.
        const ref = fsdb.collection('referralEarnings').doc(orderId);
        const snap = await ref.get();
        if (snap.exists) return true; // already credited
        await ref.set(record);
        console.log(`🎁 [Firestore] Referral earning: ${code} +Tsh ${commission} (35% of ${amount}, order ${orderId})`);
        return true;
    } catch (e) {
        console.error('Error crediting referral:', e);
        return false;
    }
}

async function grantAccessForPayment(payment) {
    if (!payment) return false;
    const userId = payment.userId || payment.uid;
    const contentId = payment.contentId;
    const orderId = payment.order_id || payment.id;

    if (!userId || !contentId) {
        console.warn(`⚠️ Cannot grant access - missing userId/contentId on payment ${orderId}`);
        return false;
    }

    if (fsdb) {
        // Idempotent: don't duplicate for the same order
        const existing = await fsdb.collection('subscriptions').where('orderId', '==', orderId).get();
        if (!existing.empty) return true;

        const durationDays = getDurationDays(null, contentId); // defaults
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + durationDays);

        const subData = {
            id: 'SUB-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
            userId,
            contentId,
            orderId,
            contentTitle: payment.contentTitle || '',
            durationDays,
            createdAt: new Date().toISOString(),
            expiresAt: expiresAt.toISOString()
        };
        await fsdb.collection('subscriptions').doc(subData.id).set(subData);

        // If a movie package was purchased, also grant general 'movies-access'
        if (['movies-package-mikumi', 'movies-package-ngorongoro', 'movies-package-serengeti'].includes(contentId)) {
            const movieAccessSub = {
                id: 'SUB-MOVIES-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
                userId,
                contentId: 'movies-access',
                packageId: contentId,
                orderId,
                contentTitle: 'Upatikanaji wa Movies (VIP Pass)',
                durationDays,
                createdAt: new Date().toISOString(),
                expiresAt: expiresAt.toISOString()
            };
            await fsdb.collection('subscriptions').doc(movieAccessSub.id).set(movieAccessSub).catch(() => {});
        }

        console.log(`🔓 Access granted: user=${userId} content=${contentId} until ${expiresAt.toISOString().slice(0, 10)}`);
        return true;
    }
    return false;
}

// GET /api/public-config
app.get('/api/public-config', async (req, res) => {
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
});

// GET /api/public-categories
// Custom categories added by admin — used to build the filter bar pills.
app.get('/api/public-categories', async (req, res) => {
    if (!fsdb) return res.json([]);
    try {
        const snap = await fsdb.collection('categories').get();
        res.setHeader('Cache-Control', 'no-cache');
        res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (e) {
        res.json([]);
    }
});

// GET /api/public-help
// Help videos (Msaada) added by admin — shown to all visitors.
app.get('/api/public-help', async (req, res) => {
    if (!fsdb) return res.json([]);
    try {
        const snap = await fsdb.collection('helpVideos').get();
        const videos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        videos.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
        res.setHeader('Cache-Control', 'no-cache');
        res.json(videos);
    } catch (e) {
        res.json([]);
    }
});

// GET /api/subscription/check?userId=&contentId=
// Source of truth the client falls back to when Firebase shows no access.
app.get('/api/subscription/check', async (req, res) => {
    const { userId, contentId } = req.query;
    if (!userId || !contentId) {
        return res.status(400).json({ hasAccess: false, error: 'userId and contentId required' });
    }

    const now = new Date();

    if (fsdb) {
        const moviePackageIds = ['movies-access', 'movies-package-mikumi', 'movies-package-ngorongoro', 'movies-package-serengeti', 'movies-subscription'];
        if (moviePackageIds.includes(contentId)) {
            const mSubs = await fsdb.collection('subscriptions')
                .where('userId', '==', userId)
                .where('contentId', 'in', moviePackageIds)
                .get();
            let validMSub = null;
            mSubs.forEach(doc => {
                const data = doc.data();
                if (new Date(data.expiresAt) > now) {
                    if (!validMSub || new Date(data.expiresAt) > new Date(validMSub.expiresAt)) {
                        validMSub = data;
                    }
                }
            });
            if (validMSub) {
                return res.json({ hasAccess: true, source: 'movies-subscription', package: validMSub.contentId, expiresAt: validMSub.expiresAt });
            }
        }

        const subs = await fsdb.collection('subscriptions')
            .where('userId', '==', userId)
            .where('contentId', '==', contentId)
            .get();
        let validSub = null;
        subs.forEach(doc => {
            const data = doc.data();
            if (new Date(data.expiresAt) > now) {
                validSub = data;
            }
        });
        if (validSub) return res.json({ hasAccess: true, source: 'subscription', expiresAt: validSub.expiresAt });

        // Calculate total payments made for installments
        const payments = await fsdb.collection('payments')
            .where('userId', '==', userId)
            .where('contentId', '==', contentId)
            .where('status', 'in', ['completed', 'success'])
            .get();
        
        let totalPaid = 0;
        payments.forEach(doc => {
            totalPaid += (Number(doc.data().amount) || 0);
        });

        if (totalPaid > 0) {
            return res.json({ hasAccess: false, totalPaid });
        }
    }

    res.json({ hasAccess: false });
});

// GET /api/referral/patches — Rudisha patches zote
app.get('/api/referral/patches', requireAdmin, async (req, res) => {
    
    if (!fsdb) return res.json([]);
    const snap = await fsdb.collection('referral_patches').get();
    const patches = [];
    snap.forEach(d => patches.push(d.data()));
    res.json(patches);

});

// GET /api/referral/summary?code=REF-xxxxxx[&phone=...]
// Server-authoritative referral earnings for a user's referral code:
//   balance = 35% commission from referred buyers' completed purchases
//             minus already-paid withdrawals.
app.get('/api/referral/summary', async (req, res) => {
    const code = (req.query.code || '').trim();
    if (!code) return res.status(400).json({ success: false, error: 'code inahitajika' });

    try {
        let earnings = [];
        let paidWithdrawals = [];

        if (fsdb) {
            const [eSnap, pSnap] = await Promise.all([
                fsdb.collection('referralEarnings').where('referralCode', '==', code).get(),
                fsdb.collection('paidWithdrawals').where('referralCode', '==', code).get()
            ]);
            eSnap.forEach(d => earnings.push(d.data()));
            pSnap.forEach(d => paidWithdrawals.push(d.data()));
        }
        res.json({
            success: true,
            code,
            rate: 0.35,
            totalEarned: earnings.reduce((sum, item) => sum + (Number(item.earnedAmount) || 0), 0),
            totalPaid: paidWithdrawals.reduce((sum, item) => sum + (Number(item.amount) || 0), 0),
            balance: earnings.reduce((sum, item) => sum + (Number(item.earnedAmount) || 0), 0) - paidWithdrawals.reduce((sum, item) => sum + (Number(item.amount) || 0), 0),
            referredCount: earnings.length,
            referredBuyers: earnings
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/payment/webhook', async (req, res) => {
    const body = req.body || {};
    console.log('📥 Webhook received:', JSON.stringify(body));
    const reference = body.reference || body.merchantReference || body.order_id || body.orderId || body.data?.reference || body.data?.merchantReference || body.data?.order_id || body.id;
    if (!reference) return res.status(400).json({ error: 'Missing reference' });
    try {
        if (!fsdb) {
            console.error('Webhook Error: fsdb not initialized');
            return res.status(500).json({ error: 'DB not ready' });
        }

        // Check if webhook reports failure
        const rawStatus = String(body.status || body.data?.status || body.event || 'COMPLETED').toUpperCase();
        const isFailed = rawStatus.includes('FAIL') || rawStatus.includes('CANCEL');

        // Resolve orderId from reference (could be PAY-... or ORD-...)
        let orderId = reference;
        const indexSnap = await fsdb.collection('paymentIndex').doc(reference).get();
        if (indexSnap.exists) {
            orderId = indexSnap.data().orderId;
            console.log(`📥 Webhook: resolved ${reference} -> ${orderId}`);
        }

        // Find payment doc
        let paymentRef = fsdb.collection('payments').doc(orderId);
        let paymentSnap = await paymentRef.get();
        
        if (!paymentSnap.exists) {
            const byMerchRef = await fsdb.collection('payments').where('merchantReference', '==', reference).limit(1).get();
            if (!byMerchRef.empty) {
                paymentRef = byMerchRef.docs[0].ref;
                paymentSnap = byMerchRef.docs[0];
                orderId = byMerchRef.docs[0].id;
            } else {
                const byId = await fsdb.collection('payments').where('id', '==', reference).limit(1).get();
                if (!byId.empty) {
                    paymentRef = byId.docs[0].ref;
                    paymentSnap = byId.docs[0];
                    orderId = byId.docs[0].id;
                }
            }
        }

        if (!paymentSnap.exists) {
            console.error(`Webhook: payment not found for reference ${reference}`);
            return res.status(404).send('Not Found');
        }

        if (isFailed) {
            await paymentRef.update({ status: 'failed', updatedAt: new Date().toISOString() });
            console.log(`❌ Webhook: payment ${orderId} marked failed`);
            return res.status(200).send('OK');
        }

        const payment = paymentSnap.data();

        if (['completed', 'success'].includes((payment.status || '').toLowerCase())) {
            console.log(`Webhook: payment ${orderId} already processed, skipping`);
            return res.status(200).send('OK');
        }

        // Update payment to completed
        await paymentRef.update({ 
            status: 'completed',
            updatedAt: new Date().toISOString()
        });
        console.log(`✅ Webhook: payment ${orderId} marked completed`);

        const userId = payment.userId || payment.uid;
        const contentId = payment.contentId;

        if (userId && contentId) {
            let durationDays = 365;
            if (contentId === 'adult-section-access') durationDays = 5;
            else if (contentId === 'live-tv-access') durationDays = 30;
            else if (contentId === 'movies-package-mikumi') durationDays = 1;
            else if (contentId === 'movies-package-ngorongoro') durationDays = 7;
            else if (contentId === 'movies-package-serengeti' || contentId === 'movies-access') durationDays = 30;

            const subId = 'SUB-' + orderId;
            await fsdb.collection('subscriptions').doc(subId).set({
                id: subId,
                userId,
                contentId,
                contentTitle: payment.contentTitle || '',
                orderId,
                createdAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + durationDays * 86400000).toISOString()
            });
            console.log(`✅ Webhook: subscription created for user=${userId} content=${contentId} (duration=${durationDays}d)`);

            // If it's a movie package, also grant general movies-access subscription
            if (contentId.startsWith('movies-package-') || contentId === 'movies-access') {
                const generalSubId = 'SUB-MOVIES-' + userId;
                await fsdb.collection('subscriptions').doc(generalSubId).set({
                    id: generalSubId,
                    userId,
                    contentId: 'movies-access',
                    packageId: contentId,
                    orderId,
                    createdAt: new Date().toISOString(),
                    expiresAt: new Date(Date.now() + durationDays * 86400000).toISOString()
                }, { merge: true });
                console.log(`✅ Webhook: general movies-access granted to user=${userId}`);
            }

            // Credit referral
            if (payment.referredBy) {
                try {
                    const refRef = fsdb.collection('referralEarnings').doc('REF-' + orderId);
                    const refSnap = await refRef.get();
                    if (!refSnap.exists) {
                        const fullPrice = Number(payment.fullPrice) || Number(payment.amount);
                        await refRef.set({
                            referralCode: payment.referredBy,
                            orderId,
                            earnedAmount: Math.floor(fullPrice * 0.35),
                            createdAt: new Date().toISOString()
                        });
                    }
                } catch (refErr) {
                    console.error('Referral error (non-fatal):', refErr.message);
                }
            }
        }
        
        res.status(200).send('OK');
    } catch(e) {
        console.error('Webhook Error:', e.message);
        if (!res.headersSent) {
            res.status(500).send('Internal Error');
        }
    }
});

function normalizePhone(phone) {
    let cleaned = phone.replace(/[\s\-+]/g, '');
    if (cleaned.startsWith('255')) {
        cleaned = '0' + cleaned.substring(3);
    }
    return cleaned;
}

function generateOrderId() {
    return 'ORD-' + Date.now() + Math.floor(Math.random() * 1000);
}

function pressoAuthHeaders(method, path, rawBody = '') {
    const timestamp = new Date().toISOString();
    const nonce = crypto.randomUUID();
    const canonical = [timestamp, nonce, method.toUpperCase(), path, rawBody].join('\n');
    const signature = crypto
        .createHmac('sha256', PRESSSO_API_SECRET)
        .update(canonical)
        .digest('hex');
    return {
        'X-Pressso-Key': PRESSSO_API_KEY,
        'X-Pressso-Timestamp': timestamp,
        'X-Pressso-Nonce': nonce,
        'X-Pressso-Signature': signature
    };
}

app.post('/api/payment/initiate', async (req, res) => {
    const { phone, amount, fullPrice, description, userId, contentId, contentTitle, username, referredBy, email } = req.body;

    if (!phone || !amount) {
        return res.status(400).json({ success: false, error: 'Namba ya simu na kiasi vinahitajika' });
    }

    const normalizedPhone = normalizePhone(phone);
    const merchantReference = generateOrderId();

    console.log(`💳 PressoPay - Initiating checkout: phone=${normalizedPhone}, amount=${amount}, ref=${merchantReference}`);

    const TEST_MODE = process.env.TEST_MODE === 'true';

    if (!TEST_MODE && (!PRESSSO_API_KEY || !PRESSSO_API_SECRET)) {
        return res.status(500).json({ success: false, error: 'Mfumo wa malipo haujasanidiwa vizuri (API Keys hazipo).' });
    }

    try {
        let gw;

        let usedGateway = 'pressopay';

        if (TEST_MODE) {
            console.log('⚙️  TEST MODE: Simulating PressoPay checkout');
            gw = { reference: merchantReference, status: 'COMPLETED', checkoutUrl: null };
        } else {
            const path = '/api/v1/checkouts';
            const bodyObj = {
                merchantReference,
                amountMinor: parseInt(amount),
                buyerName: username || 'Rajabsynic User',
                buyerEmail: email || `${normalizedPhone}@rajabsynic.com`,
                buyerPhone: normalizedPhone,
                description: description || `Rajabsynic - ${contentTitle || 'Content'}`
            };
            const rawBody = JSON.stringify(bodyObj);

            try {
                const resp = await axios.post(
                    `${PRESSSO_BASE_URL}${path}`,
                    rawBody,
                    {
                        headers: {
                            'Content-Type': 'application/json',
                            'Idempotency-Key': crypto.randomUUID(),
                            ...pressoAuthHeaders('POST', path, rawBody)
                        },
                        timeout: 15000
                    }
                );
                const data = resp.data || {};
                const pStatus = String(data.status || 'PENDING').toUpperCase();
                
                if (pStatus === 'FAILED' || pStatus === 'ERROR') {
                    throw new Error(`PressoPay returned status: ${pStatus}`);
                }

                gw = {
                    reference: data.reference || merchantReference,
                    status: (data.status || 'PENDING'),
                    checkoutUrl: data.checkoutUrl || null
                };
            } catch (pressoErr) {
                console.warn(`⚠️ PressoPay failed (${pressoErr.message}), falling back to HarakaPay...`);
                try {
                    const harakaApiKey = process.env.HARAKAPAY_API_KEY || 'hpk_2956fec8e3e5f80597bb59c734275096e99a6e6628046826';
                    const harakaResp = await axios.post(
                        'https://harakapay.net/api/v1/collect',
                        {
                            phone: normalizedPhone,
                            amount: parseInt(amount),
                            description: description || `Rajabsynic - ${contentTitle || 'Content'}`,
                            webhook_url: `${process.env.WEBHOOK_BASE_URL || 'https://rajabsynic.com'}/api/payment/webhook`
                        },
                        {
                            headers: { 'X-API-Key': harakaApiKey },
                            timeout: 15000
                        }
                    );
                    
                    const hData = harakaResp.data || {};
                    if (!hData.success) {
                        throw new Error(`HarakaPay returned error: ${hData.error || hData.message}`);
                    }
                    
                    gw = {
                        reference: hData.order_id,
                        status: 'PENDING',
                        checkoutUrl: null
                    };
                    usedGateway = 'harakapay';
                } catch (harakaErr) {
                    console.error(`❌ Both PressoPay and HarakaPay failed. HarakaErr: ${harakaErr.message}`);
                    return res.status(500).json({ success: false, error: 'Mifumo yote ya malipo inasumbua kwa sasa. Tafadhali jaribu tena baadae.' });
                }
            }
        }

        console.log(`✅ ${usedGateway} Response:`, gw);
        const orderId = gw.reference;
        const rawStatus = String(gw.status || 'PENDING').toUpperCase();
        const isCompleted = TEST_MODE || rawStatus === 'COMPLETED';

        try {
            if (!fsdb) throw new Error('Firestore not initialized');
            const paymentDoc = {
                id: orderId,
                order_id: orderId,
                merchantReference,  // ORD-... (our reference for PressoPay status checks)
                userId: userId || '',
                contentId: contentId || '',
                contentTitle: contentTitle || '',
                username: username || '',
                phone: normalizedPhone,
                amount: parseInt(amount),
                fullPrice: fullPrice ? parseInt(fullPrice) : parseInt(amount),
                status: isCompleted ? 'completed' : 'pending',
                gateway: TEST_MODE ? 'test' : usedGateway,
                referredBy: referredBy || '',
                checkoutUrl: gw.checkoutUrl || '',
                fee: 0,
                net_amount: parseInt(amount),
                createdAt: new Date().toISOString(),
                testMode: TEST_MODE
            };
            
            await fsdb.collection('payments').doc(orderId).set(paymentDoc);
            // Also index by merchantReference for webhook lookups
            await fsdb.collection('paymentIndex').doc(merchantReference).set({ orderId, merchantReference });
            console.log(`✅ Payment saved to Firestore: ${orderId} / merchantRef=${merchantReference} (${isCompleted ? 'completed' : 'pending'})`);
            
            if (isCompleted) {
                const allPayments = await fsdb.collection('payments')
                    .where('userId', '==', userId)
                    .where('contentId', '==', contentId)
                    .where('status', 'in', ['completed', 'success'])
                    .get();
                let totalPaid = 0;
                allPayments.forEach(p => totalPaid += Number(p.data().amount));
                
                if (totalPaid >= paymentDoc.fullPrice) {
                    const subData = {
                        id: 'SUB-' + Date.now(),
                        userId,
                        contentId,
                        contentTitle,
                        createdAt: new Date().toISOString(),
                        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
                    };
                    await fsdb.collection('subscriptions').doc(subData.id).set(subData);
                }
            }
        } catch (e) {
            console.error('Firestore save error:', e.message);
        }

        if (!TEST_MODE && !isCompleted) {
            // BACKGROUND POLLING: Failsafe for real-time resolution if webhook is delayed/blocked
            let attempts = 0;
            const pollTimer = setInterval(async () => {
                attempts++;
                if (attempts > 36) { // 3 minutes max
                    clearInterval(pollTimer);
                    return;
                }
                try {
                    let pStatus = '';
                    if (usedGateway === 'pressopay') {
                        const apiPath = `/api/v1/checkouts/${orderId}`;
                        const pollResp = await axios.get(`${PRESSSO_BASE_URL}${apiPath}`, {
                            headers: {
                                ...pressoAuthHeaders('GET', apiPath),
                                'X-API-Key': PRESSSO_API_KEY
                            }
                        });
                        pStatus = String(pollResp.data.status || '').toUpperCase();
                    } else if (usedGateway === 'harakapay') {
                        const harakaApiKey = process.env.HARAKAPAY_API_KEY || 'hpk_2956fec8e3e5f80597bb59c734275096e99a6e6628046826';
                        const pollResp = await axios.get(`https://harakapay.net/api/v1/status/${orderId}`, {
                            headers: { 'X-API-Key': harakaApiKey }
                        });
                        if (pollResp.data && pollResp.data.payment) {
                            pStatus = String(pollResp.data.payment.status || '').toUpperCase();
                        }
                    }
                    
                    if (pStatus === 'COMPLETED' || pStatus === 'SUCCESS') {
                        clearInterval(pollTimer);
                        
                        // ✅ FIX: Use direct doc reference (transactions can't use .where())
                        const paymentDocRef = fsdb.collection('payments').doc(orderId);
                        const paymentSnap = await paymentDocRef.get();
                        
                        if (paymentSnap.exists) {
                            const paymentData = paymentSnap.data();
                            
                            if (!['completed', 'success'].includes((paymentData.status || '').toLowerCase())) {
                                await paymentDocRef.update({ status: 'completed' });
                                
                                const pUserId = paymentData.userId || paymentData.uid;
                                const pContentId = paymentData.contentId;
                                
                                if (pUserId && pContentId) {
                                    const existingSubs = await fsdb.collection('subscriptions')
                                        .where('orderId', '==', orderId).limit(1).get();
                                    
                                    if (existingSubs.empty) {
                                        const subId = 'SUB-' + orderId;
                                        await fsdb.collection('subscriptions').doc(subId).set({
                                            id: subId,
                                            userId: pUserId,
                                            contentId: pContentId,
                                            orderId: orderId,
                                            createdAt: new Date().toISOString(),
                                            expiresAt: new Date(Date.now() + 31536000000).toISOString()
                                        });
                                    }
                                }
                            }
                        }
                        console.log(`✅ Background poll detected SUCCESS for ${orderId}`);
                    } else if (pStatus === 'FAILED' || pStatus === 'CANCELLED') {
                        clearInterval(pollTimer);
                        await fsdb.collection('payments').doc(orderId).update({ status: 'failed' });
                        console.log(`❌ Background poll detected FAILURE for ${orderId}`);
                    }
                } catch(e) {}
            }, 5000);
        }

        return res.json({
            success: true,
            order_id: orderId,
            gateway: TEST_MODE ? 'test' : 'pressopay',
            checkoutUrl: gw.checkoutUrl || null,
            message: TEST_MODE
                ? '✅ TEST MODE: Malipo yamefanikiwa mara moja! (Simulation)'
                : 'USSD push imetumwa! Angalia simu yako na ingiza PIN yako.',
            userId,
            contentId,
            contentTitle,
            testMode: TEST_MODE
        });

    } catch (err) {
        const errData = err.response ? err.response.data : null;
        console.error('❌ PressoPay Error:', errData || err.message);
        const errMsg = errData
            ? (errData.error || errData.message || 'Tatizo la mtandao')
            : err.message;
        res.status(500).json({ success: false, error: errMsg || 'Tatizo la mtandao. Jaribu tena.' });
    }
});

// Debug endpoint - check PressoPay status directly
app.get('/api/payment/debug/:merchantRef', async (req, res) => {
    try {
        const ref = req.params.merchantRef;
        const apiPath = `/api/v1/checkouts/${ref}`;
        const pollResp = await axios.get(`${PRESSSO_BASE_URL}${apiPath}`, {
            headers: { ...pressoAuthHeaders('GET', apiPath), 'X-API-Key': PRESSSO_API_KEY }
        });
        res.json({ success: true, pressoData: pollResp.data, ref });
    } catch (e) {
        res.json({ success: false, error: e.message, responseData: e.response?.data });
    }
});

app.get('/api/payment/status/:orderId', async (req, res) => {
    try {
        if (!fsdb) throw new Error('DB Error');
        const orderId = req.params.orderId;
        const snap = await fsdb.collection('payments').doc(orderId).get();
        if (!snap.exists) return res.json({ success: false, error: 'Malipo hayajapatikana' });
        
        let payment = snap.data();
        
        // --- ACTIVE POLLING (For Vercel Serverless environment) ---
        const TEST_MODE = process.env.TEST_MODE === 'true';
        if (!TEST_MODE && payment.status === 'pending') {
            const pGateway = payment.gateway || 'pressopay';
            const paymentDocRef = fsdb.collection('payments').doc(orderId);

            if (pGateway === 'harakapay') {
                try {
                    const harakaApiKey = process.env.HARAKAPAY_API_KEY || 'hpk_2956fec8e3e5f80597bb59c734275096e99a6e6628046826';
                    const pollResp = await axios.get('https://harakapay.net/api/v1/status/' + orderId, {
                        headers: { 'X-API-Key': harakaApiKey },
                        timeout: 8000
                    });
                    const hStatus = String(pollResp.data?.payment?.status || pollResp.data?.status || '').toUpperCase();
                    if (hStatus === 'COMPLETED' || hStatus === 'SUCCESS') {
                        await paymentDocRef.update({ status: 'completed', updatedAt: new Date().toISOString() });
                        payment.status = 'completed';
                        await grantAccessForPayment({ ...payment, id: orderId });
                        console.log('✅ HarakaPay active poll confirmed completed for ' + orderId);
                    } else if (hStatus === 'FAILED' || hStatus === 'CANCELLED') {
                        await paymentDocRef.update({ status: 'failed', updatedAt: new Date().toISOString() });
                        payment.status = 'failed';
                    }
                } catch (hErr) {
                    console.warn('⚠️ HarakaPay poll notice for ' + orderId + ': ' + hErr.message);
                }
            } else if (PRESSSO_API_KEY && PRESSSO_API_SECRET) {
                try {
                    const apiPath = '/api/v1/payments/' + orderId;
                    const pollResp = await axios.get(PRESSSO_BASE_URL + apiPath, {
                        headers: { ...pressoAuthHeaders('GET', apiPath) },
                        timeout: 8000
                    });
                    const pStatus = String(pollResp.data?.status || '').toUpperCase();
                    if (pStatus === 'COMPLETED' || pStatus === 'SUCCESS') {
                        await paymentDocRef.update({ status: 'completed', updatedAt: new Date().toISOString() });
                        payment.status = 'completed';
                        await grantAccessForPayment({ ...payment, id: orderId });
                        console.log('✅ PressoPay active poll confirmed completed for ' + orderId);
                    } else if (pStatus === 'FAILED' || pStatus === 'CANCELLED') {
                        await paymentDocRef.update({ status: 'failed', updatedAt: new Date().toISOString() });
                        payment.status = 'failed';
                    }
                } catch (apiErr) {
                    console.warn('⚠️ PressoPay GET poll notice: ' + (apiErr.response?.status || apiErr.message));
                }
            }
        }
        res.json({ success: true, payment: payment });
    } catch(e) {
        console.error('Status route error:', e);
        res.status(500).json({ success: false, error: 'Tatizo la mtandao' });
    }
});



// POST /api/user-ping
app.post('/api/user-ping', async (req, res) => {
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
});

// GET /api/user-activity — Admin anaona takwimu za shughuli za watumiaji
app.get('/api/user-activity', requireAdmin, async (req, res) => {
    const db = readDB();
    const activity = db.userActivity || {};
    const now = new Date();

    const entries = Object.values(activity);
    const active = entries.filter(u => {
        const diff = (now - new Date(u.lastSeen)) / 60000;
        return diff <= 5; // Online in last 5 minutes
    });
    const dead = entries.filter(u => {
        const daysSince = (now - new Date(u.lastSeen)) / 86400000;
        return daysSince > 7 || (u.sessionCount || 1) <= 2;
    });

    res.json({
        total: entries.length,
        active: active.length,
        dead: dead.length,
        activeUsers: active.slice(0, 50),
        deadUsers: dead.slice(0, 50),
        allUsers: entries.sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen)).slice(0, 100)
    });
});

// ============================================================
// WITHDRAWAL SYSTEM — Mfumo wa Toa Pesa (Referral Earnings)
// ============================================================


// POST /api/withdrawals — User anawasilisha ombi la kutoa pesa (stored in Firestore)
app.post('/api/withdrawals', async (req, res) => {
    const { userId, username, phone, receivingNumber, receivingName, amount, referralCode } = req.body;
    if (!amount || !phone || isNaN(amount)) return res.status(400).json({ success: false, error: 'Data si sahihi' });

    if (!receivingNumber || !receivingName || !amount) {
        return res.status(400).json({ success: false, error: 'Taarifa zote zinahitajika' });
    }

    const withdrawal = {
        id: 'WD-' + Date.now(),
        userId: userId || '',
        username: username || '',
        phone: phone || '',
        referralCode: referralCode || '',
        receivingNumber,
        receivingName,
        amount: parseInt(amount),
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    try {
        if (fsdb) {
            // Duplicate pending check (single-field query — no composite index needed)
            if (phone) {
                const snap = await fsdb.collection('withdrawals').where('phone', '==', phone).get();
                if (snap.docs.some(d => d.data().status === 'pending')) {
                    return res.status(400).json({ success: false, error: 'Una ombi moja linalongoja tayari. Tafadhali subiri admin akikubali kwanza.' });
                }
            }
            await fsdb.collection('withdrawals').doc(withdrawal.id).set(withdrawal);
        } else {
            const db = readDB();
            db.withdrawals = db.withdrawals || [];
            const existing = db.withdrawals.find(w => (w.userId === userId || w.phone === phone) && w.status === 'pending');
            if (existing) {
                return res.status(400).json({ success: false, error: 'Una ombi moja linalongoja tayari. Tafadhali subiri admin akikubali kwanza.' });
            }
            db.withdrawals.push(withdrawal);
            writeDB(db);
        }
        console.log(`💸 Withdrawal request: ${username} (${phone}) → ${receivingNumber} — Tsh ${amount}`);
        res.json({ success: true, withdrawal });
    } catch (e) {
        console.error('❌ withdrawal create error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/withdrawals — Admin anaona orodha yote ya maombi
app.get('/api/withdrawals', requireAdmin, async (req, res) => {
    try {
        let withdrawals = [];
        if (fsdb) {
            const snap = await fsdb.collection('withdrawals').get();
            snap.forEach(d => withdrawals.push(d.data()));
        } else {
            withdrawals = readDB().withdrawals || [];
        }
        withdrawals.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        res.json(withdrawals);
    } catch (e) {
        console.error('❌ withdrawals list error:', e.message);
        res.json([]);
    }
});

// POST /api/withdrawals/:id/approve — Admin anakubali ombi: balance inakuwa 0
app.post('/api/withdrawals/:id/approve', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { note } = req.body;
    try {
        if (fsdb) {
            const ref = fsdb.collection('withdrawals').doc(id);
            const snap = await ref.get();
            if (!snap.exists) return res.status(404).json({ success: false, error: 'Ombi halipatikani' });
            const withdrawal = snap.data();
            if (withdrawal.status !== 'pending') {
                return res.status(400).json({ success: false, error: 'Ombi hili limeshafanyiwa kazi' });
            }
            await ref.update({ status: 'approved', approvedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), adminNote: note || '' });
            // Record paid withdrawal (subtracts from referral balance)
            await fsdb.collection('paidWithdrawals').doc(id).set({
                userId: withdrawal.userId, phone: withdrawal.phone, username: withdrawal.username,
                referralCode: withdrawal.referralCode, amount: withdrawal.amount, withdrawalId: id,
                paidAt: new Date().toISOString()
            });
            console.log(`✅ Withdrawal approved: ${id} — ${withdrawal.username} — Tsh ${withdrawal.amount}`);
        } else {
            const db = readDB();
            db.withdrawals = db.withdrawals || [];
            const idx = db.withdrawals.findIndex(w => w.id === id);
            if (idx === -1) return res.status(404).json({ success: false, error: 'Ombi halipatikani' });
            const withdrawal = db.withdrawals[idx];
            if (withdrawal.status !== 'pending') return res.status(400).json({ success: false, error: 'Ombi hili limeshafanyiwa kazi' });
            db.withdrawals[idx].status = 'approved';
            db.withdrawals[idx].approvedAt = new Date().toISOString();
            db.withdrawals[idx].updatedAt = new Date().toISOString();
            db.withdrawals[idx].adminNote = note || '';
            db.paidWithdrawals = db.paidWithdrawals || [];
            db.paidWithdrawals.push({
                userId: withdrawal.userId, phone: withdrawal.phone, username: withdrawal.username,
                referralCode: withdrawal.referralCode, amount: withdrawal.amount, withdrawalId: id,
                paidAt: new Date().toISOString()
            });
            writeDB(db);
        }
        res.json({ success: true, message: 'Ombi limekubaliwa. Balance imekuwa 0.' });
    } catch (e) {
        console.error('❌ withdrawal approve error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/withdrawals/:id/reject — Admin anakataa ombi
app.post('/api/withdrawals/:id/reject', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;
    try {
        if (fsdb) {
            const ref = fsdb.collection('withdrawals').doc(id);
            const snap = await ref.get();
            if (!snap.exists) return res.status(404).json({ success: false, error: 'Ombi halipatikani' });
            await ref.update({ status: 'rejected', rejectedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), rejectReason: reason || '' });
        } else {
            const db = readDB();
            db.withdrawals = db.withdrawals || [];
            const idx = db.withdrawals.findIndex(w => w.id === id);
            if (idx === -1) return res.status(404).json({ success: false, error: 'Ombi halipatikani' });
            db.withdrawals[idx].status = 'rejected';
            db.withdrawals[idx].rejectedAt = new Date().toISOString();
            db.withdrawals[idx].updatedAt = new Date().toISOString();
            db.withdrawals[idx].rejectReason = reason || '';
            writeDB(db);
        }
        console.log(`❌ Withdrawal rejected: ${id}`);
        res.json({ success: true, message: 'Ombi limekataliwa.' });
    } catch (e) {
        console.error('❌ withdrawal reject error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/paid-withdrawals — Kulipwa kwa referral (kutumika kuhesabu balance halisi)
app.get('/api/paid-withdrawals', requireAdmin, async (req, res) => {
    try {
        let paid = [];
        if (fsdb) {
            const snap = await fsdb.collection('paidWithdrawals').get();
            snap.forEach(d => paid.push(d.data()));
        } else {
            paid = readDB().paidWithdrawals || [];
        }
        res.json(paid);
    } catch (e) {
        console.error('❌ paid-withdrawals error:', e.message);
        res.json([]);
    }
});

// ============================================
// PUSH NOTIFICATIONS via Firebase FCM
// ============================================
app.post('/api/send-notification', requireAdmin, async (req, res) => {
    try {
        const { title, body, image, topic } = req.body;

        if (!title || !body) {
            return res.status(400).json({ success: false, message: 'Title and body are required' });
        }

        let admin;
        try {
            admin = require('firebase-admin');
        } catch (e) {
            console.log('firebase-admin not installed. Simulating notification send.');
            return res.json({
                success: true,
                message: 'Notification queued (firebase-admin not configured)',
                simulated: true
            });
        }

        const message = {
            notification: {
                title,
                body,
                ...(image ? { imageUrl: image } : {})
            },
            topic: topic || 'all-users',
            android: {
                notification: {
                    sound: 'default',
                    channelId: 'rajabsynic_default'
                }
            },
            apns: {
                payload: {
                    aps: { sound: 'default' }
                }
            }
        };

        const result = await admin.messaging().send(message);
        console.log('Notification sent:', result);

        res.json({ success: true, messageId: result, message: 'Notification imetumwa!' });

    } catch (error) {
        console.error('Send notification error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ─── AI CUSTOMER SUPPORT CHATBOT (Google AI Studio / Gemini Integration) ───────
const AI_KNOWLEDGE_FILE = path.join(__dirname, 'data', 'ai-knowledge.json');
const AI_LOGS_FILE = path.join(__dirname, 'data', 'ai-chat-logs.json');

let BUNDLED_KNOWLEDGE = null;
try {
    BUNDLED_KNOWLEDGE = require('./data/ai-knowledge.json');
} catch (_) {}

let BUNDLED_CATALOG = [];
try {
    BUNDLED_CATALOG = require('./data/catalog-cache.json');
} catch (_) {}

// Helper: In-memory & Persistent Knowledge Base
const TMP_AI_KNOWLEDGE_FILE = path.join(os.tmpdir ? os.tmpdir() : '/tmp', 'ai-knowledge.json');
let RUNTIME_AI_KNOWLEDGE = null;
let RUNTIME_AI_KNOWLEDGE_TIME = 0;

async function getAIKnowledgeAsync(forceRefresh = false) {
    const now = Date.now();
    // Cache for max 10 seconds so any training saved in Admin Panel takes effect immediately
    if (!forceRefresh && RUNTIME_AI_KNOWLEDGE && (now - RUNTIME_AI_KNOWLEDGE_TIME < 10000)) {
        return RUNTIME_AI_KNOWLEDGE;
    }

    // 1. Always check Firestore FIRST for the latest training
    if (fsdb) {
        try {
            const snap = await fsdb.collection('settings').doc('ai_support').get();
            if (snap.exists && snap.data()) {
                RUNTIME_AI_KNOWLEDGE = snap.data();
                RUNTIME_AI_KNOWLEDGE_TIME = now;
                return RUNTIME_AI_KNOWLEDGE;
            }
        } catch (e) {
            console.warn('Firestore ai_support fetch error:', e.message);
        }
    }

    // 2. Try /tmp
    try {
        if (fs.existsSync(TMP_AI_KNOWLEDGE_FILE)) {
            RUNTIME_AI_KNOWLEDGE = JSON.parse(fs.readFileSync(TMP_AI_KNOWLEDGE_FILE, 'utf8'));
            return RUNTIME_AI_KNOWLEDGE;
        }
    } catch (_) {}

    // 3. Try bundled file
    try {
        if (fs.existsSync(AI_KNOWLEDGE_FILE)) {
            RUNTIME_AI_KNOWLEDGE = JSON.parse(fs.readFileSync(AI_KNOWLEDGE_FILE, 'utf8'));
            return RUNTIME_AI_KNOWLEDGE;
        }
    } catch (_) {}

    if (BUNDLED_KNOWLEDGE && BUNDLED_KNOWLEDGE.botName) {
        RUNTIME_AI_KNOWLEDGE = BUNDLED_KNOWLEDGE;
        return RUNTIME_AI_KNOWLEDGE;
    }

    return {
        botName: 'rajabsynic ai agent',
        supportPhone: '',
        whatsappLink: '',
        systemInstructions: 'Wewe ni msaidizi wa huduma kwa wateja wa RAJABSYNIC.',
        policies: {},
        faqs: []
    };
}

function getAIKnowledge() {
    if (RUNTIME_AI_KNOWLEDGE) return RUNTIME_AI_KNOWLEDGE;
    try {
        if (fs.existsSync(TMP_AI_KNOWLEDGE_FILE)) {
            return JSON.parse(fs.readFileSync(TMP_AI_KNOWLEDGE_FILE, 'utf8'));
        }
    } catch (_) {}
    try {
        if (fs.existsSync(AI_KNOWLEDGE_FILE)) {
            return JSON.parse(fs.readFileSync(AI_KNOWLEDGE_FILE, 'utf8'));
        }
    } catch (_) {}
    return BUNDLED_KNOWLEDGE || {
        botName: 'rajabsynic ai agent',
        supportPhone: '',
        whatsappLink: '',
        systemInstructions: 'Wewe ni msaidizi wa huduma kwa wateja wa RAJABSYNIC.',
        policies: {},
        faqs: []
    };
}

async function saveAIKnowledgeAsync(data) {
    RUNTIME_AI_KNOWLEDGE = data;
    let saved = false;

    // 1. Primary: Save to Firestore
    if (fsdb) {
        try {
            await fsdb.collection('settings').doc('ai_support').set(data, { merge: true });
            saved = true;
            console.log('Saved AI knowledge to Firestore settings/ai_support');
        } catch (e) {
            console.error('Firestore save ai_support error:', e.message);
        }
    }

    // 2. Save to temp directory
    try {
        fs.writeFileSync(TMP_AI_KNOWLEDGE_FILE, JSON.stringify(data, null, 2), 'utf8');
        saved = true;
    } catch (e) {
        console.warn('Failed to write temp AI knowledge:', e.message);
    }

    // 3. Save to bundled data directory if writable (local dev)
    try {
        fs.writeFileSync(AI_KNOWLEDGE_FILE, JSON.stringify(data, null, 2), 'utf8');
        saved = true;
    } catch (_) {
        // Read-only filesystem on Vercel lambda - totally normal
    }

    return saved || true;
}

function saveAIKnowledge(data) {
    RUNTIME_AI_KNOWLEDGE = data;
    try {
        fs.writeFileSync(TMP_AI_KNOWLEDGE_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (_) {}
    try {
        fs.writeFileSync(AI_KNOWLEDGE_FILE, JSON.stringify(data, null, 2), 'utf8');
        return true;
    } catch (e) {
        // Vercel serverless is read-only
        return true;
    }
}

// Helper: Read Chat Logs
function getAIChatLogs() {
    try {
        if (fs.existsSync(AI_LOGS_FILE)) {
            return JSON.parse(fs.readFileSync(AI_LOGS_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('Error reading AI chat logs:', e.message);
    }
    return [];
}

// Helper: Save Chat Logs
function appendAIChatLog(logEntry) {
    try {
        const logs = getAIChatLogs();
        logs.unshift(logEntry); // Newest first
        if (logs.length > 500) logs.pop(); // Keep max 500 logs
        fs.writeFileSync(AI_LOGS_FILE, JSON.stringify(logs, null, 2), 'utf8');
    } catch (e) {
        console.error('Error saving chat log:', e.message);
    }
}

// Helper: Get all catalog items known to AI
const CATALOG_CACHE_FILE = path.join(__dirname, 'data', 'catalog-cache.json');
let MEMORY_CATALOG = null;
let MEMORY_CATALOG_TIME = 0;

async function getCatalogItems() {
    const now = Date.now();
    if (MEMORY_CATALOG && MEMORY_CATALOG.length > 0 && (now - MEMORY_CATALOG_TIME < 10 * 60 * 1000)) {
        return MEMORY_CATALOG;
    }

    let items = [];
    if (fsdb) {
        try {
            const snap = await fsdb.collection('content').limit(1000).get();
            snap.forEach(doc => items.push({ id: doc.id, ...doc.data() }));
        } catch (_) {}
    }
    if (items.length === 0) {
        if (Array.isArray(BUNDLED_CATALOG) && BUNDLED_CATALOG.length > 0) {
            items = BUNDLED_CATALOG;
        } else if (fs.existsSync(CATALOG_CACHE_FILE)) {
            try {
                items = JSON.parse(fs.readFileSync(CATALOG_CACHE_FILE, 'utf8'));
            } catch (_) {}
        }
    }
    if (items.length === 0) {
        try {
            const dbData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));
            items = dbData.content || [];
        } catch (_) {}
    }

    if (items.length > 0) {
        MEMORY_CATALOG = items;
        MEMORY_CATALOG_TIME = now;
    }
    return items;
}

// Swahili filler & generic terms for intelligent matching
const CATALOG_FILLER_WORDS = new Set([
    'kuna', 'ipo', 'zipo', 'je', 'naomba', 'nataka', 'mchezo', 'michezo', 'wa', 'ya', 'za', 'la', 'cha',
    'kwa', 'katika', 'kwenye', 'hapa', 'pale', 'hiyo', 'hizo', 'hili', 'haya', 'nini', 'gani', 'habari',
    'mambo', 'hallow', 'hello', 'hi', 'bei', 'ngapi', 'shingapi', 'shilingi', 'pesa', 'tafadhali', 'kaka',
    'bro', 'boss', 'admin', 'agent', 'service', 'tovuti', 'website', 'online', 'na', 'au', 'ni', 'tu', 'zote', 'yote',
    'kwanini', 'mbona', 'sababu', 'vipi', 'jinsi', 'namna', 'lini', 'wapi', 'nani', 'maana', 'inamaanisha',
    'simu', 'simuni', 'phone', 'android', 'ios', 'pc', 'kompyuta', 'computer',
    'tatizo', 'shida', 'inachemka', 'moto', 'joto', 'inaganda', 'inakwama', 'haifanyi', 'haikubali', 'haiwaki',
    'haifunguki', 'haiingii', 'haijafunguka', 'inazima', 'inagoma', 'hitilafu', 'error', 'not', 'installed', 'app',
    'nifanyeje', 'kufanya', 'msaada', 'saidia', 'nisaidie', 'tatua', 'suluhisho', 'suluhu',
    'nacheza', 'kucheza', 'kuweka', 'nitaweka', 'nifungue', 'kufungua', 'kupakua', 'kudownload', 'download',
    'install', 'kusakinisha', 'kuingiza', 'kuondoa', 'futa', 'kufuta', 'clear', 'cache',
    'sana', 'nikiwa', 'yangu', 'yako', 'wangu', 'wako', 'hiki', 'kitu', 'kila', 'mara'
]);

function isTroubleshootingOrTechQuestion(text) {
    if (!text || typeof text !== 'string') return false;
    const lower = text.toLowerCase();
    const troublePatterns = [
        'kwanini', 'kwa nini', 'mbona', 'sababu', 'tatizo', 'shida', 'hitilafu', 'error',
        'inachemka', 'inapata moto', 'joto', 'inaganda', 'inakwama', 'inazima', 'inagoma',
        'haifanyi', 'haikubali', 'haiwaki', 'haifunguki', 'haiingii', 'haijafunguka',
        'app not installed', 'not installed', 'package installer', 'play protect',
        'nifanyeje', 'nifanye nini', 'suluhisho', 'jinsi ya kutatua', 'kurekebisha',
        'namna ya kurekebisha', 'msaada', 'nisaidie', 'kwanini game', 'kwanini simu'
    ];
    return troublePatterns.some(p => lower.includes(p));
}

const CATALOG_GENERIC_TERMS = new Set([
    'mod', 'mods', 'skin', 'skins', 'game', 'games', 'simulator', 'map', 'bus', 'basi', 'mabasi', 'maleo', 'bussid'
]);

function levenshteinDistance(s1, s2) {
    s1 = s1.toLowerCase();
    s2 = s2.toLowerCase();
    const costs = [];
    for (let i = 0; i <= s1.length; i++) {
        let lastValue = i;
        for (let j = 0; j <= s2.length; j++) {
            if (i === 0) costs[j] = j;
            else {
                if (j > 0) {
                    let newValue = costs[j - 1];
                    if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
                        newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
                    }
                    costs[j - 1] = lastValue;
                    lastValue = newValue;
                }
            }
        }
        if (i > 0) costs[s2.length] = lastValue;
    }
    return costs[s2.length];
}

// Intelligent Semantic / Fuzzy Search across 430+ catalog items
function findMatchingCatalogItems(query, allItems = [], maxResults = 25) {
    if (!query || typeof query !== 'string' || !Array.isArray(allItems) || allItems.length === 0) return [];
    const rawClean = query.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!rawClean) return [];

    const rawTokens = rawClean.split(' ').filter(Boolean);
    const keywords = rawTokens.filter(t => !CATALOG_FILLER_WORDS.has(t) && t.length > 1);

    if (keywords.length === 0) return [];

    const specificKeywords = keywords.filter(k => !CATALOG_GENERIC_TERMS.has(k));
    const scored = [];

    for (const item of allItems) {
        let score = 0;
        const titleLower = (item.title || '').toLowerCase();
        const catLower = (item.category || item.contentType || '').toLowerCase();
        const descLower = (item.description || '').toLowerCase();
        const titleWords = titleLower.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);

        // If specific keywords exist (like "abood", "shabiby", "katarama", "d14"), require at least one match
        if (specificKeywords.length > 0) {
            let matchesAnySpecific = false;
            for (const sk of specificKeywords) {
                if (titleLower.includes(sk) || catLower.includes(sk) || descLower.includes(sk)) {
                    matchesAnySpecific = true;
                    break;
                }
                if (sk.length >= 4) {
                    for (const tw of titleWords) {
                        if (tw.length >= 4 && levenshteinDistance(sk, tw) <= (sk.length >= 7 ? 2 : 1)) {
                            matchesAnySpecific = true;
                            break;
                        }
                    }
                }
                if (matchesAnySpecific) break;
            }
            if (!matchesAnySpecific) continue;
        }

        // Exact full phrase match
        if (titleLower.includes(rawClean)) {
            score += 200;
        }

        for (const kw of keywords) {
            const isSpecific = !CATALOG_GENERIC_TERMS.has(kw);
            const multiplier = isSpecific ? 3 : 1;

            if (titleWords.includes(kw)) {
                score += 50 * multiplier;
            } else if (titleLower.includes(kw)) {
                score += 35 * multiplier;
            }

            if (catLower.includes(kw)) {
                score += 20 * multiplier;
            }

            if (descLower.includes(kw)) {
                score += 15 * multiplier;
            }

            // Fuzzy typo matching
            if (kw.length >= 4) {
                for (const tw of titleWords) {
                    if (tw.length >= 4) {
                        const dist = levenshteinDistance(kw, tw);
                        const maxDist = kw.length >= 7 ? 2 : 1;
                        if (dist <= maxDist) {
                            score += 40 * multiplier;
                            break;
                        }
                    }
                }
            }
        }

        if (score > 0) {
            scored.push({ item, score });
        }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxResults).map(s => s.item);
}

// Helper: Build Catalog Summary for AI System Prompt
async function getCatalogSummary() {
    const items = await getCatalogItems();
    if (!items || items.length === 0) {
        return 'Maudhui makuu: Maleo Bus Mods, Maleo Bus Skins, Maleo Map Mods, ETS 2 Mods, Tanzania Games, Free Games, na Program/Apps.';
    }

    return items.slice(0, 150).map(i => {
        const price = (i.isFree || !i.price || i.price == 0) ? 'BURE (Free)' : ('Tsh ' + Number(i.price).toLocaleString('en-US'));
        const cat = i.category || i.contentType || 'mchezo';
        return '- Jina: "' + i.title + '" | Kundi: ' + cat + ' | Bei: ' + price;
    }).join('\n');
}

// Helper: Verify Payment and Grant Access Automatically (Zero-prompt AI Verification)
async function checkPaymentAndGrantAccess({ userMsg, userId = '', userPhone = '', history = [] }) {
    if (!userMsg) return null;
    const msg = userMsg.trim();
    const lower = msg.toLowerCase();

    // 1. Detect if user claims they paid, missed service, or needs verification
    const paymentClaimKeywords = [
        'nimelipa', 'nmelipa', 'nimeshalipa', 'tayari nimelipa', 'nmelipia', 'nimelipia',
        'namba niliyolipia', 'sijapata link', 'sijaona link', 'sijapata access', 'bado imefungwa',
        'haifunguki baada ya kulipa', 'hakiki malipo', 'thibitisha malipo', 'kagua malipo',
        'nimeshakatwa', 'nimekatwa', 'nimekatwa pesa', 'nimeshalipia', 'nmelipa hela',
        'nimeshatuma pesa', 'haina link', 'kifurushi hakijafunguka', 'sioni movies',
        'sijapewa huduma', 'nimekwama baada ya kulipa', 'pesa imetoka', 'malipo yamepita',
        'nililipia', 'nililipa', 'nimefanya malipo', 'hakiki', 'thibitisha'
    ];
    const hasClaimedPaid = paymentClaimKeywords.some(kw => lower.includes(kw));

    // 2. Extract phone numbers explicitly written in userMsg
    const phoneRegex = /(?:(?:\+?255)|0)([67]\d{8})/;
    const phoneMatch = msg.replace(/[\s\-]/g, '').match(phoneRegex);

    // 3. Extract Order IDs from userMsg
    const orderRegex = /\b(ORD-[A-Za-z0-9_\-]+|CPM[A-Za-z0-9_\-]+|PAY-[A-Za-z0-9_\-]+)\b/i;
    const orderMatch = msg.match(orderRegex);
    const extractedOrderId = orderMatch ? orderMatch[1].trim() : '';

    // Check if the previous message from bot asked for a phone number or payment details
    const nonUserHistory = (Array.isArray(history) ? history : []).filter(h => h.role === 'bot' || h.role === 'model');
    const lastBotMsg = nonUserHistory.length > 0 ? (nonUserHistory[nonUserHistory.length - 1].text || nonUserHistory[nonUserHistory.length - 1].message || '').toLowerCase() : '';
    const wasAskedForPaymentPhone = lastBotMsg.includes('namba ya simu') || lastBotMsg.includes('malipo');

    const isExplicitPaymentCheck = hasClaimedPaid || Boolean(extractedOrderId) || (Boolean(phoneMatch) && wasAskedForPaymentPhone);

    // STRICT GUARD: If user is not claiming payment or asking for payment verification, NEVER intercept!
    if (!isExplicitPaymentCheck) {
        return null;
    }

    // Now resolve phone number to search: prioritize phone typed in message, then userPhone from session context
    let extractedPhone = '';
    let phoneVariations = [];
    if (phoneMatch) {
        const digits = phoneMatch[1];
        extractedPhone = '0' + digits;
        phoneVariations = ['0' + digits, '255' + digits, '+255' + digits, digits];
    } else if (userPhone) {
        const upClean = String(userPhone).replace(/[^0-9]/g, '');
        if (upClean.length >= 9) {
            extractedPhone = upClean.startsWith('0') ? upClean : ('0' + upClean.slice(-9));
            phoneVariations = [extractedPhone, '255' + extractedPhone.slice(1), '+' + '255' + extractedPhone.slice(1)];
        }
    }

    // Search payments in Firestore / local DB automatically without demanding user input
    let payments = [];
    if (fsdb) {
        try {
            if (extractedOrderId) {
                const snap1 = await fsdb.collection('payments').where('id', '==', extractedOrderId).limit(5).get();
                snap1.forEach(d => payments.push({ id: d.id, ...d.data() }));
                if (payments.length === 0) {
                    const snap2 = await fsdb.collection('payments').where('merchantReference', '==', extractedOrderId).limit(5).get();
                    snap2.forEach(d => payments.push({ id: d.id, ...d.data() }));
                }
            }
            if (payments.length === 0 && phoneVariations.length > 0) {
                for (const pv of phoneVariations) {
                    const snap3 = await fsdb.collection('payments').where('phone', '==', pv).limit(5).get();
                    snap3.forEach(d => payments.push({ id: d.id, ...d.data() }));
                    if (payments.length > 0) break;
                }
            }
            if (payments.length === 0 && userId) {
                const snap4 = await fsdb.collection('payments').where('userId', '==', userId).limit(5).get();
                snap4.forEach(d => payments.push({ id: d.id, ...d.data() }));
            }
        } catch (dbErr) {
            console.warn('Payment search notice:', dbErr.message);
        }
    }

    // Fallback search in local db.json
    if (payments.length === 0) {
        try {
            const dbData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));
            const localList = dbData.payments || [];
            payments = localList.filter(p => {
                if (extractedOrderId && (p.id === extractedOrderId || p.order_id === extractedOrderId || p.merchantReference === extractedOrderId)) return true;
                if (phoneVariations.length > 0 && phoneVariations.includes(p.phone)) return true;
                if (userId && p.userId === userId) return true;
                return false;
            });
        } catch (_) {}
    }

    // Sort by createdAt descending
    payments.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    if (payments.length > 0) {
        const p = payments[0];
        let status = String(p.status || '').toLowerCase();
        const contentName = p.contentTitle || 'mchezo/filamu yako';
        const amountStr = p.amount ? Number(p.amount).toLocaleString('en-US') : '0';
        const searchPhone = p.phone || extractedPhone || userPhone;

        // If status in record was pending, do a live check in case webhook just arrived
        if (status === 'pending' && p.id && fsdb) {
            const pDoc = await fsdb.collection('payments').doc(p.id).get();
            if (pDoc.exists && ['completed', 'success'].includes((pDoc.data()?.status || '').toLowerCase())) {
                status = 'completed';
            }
        }

        if (status === 'completed' || status === 'success' || status === 'complete') {
            // GRANT ACCESS INSTANTLY!
            try {
                if (userId && !p.userId) p.userId = userId;
                await grantAccessForPayment(p);

                let durationDays = 30;
                const cId = p.contentId || '';
                if (cId === 'adult-section-access') durationDays = 5;
                else if (cId === 'live-tv-access') durationDays = 30;
                else if (cId === 'movies-package-mikumi') durationDays = 1;
                else if (cId === 'movies-package-ngorongoro') durationDays = 7;
                else if (cId === 'movies-package-serengeti' || cId === 'movies-access') durationDays = 30;

                const targetUid = userId || p.userId || p.uid || searchPhone;
                if (fsdb && targetUid) {
                    const now = new Date();
                    const expiresAt = new Date(Date.now() + durationDays * 86400000);
                    const subId = 'SUB-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
                    await fsdb.collection('subscriptions').doc(subId).set({
                        id: subId,
                        userId: targetUid,
                        contentId: cId,
                        orderId: p.order_id || p.id || '',
                        contentTitle: contentName,
                        durationDays,
                        createdAt: now.toISOString(),
                        expiresAt: expiresAt.toISOString(),
                        grantedByAI: true
                    }).catch(() => {});

                    if (cId.startsWith('movies-package-') || cId === 'movies-access') {
                        const mSubId = 'SUB-MOVIES-' + targetUid;
                        await fsdb.collection('subscriptions').doc(mSubId).set({
                            id: mSubId,
                            userId: targetUid,
                            contentId: 'movies-access',
                            packageId: cId,
                            orderId: p.order_id || p.id || '',
                            createdAt: now.toISOString(),
                            expiresAt: expiresAt.toISOString(),
                            grantedByAI: true
                        }, { merge: true }).catch(() => {});
                    }
                }

                // Log this automated grant event
                if (fsdb) {
                    fsdb.collection('ai_access_grants').add({
                        id: 'grant_' + Date.now(),
                        phone: searchPhone,
                        orderId: p.order_id || p.id || '',
                        contentTitle: contentName,
                        amount: p.amount || 0,
                        userId: targetUid,
                        timestamp: new Date().toISOString()
                    }).catch(() => {});
                }
            } catch (grantErr) {
                console.error('Error granting access by AI:', grantErr.message);
            }

            return {
                handled: true,
                accessGranted: true,
                contentId: p.contentId,
                reply: `✅ Nimehakiki malipo yako na tayari nimekupa access papo hapo!\n\nMalipo yako ya Tsh ${amountStr} kwa ajili ya "${contentName}" yamethibitishwa kikamilifu. Sasa unaweza kufungua ukurasa wa "${contentName}" na kuanza kupakua au kutazama mara moja bila kizuizi chochote. Karibu sana!`
            };
        } else if (status === 'pending') {
            return {
                handled: true,
                reply: `Hujakamilisha malipo. Muamala wako wa Tsh ${amountStr} kwa ajili ya "${contentName}" bado unangoja uthibitisho (PIN) kwenye simu yako (${searchPhone}). Tafadhali weka namba yako ya siri (PIN) ili ukamilishe muamala huo na upate huduma mara moja.`
            };
        } else {
            return {
                handled: true,
                reply: `Hujakamilisha malipo. Mfumo unaonyesha muamala wako wa "${contentName}" haukufanikiwa au ulikataliwa kwenye mtandao wa simu. Tafadhali jaribu kulipia tena kwa kubonyeza "Lipa Sasa" au wasiliana nasi kwa usaidizi zaidi.`
            };
        }
    }

    // If completely unknown visitor with no identifiers at all
    if (!extractedPhone && !extractedOrderId && !userId) {
        return {
            handled: true,
            reply: `Hujakamilisha malipo au namba yako ya simu haijatambuliwa. Kama tayari umefanya malipo kwenye simu, tafadhali niandikie hapa namba ya simu uliyotumia kulipia (mfano: 07XXXXXXXX au 06XXXXXXXX) nami nitakuhakikia na kukupa access papo hapo bila kuchelewa.`
        };
    }

    // Payment not found for known user/phone
    return {
        handled: true,
        reply: `Hujakamilisha malipo. Hakuna kumbukumbu ya malipo iliyopatikana kwenye akaunti yako. Tafadhali bonyeza "Lipa Sasa" kwenye maudhui au kifurushi unachotaka ili kukamilisha malipo na kupata access papo hapo.`
    };
}

// Public Endpoint: AI Support Chat
app.post('/api/support/chat', async (req, res) => {
    try {
        const { message, history = [], sessionId, userId, userPhone } = req.body;
        if (!message || typeof message !== 'string' || !message.trim()) {
            return res.status(400).json({ success: false, error: 'Message is required' });
        }

        const userMsg = message.trim();
        const knowledge = await getAIKnowledgeAsync();

        // 1. Check if this is a payment verification & access grant request
        const paymentCheck = await checkPaymentAndGrantAccess({ userMsg, userId, userPhone, history });
        if (paymentCheck && paymentCheck.handled) {
            // Log conversation
            const logEntry = {
                id: 'log_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
                sessionId: sessionId || ('guest_' + Date.now()),
                userMessage: userMsg,
                botResponse: paymentCheck.reply,
                timestamp: new Date().toISOString(),
                isPaymentAction: true,
                ip: req.ip || req.headers['x-forwarded-for'] || 'local'
            };
            logEntry.accessGranted = !!paymentCheck.accessGranted;
            logEntry.contentId = paymentCheck.contentId || '';
            appendAIChatLog(logEntry);
            if (fsdb) fsdb.collection('ai_chat_logs').add(logEntry).catch(() => {});

            return res.json({
                success: true,
                reply: paymentCheck.reply,
                accessGranted: !!paymentCheck.accessGranted,
                contentId: paymentCheck.contentId || '',
                botName: knowledge.botName || 'rajabsynic ai agent'
            });
        }

        // 2. Prepare Knowledge, Fuzzy Catalog Match & System Prompt
        const isTrouble = isTroubleshootingOrTechQuestion(userMsg);
        const allCatalogItems = await getCatalogItems();
        // If user is asking a technical/troubleshooting question, do NOT trigger product catalog matches
        const relevantMatches = isTrouble ? [] : findMatchingCatalogItems(userMsg, allCatalogItems, 15);

        let relevantCatalogSection = '';
        if (relevantMatches.length > 0) {
            relevantCatalogSection = `
═══ BIDHAA ZILIZOPO KWENYE MFUMO ZINAZOENDANA NA SWALI (RELEVANT MATCHES) ═══
Hapa chini ni bidhaa zilizopo kwenye mfumo wa RAJABSYNIC:
${relevantMatches.map(i => {
    const p = (i.isFree || !i.price || i.price == 0) ? 'BURE (Free)' : ('Tsh ' + Number(i.price).toLocaleString('en-US'));
    return `- Jina: "${i.title}" | Kundi: ${i.category || i.contentType || 'mchezo'} | Bei: ${p}`;
}).join('\n')}

KANUNI YA BIDHAA:
- Tumia majina na bei hizi IKIWA TU mteja anaulizia mchezo au mod husika au bei yake. Mtajie bei yake kwa Shilingi (Tsh) na umwelekeze kuipata kwa kubonyeza kitufe cha "Lipa Sasa" kwenye ukurasa wa mchezo husika.
`.trim();
        }

        const conversationGuide = `
═══ MUONGOZO WA MAZUNGUMZO NA AKILI BANDIA (DEEP CONVERSATION INTELLIGENCE) ═══
- CHAMBUA NA UELEWE KWA KINA KILE MTEJA ANACHOULIZA KABLA YA KUJIBU:
  * Swali la kiufundi / simu / matatizo (mfano: simu kuchemka, simu kuganda, kumbukumbu kujaa, betri kuisha haraka, app not installed):
    -> JIBU KWA KINA CHA KITAALAMU NA HOJA ZA KISAYANSI/KITEKNOLOJIA! Eleza kwanini tatizo linatokea na mpe hatua madhubuti za kutatua. USIMTAJIE wala kumpa orodha ya bidhaa au mods kwenye swali la kiufundi!
  * Utafutaji wa mchezo, mod au filamu:
    -> Kama anatafuta bidhaa maalum, mthibitishie kama ipo, mtajie bei yake ya Shilingi (Tsh), na mwelekeze kutumia kitufe cha "Lipa Sasa".
  * Salamu za kawaida (mfano "mambo", "habari"):
    -> Mkaribishe kwa adabu na uchangamfu kisha muulize unavyoweza kumsaidia leo. Kwenye maswali yanayofuata, jibu moja kwa moja bila kurudia salamu.
`.trim();
        const catalogSummary = await getCatalogSummary();
        const faqText = (knowledge.faqs || []).map(f => 'Q: ' + f.question + '\nA: ' + f.answer).join('\n\n');

        // Extract and format all Admin Trainings cleanly (Supreme Highest Priority)
        let customInstructionsFormatted = '';
        if (knowledge.trainings && Array.isArray(knowledge.trainings) && knowledge.trainings.length > 0) {
            customInstructionsFormatted = knowledge.trainings
                .map((t, idx) => `📌 FUNZO / MUONGOZO #${idx + 1}:\n${t.text.trim()}`)
                .join('\n\n──────────────────────────────\n\n');
        } else if (knowledge.systemInstructions || knowledge.customKnowledge) {
            customInstructionsFormatted = (knowledge.systemInstructions || knowledge.customKnowledge).trim();
        }

        const systemPrompt = `
WEWE NI: "rajabsynic ai agent" — Msaidizi Mahiri na Mtaalamu Mkuu wa Akili Bandia (High-Intelligence AI Expert Assistant) wa tovuti ya RAJABSYNIC (https://www.rajabsynic.com).
Lugha yako kuu ya mawasiliano ni Kiswahili fasaha, chenye staha, heshima, ukomavu na weledi mkubwa. (Unaweza pia kujibu kwa Kiingereza kama mteja atauliza kwa Kiingereza).

══════════════════════════════════════════════════════════════════
⭐ KANUNI KUU ZA UELEWA NA MAJIBU YA AKILI (CORE INTELLIGENCE DIRECTIVES)
══════════════════════════════════════════════════════════════════
1. ELEWA KWA KINA SWAHI LA MTEJA (DEEP COMPREHENSION):
   - Kamwe usijibu ili mradi umejibu! Chambua kwa umakini kile mteja anachouliza, dhamira yake, na muktadha kamili.
   - Jibu moja kwa moja kwa hoja za kweli, zenye mantiki na kusaidia kwa vitendo.
   - Usirudie salamu ndefu kama "Habari! Karibu sana..." ikiwa mteja tayari mnaendelea na mazungumzo au ikiwa ameuliza swali la moja kwa moja. Jibu moja kwa moja swali lake kwa hekima na ufupi unaotosheleza.
   - Usikatishe tamaa mteja kwa majibu mafupi yasiyoeleweka au majibu ya roboti ya kiotomatiki.

2. MAFUNZO YA ADMIN NDIYO AMRI KUU YA NAFASI YA #1 (SUPREME ADMIN TRAINING):
   - Kila funzo lililopo hapa chini ulipewa na ADMIN wa RAJABSYNIC na lina MAMLAKA YA JUU KABISA (Supreme Priority).
   - Mteja akiuliza au akikabiliwa na tatizo lililoelezwa kwenye mafunzo haya (kwa mfano: hitilafu za simu za Android kama 'App Not Installed', namna ya kuweka APKs, ufunguaji wa michezo, malipo, n.k.), TUMIA MAELEKEZO YA ADMIN KIKAMILIFU na umpe hatua za kitaalamu zenye mpangilio unaoeleweka vizuri.

${customInstructionsFormatted ? customInstructionsFormatted : '(Hakuna mafunzo maalum ya ziada yaliyowekwa na Admin kwa sasa.)'}
══════════════════════════════════════════════════════════════════

${conversationGuide}

${relevantCatalogSection}

═══ MWONGOZO WA HUDUMA ZA RAJABSYNIC (SERVICE KNOWLEDGE) ═══
1. MALIPO KWA SIMU (KITUFE CHA "Lipa Sasa"):
   - Kitufe cha malipo kwenye tovuti kimeandikwa "Lipa Sasa". Kila mara tumia neno "Lipa Sasa".
   - Malipo yote yanafanyika kupitia mitandao ya simu ya Tanzania: M-Pesa, Tigo Pesa, Airtel Money, au Halopesa.
   - Baada ya mteja kuingiza namba yake ya simu na kuthibitisha kwa PIN ya mtandao wake, mfumo hufungua huduma au mchezo mara moja kiotomatiki bila kuhitaji kubonyeza kitufe cha uhakiki.

2. UPATIKANAJI WA MAUDHUI (DOWNLOAD & ACCESS):
   - Vitu visivyolipiwa viko LOCKED. Mara baada ya malipo ya kitufe cha "Lipa Sasa", kitufe cha "Pakua" (Download) kinafunguka papo hapo.
   - Michezo ya bure (Free Games) haihitaji malipo — mteja anabonyeza "Pakua" moja kwa moja.
   - Chini ya hali yoyote ile, USITOE file, password au link ya kupakua kwa kitu kilichopo locked bila mteja kulipia.

3. KATAZO LA NAMBA YA SIMU AU WHATSAPP BINAFSI:
   - Chini ya hali yoyote ile, usitoe wala kutaja namba ya simu au kiungo cha WhatsApp binafsi. Mwelekeze kutumia sehemu ya "Msaada" (Help) iliyopo kwenye menyu ya tovuti.

═══ CATALOG YA BIDHAA NA MICHEZO (SUMMARY) ═══
${catalogSummary}
`.trim();

        const apiKey = process.env.GEMINI_API_KEY;
        let aiReply = '';

        // Prepare clean, properly-alternating contents for Gemini API
        const formattedHistory = [];
        for (const h of (history || [])) {
            const role = (h.role === 'user') ? 'user' : 'model';
            const text = (h.text || h.message || '').trim();
            if (!text) continue;
            // Never start Gemini contents with 'model'
            if (formattedHistory.length === 0 && role === 'model') continue;
            // Prevent consecutive same-role turns
            if (formattedHistory.length > 0 && formattedHistory[formattedHistory.length - 1].role === role) {
                formattedHistory[formattedHistory.length - 1].parts[0].text += '\n' + text;
            } else {
                formattedHistory.push({ role, parts: [{ text }] });
            }
        }

        // Add the latest incoming user message cleanly
        if (formattedHistory.length === 0 || formattedHistory[formattedHistory.length - 1].role !== 'user') {
            formattedHistory.push({ role: 'user', parts: [{ text: userMsg }] });
        } else {
            formattedHistory[formattedHistory.length - 1].parts[0].text = userMsg;
        }

        // Attempt Gemini API call with full reasoning enabled
        try {
            const geminiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=' + apiKey;
            const geminiPayload = {
                contents: formattedHistory,
                systemInstruction: {
                    parts: [{ text: systemPrompt }]
                },
                generationConfig: {
                    temperature: 0.35,
                    maxOutputTokens: 2500
                }
            };

            const geminiRes = await axios.post(geminiUrl, geminiPayload, {
                headers: {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': apiKey
                },
                timeout: 15000
            });

            if (geminiRes.data && geminiRes.data.candidates && geminiRes.data.candidates[0]?.content?.parts) {
                const parts = geminiRes.data.candidates[0].content.parts;
                const bestPart = parts.find(p => p.text && !p.thought) || parts[0];
                if (bestPart && bestPart.text) {
                    aiReply = bestPart.text.trim();
                }
            }
        } catch (apiErr) {
            console.warn('Gemini API call notice:', apiErr.message);
        }

                // Scrub any phone numbers or WhatsApp links that might have leaked from LLM
        if (aiReply) {
            aiReply = aiReply
                .replace(/(?:\+?255|0)[67]\d{8}/g, '[sehemu ya Msaada]')
                .replace(/https?:\/\/wa\.me\S*/gi, '[Msaada]');
        }

        // Graceful intelligent grounding fallback if API call returned empty or had network issues
        if (!aiReply) {
            const lower = userMsg.toLowerCase();
            const matchedFaq = (knowledge.faqs || []).find(f => {
                const qWords = f.question.toLowerCase().split(/\s+/).filter(w => w.length > 3);
                return qWords.some(w => lower.includes(w));
            });

            if (matchedFaq) {
                aiReply = matchedFaq.answer;
            } else if (relevantMatches.length > 0) {
                const topList = relevantMatches.slice(0, 5).map(m => {
                    const pr = (m.isFree || !m.price || m.price == 0) ? 'BURE' : `Tsh ${Number(m.price).toLocaleString('en-US')}`;
                    return `• ${m.title} — ${pr}`;
                }).join('\n');
                aiReply = `Ndio! Michezo na mods hizo zipo kwenye mfumo wa RAJABSYNIC:\n\n${topList}\n\nKupata mchezo wowote kati ya hiyo, fungua mchezo huo kwenye tovuti yetu kisha ubonyeze kitufe cha "Lipa Sasa". Kitufe cha kupakua (Download) kitafunguka papo hapo baada ya malipo!`;
            } else if (lower.includes('lipa') || lower.includes('malipo') || lower.includes('pesa') || lower.includes('bei')) {
                aiReply = 'Malipo yote yanafanyika kwa njia salama ya simu za Tanzania (M-Pesa, Tigo Pesa, Airtel Money, Halopesa). Bonyeza mchezo unaoutaka, bonyeza kitufe cha "Lipa Sasa", weka namba yako ya simu na uthibitishe kwa PIN. Kitufe cha kupakua (Download) kitafunguka papo hapo.';
            } else if (lower.includes('download') || lower.includes('pakua') || lower.includes('link')) {
                aiReply = 'Baada ya kukamilisha malipo kwa kitufe cha "Lipa Sasa", kitufe cha kupakua (Download) kinafunguka moja kwa moja kwenye ukurasa wa mchezo. (Kwa michezo ya bure, unabonyeza tu kitufe cha Pakua bila kulipia). Kama unakumbana na changamoto yoyote, tafadhali angalia sehemu ya "Msaada" kwenye menyu ya chini ya tovuti yetu.';
            } else if (lower.includes('wasiliana') || lower.includes('namba') || lower.includes('admin') || lower.includes('msaada') || lower.includes('contact')) {
                aiReply = 'Unaweza kupata msaada moja kwa moja kupitia sehemu ya "Msaada" (Help) iliyopo kwenye menyu ya chini ya tovuti yetu au kupitia ukurasa wako wa Akaunti.';
            } else {
                aiReply = 'Habari! Karibu sana RAJABSYNIC. Naitwa rajabsynic ai agent, msaidizi wako rasmi. Je, nikusaidie nini leo? (Unaweza kuniuliza kuhusu mchezo au mod yoyote unayoitafuta kama mods za mabasi ya Maleo ya Abood, Shabiby, Katarama, ruti za ETS2, bei zake, au jinsi ya kulipa kwa kitufe cha "Lipa Sasa" na kupakua).';
            }
        }

        // Log conversation
        const logEntry = {
            id: 'log_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
            sessionId: sessionId || ('guest_' + Date.now()),
            userMessage: userMsg,
            botResponse: aiReply,
            timestamp: new Date().toISOString(),
            ip: req.ip || req.headers['x-forwarded-for'] || 'local'
        };
        appendAIChatLog(logEntry);

        // Also save to Firestore if available
        if (fsdb) {
            fsdb.collection('ai_chat_logs').add(logEntry).catch(() => {});
        }

        res.json({
            success: true,
            reply: aiReply,
            botName: knowledge.botName || 'rajabsynic ai agent'
        });

    } catch (err) {
        console.error('Chat endpoint error:', err);
        res.status(500).json({
            success: false,
            error: 'Server error processing chat',
            reply: 'Samahani, kumetokea hitilafu ya mtandao. Tafadhali jaribu tena au tembelea sehemu ya "Msaada" kwenye menyu ya tovuti yetu.'
        });
    }
});

// Admin Endpoint: Get AI Catalog items
app.get('/api/admin/ai/catalog', requireAdmin, async (req, res) => {
    try {
        const items = await getCatalogItems();
        res.json({ success: true, count: items.length, items });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Admin Endpoint: Sync AI Catalog from frontend Firebase
app.post('/api/admin/ai/sync-catalog', requireAdmin, (req, res) => {
    try {
        const { items } = req.body;
        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ success: false, error: 'Items array is required' });
        }
        fs.writeFileSync(CATALOG_CACHE_FILE, JSON.stringify(items, null, 2), 'utf8');
        res.json({ success: true, count: items.length, message: 'Katalogi ya AI imesasishwa kikamilifu!' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Admin Endpoint: Train single Q&A correction
app.post('/api/admin/ai/train-correction', requireAdmin, (req, res) => {
    try {
        const { question, answer } = req.body;
        if (!question || !answer) {
            return res.status(400).json({ success: false, error: 'Question and answer are required' });
        }
        const knowledge = getAIKnowledge();
        knowledge.faqs = knowledge.faqs || [];
        knowledge.faqs.unshift({ question: question.trim(), answer: answer.trim() });
        knowledge.lastUpdated = new Date().toISOString();
        saveAIKnowledge(knowledge);
        if (fsdb) {
            fsdb.collection('settings').doc('ai_support').set(knowledge).catch(() => {});
        }
        res.json({ success: true, message: 'Funzo jipya limehifadhiwa kwenye akili ya AI!' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Admin Endpoint: Get AI Access Grants
app.get('/api/admin/ai/access-grants', requireAdmin, async (req, res) => {
    try {
        const grants = [];
        if (fsdb) {
            const snap = await fsdb.collection('ai_access_grants').orderBy('timestamp', 'desc').limit(50).get();
            snap.forEach(d => grants.push({ id: d.id, ...d.data() }));
        }
        res.json(grants);
    } catch (e) {
        res.json([]);
    }
});

// Admin Endpoint: Get AI Knowledge
app.get('/api/admin/ai-knowledge', requireAdmin, async (req, res) => {
    try {
        const knowledge = await getAIKnowledgeAsync();
        res.json(knowledge);
    } catch (e) {
        res.json(getAIKnowledge());
    }
});

// Admin Endpoint: Update AI Knowledge
app.post('/api/admin/ai-knowledge', requireAdmin, async (req, res) => {
    try {
        const updated = req.body;
        if (!updated || typeof updated !== 'object') {
            return res.status(400).json({ success: false, error: 'Invalid payload' });
        }
        updated.lastUpdated = new Date().toISOString();
        await saveAIKnowledgeAsync(updated);
        res.json({ success: true, message: 'Maelekezo ya AI yamehifadhiwa kikamilifu!' });
    } catch (e) {
        console.error('Error saving AI knowledge:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// Admin Endpoint: Get AI Chat Logs
app.get('/api/admin/ai-chat-logs', requireAdmin, async (req, res) => {
    if (fsdb) {
        try {
            const snap = await fsdb.collection('ai_chat_logs').orderBy('timestamp', 'desc').limit(100).get();
            const logs = [];
            snap.forEach(d => logs.push({ id: d.id, ...d.data() }));
            if (logs.length > 0) return res.json(logs);
        } catch (_) {}
    }
    res.json(getAIChatLogs());
});

// Admin Endpoint: Clear AI Chat Logs
app.delete('/api/admin/ai-chat-logs', requireAdmin, (req, res) => {
    try {
        fs.writeFileSync(AI_LOGS_FILE, JSON.stringify([], null, 2), 'utf8');
        res.json({ success: true, message: 'Kumbukumbu za maongezi zimefutwa' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`\n🚀 Rajabsynic Server imeanza!`);
        console.log(`🌐 User Portal   : http://localhost:${PORT}/`);
        console.log(`🔐 Admin Panel   : http://localhost:${PORT}/admin`);
        const _pgMode = (process.env.TEST_MODE === 'true' || !PRESSSO_API_SECRET) ? 'TEST MODE' : 'LIVE';
        console.log(`💳 Payment GW    : PressoPay (${_pgMode})`);
        console.log(`🔑 API Key       : ${PRESSSO_API_KEY ? PRESSSO_API_KEY.slice(0, 12) + '...' : '⚠️  NOT SET (check .env)'}`);
        console.log(`🔐 API Secret    : ${PRESSSO_API_SECRET ? 'set ✅' : '⚠️  NOT SET (check .env)'}`);
        console.log(`🔗 Webhook URL   : ${process.env.WEBHOOK_BASE_URL || 'https://rajabsynic.com'}/api/payment/webhook\n`);
    });
}
module.exports = app;
