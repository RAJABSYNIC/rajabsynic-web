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
            try {
                localStorage.setItem('rajabsynic_cached_content', JSON.stringify(content));
            } catch (e) {}
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

    // --- CATEGORIES (custom categories added by admin) ---
    async getCategories() {
        try {
            const snapshot = await getDocs(collection(db, "categories"));
            return snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        } catch (err) {
            console.error("Error loading categories:", err);
            return [];
        }
    }

    async saveCategory(id, data) {
        try {
            await setDoc(doc(db, "categories", id), data);
            return { success: true };
        } catch (err) {
            console.error("Error saving category:", err);
            return { success: false, message: err.message };
        }
    }

    // --- HELP VIDEOS (Msaada) ---
    async getHelpVideos() {
        try {
            const snapshot = await getDocs(collection(db, "helpVideos"));
            return snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        } catch (err) {
            console.error("Error loading help videos:", err);
            return [];
        }
    }

    async saveHelpVideo(item) {
        try {
            if (item.id) {
                const docRef = doc(db, "helpVideos", item.id);
                const dataToUpdate = { ...item };
                delete dataToUpdate.id;
                await updateDoc(docRef, dataToUpdate);
                return { success: true };
            }
            const docRef = await addDoc(collection(db, "helpVideos"), item);
            return { success: true, id: docRef.id };
        } catch (err) {
            console.error("Error saving help video:", err);
            return { success: false, message: err.message };
        }
    }

    async deleteHelpVideo(id) {
        try {
            await deleteDoc(doc(db, "helpVideos", id));
            return { success: true };
        } catch (err) {
            console.error("Error deleting help video:", err);
            return { success: false, message: err.message };
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

    async grantUserAccess(userId, itemId = 'movies-package-ngorongoro', durationDays = null) {
        try {
            let days = durationDays;
            if (!days || isNaN(days) || Number(days) <= 0) {
                if (itemId === 'movies-package-mikumi') days = 1;
                else if (itemId === 'movies-package-ngorongoro') days = 7;
                else if (itemId === 'movies-package-serengeti') days = 30;
                else if (itemId === 'movies-access') days = 365;
                else if (itemId === 'adult-section-access') days = 3650;
                else if (itemId === 'live-tv-access' || itemId === 'livetv-all') days = 30;
                else days = 3650;
            } else {
                days = parseInt(days, 10);
            }

            const paymentData = {
                userId: userId,
                uid: userId,
                itemId: itemId,
                contentId: itemId,
                amount: 0,
                status: 'COMPLETED',
                method: 'manual_admin_grant',
                description: 'Admin Granted Access: ' + itemId,
                timestamp: new Date().toISOString()
            };
            const docRef = await addDoc(collection(db, "payments"), paymentData);
            
            // Create the subscription record so user gets access immediately
            await this.createSubscription(userId, itemId, docRef.id, days);
            
            // If any movie package was granted, also grant 'movies-access' so all movie pages allow viewing/download
            if (itemId.startsWith('movies-package-') || itemId === 'movies-access') {
                if (itemId !== 'movies-access') {
                    await this.createSubscription(userId, 'movies-access', docRef.id, days);
                }
            }

            return { success: true, id: docRef.id, days };
        } catch (err) {
            console.error("Error granting access:", err);
            return { success: false, message: err.message };
        }
    }

    async revokeUserAccess(userId, itemId = null) {
        try {
            // Find payments where userId matches
            const payments = await this.getAllPayments();
            const toDeletePayments = payments.filter(p => 
                (p.userId === userId || p.uid === userId) && 
                (!itemId || p.itemId === itemId || p.contentId === itemId) && 
                (p.status === 'COMPLETED' || p.method === 'manual_admin_grant')
            );
            
            const deletePromises = toDeletePayments.map(p => deleteDoc(doc(db, "payments", p.id)));
            
            // Delete from subscriptions collection
            let q = query(
                collection(db, "subscriptions"),
                where("userId", "==", userId)
            );
            if (itemId) {
                q = query(
                    collection(db, "subscriptions"),
                    where("userId", "==", userId),
                    where("contentId", "==", itemId)
                );
            }
            const subDocs = await getDocs(q);
            const subDeletePromises = subDocs.docs.map(d => deleteDoc(doc(db, "subscriptions", d.id)));
            
            // If revoking movie package or general revoke, also remove all movie packages from subscriptions
            let movieDeletePromises = [];
            if (!itemId || itemId.startsWith('movies-package-') || itemId === 'movies-access') {
                const movieKeys = ['movies-access', 'movies-package-mikumi', 'movies-package-ngorongoro', 'movies-package-serengeti'];
                const mq = query(
                    collection(db, "subscriptions"),
                    where("userId", "==", userId),
                    where("contentId", "in", movieKeys)
                );
                const mSnap = await getDocs(mq);
                movieDeletePromises = mSnap.docs.map(d => deleteDoc(doc(db, "subscriptions", d.id)));
            }

            await Promise.all([...deletePromises, ...subDeletePromises, ...movieDeletePromises]);
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
            const moviePackageIds = ['movies-access', 'movies-package-mikumi', 'movies-package-ngorongoro', 'movies-package-serengeti', 'movies-subscription'];
            let q;
            if (moviePackageIds.includes(contentId)) {
                q = query(
                    collection(db, "subscriptions"),
                    where("userId", "==", userId),
                    where("contentId", "in", moviePackageIds)
                );
            } else {
                q = query(
                    collection(db, "subscriptions"),
                    where("userId", "==", userId),
                    where("contentId", "==", contentId)
                );
            }

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

    // --- AI CUSTOMER SUPPORT ---
    async sendSupportChat(message, history = [], sessionId = null, userId = null, userPhone = null, image = null) {
        try {
            const res = await fetch(`${this.baseUrl}/api/support/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message, history, sessionId, userId, userPhone, image })
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (err) {
            console.error('Error in sendSupportChat:', err);
            return {
                success: false,
                reply: 'Samahani, kumetokea hitilafu ya mtandao. Tafadhali jaribu tena au tembelea sehemu ya "Msaada" (Help) iliyopo kwenye menyu ya chini ya tovuti yetu.'
            };
        }
    }

    async getAIKnowledge() {
        // 1. Try directly from Firestore client SDK first
        try {
            if (db) {
                const snap = await getDoc(doc(db, 'settings', 'ai_support'));
                if (snap.exists() && snap.data()) {
                    return snap.data();
                }
            }
        } catch (fsErr) {
            console.warn('Client Firestore getDoc ai_support warning:', fsErr);
        }

        // 2. Fallback to server endpoint
        try {
            const tok = sessionStorage.getItem('rajab_admin_token');
            const res = await fetch(`${this.baseUrl}/api/admin/ai-knowledge`, {
                headers: tok ? { 'Authorization': 'Bearer ' + tok } : {}
            });
            if (res.ok) return await res.json();
        } catch (err) {
            console.error('Error getting AI knowledge:', err);
        }
        return null;
    }

    async saveAIKnowledge(knowledge) {
        let savedDirectly = false;

        // 1. Save directly to Firestore via client SDK (guaranteed persistent)
        try {
            if (db) {
                await setDoc(doc(db, 'settings', 'ai_support'), {
                    ...knowledge,
                    lastUpdated: new Date().toISOString()
                }, { merge: true });
                savedDirectly = true;
                console.log('AI Knowledge saved directly to Firestore settings/ai_support');
            }
        } catch (fsErr) {
            console.warn('Client Firestore setDoc ai_support error:', fsErr);
        }

        // 2. Also notify backend server
        let serverOk = false;
        try {
            let tok = sessionStorage.getItem('rajab_admin_token') || '';
            if (auth && auth.currentUser) {
                try {
                    tok = await auth.currentUser.getIdToken(true);
                    sessionStorage.setItem('rajab_admin_token', tok);
                } catch (_) {}
            }

            const res = await fetch(`${this.baseUrl}/api/admin/ai-knowledge`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': tok ? ('Bearer ' + tok) : ''
                },
                body: JSON.stringify(knowledge)
            });
            if (res.ok) {
                const data = await res.json();
                if (data && data.success) serverOk = true;
            }
        } catch (srvErr) {
            console.warn('Server AI knowledge sync warning:', srvErr);
        }

        if (savedDirectly || serverOk) {
            return { success: true, message: 'Mafunzo ya AI yamehifadhiwa kikamilifu!' };
        }

        return { success: false, error: 'Imeshindikana kuhifadhi. Tafadhali jaribu tena.' };
    }

    async getAIStats() {
        // 1. Try server endpoint first
        try {
            let tok = sessionStorage.getItem('rajab_admin_token') || '';
            if (auth && auth.currentUser) {
                try {
                    tok = await auth.currentUser.getIdToken(true);
                    sessionStorage.setItem('rajab_admin_token', tok);
                } catch (_) {}
            }
            const res = await fetch(`${this.baseUrl}/api/admin/ai/stats`, {
                headers: tok ? { 'Authorization': 'Bearer ' + tok } : {}
            });
            if (res.ok) {
                const data = await res.json();
                if (data && data.success) return data;
            }
        } catch (e) {
            console.warn('Server getAIStats notice:', e);
        }

        // 2. Client-side Firestore fallback
        try {
            if (db) {
                const q = query(collection(db, 'ai_chat_logs'), orderBy('timestamp', 'desc'), limit(1000));
                const snap = await getDocs(q);
                const logs = [];
                snap.forEach(d => logs.push({ id: d.id, ...d.data() }));
                if (logs.length > 0) {
                    return this._calculateAIStatsFromLogs(logs);
                }
            }
        } catch (fsErr) {
            console.warn('Client Firestore getAIStats fallback notice:', fsErr);
        }

        return {
            success: true,
            today: { people: 0, messages: 0 },
            yesterday: { people: 0, messages: 0 },
            last7Days: { people: 0, messages: 0 },
            thisMonth: { people: 0, messages: 0 },
            allTime: { people: 0, messages: 0 },
            recentLogs: []
        };
    }

    _calculateAIStatsFromLogs(logs) {
        const now = new Date();
        const eatNow = new Date(now.getTime() + (3 * 3600000));
        const curYear = eatNow.getUTCFullYear();
        const curMonth = eatNow.getUTCMonth();
        const curDate = eatNow.getUTCDate();

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
            allTimeUsers.add(pKey);
            allTimeMessages++;

            if (ts >= startOfTodayMs) {
                todayUsers.add(pKey);
                todayMessages++;
            }
            if (ts >= startOfYesterdayMs && ts < startOfTodayMs) {
                yesterdayUsers.add(pKey);
                yesterdayMessages++;
            }
            if (ts >= startOf7DaysMs) {
                last7DaysUsers.add(pKey);
                last7DaysMessages++;
            }
            if (ts >= startOfMonthMs) {
                thisMonthUsers.add(pKey);
                thisMonthMessages++;
            }
        }

        return {
            success: true,
            today: { people: todayUsers.size, messages: todayMessages },
            yesterday: { people: yesterdayUsers.size, messages: yesterdayMessages },
            last7Days: { people: last7DaysUsers.size, messages: last7DaysMessages },
            thisMonth: { people: thisMonthUsers.size, messages: thisMonthMessages },
            allTime: { people: allTimeUsers.size, messages: allTimeMessages },
            recentLogs: logs.slice(0, 100)
        };
    }

    async getAISelfLearning() {
        try {
            let tok = sessionStorage.getItem('rajab_admin_token') || '';
            if (auth && auth.currentUser) {
                try {
                    tok = await auth.currentUser.getIdToken(true);
                    sessionStorage.setItem('rajab_admin_token', tok);
                } catch (_) {}
            }
            const res = await fetch(`${this.baseUrl}/api/admin/ai/self-learn`, {
                headers: tok ? { 'Authorization': 'Bearer ' + tok } : {}
            });
            if (res.ok) return await res.json();
        } catch (e) {
            console.warn('getAISelfLearning error:', e);
        }
        return {
            success: true,
            summary: 'AI inachambua maongezi ya wateja na kujiongeza uelewa kiotomatiki.',
            topicsIdentified: [],
            activeInsights: [],
            history: []
        };
    }

    async runAISelfLearning() {
        try {
            let tok = sessionStorage.getItem('rajab_admin_token') || '';
            if (auth && auth.currentUser) {
                try {
                    tok = await auth.currentUser.getIdToken(true);
                    sessionStorage.setItem('rajab_admin_token', tok);
                } catch (_) {}
            }
            const res = await fetch(`${this.baseUrl}/api/admin/ai/self-learn`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': tok ? ('Bearer ' + tok) : ''
                }
            });
            return await res.json();
        } catch (e) {
            console.error('runAISelfLearning error:', e);
            return { success: false, error: e.message };
        }
    }

    async deleteAILearnedInsight(id) {
        try {
            let tok = sessionStorage.getItem('rajab_admin_token') || '';
            if (auth && auth.currentUser) {
                try {
                    tok = await auth.currentUser.getIdToken(true);
                    sessionStorage.setItem('rajab_admin_token', tok);
                } catch (_) {}
            }
            const res = await fetch(`${this.baseUrl}/api/admin/ai/self-learn/${encodeURIComponent(id)}`, {
                method: 'DELETE',
                headers: tok ? { 'Authorization': 'Bearer ' + tok } : {}
            });
            return await res.json();
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    async getAIChatLogs() {
        try {
            const res = await fetch(`${this.baseUrl}/api/admin/ai-chat-logs`, {
                headers: { 'Authorization': 'Bearer ' + sessionStorage.getItem('rajab_admin_token') }
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (err) {
            console.error('Error getting AI chat logs:', err);
            return [];
        }
    }

        async clearAIChatLogs() {
        try {
            const res = await fetch(`${this.baseUrl}/api/admin/ai-chat-logs`, {
                method: 'DELETE',
                headers: { 'Authorization': 'Bearer ' + sessionStorage.getItem('rajab_admin_token') }
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (err) {
            console.error('Error clearing AI chat logs:', err);
            return { success: false, error: err.message };
        }
    }

    async getAICatalog() {
        try {
            const res = await fetch(`${this.baseUrl}/api/admin/ai/catalog`, {
                headers: { 'Authorization': 'Bearer ' + sessionStorage.getItem('rajab_admin_token') }
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (err) {
            console.error('Error getting AI catalog:', err);
            return { success: false, count: 0, items: [] };
        }
    }

    async syncAICatalog(items) {
        try {
            const res = await fetch(`${this.baseUrl}/api/admin/ai/sync-catalog`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + sessionStorage.getItem('rajab_admin_token')
                },
                body: JSON.stringify({ items })
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (err) {
            console.error('Error syncing AI catalog:', err);
            return { success: false, error: err.message };
        }
    }

    async trainAICorrection(question, answer) {
        try {
            const res = await fetch(`${this.baseUrl}/api/admin/ai/train-correction`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + sessionStorage.getItem('rajab_admin_token')
                },
                body: JSON.stringify({ question, answer })
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (err) {
            console.error('Error training AI correction:', err);
            return { success: false, error: err.message };
        }
    }

    async getAIAccessGrants() {
        try {
            const res = await fetch(`${this.baseUrl}/api/admin/ai/access-grants`, {
                headers: { 'Authorization': 'Bearer ' + sessionStorage.getItem('rajab_admin_token') }
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (err) {
            console.error('Error getting AI access grants:', err);
            return [];
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
