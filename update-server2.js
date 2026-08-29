const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

const targetStr = `        if (!TEST_MODE && !isCompleted) {
            // BACKGROUND POLLING: Failsafe for real-time resolution if webhook is delayed/blocked
            let attempts = 0;
            const pollTimer = setInterval(async () => {
                attempts++;
                if (attempts > 36) { // 3 minutes max
                    clearInterval(pollTimer);
                    return;
                }
                try {
                    const apiPath = \`/api/v1/checkouts/\${orderId}\`;
                    const pollResp = await axios.get(\`\${PRESSSO_BASE_URL}\${apiPath}\`, {
                        headers: {
                            ...pressoAuthHeaders('GET', apiPath),
                            'X-API-Key': PRESSSO_API_KEY
                        }
                    });
                    
                    const pStatus = String(pollResp.data.status || '').toUpperCase();
                    if (pStatus === 'COMPLETED' || pStatus === 'SUCCESS') {`;

const replaceStr = `        if (!TEST_MODE && !isCompleted) {
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
                        const apiPath = \`/api/v1/checkouts/\${orderId}\`;
                        const pollResp = await axios.get(\`\${PRESSSO_BASE_URL}\${apiPath}\`, {
                            headers: {
                                ...pressoAuthHeaders('GET', apiPath),
                                'X-API-Key': PRESSSO_API_KEY
                            }
                        });
                        pStatus = String(pollResp.data.status || '').toUpperCase();
                    } else if (usedGateway === 'harakapay') {
                        const harakaApiKey = process.env.HARAKAPAY_API_KEY || 'hpk_2956fec8e3e5f80597bb59c734275096e99a6e6628046826';
                        const pollResp = await axios.get(\`https://harakapay.net/api/v1/status/\${orderId}\`, {
                            headers: { 'X-API-Key': harakaApiKey }
                        });
                        if (pollResp.data && pollResp.data.payment) {
                            pStatus = String(pollResp.data.payment.status || '').toUpperCase();
                        }
                    }
                    
                    if (pStatus === 'COMPLETED' || pStatus === 'SUCCESS') {`;

if (code.includes(targetStr)) {
    code = code.replace(targetStr, replaceStr);
    fs.writeFileSync('server.js', code, 'utf8');
    console.log('SUCCESS: replaced polling logic.');
} else {
    console.log('FAILED: Target string not found. Printing first 100 chars of expected:');
    console.log(targetStr.substring(0, 100));
}
