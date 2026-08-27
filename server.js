require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
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

// Serve static files with 1-year cache (except HTML, which is usually not cached this way natively without express.static options, but we can set maxAge: '1y')
app.use(express.static(__dirname, { maxAge: '1y' }));


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
    const token = authHeader.split('Bearer ')[1];
    try {
        const decodedToken = await require('firebase-admin/auth').getAuth().verifyIdToken(token);
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

// ── Firebase Admin (Firestore) ───────────────────────────────────────────────
// Referral earnings & withdrawals are stored in Firestore (like the rest of the
// app). Falls back to local db.json only if the service account key is missing.
let fsdb = null;
try {
    const { initializeApp, cert } = require('firebase-admin/app');
    const { getFirestore } = require('firebase-admin/firestore');
    const keyPath = process.env.SERVICE_ACCOUNT_PATH || path.join(__dirname, 'serviceAccountKey.json');
    if (fs.existsSync(keyPath)) {
        initializeApp({ credential: cert(require(keyPath)) });
        fsdb = getFirestore();
        console.log('✅ Firebase Admin initialized — referral data stored in Firestore');
    } else {
        console.warn('⚠️  serviceAccountKey.json not found — referral data falls back to local db.json');
    }
} catch (e) {
    console.warn('⚠️  Firebase Admin init failed, using local db.json for referral data:', e.message);
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
    const settings = deepMerge(DEFAULT_SETTINGS, db.settings || {});
    if (contentId === 'adult-section-access') return settings.adultSubscription.durationDays || 30;
    if (contentId === 'live-tv-access')       return settings.liveSubscription.durationDays || 30;
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

// GET /api/subscription/check?userId=&contentId=
// Source of truth the client falls back to when Firebase shows no access.
app.get('/api/subscription/check', async (req, res) => {
    const { userId, contentId } = req.query;
    if (!userId || !contentId) {
        return res.status(400).json({ hasAccess: false, error: 'userId and contentId required' });
    }

    const now = new Date();

    if (fsdb) {
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
    const reference = body.reference || body.merchantReference || body.order_id;
    if (!reference) return res.status(400).json({ error: 'Missing reference' });
    try {
        if (!fsdb) {
            return res.status(500).json({ error: 'DB not ready' });
        }
        const TEST_MODE = process.env.TEST_MODE === 'true';

        // Resolve orderId from reference (could be PAY-... or ORD-...)
        let orderId = reference;
        // Try to find by merchantReference (ORD-...) first via paymentIndex
        const indexSnap = await fsdb.collection('paymentIndex').doc(reference).get();
        if (indexSnap.exists) {
            orderId = indexSnap.data().orderId;
            console.log(`📥 Webhook: resolved ${reference} -> ${orderId}`);
        }

        // Find the payment doc directly
        let paymentRef = fsdb.collection('payments').doc(orderId);
        let paymentSnap = await paymentRef.get();
        
        // Fallback: search by merchantReference or id field
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

        const doc = paymentSnap;
        const payment = doc.data();

        if (['completed', 'success'].includes((payment.status || '').toLowerCase())) {
            console.log(`Webhook: payment ${orderId} already processed, skipping`);
            return res.status(200).send('OK');
        }

        // Update payment to completed
        await paymentRef.update({ status: 'completed' });
        console.log(`✅ Webhook: payment ${orderId} marked completed`);

        const userId = payment.userId || payment.uid;
        const contentId = payment.contentId;

        if (userId && contentId) {
            // Create subscription (idempotent)
            const existingSubs = await fsdb.collection('subscriptions')
                .where('orderId', '==', orderId).limit(1).get();

            if (existingSubs.empty) {
                const subId = 'SUB-' + orderId;
                await fsdb.collection('subscriptions').doc(subId).set({
                    id: subId,
                    userId,
                    contentId,
                    orderId,
                    createdAt: new Date().toISOString(),
                    expiresAt: new Date(Date.now() + 31536000000).toISOString()
                });
                console.log(`✅ Webhook: subscription created for user=${userId} content=${contentId}`);
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
            gw = {
                reference: data.reference || merchantReference,
                status: (data.status || 'PENDING'),
                checkoutUrl: data.checkoutUrl || null
            };
        }

        console.log('✅ PressoPay Response:', gw);
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
                gateway: TEST_MODE ? 'test' : 'pressopay',
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
                    const apiPath = `/api/v1/checkouts/${orderId}`;
                    const pollResp = await axios.get(`${PRESSSO_BASE_URL}${apiPath}`, {
                        headers: {
                            ...pressoAuthHeaders('GET', apiPath),
                            'X-API-Key': PRESSSO_API_KEY
                        }
                    });
                    
                    const pStatus = String(pollResp.data.status || '').toUpperCase();
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
        if (!TEST_MODE && PRESSSO_API_KEY && PRESSSO_API_SECRET && payment.status === 'pending') {
            try {
                // ✅ FIX: PressoPay status check uses /api/v1/payments/PAY-...
                const apiPath = `/api/v1/payments/${orderId}`;
                console.log(`🔍 Polling PressoPay: ${PRESSSO_BASE_URL}${apiPath}`);
                const pollResp = await axios.get(`${PRESSSO_BASE_URL}${apiPath}`, {
                    headers: {
                        ...pressoAuthHeaders('GET', apiPath)
                    },
                    timeout: 8000
                });
                
                const pStatus = String(pollResp.data.status || '').toUpperCase();
                console.log(`🔍 PressoPay status for ${orderId}: ${pStatus} (raw: ${JSON.stringify(pollResp.data)})`);
                
                if (pStatus === 'COMPLETED' || pStatus === 'SUCCESS') {
                    // ✅ FIX: Use direct doc reference - Firestore transactions cannot use .where() queries!
                    const paymentDocRef = fsdb.collection('payments').doc(orderId);
                    const paymentSnap = await paymentDocRef.get();
                    
                    if (!paymentSnap.exists) {
                        console.error(`Payment doc ${orderId} not found in Firestore`);
                    } else {
                        const txPayment = paymentSnap.data();
                        
                        // Only process if still pending (idempotent)
                        if (!['completed', 'success'].includes((txPayment.status || '').toLowerCase())) {
                            // Step 1: Mark payment as completed
                            await paymentDocRef.update({ status: 'completed' });
                            payment.status = 'completed';
                            console.log(`✅ Payment ${orderId} marked as completed`);
                            
                            // Step 2: Create subscription immediately
                            const pUserId = txPayment.userId || txPayment.uid;
                            const pContentId = txPayment.contentId;
                            
                            if (pUserId && pContentId) {
                                // Check if subscription already exists
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
                                        expiresAt: new Date(Date.now() + 31536000000).toISOString() // 1 year
                                    });
                                    console.log(`✅ Subscription created for user ${pUserId} content ${pContentId}`);
                                } else {
                                    console.log(`ℹ️ Subscription already exists for order ${orderId}`);
                                }
                                
                                // Step 3: Credit referral if applicable
                                if (txPayment.referredBy) {
                                    try {
                                        const refEarnRef = fsdb.collection('referralEarnings').doc('REF-' + orderId);
                                        const refSnap = await refEarnRef.get();
                                        if (!refSnap.exists) {
                                            const pFullPrice = Number(txPayment.fullPrice) || Number(txPayment.amount);
                                            await refEarnRef.set({
                                                referralCode: txPayment.referredBy,
                                                orderId: orderId,
                                                earnedAmount: Math.floor(pFullPrice * 0.35),
                                                createdAt: new Date().toISOString()
                                            });
                                        }
                                    } catch (refErr) {
                                        console.error('Referral credit error (non-fatal):', refErr.message);
                                    }
                                }
                            }
                        } else {
                            payment.status = txPayment.status;
                        }
                    }
                    console.log(`✅ Active poll: SUCCESS processed for ${orderId}`);
                } else if (pStatus === 'FAILED' || pStatus === 'CANCELLED') {
                    await fsdb.collection('payments').doc(orderId).update({ status: 'failed' });
                    payment.status = 'failed';
                    console.log(`❌ Active poll detected FAILURE for ${orderId}`);
                }
            } catch (apiErr) {
                // 401 means GET signature is different from POST - log but don't fail
                // Frontend will rely on Firebase onSnapshot for real-time updates from webhook
                console.warn(`⚠️ PressoPay GET poll failed (${apiErr.response?.status || apiErr.message}) - relying on webhook for status update`);
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
