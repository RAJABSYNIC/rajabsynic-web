import { db, auth, secondaryAuth, collection, getDocs, addDoc, setDoc, getDoc, doc, updateDoc, deleteDoc, signInWithEmailAndPassword, createUserWithEmailAndPassword, signInAnonymously, query, where, orderBy, limit, signOut, onSnapshot } from './firebase-config.js';

class ApiService {
    constructor() {
        this.baseUrl = window.location.origin; // http://localhost:3000
    }

    // --- CONTENT (Movies, Games, Adult) - REAL DATA FROM FIREBASE ---
    async getContent() {
        try {
            // Firebase is the source of truth for real content.
            const querySnapshot = await getDocs(collection(db, "content"));
            const content = [];
            querySnapshot.forEach((doc) => {
                content.push({ id: doc.id, ...doc.data() });
            });
            console.log('✅ Content loaded from Firebase:', content.length, 'items');
            return content;
        } catch (err) {
            console.error("Error getting content from Firebase:", err);
            // Last-resort fallback to the server API (may be empty in production).
            try {
                const response = await fetch(`${this.baseUrl}/api/content`);
                if (response.ok) return await response.json();
            } catch (_) {}
            return [];
        }
    }

    listenToContent(callback) {
        return onSnapshot(collection(db, "content"), (snapshot) => {
            const content = [];
            snapshot.forEach((doc) => {
                content.push({ id: doc.id, ...doc.data() });
            });
            console.log('🔥 Real-time content update:', content.length, 'items');
            callback(content);
        }, (error) => {
            console.error("Error in real-time content listener:", error);
            callback([]);
        });
    }

    async saveContent(item) {
        try {
            if (item.id) {
                // Update existing
                const docRef = doc(db, "content", item.id);
                const dataToUpdate = { ...item };
                delete dataToUpdate.id; // Don't save ID inside the document
                await updateDoc(docRef, dataToUpdate);
                return { success: true };
            } else {
                // Add new
                const docRef = await addDoc(collection(db, "content"), item);
                return { success: true, id: docRef.id };
            }
        } catch (err) {
            console.error("Error saving content:", err);
            return { success: false, message: err.message };
        }
    }

    async deleteContent(id) {
        try {
            await deleteDoc(doc(db, "content", id));
            return { success: true };
        } catch (err) {
            console.error("Error deleting content:", err);
            return { success: false };
        }
    }

    // --- USERS (Firestore Users) ---
    async getUsers() {
        try {
            const querySnapshot = await getDocs(collection(db, "users"));
            const users = [];
            querySnapshot.forEach((doc) => {
                users.push({ id: doc.id, ...doc.data() });
            });
            return users;
        } catch (err) {
            console.error("Error getting users:", err);
            return [];
        }
    }

    // Patch referredBy on an existing user document (used to fix users who registered before fix)
    async updateUserReferral(uid, referredBy) {
        try {
            if (!uid) {
                return { success: false, message: 'UID haipo — mtumiaji hajapatikana vizuri' };
            }
            const userDocRef = doc(db, "users", uid);
            await updateDoc(userDocRef, { referredBy: referredBy });
            console.log(`✅ referredBy patched for uid=${uid}: ${referredBy}`);
            return { success: true };
        } catch (err) {
            console.error("Error updating referral:", err.code, err.message);
            if (err.code === 'permission-denied') {
                return { success: false, message: 'Ruhusa imekataliwa. Tafadhali login tena kisha jaribu.' };
            }
            return { success: false, message: err.message };
        }
    }

    async grantUserAccess(userId, itemId = 'adult-section-access') {
        try {
            const paymentData = {
                userId: userId,
                uid: userId,
                itemId: itemId,
                amount: 0,
                status: 'COMPLETED',
                method: 'manual_admin_grant',
                description: 'Admin Granted Access',
                timestamp: new Date().toISOString()
            };
            const docRef = await addDoc(collection(db, "payments"), paymentData);
            
            // Actually create the subscription so the user gets access (grant for 10 years / lifetime)
            await this.createSubscription(userId, itemId, docRef.id, 3650);
            
            return { success: true, id: docRef.id };
        } catch (err) {
            console.error("Error granting access:", err);
            return { success: false, message: err.message };
        }
    }

    async revokeUserAccess(userId, itemId = 'adult-section-access') {
        try {
            // Find payments where userId matches and itemId matches
            const payments = await this.getAllPayments();
            const toDeletePayments = payments.filter(p => 
                (p.userId === userId || p.uid === userId) && 
                p.itemId === itemId && 
                p.status === 'COMPLETED'
            );
            
            const deletePromises = toDeletePayments.map(p => deleteDoc(doc(db, "payments", p.id)));
            
            // Also delete from subscriptions collection
            const q = query(
                collection(db, "subscriptions"),
                where("userId", "==", userId),
                where("contentId", "==", itemId)
            );
            const subSnapshot = await getDocs(q);
            subSnapshot.forEach(docSnap => {
                deletePromises.push(deleteDoc(doc(db, "subscriptions", docSnap.id)));
            });

            await Promise.all(deletePromises);

            return { success: true };
        } catch (err) {
            console.error("Error revoking access:", err);
            return { success: false, message: err.message };
        }
    }

    async deleteUser(id) {
        try {
            await deleteDoc(doc(db, "users", id));
            return { success: true };
        } catch (err) {
            console.error("Error deleting user:", err);
            return { success: false };
        }
    }

    // --- ADMINS (Firestore Admins + Auth) ---
    async adminLogin(creds) {
        try {
            // Admins log in with their email. (A bare name is still accepted and
            // mapped to the @rajabsynic.com domain for backward compatibility.)
            let email = (creds.email || creds.username || '').toLowerCase().trim();
            if (!email) {
                return { success: false, message: 'Tafadhali ingiza email na password.' };
            }
            if (!email.includes('@')) {
                email = `${email}@rajabsynic.com`;
            }

            // 1. Authenticate against Firebase Auth
            const userCredential = await signInWithEmailAndPassword(auth, email, creds.password);
            const user = userCredential.user;

            // 2. Authorize against the Firestore "admins" collection (keyed by Auth UID).
            //    Admins are managed entirely in Firebase — no hardcoded users, no local fallback.
            const adminSnap = await getDoc(doc(db, "admins", user.uid));

            if (!adminSnap.exists()) {
                console.warn("Auth succeeded but user is not in admins collection:", user.uid);
                await signOut(auth);
                return { success: false, message: "Access Denied: Wewe si admin." };
            }

            const token = await user.getIdToken();
            return { success: true, token, admin: { uid: user.uid, ...adminSnap.data() } };
        } catch (err) {
            console.error("Admin login failed:", err.code || err.message);
            let msg = "Login imeshindwa. Jaribu tena.";
            if (
                err.code === 'auth/invalid-credential' ||
                err.code === 'auth/wrong-password' ||
                err.code === 'auth/user-not-found' ||
                err.code === 'auth/invalid-login-credentials'
            ) {
                msg = "Jina la mtumiaji au password si sahihi.";
            } else if (err.code === 'auth/too-many-requests') {
                msg = "Umejaribu mara nyingi. Subiri kidogo kisha jaribu tena.";
            }
            return { success: false, message: msg };
        }
    }

    async getAdmins() {
        try {
            const querySnapshot = await getDocs(collection(db, "admins"));
            const admins = [];

            querySnapshot.forEach((doc) => {
                admins.push({ id: doc.id, ...doc.data() });
            });
            return admins;
        } catch (err) {
            console.error("Error getting admins:", err);
            return [];
        }
    }

    async deleteAdmin(id) {
        try {
            if (id === 'super-admin') {
                return { success: false, message: "Cannot delete Super Admin." };
            }
            await deleteDoc(doc(db, "admins", id));
            return { success: true };
        } catch (err) {
            console.error("Error deleting admin:", err);
            return { success: false, message: err.message };
        }
    }

    async addAdmin(adminData) {
        try {
            // Force lowercase username for consistency
            const cleanUsername = adminData.username.toLowerCase().trim();
            console.log("Creating Admin Account for:", cleanUsername);

            let email = cleanUsername;
            if (!email.includes('@')) {
                email = `${cleanUsername}@rajabsynic.com`;
            }

            // Create in Secondary Auth
            const userCredential = await createUserWithEmailAndPassword(secondaryAuth, email, adminData.password);
            const user = userCredential.user;

            // Store in Firestore
            await setDoc(doc(db, "admins", user.uid), {
                username: cleanUsername, // Store lowercase
                display_name: adminData.username, // Store original for display if needed
                email: email,
                role: 'admin',
                createdAt: new Date().toISOString(),
                uid: user.uid
            });

            return { success: true, message: "Admin created successfully." };
        } catch (err) {
            console.error("Add Admin Error:", err);
            return { success: false, message: err.message };
        }
    }


    // --- AUTHENTICATION (Public Users) ---
    async registerUser(userData) {
        try {
            const phone = userData.phone.replace(/[^0-9]/g, '');
            const email = `${phone}@rajabsynic.com`;
            const password = `pass${phone}`;

            // 1. Create Auth User
            const userCredential = await createUserWithEmailAndPassword(auth, email, password);
            const user = userCredential.user;

            // 2. Create Firestore User Profile
            const userProfile = {
                username: userData.username,
                phone: phone,
                email: email,
                uid: user.uid,
                joinedAt: new Date().toISOString(),
                role: 'user'
            };

            // 3. Attach referral code if the user arrived via a referral link
            if (userData.referredBy) {
                userProfile.referredBy = userData.referredBy;
            }

            // Use UID as document ID for easier lookup/security
            await setDoc(doc(db, "users", user.uid), userProfile);

            return { success: true, user: userProfile };
        } catch (err) {
            console.error("Registration error:", err);
            let msg = err.message;
            if (err.code === 'auth/email-already-in-use') msg = 'Namba hii imeshajisajili. Tafadhali rudi u-login.';
            return { success: false, message: msg };
        }
    }

    async loginUser(creds) {
        try {
            const phone = creds.phone.replace(/[^0-9]/g, '');
            const email = `${phone}@rajabsynic.com`;
            // Use a supplied password (e.g. for admin-created accounts) or fall
            // back to the default phone-based scheme for regular phone-only login.
            const password = (creds.password && creds.password.length)
                ? creds.password
                : `pass${phone}`;

            // Login with Email/Password
            const userCredential = await signInWithEmailAndPassword(auth, email, password);

            // Fetch latest profile data to return
            const userDocRef = doc(db, "users", userCredential.user.uid);
            const userSnap = await getDoc(userDocRef);

            let userData = { phone: phone, uid: userCredential.user.uid };
            if (userSnap.exists()) {
                userData = { ...userData, ...userSnap.data() };
            } else {
                userData.username = "Mtumiaji";
            }

            // If user was referred but referredBy not yet saved in Firestore, patch it now
            const pendingRef = localStorage.getItem('pendingReferralCode');
            if (pendingRef && !userData.referredBy) {
                try {
                    await updateDoc(userDocRef, { referredBy: pendingRef });
                    userData.referredBy = pendingRef;
                    localStorage.removeItem('pendingReferralCode');
                    console.log('Referral patched on login:', pendingRef);
                } catch (patchErr) {
                    console.warn('Could not patch referral on login:', patchErr.message);
                }
            }

            return { success: true, user: userData };
        } catch (err) {
            console.error("Login error:", err);
            // If user not found, signal that it's a new user
            if (err.code === 'auth/user-not-found' || err.code === 'auth/invalid-credential' || err.code === 'auth/invalid-login-credentials') {
                return { success: false, isNewUser: true };
            }
            return { success: false, message: err.message };
        }
    }

    async getSettings() {
        try {
            const res = await fetch('/api/settings', { headers: { 'Authorization': 'Bearer ' + sessionStorage.getItem('rajab_admin_token') } });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (err) {
            console.error("Error getting settings:", err);
            return null;
        }
    }

    async updateSettings(settingsData) {
        try {
            const res = await fetch('/api/settings', {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + sessionStorage.getItem('rajab_admin_token')
                },
                body: JSON.stringify(settingsData)
            });
            if (!res.ok) {
                const text = await res.text();
                throw new Error(`HTTP ${res.status}: ${text}`);
            }
            return await res.json();
        } catch (err) {
            console.error("Error updating settings:", err);
            return { success: false, message: err.message || "Network error" };
        }
    }

    async getUserActivity() {
        try {
            const res = await fetch(`${this.baseUrl}/api/user-activity`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (err) {
            console.error("Error getting user activity:", err);
            return { total: 0, active: 0, dead: 0, activeUsers: [], deadUsers: [], allUsers: [] };
        }
    }

    async getDashboardStats(preloadedPayments) {
        try {
            // Run the count queries in parallel instead of sequentially.
            const [games, users, admins] = await Promise.all([
                getDocs(query(collection(db, "content"), where("category", "!=", "movies"))),
                getDocs(collection(db, "users")),
                getDocs(collection(db, "admins"))
            ]);

            return {
                totalGames: games.size,
                totalUsers: users.size,
                totalAdmins: admins.size
            };
        } catch (err) {
            console.error("Stats error:", err);
            return { totalGames: 0, totalUsers: 0, totalAdmins: 0 };
        }
    }

    // --- PAYMENTS ---
    async getPayments() {
        try {
            const querySnapshot = await getDocs(collection(db, "payments"));
            const payments = [];
            querySnapshot.forEach((doc) => {
                payments.push({ id: doc.id, ...doc.data() });
            });
            return payments;
        } catch (err) {
            console.error("Error getting payments:", err);
            return [];
        }
    }

    listenToPayments(callback) {
        return onSnapshot(collection(db, "payments"), (snapshot) => {
            const payments = [];
            snapshot.forEach((doc) => {
                payments.push({ id: doc.id, ...doc.data() });
            });
            callback(payments);
        }, (error) => {
            console.error("Error in real-time payments listener:", error);
            callback([]);
        });
    }

    listenToPaymentStatus(orderId, callback) {
        return onSnapshot(doc(db, "payments", orderId), (docSnapshot) => {
            if (docSnapshot.exists()) {
                callback({ success: true, payment: { id: docSnapshot.id, ...docSnapshot.data() } });
            } else {
                callback({ success: false, error: 'Malipo hayajapatikana' });
            }
        }, (error) => {
            console.error("Error in real-time payment status listener:", error);
            callback({ success: false, error: 'Tatizo la mtandao' });
        });
    }

    async addPayment(paymentData) {
        try {
            const docRef = await addDoc(collection(db, "payments"), {
                ...paymentData,
                timestamp: new Date().toISOString()
            });
            return { success: true, id: docRef.id };
        } catch (err) {
            console.error("Error adding payment:", err);
            return { success: false, message: err.message };
        }
    }

    async getTopSpenders(limit = 10, preloadedPayments) {
        try {
            const payments = preloadedPayments || await this.getPayments();

            if (payments.length === 0) {
                return [];
            }

            // Aggregate spending by userId
            const spendingMap = {};
            payments.forEach(payment => {
                const status = (payment.status || 'pending').toLowerCase();
                const isCompleted = status === 'completed' || status === 'success' || status === 'complete';
                
                // Skip manual payments and incomplete payments
                if (status === 'manual' || !isCompleted) return;

                const userId = payment.userId || payment.uid;
                const username = payment.username || 'Unknown User';
                const amount = parseFloat(payment.amount) || 0;

                if (!spendingMap[userId]) {
                    spendingMap[userId] = {
                        userId: userId,
                        username: username,
                        totalSpent: 0,
                        purchaseCount: 0
                    };
                }

                spendingMap[userId].totalSpent += amount;
                spendingMap[userId].purchaseCount += 1;
            });

            // Convert to array and sort by totalSpent
            const spenders = Object.values(spendingMap)
                .sort((a, b) => b.totalSpent - a.totalSpent)
                .slice(0, limit);

            // Format for display
            return spenders.map((spender, index) => ({
                rank: index + 1,
                username: spender.username,
                totalSpent: `Tsh ${spender.totalSpent.toLocaleString()}`,
                purchaseCount: spender.purchaseCount
            }));
        } catch (err) {
            console.error("Error getting top spenders:", err);
            return [];
        }
    }

    // --- SUBSCRIPTIONS ---
    async createSubscription(userId, contentId, orderId, durationDays = 14) {
        try {
            const expiresAt = new Date();
            expiresAt.setDate(expiresAt.getDate() + durationDays);

            const subscriptionData = {
                userId,
                contentId,
                orderId,
                expiresAt: expiresAt.toISOString(),
                createdAt: new Date().toISOString()
            };

            const docRef = await addDoc(collection(db, "subscriptions"), subscriptionData);
            return { success: true, id: docRef.id };
        } catch (err) {
            console.error("Error creating subscription:", err);
            return { success: false, message: err.message };
        }
    }

    async checkSubscription(userId, contentId) {
        try {
            const q = query(
                collection(db, "subscriptions"),
                where("userId", "==", userId),
                where("contentId", "==", contentId)
            );

            const querySnapshot = await getDocs(q);
            const now = new Date();
            for (const doc of querySnapshot.docs) {
                const sub = doc.data();
                if (new Date(sub.expiresAt) > now) {
                    return {
                        hasAccess: true,
                        subscription: { id: doc.id, ...sub },
                        expiresAt: sub.expiresAt
                    };
                }
            }
        } catch (err) {
            if (err.code !== 'permission-denied') {
                console.error("Error checking subscription (firebase):", err);
            }
        }

        try {
            const res = await fetch(
                `${this.baseUrl}/api/subscription/check?userId=${encodeURIComponent(userId)}&contentId=${encodeURIComponent(contentId)}`
            );
            if (res.ok) {
                const data = await res.json();
                if (data.hasAccess) {
                    return { hasAccess: true, expiresAt: data.expiresAt, source: data.source };
                } else if (data.totalPaid !== undefined) {
                    return { hasAccess: false, totalPaid: data.totalPaid };
                }
            }
        } catch (err) {
            console.error("Error checking subscription (server):", err);
        }

        return { hasAccess: false };
    }

    listenToSubscription(userId, contentId, callback) {
        const q = query(
            collection(db, "subscriptions"),
            where("userId", "==", userId),
            where("contentId", "==", contentId)
        );

        return onSnapshot(q, (snapshot) => {
            const now = new Date();
            let hasAccess = false;
            let subData = null;

            for (const doc of snapshot.docs) {
                const sub = doc.data();
                if (new Date(sub.expiresAt) > now) {
                    hasAccess = true;
                    subData = { id: doc.id, ...sub };
                    break;
                }
            }
            callback({ hasAccess, subscription: subData, expiresAt: subData?.expiresAt });
        }, (error) => {
            console.error("Error in real-time subscription listener:", error);
            callback({ hasAccess: false });
        });
    }

    listenToUserPaymentsForContent(userId, contentId, callback) {
        const q = query(
            collection(db, "payments"),
            where("userId", "==", userId),
            where("contentId", "==", contentId),
            where("status", "in", ["completed", "success"])
        );
        return onSnapshot(q, (snapshot) => {
            let totalPaid = 0;
            snapshot.forEach((doc) => {
                totalPaid += Number(doc.data().amount) || 0;
            });
            callback(totalPaid);
        }, (error) => {
             console.error("Error in real-time user payments listener:", error);
             callback(0);
        });
    }

    async getUserSubscriptions(userId) {
        try {
            const q = query(
                collection(db, "subscriptions"),
                where("userId", "==", userId)
            );

            const querySnapshot = await getDocs(q);
            const subscriptions = [];
            const now = new Date();

            querySnapshot.forEach((doc) => {
                const sub = doc.data();
                const expiresAt = new Date(sub.expiresAt);
                subscriptions.push({
                    id: doc.id,
                    ...sub,
                    isActive: expiresAt > now
                });
            });

            return subscriptions;
        } catch (err) {
            console.error("Error getting user subscriptions:", err);
            return [];
        }
    }

    async recordPayment(paymentData) {
        try {
            // Update existing payment record or create new one
            const docRef = await addDoc(collection(db, "payments"), {
                ...paymentData,
                timestamp: paymentData.timestamp || new Date().toISOString()
            });
            return { success: true, id: docRef.id };
        } catch (err) {
            console.error("Error recording payment:", err);
            return { success: false, message: err.message };
        }
    }

    async getAllPayments() {
        return await this.getPayments();
    }

    // --- NOTIFICATIONS (Firestore-based real-time) ---
    async sendNotification(notifData) {
        try {
            const docRef = await addDoc(collection(db, "notifications"), {
                title: notifData.title,
                body: notifData.body,
                image: notifData.image || null,
                target: notifData.target || 'all',
                createdAt: new Date().toISOString(),
                timestamp: Date.now(),
                read: false
            });
            return { success: true, id: docRef.id };
        } catch (err) {
            console.error("Error sending notification:", err);
            return { success: false, message: err.message };
        }
    }

    // --- WITHDRAWALS ---
    async getWithdrawals() {
        try {
            const res = await fetch('/api/withdrawals', { headers: { 'Authorization': 'Bearer ' + sessionStorage.getItem('rajab_admin_token') } });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (err) {
            console.error('Error getting withdrawals:', err);
            return [];
        }
    }

    listenToWithdrawals(callback) {
        // Assuming withdrawals are also moved to Firestore in production,
        // but for now, we will fallback to fetch polling if it's still entirely server-side.
        // Wait, did we move withdrawals to Firestore? Let me check server.js.
        // I will implement a fetch poller wrapper that acts like onSnapshot for now,
        // or just use polling if we didn't migrate it to Firestore.
        let interval;
        const poll = async () => {
            const data = await this.getWithdrawals();
            callback(data);
        };
        poll();
        interval = setInterval(poll, 5000);
        return () => clearInterval(interval);
    }

    async approveWithdrawal(id, note = '') {
        try {
            const res = await fetch(`/api/withdrawals/${id}/approve`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ note })
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (err) {
            console.error('Error approving withdrawal:', err);
            return { success: false, error: err.message };
        }
    }

    async rejectWithdrawal(id, reason = '') {
        try {
            const res = await fetch(`/api/withdrawals/${id}/reject`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason })
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (err) {
            console.error('Error rejecting withdrawal:', err);
            return { success: false, error: err.message };
        }
    }

    async getRecentNotifications(limitCount = 10) {
        try {
            const q = query(
                collection(db, "notifications"),
                orderBy("timestamp", "desc"),
                limit(limitCount)
            );
            const snapshot = await getDocs(q);
            const notifs = [];
            snapshot.forEach(d => notifs.push({ id: d.id, ...d.data() }));
            return notifs;
        } catch (err) {
            console.error("Error getting notifications:", err);
            return [];
        }
    }
}

const api = new ApiService();
export default api;
