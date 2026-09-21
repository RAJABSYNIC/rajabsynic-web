// Import Firebase functionality from the CDN
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, getDocs, addDoc, setDoc, getDoc, doc, updateDoc, deleteDoc, query, where, orderBy, limit, onSnapshot } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signInAnonymously, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";

// Load config from the server (values come from .env, nothing hardcoded here).
// Fallback to the known public Firebase keys so the app still loads even when the
// config endpoint is temporarily unavailable or blocked.
const defaultFirebaseConfig = {
  apiKey: "AIzaSyCE7Kk23t6490SDSTujHL1SKg2AzMNsHTo",
  authDomain: "rajabsynicmob.firebaseapp.com",
  projectId: "rajabsynicmob",
  storageBucket: "rajabsynicmob.firebasestorage.app",
  messagingSenderId: "519704126018",
  appId: "1:519704126018:web:da0f0a911de5b21bc283db"
};

let firebaseConfig = { ...defaultFirebaseConfig };
try {
  const res = await fetch('/api/public-config');
  if (res.ok) {
    const cfg = await res.json();
    firebaseConfig = { ...firebaseConfig, ...(cfg.firebase || {}) };
    if (cfg.oneSignalAppId) window.__ONESIGNAL_APP_ID__ = cfg.oneSignalAppId;
  } else {
    console.warn('⚠️ /api/public-config returned non-OK status, using fallback Firebase config');
  }
} catch (err) {
  console.warn('⚠️ Failed to load public config from /api/public-config, using fallback Firebase config:', err);
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
