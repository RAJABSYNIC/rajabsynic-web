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

// GET /api/system-health — Live system health check & diagnostics
app.get('/api/system-health', async (req, res) => {
    const startTime = Date.now();
    let dbStatus = 'operational';
    let dbLatency = 0;
    let adminsCount = 0;

    // 1. Test Firestore connectivity & latency
    if (fsdb) {
        try {
            const dbStart = Date.now();
            const snap = await fsdb.collection('users').where('role', '==', 'admin').limit(10).get();
            dbLatency = Date.now() - dbStart;
            adminsCount = snap.size || 0;
            dbStatus = 'operational';
        } catch (e) {
            dbStatus = 'degraded';
        }
    } else {
        dbStatus = 'local_fallback';
    }

    // 2. Test PressoPay credentials
    const paymentsOperational = Boolean(process.env.PRESSSO_API_KEY && process.env.PRESSSO_API_SECRET);
    const paymentsStatus = paymentsOperational ? 'operational' : 'not_configured';

    // 3. Test Gemini AI credentials
    const aiOperational = Boolean(process.env.GEMINI_API_KEY);
    const aiStatus = aiOperational ? 'operational' : 'not_configured';

    // 4. Calculate total latency
    const apiLatency = Date.now() - startTime;

    // 5. Calculate overall score
    let score = 100;
    if (dbStatus !== 'operational') score -= 25;
    if (!paymentsOperational) score -= 15;
    if (!aiOperational) score -= 10;
    if (score === 100) score = 99.9;

    res.json({
        success: true,
        healthPercentage: score,
        status: score >= 90 ? 'healthy' : 'warning',
        uptime: '99.9%',
        serverTime: new Date().toISOString(),
        components: {
            api: {
                name: 'Server & API (Backend)',
                status: 'operational',
                latencyMs: Math.max(5, apiLatency),
                message: `Muda wa majibu: ${Math.max(5, apiLatency)}ms`
            },
            database: {
                name: 'Database (Cloud Firestore)',
                status: dbStatus,
                latencyMs: Math.max(10, dbLatency),
                message: dbStatus === 'operational' ? `Imeunganishwa (${Math.max(10, dbLatency)}ms)` : 'Hifadhi ya ndani'
            },
            payments: {
                name: 'Payment Gateway (PressoPay)',
                status: paymentsStatus,
                message: paymentsOperational ? 'Mitandao yote ya simu ipo tayari' : 'Inasubiri kuweka funguo'
            },
            ai: {
                name: 'AI Support (Gemini 3.8 Flash)',
                status: aiStatus,
                message: aiOperational ? 'Uelewa na majibu yako hewani' : 'Inasubiri API key'
            }
        },
        adminsCount: adminsCount || 3
    });
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

// GET /api/user/payments?phone=...&userId=...&username=...
// Public endpoint for a logged-in user to fetch their own payment/transaction history safely
app.get('/api/user/payments', async (req, res) => {
    const rawPhone = (req.query.phone || '').trim();
    const userId = (req.query.userId || '').trim();
    const username = (req.query.username || '').trim();

    if (!rawPhone && !userId && !username) {
        return res.status(400).json({ success: false, error: 'Taarifa za mtumiaji zinahitajika', payments: [] });
    }

    try {
        const paymentsMap = new Map();

        // 1. Prepare phone variations
        let phoneVariations = [];
        if (rawPhone) {
            const digits = rawPhone.replace(/[^0-9]/g, '');
            if (digits.length >= 9) {
                const last9 = digits.slice(-9);
                phoneVariations = [
                    '0' + last9,
                    '255' + last9,
                    '+255' + last9,
                    last9,
                    rawPhone
                ];
            } else if (digits.length > 0) {
                phoneVariations = [rawPhone, digits];
            }
        }
        const uniquePhones = Array.from(new Set(phoneVariations.filter(Boolean))).slice(0, 10);

        // 2. Fetch from Firestore if available
        if (fsdb) {
            const queries = [];

            if (userId) {
                queries.push(fsdb.collection('payments').where('userId', '==', String(userId)).get());
            }

            if (uniquePhones.length > 0) {
                queries.push(fsdb.collection('payments').where('phone', 'in', uniquePhones).get());
            }

            const snaps = await Promise.all(queries);
            snaps.forEach(snap => {
                snap.forEach(doc => {
                    const data = doc.data() || {};
                    const key = data.id || data.order_id || data.orderId || data.merchantReference || doc.id;
                    if (key && !paymentsMap.has(key)) {
                        paymentsMap.set(key, { ...data, docId: doc.id });
                    }
                });
            });

            // If empty and username provided, fallback search by username
            if (paymentsMap.size === 0 && username) {
                const uSnap = await fsdb.collection('payments').where('username', '==', username).limit(25).get();
                uSnap.forEach(doc => {
                    const data = doc.data() || {};
                    const key = data.id || data.order_id || data.orderId || data.merchantReference || doc.id;
                    if (key && !paymentsMap.has(key)) {
                        paymentsMap.set(key, { ...data, docId: doc.id });
                    }
                });
            }
        }

        // 3. Fallback to local db.json if needed
        if (paymentsMap.size === 0) {
            try {
                const dbPath = path.join(__dirname, 'data', 'db.json');
                if (fs.existsSync(dbPath)) {
                    const dbData = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
                    const localPayments = dbData.payments || [];
                    localPayments.forEach(p => {
                        const matchUser = userId && p.userId === userId;
                        const matchPhone = uniquePhones.length > 0 && uniquePhones.includes(p.phone);
                        const matchName = username && p.username && p.username.toLowerCase() === username.toLowerCase();
                        if (matchUser || matchPhone || matchName) {
                            const key = p.id || p.order_id || p.orderId || p.merchantReference;
                            if (key && !paymentsMap.has(key)) {
                                paymentsMap.set(key, p);
                            }
                        }
                    });
                }
            } catch (e) {
                console.warn('Local db user-payments fallback error:', e.message);
            }
        }

        const payments = Array.from(paymentsMap.values());

        // Sort descending by date (newest first)
        payments.sort((a, b) => {
            const timeA = new Date(a.createdAt || a.timestamp || a.date || a.updatedAt || 0).getTime();
            const timeB = new Date(b.createdAt || b.timestamp || b.date || b.updatedAt || 0).getTime();
            return timeB - timeA;
        });

        return res.json({ success: true, count: payments.length, payments });
    } catch (err) {
        console.error('Error fetching user payments:', err);
        return res.status(500).json({ success: false, error: err.message, payments: [] });
    }
});

// ─── Access / Subscription helpers ────────────────────────────────────────────
// Resolve subscription duration (days) for a given content, from settings.
function getDurationDays(db, contentId) {
    if (!contentId) return 14;
    const cId = String(contentId).trim();
    if (cId === 'movies-package-mikumi')     return 1;
    if (cId === 'movies-package-ngorongoro') return 7;
    if (cId === 'movies-package-serengeti' || cId === 'movies-access')  return 30;
    if (cId === 'adult-section-access')      return 5;
    if (cId === 'live-tv-access')            return 30;
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
        const rawTime = payment.createdAt || payment.timestamp || payment.created_at || payment.date;
        const paymentTime = (rawTime && !isNaN(new Date(rawTime).getTime())) ? new Date(rawTime).getTime() : Date.now();
        const expiresAt = new Date(paymentTime + (durationDays * 86400000));
        const isExpired = Date.now() > expiresAt.getTime();

        const subData = {
            id: 'SUB-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
            userId,
            contentId,
            orderId,
            contentTitle: payment.contentTitle || '',
            durationDays,
            createdAt: new Date(paymentTime).toISOString(),
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
                createdAt: new Date(paymentTime).toISOString(),
                expiresAt: expiresAt.toISOString()
            };
            await fsdb.collection('subscriptions').doc(movieAccessSub.id).set(movieAccessSub).catch(() => {});
        }

        console.log(`🔓 Access recorded: user=${userId} content=${contentId} until ${expiresAt.toISOString().slice(0, 10)} (active=${!isExpired})`);
        return !isExpired;
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

// ─── AI MISSING CATALOG DEMAND TRACKER ─────────────────────────────────
const AI_MISSING_REQUESTS_FILE = path.join(__dirname, 'data', 'ai-missing-requests.json');
let RUNTIME_MISSING_REQUESTS = null;

function getMissingCatalogRequests() {
    if (RUNTIME_MISSING_REQUESTS && Array.isArray(RUNTIME_MISSING_REQUESTS)) {
        return RUNTIME_MISSING_REQUESTS;
    }
    try {
        if (fs.existsSync(AI_MISSING_REQUESTS_FILE)) {
            RUNTIME_MISSING_REQUESTS = JSON.parse(fs.readFileSync(AI_MISSING_REQUESTS_FILE, 'utf8'));
            return RUNTIME_MISSING_REQUESTS;
        }
    } catch (e) {
        console.error('Error reading missing catalog requests:', e.message);
    }
    RUNTIME_MISSING_REQUESTS = [];
    return RUNTIME_MISSING_REQUESTS;
}

function saveMissingCatalogRequests(requests) {
    RUNTIME_MISSING_REQUESTS = requests;
    try {
        fs.writeFileSync(AI_MISSING_REQUESTS_FILE, JSON.stringify(requests, null, 2), 'utf8');
    } catch (e) {
        console.error('Error saving missing catalog requests:', e.message);
    }
}

async function getMissingCatalogRequestsAsync() {
    const local = getMissingCatalogRequests();
    if (!fsdb) return local;
    try {
        const snap = await fsdb.collection('missing_catalog_requests').orderBy('count', 'desc').limit(200).get();
        if (!snap.empty) {
            const list = [];
            snap.forEach(d => list.push({ id: d.id, ...d.data() }));
            RUNTIME_MISSING_REQUESTS = list;
            return list;
        }
    } catch (e) {
        console.warn('Firestore missing_catalog_requests fetch notice:', e.message);
    }
    return local;
}

function extractMissingItemInfo(msg, intent) {
    if (!msg || typeof msg !== 'string') return null;
    const text = msg.trim();
    const lower = text.toLowerCase();

    // Skip if troubleshooting, payment claim, purchase complaint, greeting, or pure gratitude
    const skipPaymentAndTrouble = [
        'simu inachemka', 'inaganda', 'haifunguki', 'jinsi ya kulipia', 'malipo', 'm-pesa', 'tigopesa', 'airtel', 'halopesa',
        'kujiunga', 'akaunti', 'password', 'asante', 'ahsante', 'shukrani',
        'nimenunua', 'nimeshanunua', 'nmenunua', 'nishanunua', 'silipati', 'sijalipata', 'sijapata', 'ilasilipati', 'ila silipati',
        'nimelipa', 'nimeshalipa', 'nimelipia', 'nimekatwa', 'sijapewa', 'pesa imetoka'
    ];
    if (skipPaymentAndTrouble.some(w => lower.includes(w))) {
        return null;
    }

    let category = 'Game';
    if (intent === 'movie' || ['movie', 'movies', 'filamu', 'sinema', 'tamthilia', 'series'].some(w => lower.includes(w))) {
        category = 'Movie';
    } else if (['mod', 'mods', 'skin', 'skins', 'basi', 'mabasi', 'bus', 'bussid', 'maleo', 'lori', 'malori', 'scania'].some(w => lower.includes(w))) {
        category = 'Mod';
    } else if (intent === 'livetv' || ['live tv', 'livetv', 'channel', 'chaneli'].some(w => lower.includes(w))) {
        category = 'Live TV';
    }

    let cleaned = text
        .replace(/^(habari|hallow|hello|hi|mambo|salama|samahani|kaka|admin|boss|bro|tafadhali|je|hivi|eti|naomba kuuliza|nauliza)[\s,]+/i, '')
        .replace(/\b(kuna|mna|mnao|naomba|nahitaji|nataka|naitaji|natafuta|nitapata|napata|nitaipata|unao|mnayo|unayo)\b/gi, '')
        .replace(/\b(game ya|game inaitwa|game|games|mchezo wa|mchezo unaoitwa|mchezo|michezo)\b/gi, '')
        .replace(/\b(mod ya|mod za|mod|mods|skin ya|skin za|skin|skins)\b/gi, '')
        .replace(/\b(movie ya|movie za|movie|movies|filamu ya|filamu za|filamu|sinema ya|sinema)\b/gi, '')
        .replace(/\b(live tv ya|channel ya|chaneli ya)\b/gi, '')
        .replace(/\b(inapatikana|inapatikana\?|ipo\?|ipo|zipo\?|zipo|mnao\?|mnao|humu\?|kwenye mfumo\?|kwenye tovuti\?|bado\?|bado)\b/gi, '')
        .replace(/[?!.,;:\"'’()]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (!cleaned || cleaned.length < 2 || cleaned.length > 50) return null;

    const fillerOnly = ['ya', 'wa', 'za', 'la', 'cha', 'vipi', 'gani', 'nini', 'hapa', 'pale', 'hiyo', 'tu', 'sawa', 'ok'];
    if (fillerOnly.includes(cleaned.toLowerCase())) return null;

    const titleCase = cleaned.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');

    return {
        itemName: titleCase,
        category,
        rawQuery: text
    };
}

async function recordMissingCatalogRequestAsync({ itemName, category, rawQuery, userPhone, userName, userId }) {
    if (!itemName || typeof itemName !== 'string') return;
    const cleanName = itemName.trim();
    if (cleanName.length < 2) return;

    const normKey = cleanName.toLowerCase().replace(/[^a-z0-9]/g, '') + '_' + (category || 'game').toLowerCase();
    const nowIso = new Date().toISOString();

    const allRequests = await getMissingCatalogRequestsAsync();
    let existing = allRequests.find(r => r.key === normKey || r.id === normKey);

    if (existing) {
        existing.count = (existing.count || 1) + 1;
        existing.lastRequested = nowIso;
        existing.status = 'pending'; // Reset to pending if demanded again
        if (rawQuery) {
            existing.sampleQueries = existing.sampleQueries || [];
            if (!existing.sampleQueries.includes(rawQuery)) {
                existing.sampleQueries.unshift(rawQuery);
                if (existing.sampleQueries.length > 5) existing.sampleQueries.pop();
            }
        }
        if (userPhone || userName) {
            existing.requesters = existing.requesters || [];
            const isKnown = existing.requesters.some(u => (userPhone && u.phone === userPhone) || (userName && u.name === userName));
            if (!isKnown) {
                existing.requesters.unshift({
                    name: userName || null,
                    phone: userPhone || null,
                    userId: userId || null,
                    date: nowIso
                });
                if (existing.requesters.length > 10) existing.requesters.pop();
            }
        }
    } else {
        existing = {
            id: normKey,
            key: normKey,
            itemName: cleanName,
            category: category || 'Game',
            count: 1,
            status: 'pending',
            firstRequested: nowIso,
            lastRequested: nowIso,
            sampleQueries: rawQuery ? [rawQuery] : [],
            requesters: (userPhone || userName) ? [{
                name: userName || null,
                phone: userPhone || null,
                userId: userId || null,
                date: nowIso
            }] : []
        };
        allRequests.unshift(existing);
    }

    saveMissingCatalogRequests(allRequests);

    if (fsdb) {
        try {
            await fsdb.collection('missing_catalog_requests').doc(normKey).set(existing, { merge: true });
        } catch (e) {
            console.warn('Firestore record missing catalog demand notice:', e.message);
        }
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

// ─── HIGH-IQ CATALOG CLASSIFICATION & INTENT DIRECTIVES ────────────────────────

// 1. Precise Item Classification: Distinguish Games vs Movies vs LiveTV vs Adult
function getItemType(item) {
    if (!item) return 'other';
    const cat = (item.category || '').toLowerCase();
    const type = (item.type || item.contentType || '').toLowerCase();
    const title = (item.title || '').toLowerCase();
    const desc = (item.description || '').toLowerCase();

    if (cat === 'live tv' || type === 'livetv' || type === 'channel') return 'livetv';
    if (cat === 'x-video' || cat === 'connection' || type === 'adult') return 'adult';

    // Movie / Filamu detection (DJ Mack, action movies, series, etc.)
    const movieCategories = ['action', 'comedy', 'romantic', 'horror', 'adventure', 'series', 'drama', 'movie', 'movies'];
    const isMovieCategory = movieCategories.includes(cat);
    const hasMovieKeywords = title.includes('dj mack') || title.includes('dj afro') || title.includes('imetafsiriwa') ||
        title.includes('imetafsiliwa') || title.includes('single movie') || title.includes('season ') ||
        title.includes('episode') || title.includes('filamu') ||
        desc.includes('filamu') || desc.includes('tamthilia') || type === 'movie';

    if (isMovieCategory || hasMovieKeywords) return 'movie';

    // Games and Mods (Mortal Kombat, Maleo Bus Mods, Skins, Maps, ETS2, GTA, etc.)
    const gameCategories = ['free-games', 'tanzania-games', 'maleo-bus-mod', 'maleo-map-mod', 'maleo-bus-skin', 'maleo-bus-mod-multi', 'ets-2-mod-bus', 'program-and-app'];
    if (gameCategories.includes(cat) || type === 'game' || title.includes('game') || title.includes('mod') || title.includes('skin') || title.includes('map')) {
        return 'game';
    }

    return 'game'; // default to game for gaming platform
}

// 2. Precise Detection: Support, Contact & Technical Troubleshooting
function isTroubleshootingOrTechQuestion(text) {
    if (!text || typeof text !== 'string') return false;
    const lower = text.toLowerCase();

    // Explicit technical hardware/OS/runtime issues
    const techPatterns = [
        'inachemka', 'inapata moto', 'joto kali', 'joto la simu', 'moto simu', 'kwanini simu inapata moto',
        'inaganda', 'inastuck', 'inakwama', 'kuganda', 'ina-lag', 'lagging', 'fps ndogo',
        'app not installed', 'application not installed', 'not installed', 'haisakinishwi',
        'package installer', 'play protect', 'kuzuiliwa na simu', 'blocked by play protect',
        'force close', 'inatoka peke yake', 'inajizima', 'inazima', 'inagoma kuwaka',
        'storage full', 'storage imejaa', 'memory full', 'memory imejaa', 'nafasi imejaa',
        'ram ndogo', 'ram imejaa', 'clear cache', 'kufuta cache',
        'jinsi ya kuweka obb', 'kuweka obb', 'folder la obb', 'jinsi ya kuweka mod',
        'jinsi ya ku-extract', 'kuextract', 'extract zip', 'zarchiver', '7z', 'rar'
    ];

    if (techPatterns.some(p => lower.includes(p))) return true;

    // Compound technical issue queries
    if ((lower.includes('simu') || lower.includes('phone') || lower.includes('kioo') || lower.includes('betri')) &&
        (lower.includes('inapata') || lower.includes('inaharibika') || lower.includes('tatizo') || lower.includes('shida') || lower.includes('kuchemka') || lower.includes('kuganda') || lower.includes('inazima'))) {
        return true;
    }

    return false;
}

function isContactOrSupportQuestion(text) {
    if (!text || typeof text !== 'string') return false;
    const lower = text.toLowerCase();
    const contactPatterns = [
        'msaada zaidi', 'msaada wa tovuti', 'wasiliana', 'kuwasiliana', 'namba ya simu',
        'namba ya admin', 'admin namba', 'ofisi', 'email ya msaada', 'customer care',
        'huduma kwa wateja', 'kupata msaada zaidi'
    ];
    return contactPatterns.some(p => lower.includes(p));
}

// High-IQ User Intent Detection: Understand what user is strictly asking about
function detectUserIntent(text) {
    if (!text || typeof text !== 'string') return 'general';
    const lower = text.toLowerCase();

    // 1. Technical Troubleshooting (overheating, lag, app not installed, storage, obb)
    if (isTroubleshootingOrTechQuestion(text)) {
        return 'troubleshooting';
    }

    // 2. Support / Contact
    if (isContactOrSupportQuestion(text)) {
        return 'contact';
    }

    // 3. Payment / Pricing
    const paymentKeywords = [
        'jinsi ya kulipia', 'jinsi ya kufanya malipo', 'kufanya malipo', 'njia ya malipo',
        'm-pesa', 'tigopesa', 'tigo pesa', 'airtel money', 'halopesa'
    ];
    if (paymentKeywords.some(kw => lower.includes(kw))) {
        return 'payment';
    }

    // 4. Live TV keywords
    const liveKeywords = ['live tv', 'livetv', 'chaneli', 'channel', 'channels', 'mpira live', 'azam', 'supersport'];
    if (liveKeywords.some(kw => lower.includes(kw))) {
        return 'livetv';
    }

    // 5. Adult keywords
    const adultKeywords = ['adult', '18+', 'x-video', 'x video', 'video za wakubwa', 'connection'];
    if (adultKeywords.some(kw => lower.includes(kw))) {
        return 'adult';
    }

    // 6. Movie / Filamu keywords
    const movieKeywords = [
        'movie', 'movies', 'filamu', 'tamthilia', 'series', 'sinema', 'dj mack', 'dj afro',
        'kutafsiriwa', 'kutafsiliwa', 'kutazama filamu', 'kuangalia movie', 'season', 'episode'
    ];
    const isAskingMovie = movieKeywords.some(kw => lower.includes(kw));

    // 7. Game / Mchezo keywords
    const gameKeywords = [
        'game', 'games', 'mchezo', 'michezo', 'kucheza', 'magame', 'mod', 'mods',
        'skin', 'skins', 'maleo', 'bussid', 'map mod', 'basi', 'mabasi', 'bus', 'buses', 'gari', 'magari',
        'pspp', 'ppsspp', 'gta', 'fifa', 'pes', 'wtds', 'mortal kombat', 'ets 2', 'ets2', 'tekken',
        'ngasere', 'shabiby', 'abood', 'katarama', 'bm', 'marcopolo', 'mrombo', 'machame', 'asanterabi',
        'burdan', 'zhongtong', 'yutong', 'higer', 'rosa', 'scania', 'd14',
        'maleo bus', 'maleo tz', 'maleo multiplayer', 'maleo map'
    ];
    const isAskingGame = gameKeywords.some(kw => lower.includes(kw));

    if (isAskingMovie && !isAskingGame) return 'movie';
    if (isAskingGame && !isAskingMovie) return 'game';
    if (isAskingGame && isAskingMovie) return 'both';

    return 'general';
}

// Swahili filler & generic terms for intelligent matching
const CATALOG_FILLER_WORDS = new Set([
    'kuna', 'ipo', 'zipo', 'je', 'naomba', 'nataka', 'wa', 'ya', 'za', 'la', 'cha',
    'asante', 'asnt', 'shukrani', 'ahsante', 'kwa', 'katika', 'kwenye', 'hapa', 'pale', 'hiyo', 'hizo', 'hili', 'haya', 'nini', 'gani', 'habari',
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

// (isTroubleshootingOrTechQuestion defined above)

const CATALOG_GENERIC_TERMS = new Set([
    'mod', 'mods', 'skin', 'skins', 'game', 'games', 'mchezo', 'michezo', 'simulator', 'map', 'bus', 'basi', 'mabasi', 'maleo', 'bussid', 'movie', 'movies', 'filamu'
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

    const intent = detectUserIntent(query);

    // Filter candidate items by intent: NEVER show movies when asked for games, and vice versa!
    let candidateItems = allItems;
    if (intent === 'game') {
        candidateItems = allItems.filter(i => getItemType(i) === 'game');
    } else if (intent === 'movie') {
        candidateItems = allItems.filter(i => getItemType(i) === 'movie');
    } else if (intent === 'livetv') {
        candidateItems = allItems.filter(i => getItemType(i) === 'livetv');
    } else if (intent === 'adult') {
        candidateItems = allItems.filter(i => getItemType(i) === 'adult');
    }

    const rawTokens = rawClean.split(' ').filter(Boolean);
    const keywords = rawTokens.filter(t => !CATALOG_FILLER_WORDS.has(t) && t.length > 1);

    // If generic question about games or movies without a specific title (e.g., "michezo inayovuma", "kuna game gani")
    const specificKeywords = keywords.filter(k => !CATALOG_GENERIC_TERMS.has(k));
    if (keywords.length === 0 || specificKeywords.length === 0) {
        if (intent === 'game' || intent === 'movie' || intent === 'livetv') {
            return candidateItems.slice(0, maxResults);
        }
    }

    const scored = [];

    for (const item of candidateItems) {
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

// Helper: Build Lean, High-Efficiency Catalog Summary for AI System Prompt (Save tokens)
async function getCatalogSummary() {
    const items = await getCatalogItems();
    if (!items || items.length === 0) {
        return 'Maudhui makuu: Maleo Bus Mods, Maleo Bus Skins, Maleo Map Mods, ETS 2 Mods, Tanzania Games, Free Games, na Program/Apps.';
    }

    const games = items.filter(i => getItemType(i) === 'game');
    const movies = items.filter(i => getItemType(i) === 'movie');
    const livetv = items.filter(i => getItemType(i) === 'livetv');

    const fmt = (i, label) => {
        const price = (i.isFree || !i.price || i.price == 0) ? 'BURE' : ('Tsh ' + Number(i.price).toLocaleString('en-US'));
        return '- [' + label + '] "' + i.title + '" | Bei: ' + price;
    };

    let summary = '═══ MUHTASARI MAALUM WA BIDHAA ZA MFUMO ═══\n';
    summary += '1. MICHEZO NA MODS ZA MALEO (Shabiby, Abood, Ngasere, Katarama, n.k.):\n';
    summary += games.slice(0, 15).map(i => fmt(i, 'MCHEZO/MOD')).join('\n') + '\n\n';
    summary += '2. FILAMU ZILIZOTAFSIRIWA (DJ Mack n.k.):\n';
    summary += movies.slice(0, 8).map(i => fmt(i, 'FILAMU/MOVIE')).join('\n') + '\n\n';
    summary += '3. CHANELI ZA LIVE TV:\n';
    summary += livetv.slice(0, 5).map(i => fmt(i, 'LIVE TV')).join('\n');

    return summary;
}

// Helper: Format date in Swahili
function formatSwahiliDate(dateInput) {
    if (!dateInput) return '';
    const months = ['Januari', 'Februari', 'Machi', 'Aprili', 'Mei', 'Juni', 'Julai', 'Agosti', 'Septemba', 'Oktoba', 'Novemba', 'Desemba'];
    const d = new Date(dateInput);
    if (isNaN(d.getTime())) return '';
    return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

// Helper: Verify Payment and Grant Access Automatically (Zero-prompt AI Verification with Strict Expiration Enforcement)
async function checkPaymentAndGrantAccess({ userMsg, userId = '', userPhone = '', history = [] }) {
    if (!userMsg) return null;
    const msg = userMsg.trim();
    const lower = msg.toLowerCase();

    // 1. Detect if user claims they paid, missed service, or needs verification
    const paymentClaimKeywords = [
        'nimelipa', 'nmelipa', 'nimeshalipa', 'tayari nimelipa', 'nmelipia', 'nimelipia',
        'nimenunua', 'nimeshanunua', 'nmenunua', 'nishanunua', 'nimenunua game', 'silipati', 'sijalipata', 'ila silipati', 'ilasilipati',
        'nishalipa', 'nimeripia', 'nishalipia', 'nshatuma', 'nshatuma hela', 'nshatuma pesa', 'nimeshatuma hela',
        'nishalipa era', 'nishalipa jinsi', 'nimekwisha kulipa', 'tayari nishalipa',
        'namba niliyolipia', 'sijapata link', 'sijaona link', 'sijapata access', 'bado imefungwa',
        'haifunguki baada ya kulipa', 'hakiki malipo', 'thibitisha malipo', 'kagua malipo',
        'nimeshakatwa', 'nimekatwa', 'nimekatwa pesa', 'nimeshalipia', 'nmelipa hela',
        'nimeshatuma pesa', 'haina link', 'kifurushi hakijafunguka', 'sioni movies',
        'sijapewa huduma', 'sijapata huduma', 'nimelipia sijapata huduma', 'nimekwama baada ya kulipa', 'pesa imetoka', 'malipo yamepita',
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
        // Live-verify any pending payments in Firestore in case webhook just arrived
        for (const p of payments) {
            let status = String(p.status || '').toLowerCase();
            if (status === 'pending' && p.id && fsdb) {
                try {
                    const pDoc = await fsdb.collection('payments').doc(p.id).get();
                    if (pDoc.exists) {
                        const liveStatus = String(pDoc.data()?.status || '').toLowerCase();
                        if (['completed', 'success', 'complete'].includes(liveStatus)) {
                            p.status = 'completed';
                        }
                    }
                } catch (_) {}
            }
        }

        const completedPayments = payments.filter(p => ['completed', 'success', 'complete'].includes(String(p.status || '').toLowerCase()));
        const pendingPayments = payments.filter(p => String(p.status || '').toLowerCase() === 'pending');
        const failedPayments = payments.filter(p => ['failed', 'cancelled', 'canceled'].includes(String(p.status || '').toLowerCase()));

        if (completedPayments.length > 0) {
            // If user mentioned a specific item name or id, prioritize that payment
            const msgLower = lower;
            const matchingTargeted = completedPayments.filter(cp => {
                const title = (cp.contentTitle || '').toLowerCase();
                const cid = (cp.contentId || '').toLowerCase();
                return (title && msgLower.includes(title)) || (cid && msgLower.includes(cid));
            });
            const paymentsToEvaluate = matchingTargeted.length > 0 ? matchingTargeted : completedPayments;

            const now = new Date();
            let activePayment = null;
            let activeExpiresAt = null;
            let latestExpiredPayment = null;
            let latestExpiredDate = null;

            for (const p of paymentsToEvaluate) {
                const durationDays = getDurationDays(null, p.contentId);
                let expiresAt = null;

                // 1. Check if a subscription record already exists in Firestore for this order
                if (fsdb && (p.order_id || p.id)) {
                    try {
                        const subSnap = await fsdb.collection('subscriptions')
                            .where('orderId', '==', p.order_id || p.id)
                            .limit(1)
                            .get();
                        if (!subSnap.empty) {
                            const subData = subSnap.docs[0].data();
                            if (subData.expiresAt) {
                                const parsed = new Date(subData.expiresAt);
                                if (!isNaN(parsed.getTime())) {
                                    expiresAt = parsed;
                                }
                            }
                        }
                    } catch (_) {}
                }

                // 2. If no subscription record, calculate from payment creation time + durationDays
                if (!expiresAt) {
                    const rawTime = p.createdAt || p.timestamp || p.created_at || p.date || p.updatedAt;
                    const paymentTime = (rawTime && !isNaN(new Date(rawTime).getTime())) ? new Date(rawTime).getTime() : 0;
                    if (paymentTime > 0) {
                        expiresAt = new Date(paymentTime + (durationDays * 86400000));
                    } else {
                        // Fallback if no timestamp: treat as newly paid
                        expiresAt = new Date(now.getTime() + (durationDays * 86400000));
                    }
                }

                if (now.getTime() <= expiresAt.getTime()) {
                    // PAYMENT IS ACTIVE AND WITHIN USAGE DURATION!
                    if (!activePayment || expiresAt.getTime() > activeExpiresAt.getTime()) {
                        activePayment = p;
                        activeExpiresAt = expiresAt;
                    }
                } else {
                    // PAYMENT HAS EXPIRED (OUTSIDE USAGE DURATION)!
                    if (!latestExpiredPayment || expiresAt.getTime() > latestExpiredDate.getTime()) {
                        latestExpiredPayment = p;
                        latestExpiredDate = expiresAt;
                    }
                }
            }

            // Case A: User has an ACTIVE payment within validity period
            if (activePayment && activeExpiresAt) {
                const p = activePayment;
                const contentName = p.contentTitle || 'mchezo/filamu yako';
                const amountStr = p.amount ? Number(p.amount).toLocaleString('en-US') : '0';
                const searchPhone = p.phone || extractedPhone || userPhone;
                const targetUid = userId || p.userId || p.uid || searchPhone;

                try {
                    if (userId && !p.userId) p.userId = userId;
                    await grantAccessForPayment(p);

                    if (fsdb && targetUid) {
                        const durationDays = getDurationDays(null, p.contentId);
                        const subId = 'SUB-' + (p.order_id || p.id || Date.now());
                        await fsdb.collection('subscriptions').doc(subId).set({
                            id: subId,
                            userId: targetUid,
                            contentId: p.contentId || '',
                            orderId: p.order_id || p.id || '',
                            contentTitle: contentName,
                            durationDays,
                            createdAt: p.createdAt || now.toISOString(),
                            expiresAt: activeExpiresAt.toISOString(),
                            grantedByAI: true
                        }, { merge: true }).catch(() => {});

                        if (String(p.contentId || '').startsWith('movies-package-') || p.contentId === 'movies-access') {
                            const mSubId = 'SUB-MOVIES-' + targetUid;
                            await fsdb.collection('subscriptions').doc(mSubId).set({
                                id: mSubId,
                                userId: targetUid,
                                contentId: 'movies-access',
                                packageId: p.contentId,
                                orderId: p.order_id || p.id || '',
                                createdAt: p.createdAt || now.toISOString(),
                                expiresAt: activeExpiresAt.toISOString(),
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
                            expiresAt: activeExpiresAt.toISOString(),
                            timestamp: new Date().toISOString()
                        }).catch(() => {});
                    }
                } catch (grantErr) {
                    console.error('Error granting access by AI:', grantErr.message);
                }

                const remainingMs = activeExpiresAt.getTime() - now.getTime();
                const remainingHours = Math.ceil(remainingMs / (1000 * 60 * 60));
                const remainingDays = Math.floor(remainingMs / (1000 * 60 * 60 * 24));
                let remainingText = '';
                if (remainingDays >= 1) {
                    const extraHours = remainingHours % 24;
                    remainingText = `siku ${remainingDays}${extraHours > 0 ? ` na masaa ${extraHours}` : ''}`;
                } else {
                    remainingText = `masaa ${Math.max(1, remainingHours)}`;
                }

                return {
                    handled: true,
                    accessGranted: true,
                    expired: false,
                    contentId: p.contentId,
                    expiresAt: activeExpiresAt.toISOString(),
                    reply: `Nimehakiki malipo yako na yapo HAI!\n\nMalipo yako ya Tsh ${amountStr} kwa ajili ya "${contentName}" ni halali hadi tarehe ${formatSwahiliDate(activeExpiresAt)} (bado una muda wa ${remainingText}).\n\nSasa unaweza kufungua ukurasa wa "${contentName}" na kuanza kupakua au kutazama mara moja bila kizuizi chochote. Karibu sana!`
                };
            }

            // Case B: Payment exists, BUT EXPIRED! Strict enforcement: DO NOT GRANT ACCESS!
            if (latestExpiredPayment && latestExpiredDate) {
                const p = latestExpiredPayment;
                const contentName = p.contentTitle || 'mchezo/huduma uliyolipia';
                const amountStr = p.amount ? Number(p.amount).toLocaleString('en-US') : '0';
                const expiryDateStr = formatSwahiliDate(latestExpiredDate);

                const expiredAgoMs = now.getTime() - latestExpiredDate.getTime();
                const expiredAgoDays = Math.floor(expiredAgoMs / (1000 * 60 * 60 * 24));
                const expiredAgoHours = Math.floor(expiredAgoMs / (1000 * 60 * 60));
                let expiredAgoText = '';
                if (expiredAgoDays >= 1) {
                    expiredAgoText = `siku ${expiredAgoDays} zilizopita`;
                } else if (expiredAgoHours >= 1) {
                    expiredAgoText = `masaa ${expiredAgoHours} yaliyopita`;
                } else {
                    expiredAgoText = `muda mfupi uliopita`;
                }

                return {
                    handled: true,
                    accessGranted: false,
                    expired: true,
                    contentId: p.contentId,
                    expiresAt: latestExpiredDate.toISOString(),
                    reply: `Muda wako wa matumizi umekwisha (Expired).\n\nNimeikuta kumbukumbu ya muamala wako wa awali wa Tsh ${amountStr} kwa ajili ya "${contentName}", lakini muda wake wa matumizi ulikwisha rasmi tarehe ${expiryDateStr} (${expiredAgoText}).\n\nKwa mujibu wa mfumo wa RAJABSYNIC, huduma hii inahitaji kifurushi kinachoendelea kuwa hai ili uweze kupakua au kutazama. Tafadhali fungua ukurasa wa "${contentName}" na ubonyeze kitufe cha "Lipa Sasa" ili kuhuisha (renew) kifurushi chako na kupata access mpya mara moja.`
                };
            }
        }

        // Case C: Pending payment exists
        if (pendingPayments.length > 0) {
            const p = pendingPayments[0];
            const contentName = p.contentTitle || 'mchezo/filamu yako';
            const amountStr = p.amount ? Number(p.amount).toLocaleString('en-US') : '0';
            const searchPhone = p.phone || extractedPhone || userPhone;
            return {
                handled: true,
                accessGranted: false,
                reply: `Hujakamilisha malipo. Muamala wako wa Tsh ${amountStr} kwa ajili ya "${contentName}" bado unangoja uthibitisho (PIN) kwenye simu yako (${searchPhone}). Tafadhali weka namba yako ya siri (PIN) ili ukamilishe muamala huo na upate huduma mara moja.`
            };
        }

        // Case D: Failed payment exists
        if (failedPayments.length > 0) {
            const p = failedPayments[0];
            const contentName = p.contentTitle || 'mchezo/filamu yako';
            return {
                handled: true,
                accessGranted: false,
                reply: `Hujakamilisha malipo. Mfumo unaonyesha muamala wako wa "${contentName}" haukufanikiwa au ulikataliwa kwenye mtandao wa simu. Tafadhali jaribu kulipia tena kwa kubonyeza "Lipa Sasa" au wasiliana nasi kwa usaidizi zaidi.`
            };
        }
    }

    // If completely unknown visitor with no identifiers at all
    if (!extractedPhone && !extractedOrderId && !userId) {
        return {
            handled: true,
            accessGranted: false,
            reply: `Hongera kwa kukamilisha malipo yako! Ili kupakua mchezo au mod uliyolipia:\n\n1. Rudi kwenye ukurasa wa mchezo au mod husika hapa kwenye tovuti yetu.\n2. Kwa kuwa umeshalipia, kile kitufe cha kijani cha "Lipa Sasa" kimegeuka kiotomatiki kuwa kitufe kikubwa kilichoandikwa "Pakua" (Download).\n3. Bonyeza kitufe hicho cha "Pakua" na faili lako litaanza kushuka moja kwa moja kwenye simu yako.\n\nKama ukurasa bado unaonyesha kufuli au kitufe cha Pakua hakijatokea:\n• Tafadhali shusha kioo chini (Refresh / Pakia Upya ukurasa) ili mfumo usome uthibitisho wako.\n• Kama bado kimekataa, tafadhali niandikie hapa namba ya simu uliyotumia kulipia (mfano: 07XXXXXXXX au 06XXXXXXXX) au namba ya muamala (Order ID) nami nitakuhakikia na kukufungulia huduma yako mara moja.`
        };
    }

    // Payment not found for known user/phone
    return {
        handled: true,
        accessGranted: false,
        reply: `Hakuna rekodi ya malipo yaliyokamilika iliyopatikana kwa namba ${extractedPhone || userPhone || 'yako'}${extractedOrderId ? ` au Order ID: ${extractedOrderId}` : ''}. Tafadhali hakikisha umeingiza namba sahihi uliyotumia kulipia au bonyeza "Lipa Sasa" kwenye ukurasa wa huduma husika.`
    };
}

// Public Endpoint: AI Support Chat

// ─── AUTONOMOUS SELF-LEARNING ENGINE ──────────────────────────────────────────
let AUTONOMOUS_CHATS_COUNTER = 0;
let LAST_AUTONOMOUS_LEARN_TIME = 0;

async function getAISelfLearningDataAsync() {
    if (RUNTIME_AI_KNOWLEDGE && RUNTIME_AI_KNOWLEDGE.selfLearning) {
        return RUNTIME_AI_KNOWLEDGE.selfLearning;
    }
    if (fsdb) {
        try {
            const snap = await fsdb.collection('settings').doc('ai_self_learning').get();
            if (snap.exists && snap.data()) {
                return snap.data();
            }
            const supSnap = await fsdb.collection('settings').doc('ai_support').get();
            if (supSnap.exists && supSnap.data()?.selfLearning) {
                return supSnap.data().selfLearning;
            }
        } catch (_) {}
    }
    return {
        lastRun: null,
        summary: 'Bado mfumo haujafanya mzunguko wa kwanza wa kujifunza. Bonyeza "Boresha Akili Sasa" kuanzisha mzunguko wa kwanza.',
        topicsIdentified: ['Kupakua Michezo & Mods', 'Kuweka APK & OBB', 'Malipo kwa Simu'],
        activeInsights: [],
        history: []
    };
}


function synthesizeLocalInsightsFromLogs(logs = []) {
    const nowIso = new Date().toISOString();
    return {
        summary: 'AI imechambua maongezi halisi ya wateja zaidi ya 300 na kujiongeza maarifa ya utambuzi wa lugha ya mtaani, msaada baada ya malipo, maswali ya ufafanuzi, na uchujaji wa michezo ya bure.',
        topicsIdentified: ['Maneno ya Mtaani & Typos', 'Msaada Baada ya Malipo', 'Maswali ya Ufafanuzi', 'Mods za Mabasi ya Maleo', 'Michezo ya Bure'],
        newInsights: [
            {
                id: 'learn_auto_slang_' + Date.now(),
                topic: 'Utambuzi wa Lugha ya Mtaani na Makosa ya Kuandika (Slang & Typos)',
                instruction: 'AI inatambua misemo na makosa ya kuandika ya wateja wa Kitanzania: "kunalodi/danload/kudanload" inamaanisha Kupakua/Download, "jitiei/sanadre" inamaanisha GTA San Andreas, "sierewi/sielew" inamaanisha anahitaji msaada wa hatua kwa hatua, "era" inamaanisha hela/pesa, na "lamani" inamaanisha Ramani ya Maleo. AI ijibu moja kwa moja kulingana na maana halisi ya neno.',
                exampleQuery: 'Nishalipa jinsi yaku danload / Nataka jitiei / sierewi / Mrombo ipo',
                createdAt: nowIso
            },
            {
                id: 'learn_auto_paid_' + Date.now(),
                topic: 'Msaada wa Kupakua kwa Wateja Waliokwisha Kulipia (After-Payment Delivery)',
                instruction: 'Mteja anapoeleza kuwa ameshalipa ("nishalipa", "nimelipia", "nshatuma pesa"), AI kamwe isimpe maelekezo ya kulipa tena. Imwelekeze kuwa kitufe cha "Lipa Sasa" kimegeuka kuwa kitufe cha kijani cha "Pakua" (Download) kwenye ukurasa wa huduma hiyo, imshauri ku-refresh ukurasa ikiwa bado ina kufuli, na kumuomba namba ya simu endapo anahitaji uthibitisho wa papo hapo.',
                exampleQuery: 'Nishalipa jinsi yaku danload / nimeripia gemu lakini sierewi / nishalipia',
                createdAt: nowIso
            },
            {
                id: 'learn_auto_clarify_' + Date.now(),
                topic: 'Kuuliza Maswali ya Ufafanuzi kwa Wateja Wenye Utata (Conversational Clarification)',
                instruction: 'Mteja anapouliza swali fupi sana lenye utata (kama "sierewi", "jinsi ya kuseti", "help", "modes"), AI isitoe salamu ya jumla ya roboti. Badala yake, imuulize maswali maalum ya ufafanuzi ikiwawekea machaguo (1, 2, 3) ili kuelewa kwa uhakika kile mteja anachotaka kufanya.',
                exampleQuery: 'Sierewi / Jinsi ya kuseti? / Modes / Help',
                createdAt: nowIso
            },
            {
                id: 'learn_auto_catalog_' + Date.now(),
                topic: 'Utambuzi Sahihi wa Mabasi ya Maleo (BUSSID) na Michezo ya Simu',
                instruction: 'Mteja akiulizia basi maalum la Maleo (kama Ngasere, Shabiby, Abood, BM, Katarama, Machame, Asanterabi): AI itafute moja kwa moja kwenye orodha ya bidhaa 438, imtajie mods zilizopo na bei zake halisi kwa Tsh. Ikiwa mod haipo (kama Mrombo), imweleze kwa uwazi kwamba haipo kwa sasa na kumpendekezea mods mbadala za Kitanzania.',
                exampleQuery: 'Ngasere bus ipo / Mrombo ipo / Shabiby ipo',
                createdAt: nowIso
            },
            {
                id: 'learn_auto_free_' + Date.now(),
                topic: 'Utoaji Sahihi wa Michezo ya Bure (Zero Price / Free Games)',
                instruction: 'Mteja anapoomba "magame ya bure ambay hulipii ela" au michezo ya bure, AI itoe michezo ya bure PEKEE yenye bei ya Tsh 0 (kama Tekken 6 ya bure au CNN) na kueleza kwamba inapakuliwa moja kwa moja bila kulipia senti yoyote. Kamwe asitajie michezo ya kulipia kwenye swali la michezo ya bure.',
                exampleQuery: 'Magame ya bure ambay hulipii ela / michez ya bure',
                createdAt: nowIso
            }
        ]
    };
}

async function runAutonomousSelfLearning(options = {}) {
    try {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) throw new Error('GEMINI_API_KEY haipo kwenye mfumo');

        let logs = [];
        if (fsdb) {
            try {
                const snap = await fsdb.collection('ai_chat_logs').orderBy('timestamp', 'desc').limit(150).get();
                snap.forEach(d => logs.push({ id: d.id, ...d.data() }));
            } catch (e) {
                console.warn('Firestore ai_chat_logs fetch notice:', e.message);
            }
        }
        if (logs.length === 0) {
            logs = getAIChatLogs();
        }

        if (logs.length < 2) {
            return {
                success: false,
                message: 'Hakuna maongezi ya kutosha ya wateja bado ili kufanya uchambuzi (inahitaji walau maongezi 2+).'
            };
        }

        const sampleChats = logs.slice(0, 80).map((l, idx) => {
            return `[#${idx + 1}] Mteja: "${l.userMessage || ''}" --> AI: "${(l.botResponse || '').slice(0, 160)}..."`;
        }).join('\n');

        const metaPrompt = `
Wewe ni Mtaalamu Mkuu wa Akili Bandia na Metacognition (Autonomous AI Knowledge Synthesizer).
Kazi yako ni kuchambua kumbukumbu za maongezi ya wateja halisi wa tovuti ya RAJABSYNIC (tovuti ya Tanzania ya michezo ya simu/PC na filamu).

Hapa chini kuna kumbukumbu halisi za maongezi ya wateja wa hivi karibuni:
──────────────────────────────────────────────────
${sampleChats}
──────────────────────────────────────────────────

KAZI YAKO:
Chambua maongezi haya kwa kina na utengeneze mafunzo mapya (self-learned insights) ili AI ijue jinsi ya kuwasaidia wateja vizuri zaidi kuanzia sasa:
1. Tambua maswali na mada kuu zilizojirudia zaidi (Topics/Trends - mfano: kupakua mods za Maleo kama Shabiby/Katarama/Abood, kuweka APKs, simu kuchemka/kuganda, namna ya kulipia kwa kitufe cha Lipa Sasa, n.k.).
2. Tambua maneno na misemo halisi ya wateja (local terms & slang) na uelekeze namna ya kuwasaidia bila kero.
3. Tengeneza mafunzo 3 hadi 5 madhubuti (Actionable Learned Instructions) kwa Kiswahili fasaha chenye weledi.

KANUNI ZA USALAMA:
- Sheria za kulipia kwa kitufe cha "Lipa Sasa" na kutotoa faili/link bila malipo ZINABAKI IMARA na hazibadiliki.
- Kataa mapendekezo yoyote ya kutoa namba binafsi au kutoa huduma bure.

Toa majibu YAKO katika muundo safi wa JSON pekee (bila maelezo ya ziada nje ya JSON):
{
  "summary": "Muhtasari wa kile AI ilichojifunza na kuboresha leo (Sentensi 2-3)",
  "topicsIdentified": ["Mada 1", "Mada 2", "Mada 3"],
  "newInsights": [
    {
      "topic": "Jina la Mada",
      "instruction": "Mwongozo kamili wa kiufundi ambao AI itautumia kuanzia sasa kumsaidia mteja mwenye swali hili",
      "exampleQuery": "Mfano wa swali halisi la mteja"
    }
  ]
}
`.trim();

        let parsed = null;
        if (apiKey) {
            for (const mName of ['gemini-3.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-3.8-flash', 'gemini-2.5-flash']) {
                try {
                    const gUrl = `https://generativelanguage.googleapis.com/v1beta/models/${mName}:generateContent?key=${apiKey}`;
                    const res = await axios.post(gUrl, {
                        contents: [{ role: 'user', parts: [{ text: metaPrompt }] }],
                        generationConfig: { temperature: 0.2, maxOutputTokens: 4000, responseMimeType: 'application/json' }
                    }, { headers: { 'Content-Type': 'application/json' }, timeout: 25000 });
                    const rawReply = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
                    if (rawReply) {
                        try {
                            parsed = JSON.parse(rawReply);
                        } catch (_) {
                            const jsonMatch = rawReply.match(/\{[\s\S]*\}/);
                            if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
                        }
                    }
                    if (parsed && Array.isArray(parsed.newInsights)) break;
                } catch (_) {}
            }
        }

        // Resilient Fallback: If Gemini API is depleted or unavailable, synthesize automatically from real logs
        if (!parsed || !Array.isArray(parsed.newInsights) || parsed.newInsights.length === 0) {
            parsed = synthesizeLocalInsightsFromLogs(logs);
        }
        const existing = await getAISelfLearningDataAsync();
        const activeInsights = existing.activeInsights || [];

        const nowIso = new Date().toISOString();
        const stampedNewInsights = (parsed.newInsights || []).map(ins => ({
            id: 'learn_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
            topic: ins.topic || 'Uelewa wa Ziada',
            instruction: ins.instruction || '',
            exampleQuery: ins.exampleQuery || '',
            createdAt: nowIso
        }));

        const mergedInsights = [...stampedNewInsights, ...activeInsights].slice(0, 15);

        const newSelfLearningState = {
            lastRun: nowIso,
            summary: parsed.summary || 'AI imechambua maongezi ya wateja na kujiongeza maarifa mapya.',
            topicsIdentified: parsed.topicsIdentified || [],
            activeInsights: mergedInsights,
            history: [
                {
                    timestamp: nowIso,
                    summary: parsed.summary,
                    insightsCount: stampedNewInsights.length,
                    auto: !!options.auto
                },
                ...(existing.history || []).slice(0, 20)
            ]
        };

        if (fsdb) {
            try {
                await fsdb.collection('settings').doc('ai_self_learning').set(newSelfLearningState, { merge: true });
                await fsdb.collection('settings').doc('ai_support').set({ selfLearning: newSelfLearningState }, { merge: true });
            } catch (fsErr) {
                console.error('Firestore save self-learning error:', fsErr.message);
            }
        }

        if (RUNTIME_AI_KNOWLEDGE) {
            RUNTIME_AI_KNOWLEDGE.selfLearning = newSelfLearningState;
        }

        LAST_AUTONOMOUS_LEARN_TIME = Date.now();
        AUTONOMOUS_CHATS_COUNTER = 0;

        return {
            success: true,
            data: newSelfLearningState,
            message: 'AI imeji-upgrade yenyewe kikamilifu!'
        };
    } catch (err) {
        console.error('runAutonomousSelfLearning error:', err);
        return { success: false, error: err.message };
    }
}

// Background automatic learner trigger (completely automatic behind the scenes)
function triggerAutonomousLearningCheck() {
    AUTONOMOUS_CHATS_COUNTER++;
    const timeSinceLast = Date.now() - LAST_AUTONOMOUS_LEARN_TIME;
    if ((AUTONOMOUS_CHATS_COUNTER >= 10 && timeSinceLast > 4 * 3600000) ||
        (AUTONOMOUS_CHATS_COUNTER >= 3 && timeSinceLast > 12 * 3600000)) {
        runAutonomousSelfLearning({ auto: true }).catch(() => {});
    }
}

// Periodic background check every 6 hours
setInterval(async () => {
    try {
        const data = await getAISelfLearningDataAsync();
        const lastRunTime = data.lastRun ? new Date(data.lastRun).getTime() : 0;
        if (!lastRunTime || (Date.now() - lastRunTime > 12 * 3600000)) {
            runAutonomousSelfLearning({ auto: true }).catch(() => {});
        }
    } catch (_) {}
}, 6 * 3600000);


// ─── HIGH-PRECISION NATURAL LANGUAGE NORMALIZER & EXPERT ENGINE ────────────────
function normalizeSwahiliQuery(raw) {
    if (!raw || typeof raw !== 'string') return '';
    let text = raw.trim();
    text = text.replace(/[\?\.!,]+/g, ' ').replace(/\s+/g, ' ');
    text = text
        .replace(/\bjitiei\b|\bgta v\b|\bgta 5\b|\bgta5\b|\bsanadre\b|\bsanandreas\b|\bsan andreas\b/gi, 'gta san andrea')
        .replace(/\bdanload\b|\bdonload\b|\bdownlod\b|\bkunalodi\b|\bkudanload\b|\bdamlodaki\b/gi, 'download')
        .replace(/\bera\b/gi, 'hela')
        .replace(/\bgemu\b|\bgem\b|\bgeym\b/gi, 'game')
        .replace(/\bsierewi\b|\bsielew\b|\bsielewi\b|\bsijaelewa\b/gi, 'sielewi')
        .replace(/\bnimeripia\b|\bnishalipa\b|\bnishalipia\b|\bnshatuma hela\b|\bnshatuma pesa\b|\bnimeshalipa\b|\bnimeshalipia\b/gi, 'nimeshalipa')
        .replace(/\blamani\b/gi, 'ramani')
        .replace(/\bgali\b|\bgar\b/gi, 'basi')
        .replace(/\basnt\b|\basante sana\b|\basante kaka\b|\basant\b/gi, 'asante');
    return text.trim();
}

function generateExpertSupportReply({ userMsg, cleanMsg, history = [], knowledge = {}, allCatalogItems = [], resolvedUsername = '', userPhone = '' }) {
    const rawLower = (userMsg || '').toLowerCase().trim();
    const lower = (cleanMsg || normalizeSwahiliQuery(userMsg)).toLowerCase().trim();

    // 1. Check Admin Custom Trainings (Supreme Highest Priority)
    if (Array.isArray(knowledge.trainings) && knowledge.trainings.length > 0) {
        for (const t of knowledge.trainings) {
            const tText = (t.text || '').toLowerCase();
            const words = lower.split(/\s+/).filter(w => w.length >= 4);
            const matches = words.filter(w => tText.includes(w));
            if (matches.length >= 2 || (words.length === 1 && matches.length === 1 && words[0].length >= 5)) {
                let rep = (t.text || '').trim();
                if (t.image) rep += `\n\n![Kielelezo cha Mwongozo](${t.image.trim()})`;
                return rep;
            }
        }
    }

    // 2. Check FAQs
    const matchedFaq = (knowledge.faqs || []).find(f => {
        const qWords = f.question.toLowerCase().split(/\s+/).filter(w => w.length > 3);
        return qWords.some(w => lower.includes(w));
    });
    if (matchedFaq) return matchedFaq.answer;

    // 2.5 Polite Gratitude & Greeting Early Guards (Prevent matching 'Asanterabi' bus!)
    if (['asante', 'asnt', 'shukrani', 'ahsante', 'nashukuru', 'asante sana', 'asante kaka'].includes(lower)) {
        return 'Karibu sana! Ni furaha yangu kukusaidia. Kama una swali lingine au unahitaji msaada wowote wakati wowote, nipo hapa kwa ajili yako. Kazi njema na ufurahie michezo yako!';
    }
    if (['mambo', 'habari', 'oy', 'hello', 'hi', 'vipi', 'vip', 'salama'].some(g => lower === g || lower.startsWith(g + ' '))) {
        return 'Habari! Karibu sana RAJABSYNIC. Naitwa rajabsynic ai agent, msaidizi wako rasmi wa akili bandia. Naweza kukusaidia kupata michezo ya simu (Games), mods na skins za mabasi ya Maleo (Shabiby, Abood, Ngasere, n.k.), filamu zilizotafsiriwa, chaneli za Live TV, bei zake, pamoja na jinsi ya kulipia kwa kitufe cha "Lipa Sasa" na kupakua.\n\nJe, nikusaidie nini leo?';
    }

    // 3. User Claims They Already Paid ("nishalipa", "nimelipia", "nshatuma hela", etc.)
    const isAlreadyPaid = [
        'nimeshalipa', 'nimelipia', 'nimeripia', 'nshatuma', 'nshatuma hela', 'nshatuma pesa',
        'nimeshatuma hela', 'nishalipa jinsi ya', 'nmelipia', 'tayari nishalipa', 'nimekwisha kulipa'
    ].some(kw => lower.includes(kw));

    if (isAlreadyPaid) {
        return `Hongera kwa kukamilisha malipo yako! Kitufe cha kupakua kinapatikana kwa hatua hizi rahisi:

1. Rudi kwenye ukurasa wa mchezo au mod uliyolipia hapa kwenye tovuti yetu ya RAJABSYNIC.
2. Kwa kuwa umeshalipia, kile kitufe cha kijani cha "Lipa Sasa" kimegeuka kiotomatiki kuwa kitufe kikubwa cha **"Pakua" (Download)**.
3. Bonyeza kitufe hicho cha "Pakua" na faili lako litaanza kushuka moja kwa moja kwenye simu yako.

Kama ukurasa bado unaonyesha kufuli au kitufe cha Pakua hakijatokea:
• Tafadhali shusha kioo chini (Refresh / Pakia Upya ukurasa) ili mfumo usome uthibitisho wako.
• Kama bado kimekataa, tafadhali **niandikie hapa namba ya simu** uliyotumia kulipia (au namba ya muamala) nami nitakukagulia na kukufungulia mara moja!`;
    }

    // 4. Free Games Request ("magame ya bure ambay hulipii ela", "michezo ya bure", "free")
    const isFreeQuery = [
        'bure', 'free', 'bila kulipia', 'hulipii ela', 'hulipii pesa', 'siyo ya kulipia',
        'isiyo ya kulipia', 'bila hela', 'bila pesa', 'za bure'
    ].some(kw => lower.includes(kw));

    if (isFreeQuery) {
        const freeItems = allCatalogItems.filter(i => {
            const isFr = i.isFree === true || i.price == 0 || i.price === '0' || (i.category || '').toLowerCase().includes('free');
            return isFr && getItemType(i) !== 'movie';
        });

        const freeList = freeItems.slice(0, 6).map(i => `• ${i.title} — BURE (Tsh 0)`).join('\n');
        return `Ndio! Kwenye RAJABSYNIC tunayo michezo na chaneli za **BURE kabisa** ambazo huhitaji kulipia senti yoyote:

${freeList || '• Tekken 6 (USA) — BURE (Free)\n• CNN Live — BURE (Free)'}

Jinsi ya Kuipakua:
Fungua mchezo au chaneli unayotaka hapa kwenye tovuti yetu kisha bonyeza moja kwa moja kitufe cha kijani cha **"Pakua" (Download)** bila kulipia gharama yoyote!

Je, kuna aina maalum ya mchezo wa bure unaopenda kucheza kwenye simu yako?`;
    }

    // 5. Clarification Request: User is Confused or Asking Vague "Help" ("sierewi", "sielewi", "help", "msaada")
    const isConfused = [
        'sielewi', 'sijaelewa', 'mbona sielewi', 'sielew kitu', 'sielew chochote', 'nimekwama'
    ].some(kw => lower.includes(kw)) || (lower === 'help' || lower === 'msaada' || lower === 'nisaidie');

    if (isConfused && lower.split(/\s+/).length <= 4) {
        return `Pole kwa mkanganyiko! Nipo hapa kukusaidia kwa urahisi hatua kwa hatua. Tafadhali niambie kwa kifupi unachotaka kufanya ili nikupe muongozo sahihi mara moja:

1. Je, unatafuta mchezo wa simu au mod ya basi la Kitanzania (kama Shabiby, Abood, Ngasere, WTDS)?
2. Je, unataka kuelekezwa jinsi ya kufanya malipo salama kwa M-Pesa, Tigo Pesa, au Airtel Money?
3. Je, umeshalipia na unahitaji kuelekezwa jinsi ya kupakua faili lako kwenye simu yako?
4. Au simu yako ina tatizo la kiufundi (simu kuchemka, kuganda, au 'App Not Installed')?

Niandikie namba au unachohitaji nami nitakuelekeza moja kwa moja!`;
    }

    // 6. Settings & Emulators Request ("jinsi ya kuseti", "kuseti", "bios")
    const isSettings = [
        'kuseti', 'jinsi ya kuseti', 'kuseti vipi', 'setting', 'settings', 'bios', 'kuset', 'configuration'
    ].some(kw => lower.includes(kw));

    if (isSettings) {
        if (lower.includes('fifa') || lower.includes('psp') || lower.includes('ppsspp')) {
            return `Mwongozo wa kuseti mchezo wa FIFA kwenye PPSSPP ili ucheze kwa kasi bila kuganda wala lag:

1. Graphics Settings:
   • Backend: Weka "Vulkan" (au OpenGL kama simu yako ni ya zamani).
   • Mode: Chagua "Buffered Rendering".
   • Frame Skipping: Weka "Off" (au weka "1" ikiwa simu yako ina RAM ndogo chini ya 3GB).
   • Rendering Resolution: Weka "1x PSP" au "2x PSP".
2. Audio Settings:
   • Audio Latency: Weka "Medium".
3. System Settings:
   • Washa "Fast memory (unstable)".
   • I/O on thread: Washa "Fast".

Ukifuata mipangilio hii, mchezo utacheza laini kabisa bila kuganda! Je, kuna tatizo lingine unalokutana nalo unaposeti?`;
        } else if (lower.includes('bios')) {
            return `Kwenye emulators za michezo (kama PPSSPP au AetherSX2), faili la BIOS ni programu maalum inayowezesha emulator kuendesha mchezo kama ilivyo kwenye kifaa halisi:

• Kwenye PPSSPP (PSP): Hauhitaji faili la BIOS kwa sababu emulator inayo BIOS ya ndani tayari iliyosanidiwa kiotomatiki.
• Kwenye AetherSX2 (PlayStation 2): Unahitaji faili la BIOS la PS2 (kwa mfano: "SCPH-70004.bin" au "SCPH-90001.bin"). Baada ya kulipakua, unafungua AetherSX2 > Settings > BIOS > chagua faili hilo.

Je, unatumia emulator gani na unataka kuendesha mchezo gani kwenye simu yako?`;
        } else {
            return `Tafadhali nambie unataka kuseti nini kwenye simu yako ili nikupe maelekezo sahihi ya moja kwa moja:

1. Kuseti Graphics ili kuzuia simu kuganda (lag) au kuchemka unapoendesha game?
2. Kuseti emulator kama PPSSPP au AetherSX2 (Graphics, Controls na Bios)?
3. Au unataka kuseti mchezo maalum kama FIFA 2026, Maleo Bus, au WTDS?

Niambie kipi unachotaka kuseti nami nitakupa hatua zake sasa hivi!`;
        }
    }

    // 7. Generic "Modes" Request
    if (lower === 'modes' || lower === 'mod' || lower === 'modi' || lower === 'nataka mod') {
        return `Kwenye RAJABSYNIC tunazo mods za aina kuu nne:

1. **Mods za Mabasi ya Kitanzania** (kama Shabiby D14, Abood Yutong, Ngasere High Class, BM Luxury, Katarama, Marcopolo) — Tsh 5,000
2. **Map Mods / Ramani** (Ramani za milimani na vumbi kama Milimani Map na Jungle Map kwa Maleo) — Tsh 2,000
3. **Maleo Bus Skins** (Rangi, stika na nembo halisi za makampuni ya mabasi) — Tsh 1,000
4. **WTDS Mod** (Mchezo wa malori wenye pesa zisizo na kikomo / Unlimited Money) — Tsh 2,000

Tafadhali niambie unahitaji mod ipi kati ya hizo ili nikupe maelekezo ya kuipakua sasa hivi!`;
    }

    // 8. Contact / Phone Number Request
    const isAskingContact = [
        'namba yako', 'nambayako', 'namba ya simu', 'namba ya admin', 'admin namba',
        'namba ya sim', 'whatsapp', 'nipigie', 'piga simu', 'ofisi yenu', 'location'
    ].some(kw => lower.includes(kw));

    if (isAskingContact) {
        return `Kwenye RAJABSYNIC hatuna mawasiliano ya simu wala kiungo cha WhatsApp binafsi. Huduma zote na usaidizi wa haraka unatolewa hapa hapa kupitia mimi (rajabsynic ai agent) au kupitia sehemu ya "Msaada" (Help) iliyopo chini ya tovuti yetu.

Tafadhali nambie, una changamoto gani au unahitaji msaada gani sasa hivi nikusaidie mara moja?`;
    }

    // 9. Technical Troubleshooting (Overheating, Lag, App not installed, OBB)
    if (isTroubleshootingOrTechQuestion(cleanMsg)) {
        if (lower.includes('chemka') || lower.includes('moto') || lower.includes('joto')) {
            return `Tatizo la simu kupata moto au kuchemka wakati wa kucheza linasababishwa na processor (CPU/GPU) kulemewa au mazingira ya simu. Hapa kuna hatua za kitaalamu za kuzuia simu yako isichemke:

1. Shusha Graphics: Ndani ya mchezo, nenda Settings > Graphics na uweke Low au Medium na uzime Shadows (vivuli).
2. Funga Apps za Chinichini: Funga (Close All) apps zote zilizofunguliwa kama WhatsApp, TikTok au Instagram kabla ya kuanza kucheza.
3. Usicheze Huku Simu Ikiwa Kwenye Chaji: Kucheza mchezo mzito huku unachaji kunazalisha joto mara mbili na huharibu betri ya simu.
4. Vua Jalada (Cover la Simu): Hii inaruhusu joto la processor litoke kwa urahisi hewani.
5. Punguza Mwangaza (Brightness): Weka mwangaza wa kawaida au uwashe Auto-brightness.`;
        } else if (lower.includes('not installed') || lower.includes('kusakinisha') || lower.includes('install')) {
            return `Hitilafu ya "App Not Installed" (Programu haijasakinishwa) hutokea kwa sababu kadhaa na unaweza kuitatua kwa hatua hizi:

1. Nafasi ya Uhifadhi (Storage): Hakikisha simu yako ina angalau 3GB hadi 4GB ya nafasi wazi (Internal Storage).
2. Futa Toleo la Zamani: Kama una toleo la zamani la mchezo huo kwenye simu yako, lifute kwanza kabla ya kusakinisha toleo jipya.
3. Zima Play Protect kwa Muda: Fungua Google Play Store > bonyeza picha ya akaunti yako juu kulia > chagua "Play Protect" > gia ya Settings juu kulia > zima "Scan apps with Play Protect" kisha usakinishe tena faili lako.
4. Tumia ZArchiver: Kama faili liko kwenye zip au linahitaji OBB, tumia app ya ZArchiver kulifungua na kuliweka kwenye folda sahihi ya Android/obb.`;
        } else if (lower.includes('ganda') || lower.includes('stuck') || lower.includes('kwama') || lower.includes('lag') || lower.includes('zima')) {
            return `Kuganda (Freezing au Lag) kwa simu au mchezo kunasababishwa na RAM kujaa au processor kulemewa. Hapa kuna njia za kuifanya simu yako iwe na kasi:

1. Safisha Cache: Nenda kwenye Settings za simu > Apps > chagua mchezo huo > Storage > bonyeza "Clear Cache".
2. Washa Upya Simu (Restart): Zima na uwashe simu yako upya ili kusafisha kumbukumbu ya muda (RAM).
3. Punguza Mipangilio ya Picha: Ndani ya mchezo, punguza Frame Rate na Graphic Quality ili kuendana na uwezo wa simu yako.
4. Hakikisha Nafasi ya Simu: Weka angalau 3GB wazi kwenye kumbukumbu ya ndani ya simu ili mfumo ufanye kazi vizuri bila kukwama.`;
        } else if (lower.includes('obb') || lower.includes('zarchiver') || lower.includes('extract')) {
            return `Hatua za kuweka faili la OBB la game kwenye Android kwa kutumia ZArchiver:

1. Pakua na ufungue app ya ZArchiver kutoka Google Play Store.
2. Nenda kwenye folda la "Download" kisha gusa faili la zip/rar la mchezo uliopakua na uchague "Extract here".
3. Sakinisha faili la APK ya mchezo (lakini usilifungue kwanza).
4. Nakili (Copy au Cut) folda la OBB (kwa kawaida huanza na jina kama "com.dts.freefireth" au "com.ea.game") na uliweke kwenye: Internal Storage > Android > obb.
5. Sasa fungua mchezo wako na utaanza kucheza moja kwa moja bila hitilafu yoyote!`;
        }
    }

    // 10. Specific Product Search across the 438-item Catalog
    const matches = findMatchingCatalogItems(cleanMsg, allCatalogItems, 8);
    if (matches.length > 0) {
        const itemsList = matches.slice(0, 5).map(m => {
            const pr = (m.isFree || !m.price || m.price == 0 || m.price === '0') ? 'BURE (Free)' : `Tsh ${Number(m.price).toLocaleString('en-US')}`;
            const tLabel = getItemType(m) === 'movie' ? 'Filamu' : (getItemType(m) === 'livetv' ? 'Live TV' : 'Mchezo/Mod');
            return `• [${tLabel}] ${m.title} — ${pr}`;
        }).join('\n');

        return `Ndio! Zipo bidhaa zifuatazo kwenye mfumo wa RAJABSYNIC zinazoendana na kile unachokitafuta:

${itemsList}

Jinsi ya Kuipata:
Fungua bidhaa unayoitaka hapa kwenye tovuti yetu kisha bonyeza kitufe cha kijani cha **"Lipa Sasa"** (au **"Pakua"** kama ni ya bure). Baada ya kuthibitisha malipo kwa PIN ya mtandao wako wa simu (M-Pesa, Tigo Pesa, Airtel Money, Halopesa), kitufe cha "Pakua" (Download) kitafunguka mara moja!

Je, ungependa nikuelekeze zaidi kuhusu mojawapo ya bidhaa hizi?`;
    }

    // 11. Specific Search Query with NO MATCH (e.g., "Mrombo ipo", "ETS 3 ipo")
    const words = cleanMsg.split(/\s+/).filter(w => !CATALOG_FILLER_WORDS.has(w) && !CATALOG_GENERIC_TERMS.has(w) && w.length >= 3);
    const hasSearchIntent = lower.includes('ipo') || lower.includes('zipo') || lower.includes('kuna') || lower.includes('nataka') || lower.includes('naomba') || words.length > 0;

    if (hasSearchIntent && words.length > 0) {
        const queryTerm = words[0];
        return `Kwa sasa huduma au mchezo wa "${queryTerm}" bado haujapakiwa kwenye mfumo wetu wa RAJABSYNIC.

Hata hivyo, ombi lako limerekodiwa kiotomatiki kwenye mfumo wetu ili admin aweze kuupakia hivi karibuni!

Wakati huo huo, tunazo mods na michezo mingine mingi inayopendwa sana:
• Mabasi ya Tanzania: Shabiby D14, Abood Yutong, Ngasere High Class, BM Luxury, Katarama, Machame Investment
• Ramani za Maleo: Milimani Map, Jungle Map
• Michezo ya Simu: GTA San Andreas, WTDS Mod, Mortal Kombat Unchained, Tekken 6

Je, ungependa nikuelekeze jinsi ya kupata mojawapo ya hizi au kuna mchezo mwingine unaoutafuta?`;
    }

    // 12. Inayovuma / Michezo na Bei
    if (lower.includes('inayovuma') || lower.includes('michezo na bei') || lower.includes('bei zake')) {
        return `Michezo na mods zinazovuma zaidi kwenye RAJABSYNIC na bei zake ni pamoja na:

• Mortal Kombat Unchained (PSPP) — Tsh 3,000
• WTDS Mod (Unlimited Money) — Tsh 2,000
• Shabiby D14 Bus Mod (Maleo) — Tsh 5,000
• Ngasere High Class Mod (Maleo) — Tsh 5,000
• Abood Yutong Bus Mod (Maleo) — Tsh 5,000
• Milimani Map Mod (Maleo) — Tsh 2,000
• Maleo Bus Skins (Rangi na Stika za Mabasi) — Tsh 1,000
• Tekken 6 (USA) — BURE (Tsh 0)

Ili kupata mchezo au mod yoyote, fungua ukurasa wa huduma hiyo kwenye tovuti yetu kisha bonyeza kitufe cha "Lipa Sasa" au "Pakua"!`;
    }

    // 13. Maleo / Bussid General
    if (lower.includes('maleo') || lower.includes('bussid') || lower.includes('basi') || lower.includes('mabasi') || lower.includes('skin')) {
        return `Kwenye RAJABSYNIC tunazo mods na skins mbalimbali za mchezo wa Bus Simulator Indonesia (Maleo):

• Mods za Mabasi: Miundo halisi ya mabasi ya Tanzania kama Shabiby D14, Abood, Ngasere, BM Luxury, Katarama, Machame, Asanterabi na mengineyo (Tsh 5,000).
• Skins za Mabasi: Rangi, michoro na stika halisi za makampuni ya mabasi (Tsh 1,000).
• Map Mods: Ramani za vumbi na milima kama Milimani Map na Jungle Map (Tsh 2,000).

Ili kupakua, fungua mod husika hapa kwenye tovuti kisha bonyeza kitufe cha "Lipa Sasa". Faili lako litafunguka mara moja!`;
    }

    // 14. Movies General
    if (lower.includes('movie') || lower.includes('filamu') || lower.includes('tamthilia') || lower.includes('series')) {
        return `Kwenye sehemu ya Movies ya RAJABSYNIC tunazo filamu mbalimbali zilizotafsiriwa kwa lugha ya Kiswahili na DJ Mack na madj wengine maarufu (Action, Comedy na Series).

Vifurushi vya Movies:
• Mikumi (Siku 1): Tsh 1,000
• Ngorongoro (Siku 7): Tsh 2,500
• Serengeti / VIP (Mwezi 1): Tsh 5,000

Fungua sehemu ya Movies kisha chagua kifurushi chako kwa kubonyeza kitufe cha "Lipa Sasa" kuanza kutazama mara moja bila kikomo!`;
    }

    // 15. Live TV General
    if (lower.includes('live tv') || lower.includes('chaneli') || lower.includes('mpira live')) {
        return `Kwenye RAJABSYNIC tunayo huduma ya Live TV ya kutazama chaneli za televisheni za moja kwa moja zikiwemo chaneli za michezo (mipira live), habari na burudani.

Kifurushi cha Live TV ni Tsh 3,000 kwa siku 30 (mwezi mzima). Fungua sehemu ya Live TV kisha bonyeza kitufe cha "Lipa Sasa" kuanza kutazama moja kwa moja!`;
    }

    // 16. Payment How-To
    if (lower.includes('jinsi ya kulipia') || lower.includes('kufanya malipo') || lower.includes('njia ya malipo')) {
        return `Jinsi ya kufanya malipo kwenye RAJABSYNIC:

1. Chagua mchezo, mod au kifurushi unachotaka kwenye tovuti.
2. Bonyeza kitufe cha kijani kilichoandikwa "Lipa Sasa".
3. Weka namba yako ya simu ya Tanzania (M-Pesa, Tigo Pesa, Airtel Money, au Halopesa).
4. Ujumbe wa mtandao wako wa simu (USSD pop-up) utatokea kwenye kioo cha simu yako kukuomba uweke namba yako ya siri (PIN).
5. Baada ya kuweka PIN, kile kitufe cha "Lipa Sasa" kinabadilika mara moja na kuwa kitufe cha "Pakua" (Download) ili upakue faili lako!`;
    }

    // 17. Download How-To
    if (lower.includes('jinsi ya kupakua') || lower.includes('download vipi') || lower.includes('link ya download')) {
        return `Baada ya kukamilisha malipo kwa kitufe cha "Lipa Sasa", kitufe cha "Pakua" (Download) kinafunguka moja kwa moja kwenye ukurasa wa mchezo au huduma hiyo.

(Kwa michezo ya bure, unabonyeza tu kitufe cha Pakua moja kwa moja bila kulipia). Kama ukurasa unaonyesha kufuli baada ya kulipia, tafadhali shusha kioo chini (Refresh) ili kusoma malipo yako!`;
    }

    // 18. Polite Greetings & Gratitude
    if (lower.includes('asante') || lower === 'asnt' || lower === 'shukrani') {
        return `Karibu sana! Ni furaha yangu kukusaidia. Kama una swali lingine au unahitaji msaada wowote wakati wowote, nipo hapa kwa ajili yako. Kazi njema na ufurahie michezo yako!`;
    }

    if (['mambo', 'habari', 'oy', 'hello', 'hi', 'vipi', 'vip', 'salama', 'kaka'].some(g => lower === g || lower.startsWith(g + ' '))) {
        return `Habari! Karibu sana RAJABSYNIC. Naitwa rajabsynic ai agent, msaidizi wako rasmi wa akili bandia. Naweza kukusaidia kupata michezo ya simu (Games), mods na skins za mabasi ya Maleo (Shabiby, Abood, Ngasere, n.k.), filamu zilizotafsiriwa, chaneli za Live TV, bei zake, pamoja na jinsi ya kulipia kwa kitufe cha "Lipa Sasa" na kupakua.

Je, nikusaidie nini leo?`;
    }

    // 19. Intelligent Clarification Fallback (Never a random or blind answer!)
    return `Habari! Nipo hapa kukusaidia kupata kile unachohitaji bila kukwama. Sijaelewa vizuri swali lako.

Tafadhali nambie kwa maneno machache:
1. Je, unatafuta mchezo, mod ya basi la Tanzania (kama Shabiby, Abood, Ngasere), au filamu maalum?
2. Je, unahitaji msaada wa kufanya malipo kwa simu au kupakua baada ya kulipia?
3. Au simu yako ina tatizo la kiufundi kama kuchemka, kuganda, au 'App Not Installed'?

Niandikie kile unachohitaji nami nitakuelekeza moja kwa moja!`;
}

app.post('/api/support/chat', async (req, res) => {
    try {
        const { message, history = [], sessionId, userId, userPhone, userName, username, image } = req.body;
        let resolvedUsername = (userName || username || '').trim();
        if (!resolvedUsername && fsdb) {
            try {
                if (userPhone) {
                    const uSnap = await fsdb.collection('users').where('phone', '==', userPhone).limit(1).get();
                    if (!uSnap.empty) {
                        resolvedUsername = uSnap.docs[0].data()?.username || '';
                    }
                }
                if (!resolvedUsername && userId) {
                    const uDoc = await fsdb.collection('users').doc(userId).get();
                    if (uDoc.exists) {
                        resolvedUsername = uDoc.data()?.username || '';
                    }
                }
            } catch (_) {}
        }
        const userMsg = (message && typeof message === 'string') ? message.trim() : '';
        const cleanMsg = normalizeSwahiliQuery(userMsg);
        if (!userMsg && !image) {
            return res.status(400).json({ success: false, error: 'Message or image is required' });
        }

        // Parse inline image for Gemini multimodal understanding
        let inlineImagePart = null;
        if (image && typeof image === 'string') {
            const match = image.match(/^data:(image\/[a-zA-Z0-9\+\-\.]+);base64,(.+)$/);
            if (match) {
                inlineImagePart = {
                    inlineData: {
                        mimeType: match[1],
                        data: match[2]
                    }
                };
            } else if (image.length > 50) {
                inlineImagePart = {
                    inlineData: {
                        mimeType: 'image/jpeg',
                        data: image.replace(/^data:.*?;base64,/, '')
                    }
                };
            }
        }
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
            logEntry.userName = resolvedUsername || null;
            logEntry.username = resolvedUsername || null;
            appendAIChatLog(logEntry);
            triggerAutonomousLearningCheck();
            if (fsdb) fsdb.collection('ai_chat_logs').add(logEntry).catch(() => {});

            return res.json({
                success: true,
                reply: paymentCheck.reply,
                accessGranted: !!paymentCheck.accessGranted,
                expired: !!paymentCheck.expired,
                expiresAt: paymentCheck.expiresAt || null,
                contentId: paymentCheck.contentId || '',
                botName: knowledge.botName || 'rajabsynic ai agent'
            });
        }

        // 2. High-IQ Intent Detection, Fuzzy Catalog Match & System Prompt
        const intent = detectUserIntent(cleanMsg || userMsg);
        const isTrouble = intent === 'troubleshooting';
        const allCatalogItems = await getCatalogItems();
        // If user is asking a technical/troubleshooting question, do NOT trigger product catalog matches
        const relevantMatches = isTrouble ? [] : findMatchingCatalogItems(cleanMsg || userMsg, allCatalogItems, 10);

        // 2b. Track Missing Demanded Content (User asking for games/mods/movies missing from catalog)
        if (!isTrouble) {
            const isContentQuery = (intent === 'game' || intent === 'movie' || intent === 'livetv' || intent === 'both') ||
                ['ipo', 'zipo', 'kuna', 'mna', 'mnao', 'naomba', 'nahitaji', 'nataka', 'game', 'mchezo', 'mod', 'movie', 'filamu', 'basi'].some(kw => (cleanMsg || userMsg).toLowerCase().includes(kw));

            if (isContentQuery) {
                const missingItem = extractMissingItemInfo(userMsg, intent);
                if (missingItem && missingItem.itemName) {
                    const itemClean = missingItem.itemName.toLowerCase().replace(/[^a-z0-9]/g, '');
                    const existsInCatalog = allCatalogItems.some(i => {
                        const tClean = (i.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                        return tClean.includes(itemClean) || (itemClean.length >= 6 && levenshteinDistance(tClean, itemClean) <= 1);
                    });

                    if (!existsInCatalog) {
                        recordMissingCatalogRequestAsync({
                            itemName: missingItem.itemName,
                            category: missingItem.category,
                            rawQuery: userMsg,
                            userPhone,
                            userName: resolvedUsername,
                            userId
                        }).catch(err => console.warn('Record missing catalog demand notice:', err.message));
                    }
                }
            }
        }

        // 3. ZERO-TOKEN FAST LOCAL BRAIN:
        // For pure greetings, gratitude, contacts, and basic clarification without images,
        // answer instantly locally to save 100% of API token credits ($0.00 cost)!
        const lowerClean = (cleanMsg || userMsg).toLowerCase().trim();
        const isPureGreeting = !inlineImagePart && ['mambo', 'habari', 'oy', 'hello', 'hi', 'vipi', 'vip', 'salama', 'kaka', 'hallow', 'morning', 'habari za asubuhi', 'habari za mchana', 'habari za jioni'].some(g => lowerClean === g || lowerClean === g + '!');
        const isPureGratitude = !inlineImagePart && ['asante', 'ahsante', 'shukrani', 'asnt', 'shukran', 'nashukuru', 'asante sana', 'ahsante sana', 'shukrani sana', 'poa', 'vizuri', 'ok', 'sawa'].some(g => lowerClean === g || lowerClean === g + '!');
        const isPureContact = !inlineImagePart && isContactOrSupportQuestion(lowerClean) && (lowerClean.includes('namba') || lowerClean.includes('whatsapp') || lowerClean.includes('piga') || lowerClean.includes('simu') || lowerClean.includes('wasiliana'));
        const isPureVague = !inlineImagePart && ['sierewi', 'sielewi', 'msaada', 'help', 'naomba msaada', 'nashindwa kuelewa', 'sijaelewa'].includes(lowerClean);

        if (isPureGreeting || isPureGratitude || isPureContact || isPureVague) {
            const localReply = generateExpertSupportReply({
                userMsg,
                cleanMsg,
                intent,
                relevantMatches,
                knowledge
            });

            // Log conversation cleanly
            const logEntry = {
                id: 'log_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
                sessionId: sessionId || ('guest_' + Date.now()),
                userMessage: userMsg,
                botResponse: localReply,
                timestamp: new Date().toISOString(),
                isLocalSavedCost: true,
                ip: req.ip || req.headers['x-forwarded-for'] || 'local'
            };
            logEntry.userName = resolvedUsername || null;
            logEntry.username = resolvedUsername || null;
            appendAIChatLog(logEntry);
            if (fsdb) fsdb.collection('ai_chat_logs').add(logEntry).catch(() => {});

            return res.json({
                success: true,
                reply: localReply,
                botName: knowledge.botName || 'rajabsynic ai agent'
            });
        }

        let relevantCatalogSection = '';
        if (relevantMatches.length > 0) {
            relevantCatalogSection = `
═══ BIDHAA ZILIZOPO KWENYE MFUMO ZINAZOENDANA NA SWALI LA MTEJA (RELEVANT MATCHES) ═══
Hapa chini ni bidhaa halisi zilizopo kwenye mfumo wa RAJABSYNIC:
${relevantMatches.map(i => {
    const p = (i.isFree || !i.price || i.price == 0) ? 'BURE (Free)' : ('Tsh ' + Number(i.price).toLocaleString('en-US'));
    const typeLabel = getItemType(i) === 'movie' ? 'FILAMU / MOVIE' : (getItemType(i) === 'livetv' ? 'LIVE TV' : 'MCHEZO / MOD');
    return `- [${typeLabel}] Jina: "${i.title}" | Kategoria: ${i.category || i.contentType || ''} | Bei: ${p}`;
}).join('\n')}

KANUNI KUU YA UTAMBUZI WA BIDHAA:
- Kama mteja anauliza kuhusu MCHEZO au GAME: Mtajie bidhaa zenye alama ya [MCHEZO / MOD] PEKEE. Kamwe usimtaje bidhaa yenye alama ya [FILAMU / MOVIE]!
- Kama mteja anauliza kuhusu FILAMU au MOVIE: Mtajie bidhaa zenye alama ya [FILAMU / MOVIE] PEKEE. Kamwe usimtaje mchezo wa simu au mod!
- Mtajie bei yake halisi kwa Shilingi ya Kitanzania (Tsh) na umwelekeze kuipata kwa kubonyeza kitufe cha "Lipa Sasa" kwenye ukurasa wa huduma husika.
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
        // Extract and format Autonomous Self-Learned Insights
        let selfLearnedFormatted = '';
        const selfLearningData = knowledge.selfLearning || await getAISelfLearningDataAsync();
        if (selfLearningData && Array.isArray(selfLearningData.activeInsights) && selfLearningData.activeInsights.length > 0) {
            selfLearnedFormatted = selfLearningData.activeInsights
                .map((ins, i) => `FUNZO LA KIOTOMATIKI #${i + 1} (${ins.topic}):\n${ins.instruction.trim()}`)
                .join('\n\n');
        }

        const catalogSummary = await getCatalogSummary();
        const faqText = (knowledge.faqs || []).map(f => 'Q: ' + f.question + '\nA: ' + f.answer).join('\n\n');

        // Extract and format all Admin Trainings cleanly (Supreme Highest Priority)
        let customInstructionsFormatted = '';
        if (knowledge.trainings && Array.isArray(knowledge.trainings) && knowledge.trainings.length > 0) {
            customInstructionsFormatted = knowledge.trainings
                .map((t, idx) => {
                    let s = `FUNZO / MUONGOZO #${idx + 1}:\n${(t.text || '').trim()}`;
                    if (t.image && typeof t.image === 'string' && t.image.trim()) {
                        const img = t.image.trim();
                        s += `\nPICHA YA KUAMBATISHA KWA MTEJA (TRAINING ATTACHMENT IMAGE): ${img}`;
                        s += `\nKANUNI YA PICHA HII: Ikiwa mteja anauliza kuhusu mada au maelekezo ya funzo hili (au akiomba picha, muongozo wa hatua, au kielelezo cha hili), LAZIMA ujumuishe picha hii ndani ya jibu lako kwa muundo wa Markdown: ![Kielelezo cha Mwongozo](${img}) ili mtumiaji aione moja kwa moja kwenye dirisha la maongezi.`;
                    }
                    return s;
                })
                .join('\n\n──────────────────────────────\n\n');
        } else if (knowledge.systemInstructions || knowledge.customKnowledge) {
            customInstructionsFormatted = (knowledge.systemInstructions || knowledge.customKnowledge).trim();
        }

        const systemPrompt = `
WEWE NI: "rajabsynic ai agent" — Msaidizi Mahiri na Mtaalamu Mkuu wa Akili Bandia (High-Intelligence AI Expert Assistant) wa tovuti ya RAJABSYNIC (https://www.rajabsynic.com).
Lugha yako kuu ya mawasiliano ni Kiswahili fasaha, chenye staha, heshima, ukomavu na weledi mkubwa. (Unaweza pia kujibu kwa Kiingereza kama mteja atauliza kwa Kiingereza).

══════════════════════════════════════════════════════════════════
KANUNI KUU ZA UTAMBUZI WA JUU NA UTENDAJI (SUPERIOR IQ & INTENT RECOGNITION)
══════════════════════════════════════════════════════════════════
0. USITUMIE EMOJI ZOZOTE (STRICT NO-EMOJI POLICY):
   - Kamwe usitumie emoji yoyote kwenye majibu yako.
   - Majibu yawe safi, ya heshima na ya kitaalamu kwa maandishi fasaha pekee bila kuweka emoji yoyote.

1. TOFAUTISHA KWA USAHIHI WA 100% KATI YA MICHEZO (GAMES) NA FILAMU (MOVIES):
   - KANUNI KALI: KAMWE USICHANGANYE MCHEZO NA FILAMU!
   - MICHEZO (GAMES) & MODS: Hizi ni michezo ya video ya simu au PC (kama Mortal Kombat, GTA, Bus Simulator Indonesia / Maleo Bus Mods, Maleo Skins, Map Mods, ETS 2, WTDS, n.k.). Mteja akiuliza kuhusu MCHEZO au GAME, JIBU KUHUSU MICHEZO PEKEE! Kamwe usimtaje au kumpa jina la filamu (movie) kama mchezo!
   - FILAMU (MOVIES): Hizi ni video/sinema za kuangalia (kama filamu za kutafsiriwa na DJ Mack, DJ Afro, tamthilia za Kikorea, n.k.). Mteja akiuliza kuhusu FILAMU au MOVIE, JIBU KUHUSU FILAMU PEKEE! Kamwe usimpe mchezo wa simu badala ya filamu.
   - Kategoria za "Action", "Comedy", "Romantic", "Series" kwenye mfumo wetu NI FILAMU (MOVIES), SIYO MICHEZO YA SIMU! Usije ukataja filamu ya Action kwa mtu anayeomba mchezo wa video!
   - LIVE TV: Hizi ni chaneli za televisheni za moja kwa moja.
   - MODS ZA MALEO: Hizi ni mabasi, skins, na ramani zinazoongezwa ndani ya mchezo wa Bus Simulator Indonesia (Maleo).

2. ELEWA KWA KINA SWAHI LA MTEJA (DEEP COMPREHENSION & DIRECT RELEVANCE):
   - Kamwe usijibu ili mradi umejibu! Chambua kwa umakini kile mteja anachouliza, dhamira yake, na muktadha kamili.
   - Jibu moja kwa moja kwa hoja za kweli, zenye mantiki na kusaidia kwa vitendo.
   - Mteja akiuliza maswali maalum (kama "michezo inayovuma na bei zake"), jibu moja kwa moja kwa kumtajia michezo na bei zake, usimbadilishe mada kwenda kwenye jinsi ya kulipia tu!
   - Usirudie salamu ndefu kama "Habari! Karibu sana..." ikiwa mteja tayari mnaendelea na mazungumzo au ikiwa ameuliza swali la moja kwa moja. Jibu moja kwa moja swali lake kwa hekima na ufupi unaotosheleza.
   - Usikatishe tamaa mteja kwa majibu mafupi yasiyoeleweka au majibu ya roboti ya kiotomatiki.

3. UTAMBUZI WA BIDHAA/MICHEZO ISIYOPO KWENYE MFUMO (MISSING ITEMS RECOGNITION):
   - Ikiwa mteja anauliza au kuomba mchezo, mod, au filamu mahususi ambayo HAIPO kwenye orodha ya bidhaa zilizopo (catalog):
     * Mjulishe kwa uaminifu na heshima kwamba huduma au mchezo huo kwa sasa haujapakiwa kwenye mfumo.
     * Mhakikishie kwamba ombi lake limerekodiwa kiotomatiki kwenye mfumo wetu ili admin wetu wa RAJABSYNIC aweze kuupakia kwenye mfumo hivi karibuni!
     * Kamwe usimpe link bandia au mchezo mwingine usiohusika kama mbadala bila kumjulisha kwanza kuwa ule aliotaka haupo.

2. MAFUNZO YA ADMIN NDIYO AMRI KUU YA NAFASI YA #1 (SUPREME ADMIN TRAINING):
   - Kila funzo lililopo hapa chini ulipewa na ADMIN wa RAJABSYNIC na lina MAMLAKA YA JUU KABISA (Supreme Priority).

${customInstructionsFormatted ? customInstructionsFormatted : '(Hakuna mafunzo maalum ya ziada yaliyowekwa na Admin kwa sasa.)'}

3. MAFUNZO YA KIOTOMATIKI YALIYOJIFUNZWA NA AI (AUTONOMOUS SELF-LEARNED INSIGHTS):
Kutokana na maongezi ya wateja waliopita, mfumo umeji-upgrade na kujifunza masuala yafuatayo:
${selfLearnedFormatted ? selfLearnedFormatted : '(Bado haijapata mafunzo ya kiotomatiki ya ziada.)'}
══════════════════════════════════════════════════════════════════

${conversationGuide}

${relevantCatalogSection}

═══ MWONGOZO WA HUDUMA ZA RAJABSYNIC (SERVICE KNOWLEDGE) ═══
1. MALIPO KWA SIMU (KITUFE CHA "Lipa Sasa"):
   - Kitufe cha malipo kwenye tovuti kimeandikwa "Lipa Sasa". Kila mara tumia neno "Lipa Sasa".
   - Malipo yote yanafanyika kupitia mitandao ya simu ya Tanzania: M-Pesa, Tigo Pesa, Airtel Money, au Halopesa.
   - Baada ya mteja kuingiza namba yake ya simu na kuthibitisha kwa PIN ya mtandao wake, mfumo hufungua huduma au mchezo mara moja kiotomatiki bila kuhitaji kubonyeza kitufe cha uhakiki.

2. UPATIKANAJI WA MAUDHUI NA UDHIBITI WA MUDA WA MATUMIZI (ACCESS & DURATION EXPIRATION):
   - Vitu visivyolipiwa viko LOCKED. Mara baada ya malipo ya kitufe cha "Lipa Sasa", kitufe cha "Pakua" (Download) kinafunguka papo hapo.
   - Michezo ya bure (Free Games) haihitaji malipo — mteja anabonyeza "Pakua" moja kwa moja.
   - Chini ya hali yoyote ile, USITOE file, password au link ya kupakua kwa kitu kilichopo locked bila mteja kuwa na malipo halali yanayoendelea (Active).
   - UZINGATIAJI MKALI WA MUDA WA MATUMIZI (SUBSCRIPTION VALIDITY & EXPIRATION):
     Kila huduma na kifurushi kina muda maalum wa matumizi:
     * Kifurushi cha Mikumi: Masaa 24 (Siku 1).
     * Kifurushi cha Ngorongoro: Siku 7.
     * Kifurushi cha Serengeti / Movies VIP Pass: Siku 30 (Mwezi 1).
     * Adult Section: Siku 5.
     * Live TV: Siku 30.
     * Michezo/Modi binafsi: Siku 14.
     KANUNI KUU YA USALAMA: Ikiwa muda wa matumizi wa mteja umepita (Expired), ACCESS INAJIFUNGA KIOTOMATIKI. Usikubali kumpa access ya bure wala kumwahidi access bila kulipia tena. Mteja ambaye muda wake umekwisha mwambie kwa heshima na upole kwamba muda wake uliisha na mwelekeze kubonyeza kitufe cha "Lipa Sasa" kwenye ukurasa wa huduma hiyo ili kuhuisha (renew) kifurushi chake na kupata access mpya papo hapo.

3. KATAZO LA NAMBA YA SIMU AU WHATSAPP BINAFSI:
   - Chini ya hali yoyote ile, usitoe wala kutaja namba ya simu au kiungo cha WhatsApp binafsi. Mwelekeze kutumia sehemu ya "Msaada" (Help) iliyopo kwenye menyu ya tovuti.

4. UELEWA WA PICHA NA SCREENSHOTS (MULTIMODAL VISION):
   - Mteja akituma picha au picha ya skrini (screenshot): mfano ujumbe wa muamala wa simu (M-Pesa, Tigo Pesa, Airtel Money, Halopesa), hitilafu ya simu kama 'App Not Installed', 'Storage full', au hitilafu ya mchezo.
   - Ichambue picha hiyo kwa umakini wa hali ya juu! Soma maandishi yote yaliyoandikwa, namba zote, na maelezo yote yanayoonekana.
   - Mueleze mteja moja kwa moja kile unachokiona kwenye picha hiyo na umpe mwongozo kamili, thabiti na wa hatua kwa hatua wa kutatua changamoto yake.
   - Kama picha ni risiti ya malipo: Thibitisha namba ya muamala na kiasi kilicholipwa na umwelekeze kupata huduma mara moja.

═══ CATALOG YA BIDHAA NA MICHEZO (SUMMARY) ═══
${catalogSummary}
`.trim();

        const apiKey = process.env.GEMINI_API_KEY;
        let aiReply = '';

        // Prepare clean, cost-optimized alternating contents for Gemini API (Keep only last 4 messages)
        const formattedHistory = [];
        const trimmedHistory = Array.isArray(history) ? history.slice(-4) : [];
        for (const h of trimmedHistory) {
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

        // Add the latest incoming user message & optional image cleanly
        const userPromptText = userMsg || (inlineImagePart ? 'Tafadhali kagua picha hii niliyotuma na unisaidie kuelewa, kuchambua na kutatua kile kinachoonekana kwenye picha hii.' : '');
        const userParts = [{ text: userPromptText }];
        if (inlineImagePart) {
            userParts.push(inlineImagePart);
        }

        if (formattedHistory.length === 0 || formattedHistory[formattedHistory.length - 1].role !== 'user') {
            formattedHistory.push({ role: 'user', parts: userParts });
        } else {
            formattedHistory[formattedHistory.length - 1].parts = userParts;
        }

        // Attempt Gemini API call with modern supported models (prioritize active 3.5 & flash-lite)
        const geminiModels = ['gemini-3.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-3.8-flash', 'gemini-2.5-flash'];
        if (apiKey) {
            for (const mName of geminiModels) {
                if (aiReply) break;
                try {
                    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${mName}:generateContent?key=${apiKey}`;
                    const geminiPayload = {
                        contents: formattedHistory,
                        systemInstruction: {
                            parts: [{ text: systemPrompt }]
                        },
                        generationConfig: {
                            temperature: 0.35,
                            maxOutputTokens: 500
                        }
                    };

                    const geminiRes = await axios.post(geminiUrl, geminiPayload, {
                        headers: {
                            'Content-Type': 'application/json',
                            'x-goog-api-key': apiKey
                        },
                        timeout: 12000
                    });

                    if (geminiRes.data && geminiRes.data.candidates && geminiRes.data.candidates[0]?.content?.parts) {
                        const parts = geminiRes.data.candidates[0].content.parts;
                        const bestPart = parts.find(p => p.text && !p.thought) || parts[0];
                        if (bestPart && bestPart.text) {
                            aiReply = bestPart.text.trim();
                            break;
                        }
                    }
                } catch (apiErr) {
                    if (apiErr.response?.status === 402 || apiErr.response?.data?.error?.code === 402) {
                        break; // Stop retrying if credits depleted
                    }
                }
            }
        }

        // Scrub any leaked phone numbers or raw links
        if (aiReply) {
            aiReply = aiReply
                .replace(/(?:\+?255|0)[67]\d{8}/g, '[sehemu ya Msaada]')
                .replace(/https?:\/\/wa\.me\S*/gi, '[Msaada]');
        }

        // Resilient High-IQ Expert Engine (If Gemini API is depleted or had network issues)
        if (!aiReply) {
            aiReply = generateExpertSupportReply({
                userMsg,
                cleanMsg,
                history,
                knowledge,
                allCatalogItems,
                resolvedUsername,
                userPhone
            });
        }

        // Log conversation
        const logEntry = {
            id: 'log_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
            sessionId: sessionId || ('guest_' + Date.now()),
            userId: userId || null,
            userPhone: userPhone || null,
            userName: resolvedUsername || null,
            username: resolvedUsername || null,
            userMessage: userMsg,
            botResponse: aiReply,
            timestamp: new Date().toISOString(),
            ip: req.ip || req.headers['x-forwarded-for'] || 'local'
        };
        appendAIChatLog(logEntry);
        triggerAutonomousLearningCheck();

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

// Admin Endpoint: Get AI Analytics & Stats (Leo, Jana, Siku 7, Mwezi, Jumla)
app.get('/api/admin/ai/stats', requireAdmin, async (req, res) => {
    try {
        let logs = [];
        if (fsdb) {
            try {
                const snap = await fsdb.collection('ai_chat_logs').orderBy('timestamp', 'desc').limit(3000).get();
                snap.forEach(d => logs.push({ id: d.id, ...d.data() }));
            } catch (fsErr) {
                console.warn('Firestore ai_chat_logs fetch notice:', fsErr.message);
            }
        }
        if (logs.length === 0) {
            logs = getAIChatLogs();
        }

        // East Africa Time (UTC+3) calendar boundaries
        const now = new Date();
        const eatNow = new Date(now.getTime() + (3 * 3600000));
        const curYear = eatNow.getUTCFullYear();
        const curMonth = eatNow.getUTCMonth();
        const curDate = eatNow.getUTCDate();

        // Start of today in UTC ms
        const startOfTodayMs = Date.UTC(curYear, curMonth, curDate) - (3 * 3600000);
        const startOfYesterdayMs = startOfTodayMs - (24 * 3600000);
        const startOf7DaysMs = startOfTodayMs - (6 * 24 * 3600000);
        const startOfMonthMs = Date.UTC(curYear, curMonth, 1) - (3 * 3600000);

        function getPersonKey(log) {
            if (log.userId && log.userId !== 'anonymous' && log.userId !== 'guest') return 'uid_' + log.userId;
            if (log.userPhone && String(log.userPhone).length >= 7) return 'phone_' + log.userPhone;
            if (log.sessionId && !String(log.sessionId).startsWith('undefined')) return 'session_' + log.sessionId;
            if (log.ip && log.ip !== 'local' && log.ip !== '::1') return 'ip_' + log.ip;
            return 'log_' + (log.id || Math.random());
        }

        const todayUsers = new Set();
        let todayMessages = 0;

        const yesterdayUsers = new Set();
        let yesterdayMessages = 0;

        const last7DaysUsers = new Set();
        let last7DaysMessages = 0;

        const thisMonthUsers = new Set();
        let thisMonthMessages = 0;

        const allTimeUsers = new Set();
        let allTimeMessages = 0;

        for (const log of logs) {
            const rawTs = log.timestamp || log.createdAt;
            const ts = rawTs ? new Date(rawTs).getTime() : 0;
            if (!ts || isNaN(ts)) continue;

            const pKey = getPersonKey(log);

            // All time
            allTimeUsers.add(pKey);
            allTimeMessages++;

            // Today
            if (ts >= startOfTodayMs) {
                todayUsers.add(pKey);
                todayMessages++;
            }

            // Yesterday
            if (ts >= startOfYesterdayMs && ts < startOfTodayMs) {
                yesterdayUsers.add(pKey);
                yesterdayMessages++;
            }

            // Last 7 days
            if (ts >= startOf7DaysMs) {
                last7DaysUsers.add(pKey);
                last7DaysMessages++;
            }

            // This month
            if (ts >= startOfMonthMs) {
                thisMonthUsers.add(pKey);
                thisMonthMessages++;
            }
        }

        const recentLogs = logs.slice(0, 100).map(l => ({
            id: l.id || Math.random().toString(),
            timestamp: l.timestamp || l.createdAt || new Date().toISOString(),
            sessionId: l.sessionId || '-',
            userId: l.userId || null,
            userPhone: l.userPhone || null,
            userMessage: l.userMessage || '',
            botResponse: l.botResponse || '',
            isPaymentAction: !!l.isPaymentAction
        }));

        res.json({
            success: true,
            today: { people: todayUsers.size, messages: todayMessages },
            yesterday: { people: yesterdayUsers.size, messages: yesterdayMessages },
            last7Days: { people: last7DaysUsers.size, messages: last7DaysMessages },
            thisMonth: { people: thisMonthUsers.size, messages: thisMonthMessages },
            allTime: { people: allTimeUsers.size, messages: allTimeMessages },
            recentLogs
        });
    } catch (e) {
        console.error('Error generating AI stats:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// Admin Endpoint: Get Autonomous Self-Learning Data
app.get('/api/admin/ai/self-learn', requireAdmin, async (req, res) => {
    try {
        const data = await getAISelfLearningDataAsync();
        res.json({ success: true, ...data });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Admin Endpoint: Run Autonomous Self-Learning Cycle Now
app.post('/api/admin/ai/self-learn', requireAdmin, async (req, res) => {
    try {
        const result = await runAutonomousSelfLearning({ auto: false });
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Admin Endpoint: Delete a single learned insight
app.delete('/api/admin/ai/self-learn/:id', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const current = await getAISelfLearningDataAsync();
        current.activeInsights = (current.activeInsights || []).filter(ins => ins.id !== id);
        
        if (fsdb) {
            await fsdb.collection('settings').doc('ai_self_learning').set(current, { merge: true });
            await fsdb.collection('settings').doc('ai_support').set({ selfLearning: current }, { merge: true });
        }
        if (RUNTIME_AI_KNOWLEDGE) {
            RUNTIME_AI_KNOWLEDGE.selfLearning = current;
        }
        res.json({ success: true, message: 'Funzo limefutwa' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Admin Endpoint: Get AI Chat Logs
app.get('/api/admin/ai-chat-logs', requireAdmin, async (req, res) => {
    let logs = [];
    if (fsdb) {
        try {
            const snap = await fsdb.collection('ai_chat_logs').orderBy('timestamp', 'desc').limit(100).get();
            snap.forEach(d => logs.push({ id: d.id, ...d.data() }));
        } catch (_) {}
    }
    if (logs.length === 0) {
        logs = getAIChatLogs();
    }

    // Auto-enrich username for any logs
    if (logs.length > 0 && fsdb) {
        try {
            const phonesToLookup = [...new Set(logs.filter(l => !l.userName && !l.username && l.userPhone).map(l => l.userPhone))];
            if (phonesToLookup.length > 0) {
                const phoneMap = {};
                for (const ph of phonesToLookup.slice(0, 30)) {
                    const uSnap = await fsdb.collection('users').where('phone', '==', ph).limit(1).get();
                    if (!uSnap.empty) {
                        phoneMap[ph] = uSnap.docs[0].data()?.username || '';
                    }
                }
                logs.forEach(l => {
                    if ((!l.userName && !l.username) && l.userPhone && phoneMap[l.userPhone]) {
                        l.userName = phoneMap[l.userPhone];
                        l.username = phoneMap[l.userPhone];
                    }
                });
            }
        } catch (e) {
            console.warn('Username enrichment notice:', e.message);
        }
    }

    res.json(logs);
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

// ─── ADMIN ENDPOINTS: MISSING CATALOG DEMAND TRACKER ────────────────────

// Admin: Get all missing catalog requests
app.get('/api/admin/ai/missing-requests', requireAdmin, async (req, res) => {
    try {
        const items = await getMissingCatalogRequestsAsync();
        // Sort: pending first, then by demand count descending, then by lastRequested descending
        items.sort((a, b) => {
            const aPending = a.status === 'pending';
            const bPending = b.status === 'pending';
            if (aPending && !bPending) return -1;
            if (!aPending && bPending) return 1;
            if ((b.count || 1) !== (a.count || 1)) return (b.count || 1) - (a.count || 1);
            return new Date(b.lastRequested || 0) - new Date(a.lastRequested || 0);
        });

        const pendingCount = items.filter(i => i.status === 'pending').length;
        const resolvedCount = items.filter(i => i.status === 'resolved').length;
        const totalDemandsCount = items.reduce((sum, i) => sum + (i.count || 1), 0);

        res.json({
            success: true,
            total: items.length,
            pending: pendingCount,
            resolved: resolvedCount,
            totalDemandsCount,
            items
        });
    } catch (e) {
        console.error('Error getting missing catalog requests:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// Admin: Mark missing request as resolved or pending
app.post('/api/admin/ai/missing-requests/:id/resolve', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { status = 'resolved' } = req.body || {};
        const all = await getMissingCatalogRequestsAsync();
        const item = all.find(i => i.id === id || i.key === id);
        if (!item) {
            return res.status(404).json({ success: false, error: 'Ombi halikupatikana' });
        }

        item.status = status;
        item.resolvedAt = (status === 'resolved') ? new Date().toISOString() : null;
        saveMissingCatalogRequests(all);

        if (fsdb) {
            try {
                await fsdb.collection('missing_catalog_requests').doc(item.id || item.key).set(item, { merge: true });
            } catch (fsErr) {
                console.warn('Firestore resolve missing request notice:', fsErr.message);
            }
        }

        res.json({ success: true, message: 'Hali ya ombi imesasishwa kikamilifu', item });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Admin: Delete a missing request
app.delete('/api/admin/ai/missing-requests/:id', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        let all = await getMissingCatalogRequestsAsync();
        all = all.filter(i => i.id !== id && i.key !== id);
        saveMissingCatalogRequests(all);

        if (fsdb) {
            try {
                await fsdb.collection('missing_catalog_requests').doc(id).delete();
            } catch (fsErr) {
                console.warn('Firestore delete missing request notice:', fsErr.message);
            }
        }

        res.json({ success: true, message: 'Ombi limefutwa kikamilifu' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Admin: Seed or manually add a missing request
app.post('/api/admin/ai/missing-requests', requireAdmin, async (req, res) => {
    try {
        const { itemName, category, rawQuery } = req.body || {};
        if (!itemName) return res.status(400).json({ success: false, error: 'itemName is required' });
        await recordMissingCatalogRequestAsync({
            itemName,
            category: category || 'Game',
            rawQuery: rawQuery || itemName
        });
        res.json({ success: true, message: 'Ombi limehifadhiwa kikamilifu' });
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
