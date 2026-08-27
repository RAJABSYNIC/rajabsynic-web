// Import Firebase functionality from the CDN
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, getDocs, addDoc, setDoc, getDoc, doc, updateDoc, deleteDoc, query, where, orderBy, limit, onSnapshot } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signInAnonymously, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";

// Load config from the server (values come from .env, nothing hardcoded here).
// Top-level await is supported because all scripts load as ES modules.
let firebaseConfig;
try {
  const res = await fetch('/api/public-config');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const cfg = await res.json();
  firebaseConfig = cfg.firebase;
  // Expose OneSignal app id for index.html to pick up
  if (cfg.oneSignalAppId) window.__ONESIGNAL_APP_ID__ = cfg.oneSignalAppId;
} catch (err) {
  console.error('❌ Failed to load public config from /api/public-config:', err);
  throw err;
}

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Modern offline cache with multi-tab support. Replaces the deprecated
// enableIndexedDbPersistence() and avoids the "exclusive access" error when
// the app is open in multiple tabs (e.g. main app + admin panel).
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

const auth = getAuth(app);

// Initialize Secondary App for Admin User Creation (prevents logout when creating users)
const secondaryApp = initializeApp(firebaseConfig, "Secondary");
const secondaryAuth = getAuth(secondaryApp);

export { app, db, auth, secondaryAuth, collection, getDocs, addDoc, setDoc, getDoc, doc, updateDoc, deleteDoc, query, where, orderBy, limit, signInWithEmailAndPassword, createUserWithEmailAndPassword, signInAnonymously, signOut, onAuthStateChanged, onSnapshot };
