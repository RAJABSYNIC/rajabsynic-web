const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

const targetStr = `        if (TEST_MODE) {
            console.log('⚙️  TEST MODE: Simulating PressoPay checkout');
            gw = { reference: merchantReference, status: 'COMPLETED', checkoutUrl: null };
        } else {
            const path = '/api/v1/checkouts';
            const bodyObj = {
                merchantReference,
                amountMinor: parseInt(amount),
                buyerName: username || 'Rajabsynic User',
                buyerEmail: email || \`\${normalizedPhone}@rajabsynic.com\`,
                buyerPhone: normalizedPhone,
                description: description || \`Rajabsynic - \${contentTitle || 'Content'}\`
            };
            const rawBody = JSON.stringify(bodyObj);

            const resp = await axios.post(
                \`\${PRESSSO_BASE_URL}\${path}\`,
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
                gateway: TEST_MODE ? 'test' : 'pressopay',`;

const replaceStr = `        let usedGateway = 'pressopay';

        if (TEST_MODE) {
            console.log('⚙️  TEST MODE: Simulating PressoPay checkout');
            gw = { reference: merchantReference, status: 'COMPLETED', checkoutUrl: null };
        } else {
            const path = '/api/v1/checkouts';
            const bodyObj = {
                merchantReference,
                amountMinor: parseInt(amount),
                buyerName: username || 'Rajabsynic User',
                buyerEmail: email || \`\${normalizedPhone}@rajabsynic.com\`,
                buyerPhone: normalizedPhone,
                description: description || \`Rajabsynic - \${contentTitle || 'Content'}\`
            };
            const rawBody = JSON.stringify(bodyObj);

            try {
                const resp = await axios.post(
                    \`\${PRESSSO_BASE_URL}\${path}\`,
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
                    throw new Error(\`PressoPay returned status: \${pStatus}\`);
                }

                gw = {
                    reference: data.reference || merchantReference,
                    status: (data.status || 'PENDING'),
                    checkoutUrl: data.checkoutUrl || null
                };
            } catch (pressoErr) {
                console.warn(\`⚠️ PressoPay failed (\${pressoErr.message}), falling back to HarakaPay...\`);
                try {
                    const harakaApiKey = process.env.HARAKAPAY_API_KEY || 'hpk_2956fec8e3e5f80597bb59c734275096e99a6e6628046826';
                    const harakaResp = await axios.post(
                        'https://harakapay.net/api/v1/collect',
                        {
                            phone: normalizedPhone,
                            amount: parseInt(amount),
                            description: description || \`Rajabsynic - \${contentTitle || 'Content'}\`,
                            webhook_url: \`\${process.env.WEBHOOK_BASE_URL || 'https://rajabsynic.com'}/api/payment/webhook\`
                        },
                        {
                            headers: { 'X-API-Key': harakaApiKey },
                            timeout: 15000
                        }
                    );
                    
                    const hData = harakaResp.data || {};
                    if (!hData.success) {
                        throw new Error(\`HarakaPay returned error: \${hData.error || hData.message}\`);
                    }
                    
                    gw = {
                        reference: hData.order_id,
                        status: 'PENDING',
                        checkoutUrl: null
                    };
                    usedGateway = 'harakapay';
                } catch (harakaErr) {
                    console.error(\`❌ Both PressoPay and HarakaPay failed. HarakaErr: \${harakaErr.message}\`);
                    return res.status(500).json({ success: false, error: 'Mifumo yote ya malipo inasumbua kwa sasa. Tafadhali jaribu tena baadae.' });
                }
            }
        }

        console.log(\`✅ \${usedGateway} Response:\`, gw);
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
                gateway: TEST_MODE ? 'test' : usedGateway,`;

if (code.includes(targetStr)) {
    code = code.replace(targetStr, replaceStr);
    fs.writeFileSync('server.js', code, 'utf8');
    console.log('SUCCESS: replaced target string.');
} else {
    console.log('FAILED: Target string not found. Printing first 100 chars of expected:');
    console.log(targetStr.substring(0, 100));
}
