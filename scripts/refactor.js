const fs = require('fs');
const path = require('path');

const SERVER_FILE = path.join(__dirname, '..', 'server.js');
let code = fs.readFileSync(SERVER_FILE, 'utf8');

// 1. Rewrite grantAccessForPayment
code = code.replace(/function grantAccessForPayment\(db, payment\) \{[\s\S]*?return true;\n\}/m, 
`async function grantAccessForPayment(payment) {
    if (!payment) return false;
    const userId = payment.userId || payment.uid;
    const contentId = payment.contentId;
    const orderId = payment.order_id || payment.id;

    if (!userId || !contentId) {
        console.warn(\`??  Cannot grant access - missing userId/contentId on payment \${orderId}\`);
        return false;
    }

    if (fsdb) {
        // Idempotent: don't duplicate for the same order
        const existing = await fsdb.collection('subscriptions').where('orderId', '==', orderId).get();
        if (!existing.empty) return true;

        const durationDays = getDurationDays(null, contentId); // getDurationDays uses db.content, but actually in server.js it reads memoryDB
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
        console.log(\`?? Access granted: user=\${userId} content=\${contentId} until \${expiresAt.toISOString().slice(0, 10)}\`);
        return true;
    }
    return false;
}`);

// 2. Rewrite GET /api/subscription/check
code = code.replace(/app\.get\('\/api\/subscription\/check', \(req, res\) => \{[\s\S]*?\}\);/m, 
`app.get('/api/subscription/check', async (req, res) => {
    const { userId, contentId } = req.query;
    if (!userId || !contentId) {
        return res.status(400).json({ hasAccess: false, error: 'userId and contentId required' });
    }

    if (fsdb) {
        const now = new Date();
        // 1. Check subscriptions
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
        
        if (validSub) {
            return res.json({ hasAccess: true, source: 'subscription', expiresAt: validSub.expiresAt });
        }

        // 2. Check completed payments
        const payments = await fsdb.collection('payments')
            .where('userId', '==', userId)
            .where('contentId', '==', contentId)
            .where('status', '==', 'completed')
            .get();
            
        if (!payments.empty) {
            return res.json({ hasAccess: true, source: 'payment' });
        }
    }
    return res.json({ hasAccess: false });
});`);

// 3. Rewrite GET /api/payments
code = code.replace(/app\.get\('\/api\/payments', \(req, res\) => \{[\s\S]*?\}\);/m, 
`app.get('/api/payments', async (req, res) => {
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
    res.json([]);
});`);

// 4. Update creditReferralEarning calls
code = code.replace(/creditReferralEarning\(db\.payments\[[^\]]+\]\)/g, 'creditReferralEarning(paymentRecord || dbPayment)');

// 5. Update Webhook
code = code.replace(/const db = readDB\(\);[\s\S]*?console\.log\(\`.*?Webhook updated payment: \$\{reference\}.*?\`\);/m, 
`if (fsdb) {
            const docRef = fsdb.collection('payments').doc(reference);
            const doc = await docRef.get();
            if (!doc.exists) {
                console.warn('??  Webhook: payment not found in fsdb:', reference);
                return;
            }

            const payment = doc.data();
            payment.status = normalizedStatus;
            payment.updatedAt = new Date().toISOString();
            payment.webhook_data = body;

            await docRef.set(payment);

            if (normalizedStatus === 'completed') {
                grantAccessForPayment(payment).catch(e => console.error(e));
                creditReferralEarning(payment).catch(e => console.error(e));
            }
            console.log(\`? Webhook updated payment in fsdb: \${reference}   \${normalizedStatus}\`);
        }`);

// 6. Update POST /api/payment/initiate
code = code.replace(/const db = readDB\(\);\s*db\.payments\.push\(paymentRecord\);\s*writeDB\(db\);\s*console\.log\(\`\?\? Payment saved to DB: \$\{orderId\} \(\$\{isCompleted \? 'completed' : 'pending'\}\)\`\);\s*\} catch \(e\) \{/m,
`if (fsdb) {
            await fsdb.collection('payments').doc(orderId).set(paymentRecord);
            console.log(\`? Payment saved to fsdb: \${orderId} (\${isCompleted ? 'completed' : 'pending'})\`);
        }
    } catch (e) {`);
code = code.replace(/grantAccessForPayment\(db, db\.payments\[db\.payments\.length - 1\]\);/m, 'grantAccessForPayment(paymentRecord);');
code = code.replace(/creditReferralEarning\(db\.payments\[db\.payments\.length - 1\]\)/m, 'creditReferralEarning(paymentRecord)');

// 7. Update GET /api/payment/status/:orderId
code = code.replace(/const db = readDB\(\);\s*let dbPayment = \(db\.payments \|\| \[\]\)\.find\(p => p\.order_id === orderId \|\| p\.id === orderId\);/m,
`let dbPayment = null;
    if (fsdb) {
        const doc = await fsdb.collection('payments').doc(orderId).get();
        if (doc.exists) dbPayment = doc.data();
    }`);
code = code.replace(/const idx = \(db\.payments \|\| \[\]\)\.findIndex\(p => p\.id === orderId \|\| p\.order_id === orderId\);\s*if \(idx !== -1\) \{\s*db\.payments\[idx\]\.status = normalizedStatus;\s*db\.payments\[idx\]\.updatedAt = new Date\(\)\.toISOString\(\);\s*\/\/ Grant access on confirmed completion \(webhook-independent path\)\.\s*if \(normalizedStatus === 'completed'\) \{\s*grantAccessForPayment\(db, db\.payments\[idx\]\);\s*creditReferralEarning\(db\.payments\[idx\]\)\.catch\(e => console\.error\(e\)\);\s*\}\s*writeDB\(db\);\s*console\.log\(\`\?\? Local DB updated: \$\{orderId\}   \$\{normalizedStatus\}\`\);\s*\}/m,
`if (dbPayment && fsdb) {
                dbPayment.status = normalizedStatus;
                dbPayment.updatedAt = new Date().toISOString();
                await fsdb.collection('payments').doc(orderId).set(dbPayment);
                if (normalizedStatus === 'completed') {
                    grantAccessForPayment(dbPayment).catch(e => console.error(e));
                    creditReferralEarning(dbPayment).catch(e => console.error(e));
                }
                console.log(\`? fsdb updated: \${orderId}   \${normalizedStatus}\`);
            }`);

fs.writeFileSync(SERVER_FILE, code, 'utf8');
console.log("server.js refactored successfully.");
