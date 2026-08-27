// Native fetch used

// If node-fetch is not installed, we can rely on Node 18+ native fetch. 
// If older node, this might fail, but let's assume recent node.

const BASE_URL = 'http://localhost:3000/api';

async function test() {
    console.log("Starting API Tests...");

    try {
        // 1. Get Content
        const resContent = await fetch(`${BASE_URL}/content`);
        if (!resContent.ok) {
            console.error(`[FAIL] Get Content Status: ${resContent.status}`);
            console.error(`[FAIL] Body: ${await resContent.text()}`);
            return;
        }
        const content = await resContent.json();
        console.log(`[PASS] Get Content: Found ${content.length} items`);

        // 2. Add Content
        const newContent = {
            title: "Test Game",
            category: "tanzania-games",
            image: "mock_url",
            isTrending: false,
            isFree: true,
            isAdult: false
        };
        const resAdd = await fetch(`${BASE_URL}/content`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(newContent)
        });
        const added = await resAdd.json();
        if (added.success && added.item.id) {
            console.log(`[PASS] Add Content: ${added.item.id}`);
        } else {
            console.error(`[FAIL] Add Content`, added);
        }

        // 3. Delete Content
        if (added.item && added.item.id) {
            const resDel = await fetch(`${BASE_URL}/content/${added.item.id}`, { method: 'DELETE' });
            const del = await resDel.json();
            if (del.success) console.log(`[PASS] Delete Content`);
            else console.error(`[FAIL] Delete Content`);
        }

        // 4. Register User
        const user = { username: `testuser_${Date.now()}`, password: 'password', phone: '123456' };
        const resReg = await fetch(`${BASE_URL}/users`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(user)
        });
        const reg = await resReg.json();
        if (reg.success) console.log(`[PASS] Register User`);
        else console.error(`[FAIL] Register User`, reg);

        // 5. Login User
        const resLogin = await fetch(`${BASE_URL}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identifier: user.username, password: 'password' })
        });
        const login = await resLogin.json();
        if (login.success) console.log(`[PASS] Login User`);
        else console.error(`[FAIL] Login User`, login);

        // 6. Admin Login
        const resAdmin = await fetch(`${BASE_URL}/admin/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'admin', password: 'password123' })
        });
        const admin = await resAdmin.json();
        if (admin.success) console.log(`[PASS] Admin Login`);
        else console.error(`[FAIL] Admin Login`, admin);


    } catch (err) {
        console.error("Test Failed:", err);
    }
}

test();
