// ─── IMPORTANT: Replace the firebaseConfig below with YOUR project's config
// from Firebase Console → Project Settings → Your apps → Config
// See SETUP-GUIDE.md for step-by-step instructions

import { useState, useEffect } from "react";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, onSnapshot, serverTimestamp,
  enableIndexedDbPersistence
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ── REPLACE THIS with your Firebase config ────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyCFxjYuM13lCjJFH8ae2QFqa5e48cQrxIk",
  authDomain: "dugout-app-d1da0.firebaseapp.com",
  projectId: "dugout-app-d1da0",
  storageBucket: "dugout-app-d1da0.firebasestorage.app",
  messagingSenderId: "1071549583531",
  appId: "1:1071549583531:web:1f7808ac0b717d75efa7ee"
};
// ─────────────────────────────────────────────────────────────────────────────

const firebaseApp = initializeApp(firebaseConfig);
const auth        = getAuth(firebaseApp);
const db          = getFirestore(firebaseApp);
const provider    = new GoogleAuthProvider();

// ── Enable offline persistence ────────────────────────────────────────────────
// Data saves locally on device and syncs to cloud when connection returns.
enableIndexedDbPersistence(db).catch(err => {
  if (err.code === "failed-precondition") {
    // Multiple tabs open — persistence only works in one tab at a time
    console.warn("Offline persistence unavailable: multiple tabs open.");
  } else if (err.code === "unimplemented") {
    // Browser doesn't support it (rare on modern iOS Safari)
    console.warn("Offline persistence not supported on this browser.");
  }
});

// ── Firestore helpers ─────────────────────────────────────────────────────────

// Generate a random 6-char alphanumeric join code
function genCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Team data path
const teamDoc  = (teamId) => `teams/${teamId}/data/dugout`;
const teamMeta = (teamId) => `teams/${teamId}`;
const userDoc  = (uid)    => `users/${uid}`;

async function getUserMembership(uid) {
  try {
    const snap = await getDoc(doc(db, userDoc(uid)));
    return snap.exists() ? snap.data() : null;
  } catch (e) { return null; }
}

async function createTeam(uid, displayName) {
  const teamId   = genCode();
  const joinCode = genCode();
  // Store team metadata
  await setDoc(doc(db, teamMeta(teamId)), {
    teamId, joinCode, createdBy: uid,
    createdAt: serverTimestamp(),
    members: [uid],
  });
  // Store empty data doc
  await setDoc(doc(db, teamDoc(teamId)), {});
  // Link user to team
  await setDoc(doc(db, userDoc(uid)), { teamId, joinCode, role: "owner", displayName });
  return { teamId, joinCode };
}

async function joinTeam(uid, joinCode, displayName) {
  // Find the team with this join code
  // We store joinCode on the team meta doc — search by scanning (small scale is fine)
  // For simplicity we store teamId = joinCode prefix approach:
  // Actually we'll look up by reading teams/{joinCode} — we use joinCode as teamId too
  // Simpler: joinCode IS the teamId for lookup
  const snap = await getDoc(doc(db, teamMeta(joinCode)));
  if (!snap.exists()) return { error: "Team not found. Check your code and try again." };
  const teamData = snap.data();
  // Add user to members list
  const members = [...(teamData.members || [])];
  if (!members.includes(uid)) members.push(uid);
  await setDoc(doc(db, teamMeta(joinCode)), { ...teamData, members }, { merge: true });
  // Link user to team
  await setDoc(doc(db, userDoc(uid)), { teamId: joinCode, joinCode, role: "member", displayName });
  return { teamId: joinCode, joinCode };
}

async function leaveTeam(uid) {
  await setDoc(doc(db, userDoc(uid)), { teamId: null, joinCode: null }, { merge: true });
}

async function loadTeamData(teamId) {
  try {
    const snap = await getDoc(doc(db, teamDoc(teamId)));
    return snap.exists() ? snap.data() : {};
  } catch (e) { return {}; }
}

async function saveTeamField(teamId, field, value) {
  try {
    await setDoc(doc(db, teamDoc(teamId)), { [field]: JSON.stringify(value) }, { merge: true });
  } catch (e) { console.error("saveTeamField:", e); }
}

async function loadTeamMeta(teamId) {
  try {
    const snap = await getDoc(doc(db, teamMeta(teamId)));
    return snap.exists() ? snap.data() : null;
  } catch (e) { return null; }
}

async function submitFeedback(entry) {
  try {
    await setDoc(doc(db, `feedback/fb_${Date.now()}`), entry);
    return true;
  } catch (e) { return false; }
}

// ── App data defaults ─────────────────────────────────────────────────────────
const defaultMyTeam = {
  name: "My Team",
  roster: [],
};

const mkStat     = (id) => ({ id, ab:0, h:0, "1b":0, "2b":0, "3b":0, hr:0, rbi:0, bb:0, k:0, r:0, rob:0 });
const POSITIONS  = ["P","C","1B","2B","3B","SS","LF","CF","RF","DH","OF","IF"];
const emptyBases = () => ({ first:null, second:null, third:null });

function newGame(myTeamName, oppName) {
  return {
    id: Date.now(), myTeamName, oppName,
    date: new Date().toLocaleDateString(),
    innings: Array(7).fill(null).map(() => ({ us:null, them:null })),
    balls:0, strikes:0, outs:0,
    inning:1, half:"top", final:false,
    myBatterIdx:0, oppBatterIdx:0,
    myBases: emptyBases(),
    oppBases: emptyBases(),
  };
}

function advanceRunners(bases, numBases) {
  const order = ["first","second","third"];
  let newBases = { ...bases };
  let runsScored = [];
  for (let i = 2; i >= 0; i--) {
    const base = order[i], runner = newBases[base];
    if (!runner) continue;
    const newPos = i + numBases;
    if (newPos >= 3) { runsScored.push(runner); newBases[base] = null; }
    else             { newBases[order[newPos]] = runner; newBases[base] = null; }
  }
  return { newBases, runsScored };
}

function moveRunner(bases, fromBase) {
  const order = ["first","second","third"];
  const idx   = order.indexOf(fromBase);
  const runner = bases[fromBase];
  if (idx === -1 || !runner) return { newBases: bases, scored: null };
  const newBases = { ...bases, [fromBase]: null };
  if (idx === 2) return { newBases, scored: runner };
  newBases[order[idx+1]] = runner;
  return { newBases, scored: null };
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = `
  @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@400;500;600&display=swap');
  *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
  :root {
    --navy:#0d1b2a; --navy2:#1a2d42; --navy3:#243a52;
    --gold:#f5c518; --gold2:#ffd84d; --red:#e63946;
    --green:#2dc653; --blue:#4895ef; --orange:#f4781f;
    --white:#f0f4f8; --muted:#8a9bb0; --card:#162333; --border:#2a3d52;
  }
  body { background:var(--navy); color:var(--white); font-family:'DM Sans',sans-serif; min-height:100vh; }
  .app { max-width:480px; margin:0 auto; min-height:100vh; display:flex; flex-direction:column; }

  /* Auth / setup screens */
  .center-screen { display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:100vh; padding:32px; gap:20px; }
  .login-icon { font-size:64px; }
  .login-title { font-family:'Bebas Neue',sans-serif; font-size:48px; color:var(--gold); letter-spacing:4px; }
  .login-sub { font-size:14px; color:var(--muted); text-align:center; line-height:1.6; max-width:280px; }
  .login-btn { display:flex; align-items:center; gap:12px; padding:14px 28px; background:var(--white); border:none; border-radius:12px; font-size:15px; font-weight:600; color:#1a1a1a; cursor:pointer; }
  .login-error { font-size:12px; color:var(--red); text-align:center; }

  /* Team setup */
  .setup-card { background:var(--card); border:1px solid var(--border); border-radius:16px; padding:24px; width:100%; max-width:360px; }
  .setup-title { font-family:'Bebas Neue',sans-serif; font-size:22px; color:var(--gold); letter-spacing:1px; margin-bottom:4px; }
  .setup-sub { font-size:12px; color:var(--muted); margin-bottom:16px; line-height:1.5; }
  .setup-divider { display:flex; align-items:center; gap:10px; margin:16px 0; }
  .setup-divider-line { flex:1; height:1px; background:var(--border); }
  .setup-divider-text { font-size:11px; color:var(--muted); }
  .join-code-display { font-family:'Bebas Neue',sans-serif; font-size:36px; letter-spacing:6px; color:var(--gold2); text-align:center; background:var(--navy2); border-radius:12px; padding:16px; border:1px solid var(--gold); margin:12px 0; }
  .join-code-hint { font-size:11px; color:var(--muted); text-align:center; }
  .code-input { width:100%; padding:12px; background:var(--navy2); border:1px solid var(--border); border-radius:8px; color:var(--white); font-family:'Bebas Neue',sans-serif; font-size:24px; letter-spacing:4px; text-align:center; text-transform:uppercase; outline:none; margin-bottom:8px; }
  .code-input:focus { border-color:var(--gold); }

  .header { background:linear-gradient(135deg,var(--navy2),var(--navy3)); padding:16px 20px 0; border-bottom:2px solid var(--gold); position:sticky; top:0; z-index:100; }
  .header-top { display:flex; align-items:center; gap:10px; margin-bottom:14px; }
  .header-icon { font-size:28px; }
  .header-title { font-family:'Bebas Neue',sans-serif; font-size:26px; color:var(--gold); letter-spacing:2px; line-height:1; }
  .header-sub { font-size:11px; color:var(--muted); letter-spacing:1px; text-transform:uppercase; }
  .record { font-family:'Bebas Neue',sans-serif; font-size:13px; letter-spacing:1px; }
  .record .w { color:var(--green); } .record .l { color:var(--red); }
  .signout-btn { font-size:11px; color:var(--muted); background:transparent; border:1px solid var(--border); border-radius:6px; padding:3px 8px; cursor:pointer; }
  .nav { display:flex; }
  .nav-btn { flex:1; padding:8px 2px; background:transparent; border:none; font-size:10px; font-weight:600; color:var(--muted); cursor:pointer; letter-spacing:1px; text-transform:uppercase; border-bottom:2px solid transparent; transition:all 0.2s; display:flex; flex-direction:column; align-items:center; gap:3px; }
  .nav-btn.active { color:var(--gold); border-bottom-color:var(--gold); }
  .nav-icon { font-size:15px; }

  .content { flex:1; padding:16px; overflow-y:auto; padding-bottom:40px; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:16px; margin-bottom:12px; }
  .card-title { font-family:'Bebas Neue',sans-serif; font-size:18px; color:var(--gold); letter-spacing:1px; margin-bottom:12px; }
  .section-title { font-family:'Bebas Neue',sans-serif; font-size:13px; color:var(--muted); letter-spacing:2px; margin-bottom:10px; text-transform:uppercase; }

  .scoreboard { background:linear-gradient(145deg,var(--navy2),var(--card)); border:1px solid var(--border); border-radius:16px; overflow:hidden; margin-bottom:12px; }
  .score-header { background:var(--navy3); padding:10px 16px; display:flex; justify-content:space-between; align-items:center; }
  .score-label { font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:1px; }
  .game-status { font-size:12px; font-weight:600; color:var(--green); }
  .game-status.final { color:var(--muted); }
  .score-main { display:grid; grid-template-columns:1fr auto 1fr; align-items:center; padding:16px; gap:8px; }
  .team-score { text-align:center; }
  .t-name { font-family:'Bebas Neue',sans-serif; font-size:13px; letter-spacing:1px; color:var(--muted); margin-bottom:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:110px; }
  .t-name.us { color:var(--gold); }
  .score-num { font-family:'Bebas Neue',sans-serif; font-size:48px; line-height:1; color:var(--white); }
  .score-num.us { color:var(--gold2); }
  .score-divider { font-family:'Bebas Neue',sans-serif; font-size:28px; color:var(--border); }
  .inning-row { display:flex; border-top:1px solid var(--border); }
  .inning-cell { flex:1; text-align:center; padding:5px 1px; border-right:1px solid var(--border); font-size:10px; }
  .inning-cell:last-child { border-right:none; }
  .inning-cell.ih { font-size:9px; color:var(--muted); font-weight:600; }
  .inning-cell.us { color:var(--gold); font-weight:600; }
  .inning-cell.tot { background:var(--navy3); font-weight:700; }
  .half-tag { font-size:9px; padding:2px 5px; border-radius:8px; cursor:pointer; border:1px solid var(--border); background:transparent; color:var(--muted); }
  .half-tag.active { background:var(--gold); border-color:var(--gold); color:var(--navy); font-weight:700; }

  .score-controls { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:10px; }
  .score-ctrl { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:10px; }
  .ctrl-label { font-size:10px; color:var(--muted); text-transform:uppercase; letter-spacing:1px; margin-bottom:6px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .ctrl-label.us { color:var(--gold); }
  .ctrl-btns { display:flex; align-items:center; gap:8px; justify-content:center; }
  .ctrl-btn { width:30px; height:30px; border-radius:50%; border:1px solid var(--border); background:var(--navy2); color:var(--white); font-size:18px; cursor:pointer; display:flex; align-items:center; justify-content:center; font-weight:600; }
  .ctrl-btn:active { transform:scale(0.9); }
  .ctrl-val { font-family:'Bebas Neue',sans-serif; font-size:26px; min-width:28px; text-align:center; }
  .ctrl-val.us { color:var(--gold2); }

  .ab-panel { background:var(--card); border:1px solid var(--border); border-radius:14px; margin-bottom:10px; overflow:hidden; }
  .batter-row { display:flex; align-items:center; gap:10px; padding:10px 14px; border-bottom:1px solid var(--border); }
  .batter-num { font-family:'Bebas Neue',sans-serif; font-size:26px; color:var(--gold); min-width:30px; text-align:center; }
  .batter-info { flex:1; }
  .batter-name { font-size:15px; font-weight:600; }
  .batter-sub { font-size:11px; color:var(--muted); }
  .batter-nav-btn { width:28px; height:28px; border-radius:50%; border:1px solid var(--border); background:var(--navy2); color:var(--muted); font-size:15px; cursor:pointer; display:flex; align-items:center; justify-content:center; }

  .lineup-scroll { display:flex; gap:6px; padding:8px 14px; overflow-x:auto; border-bottom:1px solid var(--border); -webkit-overflow-scrolling:touch; }
  .lineup-scroll::-webkit-scrollbar { height:3px; }
  .lineup-chip { flex-shrink:0; padding:4px 8px; border-radius:16px; border:1px solid var(--border); background:var(--navy2); cursor:pointer; text-align:center; transition:all 0.15s; }
  .lineup-chip.active { border-color:var(--gold); background:rgba(245,197,24,0.12); }
  .lineup-chip.them.active { border-color:var(--white); background:rgba(240,244,248,0.1); }
  .lineup-chip-num { font-family:'Bebas Neue',sans-serif; font-size:12px; color:var(--gold); }
  .lineup-chip-num.them { color:var(--muted); }
  .lineup-chip.active .lineup-chip-num { color:var(--gold2); }
  .lineup-chip.them.active .lineup-chip-num { color:var(--white); }
  .lineup-chip-name { font-size:9px; color:var(--muted); white-space:nowrap; }

  .diamond-wrap { padding:12px 14px; border-bottom:1px solid var(--border); background:var(--navy2); }
  .diamond-label { font-size:9px; color:var(--muted); text-transform:uppercase; letter-spacing:1.5px; margin-bottom:8px; }
  .diamond-svg-wrap { position:relative; width:220px; height:220px; margin:0 auto; }
  .diamond-svg { width:100%; height:100%; }
  /* Floating runner badges positioned over SVG bases */
  .runner-badge {
    position:absolute; display:flex; flex-direction:column; align-items:center; justify-content:center;
    width:46px; height:46px; border-radius:8px; cursor:pointer;
    transition:transform 0.15s, box-shadow 0.15s;
    box-shadow: 0 2px 8px rgba(0,0,0,0.4);
  }
  .runner-badge:active { transform:scale(0.93); }
  .runner-badge.us   { background:rgba(245,197,24,0.9); border:2px solid var(--gold2); }
  .runner-badge.them { background:rgba(240,244,248,0.85); border:2px solid var(--white); }
  .runner-badge-num  { font-family:'Bebas Neue',sans-serif; font-size:15px; line-height:1; color:var(--navy); }
  .runner-badge-name { font-size:7px; font-weight:700; color:var(--navy); white-space:nowrap; overflow:hidden; max-width:42px; text-overflow:ellipsis; }
  .run-flash { font-size:11px; font-weight:700; color:var(--green); text-align:center; margin-top:6px; min-height:16px; }

  /* Home plate confirmation modal */
  .homeplate-overlay { position:fixed; inset:0; background:rgba(0,0,0,0.7); z-index:300; display:flex; align-items:center; justify-content:center; padding:24px; }
  .homeplate-modal { background:var(--navy2); border:2px solid var(--gold); border-radius:16px; padding:24px; width:100%; max-width:320px; text-align:center; }
  .homeplate-icon { font-size:40px; margin-bottom:8px; }
  .homeplate-title { font-family:'Bebas Neue',sans-serif; font-size:22px; color:var(--gold); letter-spacing:2px; margin-bottom:4px; }
  .homeplate-runner { font-size:14px; font-weight:600; margin-bottom:4px; }
  .homeplate-sub { font-size:12px; color:var(--muted); margin-bottom:20px; }
  .homeplate-btns { display:flex; flex-direction:column; gap:8px; }
  .homeplate-btn { padding:14px; border-radius:12px; border:none; font-family:'Bebas Neue',sans-serif; font-size:20px; letter-spacing:2px; cursor:pointer; transition:all 0.15s; }
  .homeplate-btn:active { transform:scale(0.97); }
  .homeplate-btn.safe { background:var(--green); color:var(--navy); }
  .homeplate-btn.out  { background:var(--red);   color:var(--white); }
  .homeplate-btn.back { background:var(--navy3); color:var(--muted); border:1px solid var(--border); font-size:16px; }

  .runner-menu-overlay { position:fixed; inset:0; z-index:200; }
  .runner-menu { position:absolute; z-index:201; background:var(--navy2); border:1px solid var(--gold); border-radius:12px; padding:8px; min-width:130px; box-shadow:0 4px 20px rgba(0,0,0,0.5); }
  .runner-menu-name { font-size:11px; font-weight:700; color:var(--gold); padding:2px 6px 6px; border-bottom:1px solid var(--border); margin-bottom:6px; white-space:nowrap; }
  .runner-menu-btn { display:block; width:100%; text-align:left; padding:7px 10px; background:transparent; border:none; color:var(--white); font-size:13px; cursor:pointer; border-radius:8px; font-family:'DM Sans',sans-serif; }
  .runner-menu-btn:hover { background:var(--navy3); }
  .runner-menu-btn.danger { color:var(--red); }

  .hit-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:6px; padding:10px 14px; border-bottom:1px solid var(--border); }
  .undo-bar { padding:8px 14px 0; display:flex; justify-content:flex-end; }
  .undo-btn { display:flex; align-items:center; gap:5px; padding:5px 12px; border-radius:8px; border:1px solid var(--border); background:var(--navy2); color:var(--muted); font-size:12px; cursor:pointer; }
  .undo-btn:not(:disabled):hover { border-color:var(--gold); color:var(--gold); }
  .undo-btn:disabled { opacity:0.3; cursor:default; }
  .hit-btn { padding:9px 4px; border-radius:10px; border:1.5px solid transparent; background:var(--navy2); cursor:pointer; text-align:center; transition:all 0.15s; }
  .hit-btn:active { transform:scale(0.95); filter:brightness(1.2); }
  .hit-btn:disabled { opacity:0.4; cursor:default; }
  .hit-btn-icon { font-size:16px; display:block; margin-bottom:2px; }
  .hit-btn-label { font-family:'Bebas Neue',sans-serif; font-size:12px; letter-spacing:1px; display:block; }
  .hit-btn.single    { border-color:#4895ef; } .hit-btn.single .hit-btn-label    { color:#4895ef; }
  .hit-btn.double    { border-color:#2dc653; } .hit-btn.double .hit-btn-label    { color:#2dc653; }
  .hit-btn.triple    { border-color:#f4781f; } .hit-btn.triple .hit-btn-label    { color:#f4781f; }
  .hit-btn.homer     { border-color:#e63946; } .hit-btn.homer .hit-btn-label     { color:#e63946; }
  .hit-btn.walk      { border-color:#8a9bb0; } .hit-btn.walk .hit-btn-label      { color:var(--muted); }
  .hit-btn.strikeout { border-color:#8a9bb0; } .hit-btn.strikeout .hit-btn-label { color:var(--muted); }
  .hit-btn.out       { border-color:#8a9bb0; } .hit-btn.out .hit-btn-label       { color:var(--muted); }
  .hit-btn.pitch-k   { border-color:#e63946; } .hit-btn.pitch-k .hit-btn-label   { color:#e63946; }
  .hit-btn.pitch-b   { border-color:#4895ef; } .hit-btn.pitch-b .hit-btn-label   { color:#4895ef; }

  .ab-log { padding:6px 14px 10px; max-height:80px; overflow-y:auto; }
  .ab-log-item { display:flex; align-items:center; gap:6px; font-size:11px; padding:3px 0; border-bottom:1px solid var(--border); }
  .ab-log-item:last-child { border-bottom:none; }
  .ab-log-result { font-family:'Bebas Neue',sans-serif; font-size:12px; min-width:36px; }
  .ab-log-name { color:var(--muted); flex:1; }
  .ab-log-inn { color:var(--border); font-size:10px; }
  .result-1B { color:#4895ef; } .result-2B { color:#2dc653; } .result-3B { color:#f4781f; }
  .result-HR { color:#e63946; } .result-K  { color:var(--muted); } .result-BB { color:var(--muted); }
  .result-OUT { color:var(--muted); } .result-ROB { color:var(--red); }

  .stats-table { width:100%; border-collapse:collapse; font-size:12px; }
  .stats-table th { padding:6px 4px; text-align:center; color:var(--muted); font-size:10px; text-transform:uppercase; border-bottom:1px solid var(--border); }
  .stats-table th:first-child { text-align:left; }
  .stats-table td { padding:8px 4px; text-align:center; border-bottom:1px solid var(--border); }
  .stats-table td:first-child { text-align:left; }
  .stats-table tr:last-child td { border-bottom:none; }
  .avg-badge { font-family:'Bebas Neue',sans-serif; font-size:14px; color:var(--gold2); }
  .stat-inc { background:transparent; border:none; color:var(--gold); font-size:15px; cursor:pointer; padding:0 2px; }

  .player-card { display:flex; align-items:center; gap:10px; padding:10px; background:var(--card); border:1px solid var(--border); border-radius:10px; margin-bottom:8px; }
  .player-num { font-family:'Bebas Neue',sans-serif; font-size:20px; color:var(--gold); min-width:26px; text-align:center; }
  .player-info { flex:1; min-width:0; }
  .player-name { font-weight:600; font-size:13px; }
  .player-pos-sub { font-size:11px; color:var(--muted); margin-top:2px; }
  .pos-badge { display:inline-block; padding:1px 6px; border-radius:6px; font-size:10px; font-weight:700; background:var(--navy3); color:var(--gold); border:1px solid var(--border); }
  .order-badge { font-family:'Bebas Neue',sans-serif; font-size:14px; color:var(--muted); min-width:18px; text-align:center; }

  .team-tabs { display:flex; gap:6px; margin-bottom:14px; overflow-x:auto; padding-bottom:4px; }
  .team-tab { flex-shrink:0; padding:7px 12px; border-radius:8px; border:1px solid var(--border); background:transparent; color:var(--muted); font-size:12px; font-weight:600; cursor:pointer; white-space:nowrap; transition:all 0.2s; }
  .team-tab.active { background:var(--gold); border-color:var(--gold); color:var(--navy); }
  .opp-pick { padding:10px 12px; border-radius:10px; margin-bottom:6px; cursor:pointer; border:1px solid var(--border); background:var(--navy2); display:flex; justify-content:space-between; align-items:center; transition:all 0.15s; }
  .opp-pick.selected { border-color:var(--gold); background:rgba(245,197,24,0.08); }

  .game-row { display:flex; align-items:center; gap:10px; padding:10px; background:var(--card); border:1px solid var(--border); border-radius:10px; margin-bottom:4px; cursor:pointer; transition:background 0.15s; }
  .game-row:hover { background:var(--navy2); }
  .game-row.expanded { border-color:var(--gold); border-bottom-left-radius:0; border-bottom-right-radius:0; margin-bottom:0; }
  .pbp-panel { background:var(--navy2); border:1px solid var(--gold); border-top:none; border-bottom-left-radius:10px; border-bottom-right-radius:10px; margin-bottom:12px; overflow:hidden; }
  .pbp-inning-header { padding:6px 12px; background:var(--navy3); font-family:'Bebas Neue',sans-serif; font-size:13px; color:var(--muted); letter-spacing:2px; border-bottom:1px solid var(--border); }
  .pbp-entry { display:flex; align-items:center; gap:8px; padding:7px 12px; border-bottom:1px solid var(--border); font-size:12px; }
  .pbp-entry:last-child { border-bottom:none; }
  .pbp-result { font-family:'Bebas Neue',sans-serif; font-size:13px; min-width:36px; }
  .pbp-name { flex:1; color:var(--white); }
  .pbp-team { font-size:10px; color:var(--muted); }
  .game-result { font-family:'Bebas Neue',sans-serif; font-size:22px; min-width:24px; }
  .game-result.w { color:var(--green); } .game-result.l { color:var(--red); } .game-result.t { color:var(--muted); }
  .score-pill { font-family:'Bebas Neue',sans-serif; font-size:16px; background:var(--navy3); padding:4px 10px; border-radius:8px; }

  .text-input { width:100%; padding:10px 12px; background:var(--navy2); border:1px solid var(--border); border-radius:8px; color:var(--white); font-size:14px; outline:none; margin-bottom:8px; }
  .text-input:focus { border-color:var(--gold); }
  .select-input { flex:1; padding:8px 10px; background:var(--navy2); border:1px solid var(--border); border-radius:8px; color:var(--white); font-size:13px; outline:none; }
  .form-label { font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:1px; margin-bottom:6px; }
  .form-row { display:flex; gap:8px; margin-bottom:8px; align-items:center; }
  .form-row .text-input { margin-bottom:0; }
  .btn-gold { width:100%; padding:12px; border-radius:10px; background:linear-gradient(135deg,var(--gold),var(--gold2)); border:none; color:var(--navy); font-family:'Bebas Neue',sans-serif; font-size:18px; letter-spacing:2px; cursor:pointer; margin-bottom:10px; }
  .btn-gold:disabled { opacity:0.5; cursor:default; }
  .btn-outline { width:100%; padding:10px; border-radius:10px; background:transparent; border:1px solid var(--green); color:var(--green); font-size:13px; font-weight:600; cursor:pointer; margin-bottom:8px; }
  .btn-outline.gold { border-color:var(--gold); color:var(--gold); }
  .btn-outline.blue { border-color:var(--blue); color:var(--blue); }
  .btn-outline.red  { border-color:var(--red);  color:var(--red);  }
  .btn-sm { padding:5px 10px; border-radius:8px; border:1px solid var(--border); background:var(--navy2); color:var(--white); font-size:12px; cursor:pointer; white-space:nowrap; }
  .btn-sm.gold  { border-color:var(--gold);  color:var(--gold);  }
  .btn-sm.red   { border-color:var(--red);   color:var(--red);   }
  .btn-sm.green { border-color:var(--green); color:var(--green); }
  .btn-sm.blue  { border-color:var(--blue);  color:var(--blue);  }
  .row { display:flex; align-items:center; gap:8px; }
  .ml-auto { margin-left:auto; }
  .empty { text-align:center; color:var(--muted); font-size:13px; padding:28px 0; }
  .sync-dot { width:7px; height:7px; border-radius:50%; background:var(--green); display:inline-block; margin-right:4px; }
  .sync-dot.saving { background:var(--gold); }

  /* Feedback */
  .fb-type-row { display:flex; gap:6px; margin-bottom:12px; }
  .fb-type-btn { flex:1; padding:8px 4px; border-radius:8px; border:1px solid var(--border); background:transparent; color:var(--muted); font-size:12px; font-weight:600; cursor:pointer; text-align:center; transition:all 0.15s; }
  .fb-type-btn.active.bug     { border-color:var(--red);   color:var(--red);   background:rgba(230,57,70,0.1); }
  .fb-type-btn.active.idea    { border-color:var(--gold);  color:var(--gold);  background:rgba(245,197,24,0.1); }
  .fb-type-btn.active.praise  { border-color:var(--green); color:var(--green); background:rgba(45,198,83,0.1); }
  .fb-type-btn.active.other   { border-color:var(--blue);  color:var(--blue);  background:rgba(72,149,239,0.1); }
  .fb-textarea { width:100%; padding:12px; background:var(--navy2); border:1px solid var(--border); border-radius:8px; color:var(--white); font-size:14px; font-family:'DM Sans',sans-serif; outline:none; resize:vertical; min-height:100px; margin-bottom:10px; }
  .fb-textarea:focus { border-color:var(--gold); }
  .fb-log-item { padding:10px 12px; background:var(--navy2); border:1px solid var(--border); border-radius:10px; margin-bottom:8px; }
  .fb-log-meta { display:flex; align-items:center; gap:6px; margin-bottom:4px; }
  .fb-log-type { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:1px; padding:2px 6px; border-radius:4px; }
  .fb-log-type.bug    { color:var(--red);   background:rgba(230,57,70,0.15); }
  .fb-log-type.idea   { color:var(--gold);  background:rgba(245,197,24,0.15); }
  .fb-log-type.praise { color:var(--green); background:rgba(45,198,83,0.15); }
  .fb-log-type.other  { color:var(--blue);  background:rgba(72,149,239,0.15); }
  .fb-log-date { font-size:10px; color:var(--muted); margin-left:auto; }
  .fb-log-text { font-size:13px; color:var(--white); line-height:1.5; }
`;

// ── Diamond ───────────────────────────────────────────────────────────────────
// SVG viewBox is 220x220. Key coordinates:
//   Home:   (110, 188)
//   First:  (188, 110)
//   Second: (110, 32)
//   Third:  (32,  110)
// Runner badge centers (top-left corner for absolute positioning):
//   First:  right:8px,  top:50%, translateY(-50%)  → approx (166, 87)
//   Second: top:4px,    left:50%, translateX(-50%)  → approx (87,  4)
//   Third:  left:8px,   top:50%, translateY(-50%)  → approx (0,   87)

function Diamond({ bases, isMyTeam, onAction }) {
  const [menu, setMenu] = useState(null);

  const BASE_CONFIG = [
    { key:"first",  label:"1B", nextLabel:"→ 2nd",   prevLabel:null,      badgeStyle:{ right:4,  top:"50%", transform:"translateY(-50%)" } },
    { key:"second", label:"2B", nextLabel:"→ 3rd",   prevLabel:"← 1st",  badgeStyle:{ top:4,    left:"50%", transform:"translateX(-50%)" } },
    { key:"third",  label:"3B", nextLabel:"→ Score", prevLabel:"← 2nd",  badgeStyle:{ left:4,   top:"50%", transform:"translateY(-50%)" } },
  ];

  const openMenu = (e, key) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setMenu({ baseKey:key, x:rect.left, y:rect.bottom+6 });
  };
  const closeMenu = () => setMenu(null);
  const act = (action) => { onAction(menu.baseKey, action); closeMenu(); };
  const activeConfig = menu ? BASE_CONFIG.find(b=>b.key===menu.baseKey) : null;
  const menuRunner   = menu ? bases[menu.baseKey] : null;

  return (
    <>
      <div className="diamond-svg-wrap">
        {/* ── Illustrated SVG field ── */}
        <svg className="diamond-svg" viewBox="0 0 220 220" xmlns="http://www.w3.org/2000/svg">
          {/* Outfield grass — full background */}
          <circle cx="110" cy="100" r="108" fill="#1a3d1a"/>

          {/* Infield dirt — rotated square */}
          <polygon points="110,28 192,110 110,192 28,110" fill="#6b4226"/>

          {/* Grass cut pattern on infield — subtle darker stripes */}
          <polygon points="110,28 192,110 110,192 28,110" fill="none" stroke="#1a3d1a" strokeWidth="1" opacity="0.3"/>

          {/* Foul lines */}
          <line x1="110" y1="192" x2="200" y2="10"  stroke="rgba(255,255,255,0.5)" strokeWidth="1.5"/>
          <line x1="110" y1="192" x2="20"  y2="10"  stroke="rgba(255,255,255,0.5)" strokeWidth="1.5"/>

          {/* Pitcher's mound */}
          <circle cx="110" cy="110" r="10" fill="#7a4e2a" stroke="#8a5e3a" strokeWidth="1"/>
          <circle cx="110" cy="110" r="2"  fill="#e0c090"/>

          {/* Base paths — dirt strips */}
          <line x1="110" y1="192" x2="192" y2="110" stroke="#8a5e3a" strokeWidth="8" opacity="0.5"/>
          <line x1="192" y1="110" x2="110" y2="28"  stroke="#8a5e3a" strokeWidth="8" opacity="0.5"/>
          <line x1="110" y1="28"  x2="28"  y2="110" stroke="#8a5e3a" strokeWidth="8" opacity="0.5"/>
          <line x1="28"  y1="110" x2="110" y2="192" stroke="#8a5e3a" strokeWidth="8" opacity="0.5"/>

          {/* Base squares — empty */}
          {/* First base */}
          <rect x="181" y="99" width="22" height="22" rx="3" fill={bases.first?"transparent":"#e8d5a0"} stroke={bases.first?(isMyTeam?"#f5c518":"#f0f4f8"):"#c8b57a"} strokeWidth={bases.first?2.5:1.5} transform="rotate(45,192,110)"/>
          {/* Second base */}
          <rect x="99"  y="21" width="22" height="22" rx="3" fill={bases.second?"transparent":"#e8d5a0"} stroke={bases.second?(isMyTeam?"#f5c518":"#f0f4f8"):"#c8b57a"} strokeWidth={bases.second?2.5:1.5} transform="rotate(45,110,32)"/>
          {/* Third base */}
          <rect x="17"  y="99" width="22" height="22" rx="3" fill={bases.third?"transparent":"#e8d5a0"} stroke={bases.third?(isMyTeam?"#f5c518":"#f0f4f8"):"#c8b57a"} strokeWidth={bases.third?2.5:1.5} transform="rotate(45,28,110)"/>
          {/* Home plate — pentagon shape */}
          <polygon points="110,178 122,188 122,200 98,200 98,188" fill="#f0f4f8" stroke="#c0c0c0" strokeWidth="1.5"/>

          {/* Base labels when empty */}
          {!bases.first  && <text x="192" y="114" textAnchor="middle" fontSize="8" fontWeight="bold" fill="#6b4226" fontFamily="sans-serif">1B</text>}
          {!bases.second && <text x="110" y="36"  textAnchor="middle" fontSize="8" fontWeight="bold" fill="#6b4226" fontFamily="sans-serif">2B</text>}
          {!bases.third  && <text x="28"  y="114" textAnchor="middle" fontSize="8" fontWeight="bold" fill="#6b4226" fontFamily="sans-serif">3B</text>}
          {/* H label */}
          <text x="110" y="196" textAnchor="middle" fontSize="8" fontWeight="bold" fill="#1a2d42" fontFamily="sans-serif">H</text>
        </svg>

        {/* ── Tappable runner badges overlaid on bases ── */}
        {BASE_CONFIG.map(({ key, badgeStyle }) => {
          const runner = bases[key];
          if (!runner) return null;
          const cls = isMyTeam ? "us" : "them";
          return (
            <div key={key}
              className={`runner-badge ${cls}`}
              style={{ position:"absolute", ...badgeStyle }}
              onClick={e => openMenu(e, key)}>
              <div className="runner-badge-num">#{runner.number||"?"}</div>
              <div className="runner-badge-name">{runner.name.split(" ")[0]}</div>
            </div>
          );
        })}
      </div>

      {/* Runner action menu */}
      {menu && menuRunner && (
        <>
          <div className="runner-menu-overlay" onClick={closeMenu} />
          <div className="runner-menu" style={{ top:Math.min(menu.y,window.innerHeight-220), left:Math.max(8,Math.min(menu.x-20,window.innerWidth-160)) }}>
            <div className="runner-menu-name">#{menuRunner.number} {menuRunner.name}</div>
            {activeConfig?.nextLabel && <button className="runner-menu-btn" onClick={()=>act("advance")}>▶ {activeConfig.nextLabel}</button>}
            {activeConfig?.prevLabel && <button className="runner-menu-btn" onClick={()=>act("back")}>◀ {activeConfig.prevLabel}</button>}
            <button className="runner-menu-btn" onClick={closeMenu}>· Stay / Hold</button>
            <button className="runner-menu-btn danger" onClick={()=>act("taggedout")}>⚡ Tagged / Thrown Out</button>
            <button className="runner-menu-btn danger" onClick={()=>act("remove")}>✕ Remove runner</button>
          </div>
        </>
      )}
    </>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function BaseballApp() {
  // Auth
  const [user, setUser]           = useState(undefined);
  const [loginError, setLoginError] = useState("");

  // Team membership
  const [teamId, setTeamId]       = useState(null);
  const [joinCode, setJoinCode]   = useState(null);
  const [teamSetup, setTeamSetup] = useState(false); // show setup screen
  const [joinInput, setJoinInput] = useState("");
  const [joinError, setJoinError] = useState("");
  const [teamMeta, setTeamMeta]   = useState(null);
  const [setupView, setSetupView] = useState("choose"); // "choose"|"create"|"join"|"created"

  // App data
  const [tab, setTab]             = useState("score");
  const [myTeam, setMyTeam]       = useState(defaultMyTeam);
  const [oppTeams, setOppTeams]   = useState([]);
  const [games, setGames]         = useState([]);
  const [stats, setStats]         = useState([]);
  const [loading, setLoading]     = useState(true);
  const [syncing, setSyncing]     = useState(false);

  // Game state
  const [game, setGame]           = useState(null);
  const [selectedOppId, setSelectedOppId] = useState(null);
  const [abLog, setAbLog]         = useState([]);
  const [abTeamOverride, setAbTeamOverride] = useState(null);
  const [runFlash, setRunFlash]   = useState("");
  const [expandedGame, setExpandedGame] = useState(null);
  const [undoStack, setUndoStack] = useState([]);
  // Home plate confirmation — { runner, forUs, pendingBases, pendingGame }
  const [homePlateConfirm, setHomePlateConfirm] = useState(null);

  // Roster UI
  const [rosterTeam, setRosterTeam]       = useState("my");
  const [editingMyName, setEditingMyName] = useState(false);
  const [myNameDraft, setMyNameDraft]     = useState("");
  const [editingOppName, setEditingOppName] = useState(null);
  const [oppNameDraft, setOppNameDraft]   = useState("");
  const [addingOpp, setAddingOpp]         = useState(false);
  const [newOppName, setNewOppName]       = useState("");
  const [addingPlayer, setAddingPlayer]   = useState(null);
  const [newPlayer, setNewPlayer]         = useState({ name:"", number:"", pos:"OF" });

  // Feedback
  const [fbType, setFbType]       = useState("bug");
  const [fbText, setFbText]       = useState("");
  const [fbSent, setFbSent]       = useState(false);
  const [fbSending, setFbSending] = useState(false);
  const [fbLog, setFbLog]         = useState([]);

  // ── Auth ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, u => setUser(u||null));
    return unsub;
  }, []);

  const signIn = async () => {
    setLoginError("");
    try { await signInWithPopup(auth, provider); }
    catch { setLoginError("Sign-in failed. Please try again."); }
  };

  const handleSignOut = () => { signOut(auth); setTeamId(null); setTeamSetup(false); };

  // ── Load membership after sign-in ────────────────────────────────────────
  useEffect(() => {
    if (!user) return;
    (async () => {
      const membership = await getUserMembership(user.uid);
      if (membership?.teamId) {
        setTeamId(membership.teamId);
        setJoinCode(membership.joinCode);
        const meta = await loadTeamMeta(membership.teamId);
        setTeamMeta(meta);
      } else {
        setTeamSetup(true);
        setLoading(false);
      }
    })();
  }, [user]);

  // ── Load team data once we have a teamId ─────────────────────────────────
  useEffect(() => {
    if (!teamId) return;
    (async () => {
      const data = await loadTeamData(teamId);
      if (data.myTeam)   setMyTeam(JSON.parse(data.myTeam));
      if (data.oppTeams) setOppTeams(JSON.parse(data.oppTeams));
      if (data.games)    setGames(JSON.parse(data.games));
      if (data.stats)    setStats(JSON.parse(data.stats));
      setLoading(false);
    })();
  }, [teamId]);

  // ── Real-time listener ────────────────────────────────────────────────────
  useEffect(() => {
    if (!teamId) return;
    const unsub = onSnapshot(doc(db, teamDoc(teamId)), snap => {
      if (!snap.exists()) return;
      const data = snap.data();
      if (data.myTeam)   setMyTeam(JSON.parse(data.myTeam));
      if (data.oppTeams) setOppTeams(JSON.parse(data.oppTeams));
      if (data.games)    setGames(JSON.parse(data.games));
      if (data.stats)    setStats(JSON.parse(data.stats));
    });
    return unsub;
  }, [teamId]);

  // ── Save helpers ──────────────────────────────────────────────────────────
  const persist = async (field, value) => {
    if (!teamId) return;
    setSyncing(true);
    await saveTeamField(teamId, field, value);
    setSyncing(false);
  };

  useEffect(() => { if (!loading && teamId) persist("myTeam",   myTeam);   }, [myTeam]);
  useEffect(() => { if (!loading && teamId) persist("oppTeams", oppTeams); }, [oppTeams]);
  useEffect(() => { if (!loading && teamId) persist("games",    games);    }, [games]);
  useEffect(() => { if (!loading && teamId) persist("stats",    stats);    }, [stats]);

  // ── Team setup handlers ───────────────────────────────────────────────────
  const handleCreateTeam = async () => {
    const result = await createTeam(user.uid, user.displayName);
    setTeamId(result.teamId);
    setJoinCode(result.joinCode);
    setSetupView("created");
  };

  const handleJoinTeam = async () => {
    setJoinError("");
    const code = joinInput.trim().toUpperCase();
    if (code.length < 4) { setJoinError("Enter a valid join code."); return; }
    const result = await joinTeam(user.uid, code, user.displayName);
    if (result.error) { setJoinError(result.error); return; }
    setTeamId(result.teamId);
    setJoinCode(result.joinCode);
    setTeamSetup(false);
  };

  const handleDoneSetup = () => setTeamSetup(false);

  const handleLeaveTeam = async () => {
    if (!window.confirm("Leave this team? You'll need the join code to rejoin.")) return;
    await leaveTeam(user.uid);
    setTeamId(null); setJoinCode(null); setTeamMeta(null);
    setMyTeam(defaultMyTeam); setOppTeams([]); setGames([]); setStats([]);
    setTeamSetup(true); setSetupView("choose"); setLoading(true);
  };

  // ── Helpers ───────────────────────────────────────────────────────────────
  const totalScore = (innings, team) => innings.reduce((s,i) => s+(i[team]||0), 0);
  const avg = s => s.ab>0 ? (s.h/s.ab).toFixed(3).replace("0.",".") : ".000";
  const record = games.reduce((a,g) => {
    if (g.usScore>g.themScore) a.w++; else if (g.usScore<g.themScore) a.l++; else a.t++;
    return a;
  }, { w:0,l:0,t:0 });

  const myRoster  = [...myTeam.roster].sort((a,b)=>a.order-b.order);
  const oppTeam   = game ? oppTeams.find(t=>t.name===game.oppName) : null;
  const oppRoster = oppTeam ? [...oppTeam.roster].sort((a,b)=>a.order-b.order) : [];

  const myBatterIdx     = game?.myBatterIdx  ?? 0;
  const oppBatterIdx    = game?.oppBatterIdx ?? 0;
  const isMyBatting     = abTeamOverride!==null ? abTeamOverride==="us" : game?.half==="bottom";
  const currentRoster   = isMyBatting ? myRoster : oppRoster;
  const currentBatterIdx = isMyBatting ? myBatterIdx : oppBatterIdx;
  const currentBatter   = currentRoster.length>0 ? currentRoster[currentBatterIdx%currentRoster.length] : null;
  const currentBases    = game ? (isMyBatting?game.myBases:game.oppBases) : emptyBases();
  const basesKey        = isMyBatting ? "myBases" : "oppBases";

  const flashRun = (msg) => { setRunFlash(msg); setTimeout(()=>setRunFlash(""),2500); };

  const scoreRuns = (runners, forUs) => {
    if (!runners.length) return;
    const team = forUs?"us":"them";
    setGame(g=>({ ...g, innings:g.innings.map((inn,i)=>i===g.inning-1?{...inn,[team]:(inn[team]||0)+runners.length}:inn) }));
    if (forUs) setStats(prev=>prev.map(s=>runners.find(r=>r.id===s.id)?{...s,r:s.r+1}:s));
    flashRun(`${runners.map(r=>r.name.split(" ")[0]).join(", ")} score${runners.length>1?"":"s"}! +${runners.length}`);
  };

  const advanceBatter = (forUs) => setGame(g=>{
    if (forUs) { const l=myRoster.length||1; return {...g,myBatterIdx:(g.myBatterIdx+1)%l}; }
    const l=oppRoster.length||1; return {...g,oppBatterIdx:(g.oppBatterIdx+1)%l};
  });

  const selectBatter = (idx) => {
    if (isMyBatting) setGame(g=>({...g,myBatterIdx:idx}));
    else             setGame(g=>({...g,oppBatterIdx:idx}));
  };

  // ── Undo ──────────────────────────────────────────────────────────────────
  const snapshot = () => setUndoStack(prev=>[...prev.slice(-19),{ game, stats:JSON.parse(JSON.stringify(stats)), abLog:[...abLog] }]);
  const undo = () => {
    if (!undoStack.length) return;
    const prev = undoStack[undoStack.length-1];
    setGame(prev.game); setStats(prev.stats); setAbLog(prev.abLog);
    setUndoStack(s=>s.slice(0,-1));
  };

  // ── Record AB ─────────────────────────────────────────────────────────────
  const recordAB = (result) => {
    if (!game||!currentBatter) return;
    snapshot();
    if (result==="BALL") { setGame(g=>({...g,balls:Math.min(g.balls+1,4)})); return; }
    if (result==="K")    { setGame(g=>({...g,strikes:Math.min(g.strikes+1,3)})); return; }

    const forUs=isMyBatting, batter=currentBatter, bases={...currentBases};
    let newBases={...bases}, runsScored=[];
    const batterRunner={id:batter.id,name:batter.name,number:batter.number};

    if (result==="1B"||result==="BB") {
      const adv=advanceRunners(bases,1); newBases=adv.newBases; runsScored=adv.runsScored; newBases.first=batterRunner;
    } else if (result==="2B") {
      const adv=advanceRunners(bases,2); newBases=adv.newBases; runsScored=adv.runsScored; newBases.second=batterRunner;
    } else if (result==="3B") {
      const adv=advanceRunners(bases,3); newBases=adv.newBases; runsScored=adv.runsScored; newBases.third=batterRunner;
    } else if (result==="HR") {
      ["first","second","third"].forEach(b=>{if(bases[b])runsScored.push(bases[b]);}); runsScored.push(batterRunner); newBases=emptyBases();
    } else if (result==="K_OUT"||result==="OUT") { newBases=bases; }

    const isOut=result==="OUT"||result==="K_OUT";
    setGame(g=>({...g,[basesKey]:newBases,balls:0,strikes:0,outs:isOut?Math.min(g.outs+1,3):g.outs}));

    // For hits: show home plate confirm for each runner that would score
    // HR is the only exception — everyone auto-scores on a homer
    if (runsScored.length) {
      if (result === "HR") {
        scoreRuns(runsScored, forUs);
      } else if (runsScored.length === 1) {
        setHomePlateConfirm({ runner: runsScored[0], forUs });
      } else {
        // Multiple runners scoring — confirm one at a time (queue them)
        // For simplicity show first one; user can manually adjust others via diamond
        setHomePlateConfirm({ runner: runsScored[0], forUs });
        // Any additional runners put back on bases — user manages via diamond
        // (rare edge case — 2+ runners score on same non-HR hit)
      }
    }

    if (forUs) {
      setStats(prev=>prev.map(s=>{
        if (s.id!==batter.id) return s;
        const isHit=["1B","2B","3B","HR"].includes(result);
        return {...s,
          ab:result==="BB"?s.ab:s.ab+1, h:isHit?s.h+1:s.h,
          "1b":result==="1B"?s["1b"]+1:s["1b"], "2b":result==="2B"?s["2b"]+1:s["2b"],
          "3b":result==="3B"?s["3b"]+1:s["3b"], hr:result==="HR"?s.hr+1:s.hr,
          bb:result==="BB"?s.bb+1:s.bb, k:result==="K_OUT"?s.k+1:s.k,
          rbi:result==="HR"?s.rbi+runsScored.length:s.rbi,
        };
      }));
    }
    setAbLog(prev=>[{result,name:batter.name,num:batter.number,inning:game.inning,half:game.half,forUs},...prev]);
    advanceBatter(forUs);
  };

  // ── Runner actions ────────────────────────────────────────────────────────
  const handleRunnerAction = (fromBase, action) => {
    const order=["first","second","third"], idx=order.indexOf(fromBase), runner=currentBases[fromBase];
    if (!runner) return;
    snapshot();
    if (action==="advance") {
      const {newBases,scored}=moveRunner(currentBases,fromBase);
      if (scored) {
        // Don't auto-score — show home plate confirmation
        setGame(g=>({...g,[basesKey]:newBases}));
        setHomePlateConfirm({ runner:scored, forUs:isMyBatting });
      } else {
        setGame(g=>({...g,[basesKey]:newBases}));
      }
    } else if (action==="back") {
      if (idx<=0) return;
      setGame(g=>({...g,[basesKey]:{...currentBases,[fromBase]:null,[order[idx-1]]:runner}}));
    } else if (action==="taggedout") {
      setGame(g=>({...g,[basesKey]:{...currentBases,[fromBase]:null},outs:Math.min(g.outs+1,3)}));
      setAbLog(prev=>[{result:"ROB",name:runner.name,num:runner.number,inning:game.inning,half:game.half,forUs:isMyBatting},...prev]);
      if (isMyBatting) setStats(prev=>prev.map(s=>s.id===runner.id?{...s,rob:(s.rob||0)+1}:s));
    } else if (action==="remove") {
      setGame(g=>({...g,[basesKey]:{...currentBases,[fromBase]:null}}));
    }
  };

  // ── Home plate confirmation ───────────────────────────────────────────────
  const resolveHomePlate = (outcome) => {
    if (!homePlateConfirm) return;
    const { runner, forUs } = homePlateConfirm;
    if (outcome === "safe") {
      // Run scores
      scoreRuns([runner], forUs);
      setAbLog(prev=>[{result:"RUN",name:runner.name,num:runner.number,inning:game.inning,half:game.half,forUs},...prev]);
    } else if (outcome === "out") {
      // Out at home — increment out counter, log it
      setGame(g=>({...g, outs:Math.min(g.outs+1,3)}));
      setAbLog(prev=>[{result:"ROB",name:runner.name,num:runner.number,inning:game.inning,half:game.half,forUs},...prev]);
      if (forUs) setStats(prev=>prev.map(s=>s.id===runner.id?{...s,rob:(s.rob||0)+1}:s));
    } else if (outcome === "back") {
      // Send runner back to 3rd
      setGame(g=>({...g,[basesKey]:{...currentBases,third:runner}}));
    }
    setHomePlateConfirm(null);
  };

  const adjustScore = (team,delta) => {
    snapshot();
    setGame(g=>({...g,innings:g.innings.map((inn,i)=>i===g.inning-1?{...inn,[team]:Math.max(0,(inn[team]||0)+delta)}:inn)}));
  };

  const nextInning = () => {
    snapshot();
    setGame(g=>g.half==="top"?{...g,half:"bottom",outs:0,balls:0,strikes:0}:{...g,inning:Math.min(g.inning+1,7),half:"top",outs:0,balls:0,strikes:0});
    setAbTeamOverride(null);
  };

  const saveGame = () => {
    if (!game) return;
    const us=totalScore(game.innings,"us"), them=totalScore(game.innings,"them");
    setGames(prev=>[{...game,final:true,usScore:us,themScore:them,playByPlay:[...abLog]},...prev]);
    setGame(null); setSelectedOppId(null); setAbLog([]); setAbTeamOverride(null); setUndoStack([]);
  };

  // ── Roster management ─────────────────────────────────────────────────────
  const addMyPlayer = () => {
    if (!newPlayer.name.trim()) return;
    const maxOrder=myTeam.roster.length?Math.max(...myTeam.roster.map(p=>p.order)):0;
    const p={id:Date.now(),name:newPlayer.name.trim(),number:newPlayer.number.trim(),pos:newPlayer.pos,order:maxOrder+1};
    setMyTeam(t=>({...t,roster:[...t.roster,p]}));
    setStats(s=>[...s,mkStat(p.id)]);
    setNewPlayer({name:"",number:"",pos:"OF"}); setAddingPlayer(null);
  };
  const removeMyPlayer = (id) => { setMyTeam(t=>({...t,roster:t.roster.filter(p=>p.id!==id)})); setStats(s=>s.filter(x=>x.id!==id)); };
  const addOppTeam = () => {
    if (!newOppName.trim()) return;
    const team={id:Date.now(),name:newOppName.trim(),roster:[]};
    setOppTeams(prev=>[...prev,team]); setNewOppName(""); setAddingOpp(false); setRosterTeam(team.id);
  };
  const addOppPlayer = (teamId) => {
    if (!newPlayer.name.trim()) return;
    setOppTeams(prev=>prev.map(t=>{
      if (t.id!==teamId) return t;
      const maxOrder=t.roster.length?Math.max(...t.roster.map(p=>p.order)):0;
      const p={id:Date.now(),name:newPlayer.name.trim(),number:newPlayer.number.trim(),pos:newPlayer.pos,order:maxOrder+1};
      return {...t,roster:[...t.roster,p]};
    }));
    setNewPlayer({name:"",number:"",pos:"OF"}); setAddingPlayer(null);
  };
  const removeOppPlayer = (tid,pid) => setOppTeams(prev=>prev.map(t=>t.id!==tid?t:{...t,roster:t.roster.filter(p=>p.id!==pid)}));
  const removeOppTeam   = (tid) => { setOppTeams(prev=>prev.filter(t=>t.id!==tid)); if(rosterTeam===tid) setRosterTeam("my"); };
  const incStat = (pid,field) => setStats(prev=>prev.map(s=>s.id===pid?{...s,[field]:(s[field]||0)+1,ab:["h","hr","k"].includes(field)?(s.ab||0)+1:s.ab}:s));

  // ── Feedback ──────────────────────────────────────────────────────────────
  const sendFeedback = async () => {
    if (!fbText.trim()) return;
    setFbSending(true);
    const entry={type:fbType,text:fbText.trim(),date:new Date().toISOString(),dateDisplay:new Date().toLocaleString(),uid:user?.uid||"unknown",teamId:teamId||"none",appVersion:"1.0-beta"};
    const ok=await submitFeedback(entry);
    if (ok) { setFbLog(prev=>[entry,...prev]); setFbText(""); setFbSent(true); setTimeout(()=>setFbSent(false),3000); }
    setFbSending(false);
  };

  const selectedOpp=oppTeams.find(t=>t.id===selectedOppId);
  const viewingOpp=rosterTeam!=="my"?oppTeams.find(t=>t.id===rosterTeam):null;

  const HIT_BUTTONS=[
    {result:"1B",   label:"Single",    icon:"🟦",cls:"single"   },
    {result:"2B",   label:"Double",    icon:"🟩",cls:"double"   },
    {result:"3B",   label:"Triple",    icon:"🟧",cls:"triple"   },
    {result:"HR",   label:"Homer",     icon:"🔴",cls:"homer"    },
    {result:"K",    label:"Strike",    icon:"✗", cls:"pitch-k"  },
    {result:"BALL", label:"Ball",      icon:"⚪",cls:"pitch-b"  },
    {result:"K_OUT",label:"Strikeout", icon:"⚡",cls:"strikeout"},
    {result:"BB",   label:"Walk",      icon:"🚶",cls:"walk"     },
    {result:"OUT",  label:"Out",       icon:"⚑", cls:"out"      },
  ];

  const AddPlayerForm=({onSave,onCancel})=>(
    <div className="card" style={{marginBottom:10}}>
      <div className="form-label">New Player</div>
      <input className="text-input" placeholder="Player name" value={newPlayer.name} onChange={e=>setNewPlayer(p=>({...p,name:e.target.value}))}/>
      <div className="form-row">
        <input className="text-input" placeholder="#" value={newPlayer.number} onChange={e=>setNewPlayer(p=>({...p,number:e.target.value}))} style={{maxWidth:70}}/>
        <select className="select-input" value={newPlayer.pos} onChange={e=>setNewPlayer(p=>({...p,pos:e.target.value}))}>
          {POSITIONS.map(pos=><option key={pos}>{pos}</option>)}
        </select>
      </div>
      <div className="row">
        <button className="btn-sm green" onClick={onSave}>Add Player</button>
        <button className="btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );

  // ── Loading states ────────────────────────────────────────────────────────
  if (user===undefined) return <><style>{styles}</style><div className="center-screen"><div style={{color:"var(--muted)"}}>Loading…</div></div></>;

  if (!user) return (
    <><style>{styles}</style>
    <div className="center-screen">
      <div className="login-icon">⚾</div>
      <div className="login-title">Dugout</div>
      <div className="login-sub">Sign in to sync your data across all your devices.</div>
      <button className="login-btn" onClick={signIn}><span style={{fontSize:20}}>🔑</span> Sign in with Google</button>
      {loginError && <div className="login-error">{loginError}</div>}
    </div></>
  );

  // ── Team setup screen ─────────────────────────────────────────────────────
  if (teamSetup) return (
    <><style>{styles}</style>
    <div className="center-screen">
      <div className="login-icon">⚾</div>
      <div className="login-title">Dugout</div>

      {setupView==="choose" && (
        <div className="setup-card">
          <div className="setup-title">Welcome, {user.displayName?.split(" ")[0]}!</div>
          <div className="setup-sub">Create a new team or join an existing one with a code.</div>
          <button className="btn-gold" onClick={handleCreateTeam}>Create a New Team</button>
          <div className="setup-divider"><div className="setup-divider-line"/><div className="setup-divider-text">OR</div><div className="setup-divider-line"/></div>
          <div className="form-label">Join with a code</div>
          <input className="code-input" placeholder="XXXXXX" maxLength={6} value={joinInput} onChange={e=>setJoinInput(e.target.value.toUpperCase())}/>
          {joinError && <div style={{fontSize:12,color:"var(--red)",marginBottom:8}}>{joinError}</div>}
          <button className="btn-gold" onClick={handleJoinTeam} disabled={joinInput.length<4}>Join Team</button>
        </div>
      )}

      {setupView==="created" && joinCode && (
        <div className="setup-card">
          <div className="setup-title">Team Created! 🎉</div>
          <div className="setup-sub">Share this code with your wife so she can join your team. She'll enter it when she first opens the app.</div>
          <div className="join-code-display">{joinCode}</div>
          <div className="join-code-hint">Anyone with this code can join and see your shared data.</div>
          <button className="btn-gold" style={{marginTop:16}} onClick={handleDoneSetup}>Let's Play Ball ⚾</button>
        </div>
      )}
    </div></>
  );

  if (loading) return <><style>{styles}</style><div className="center-screen"><div style={{color:"var(--muted)"}}>Loading your team…</div></div></>;

  const us=game?totalScore(game.innings,"us"):0;
  const them=game?totalScore(game.innings,"them"):0;

  return (
    <><style>{styles}</style>
    <div className="app">

      {/* Header */}
      <div className="header">
        <div className="header-top">
          <span className="header-icon">⚾</span>
          <div>
            <div className="header-title">Dugout</div>
            <div className="header-sub">{myTeam.name}</div>
          </div>
          <div className="ml-auto" style={{display:"flex",alignItems:"center",gap:8}}>
            <span className="record"><span className="w">{record.w}W</span>{" · "}<span className="l">{record.l}L</span>{record.t>0&&<> · {record.t}T</>}</span>
            <span className={`sync-dot ${syncing?"saving":""}`} title={syncing?"Saving…":"Synced"}/>
            <button className="signout-btn" onClick={handleSignOut}>Sign out</button>
          </div>
        </div>
        <nav className="nav">
          {[["score","🎯","Score"],["roster","👥","Lineup"],["stats","📊","Stats"],["history","📋","History"],["team","🔑","Team"],["feedback","💬","Feedback"]].map(([id,icon,label])=>(
            <button key={id} className={`nav-btn ${tab===id?"active":""}`} onClick={()=>setTab(id)}>
              <span className="nav-icon">{icon}</span>{label}
            </button>
          ))}
        </nav>
      </div>

      <div className="content">

        {/* ══ SCORE ══════════════════════════════════════════════════════════ */}
        {tab==="score" && (
          <>
            {!game && (
              <div className="card">
                <div className="card-title">Start a Game</div>
                <div className="form-label">Your Team</div>
                <div style={{padding:"9px 12px",background:"var(--navy2)",borderRadius:8,marginBottom:14,fontWeight:600,color:"var(--gold)"}}>{myTeam.name}</div>
                <div className="form-label">Select Opponent</div>
                {oppTeams.length===0
                  ? <div className="empty" style={{padding:"12px 0"}}>No opponent teams yet.<br/>Go to Lineup tab to add one.</div>
                  : oppTeams.map(t=>(
                    <div key={t.id} className={`opp-pick ${selectedOppId===t.id?"selected":""}`} onClick={()=>setSelectedOppId(t.id)}>
                      <span style={{fontWeight:600}}>{t.name}</span>
                      <span style={{fontSize:11,color:"var(--muted)"}}>{t.roster.length} players</span>
                    </div>
                  ))
                }
                {selectedOppId && <button className="btn-gold" style={{marginTop:10}} onClick={()=>setGame(newGame(myTeam.name,selectedOpp?.name||"Opponent"))}>⚾ Play Ball!</button>}
              </div>
            )}

            {game && (
              <>
                {/* Scoreboard */}
                <div className="scoreboard">
                  <div className="score-header">
                    <span className="score-label">{game.myTeamName} vs {game.oppName}</span>
                    <span className={`game-status ${game.final?"final":""}`}>{game.final?"FINAL":`INN ${game.inning} ${game.half==="top"?"▲":"▼"}`}</span>
                  </div>
                  <div className="score-main">
                    <div className="team-score"><div className="t-name">{game.oppName}</div><div className="score-num">{them}</div></div>
                    <div className="score-divider">:</div>
                    <div className="team-score"><div className="t-name us">{game.myTeamName}</div><div className="score-num us">{us}</div></div>
                  </div>
                  <div className="inning-row">
                    <div className="inning-cell ih" style={{minWidth:26}}></div>
                    {game.innings.map((_,i)=><div key={i} className="inning-cell ih">{i+1}</div>)}
                    <div className="inning-cell ih tot">R</div>
                  </div>
                  {[["them",game.oppName],["us",game.myTeamName]].map(([team,label])=>(
                    <div key={team} className="inning-row">
                      <div className={`inning-cell ${team}`} style={{minWidth:26,fontSize:9}}>{label.slice(0,4).toUpperCase()}</div>
                      {game.innings.map((inn,i)=><div key={i} className={`inning-cell ${team}`}>{inn[team]??"·"}</div>)}
                      <div className={`inning-cell tot ${team}`}>{totalScore(game.innings,team)}</div>
                    </div>
                  ))}
                </div>

                {/* Score +/- */}
                <div className="score-controls">
                  {[["us",game.myTeamName],["them",game.oppName]].map(([team,label])=>(
                    <div key={team} className="score-ctrl">
                      <div className={`ctrl-label ${team}`}>{label}</div>
                      <div className="ctrl-btns">
                        <button className="ctrl-btn" onClick={()=>adjustScore(team,-1)}>−</button>
                        <div className={`ctrl-val ${team}`}>{totalScore(game.innings,team)}</div>
                        <button className="ctrl-btn" onClick={()=>adjustScore(team,1)}>+</button>
                      </div>
                    </div>
                  ))}
                </div>

                {/* AT-BAT PANEL */}
                <div className="ab-panel">
                  {/* Count + Inning + Team toggle */}
                  <div style={{background:"var(--navy3)",padding:"10px 14px",display:"flex",gap:10,alignItems:"center"}}>
                    {[["Balls",game.balls,"var(--gold2)"],["Strk",game.strikes,"var(--white)"],["Outs",game.outs,"var(--red)"]].map(([label,val,color])=>(
                      <div key={label} style={{display:"flex",flexDirection:"column",alignItems:"center",gap:1,border:"1px solid var(--border)",borderRadius:8,padding:"5px 10px",minWidth:44}}>
                        <span style={{fontSize:8,color:"var(--muted)",textTransform:"uppercase",letterSpacing:1}}>{label}</span>
                        <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:26,lineHeight:1,color}}>{val}</span>
                      </div>
                    ))}
                    <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:2,marginLeft:2}}>
                      <span style={{fontSize:8,color:"var(--muted)",textTransform:"uppercase",letterSpacing:1}}>INN</span>
                      <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,lineHeight:1}}>{game.inning}</div>
                      <div style={{display:"flex",gap:3}}>
                        <span className={`half-tag ${game.half==="top"?"active":""}`} onClick={()=>setGame(g=>({...g,half:"top"}))}>▲</span>
                        <span className={`half-tag ${game.half==="bottom"?"active":""}`} onClick={()=>setGame(g=>({...g,half:"bottom"}))}>▼</span>
                      </div>
                    </div>
                    <div style={{marginLeft:"auto",display:"flex",flexDirection:"column",gap:3}}>
                      <span style={{fontSize:8,color:"var(--muted)",textTransform:"uppercase",letterSpacing:1,textAlign:"center"}}>BATTING</span>
                      <div style={{display:"flex",gap:4}}>
                        {[["US",true],["OPP",false]].map(([label,isUs])=>(
                          <button key={label} onClick={()=>setAbTeamOverride(isUs?"us":"them")}
                            style={{padding:"4px 9px",borderRadius:7,border:"1px solid",fontSize:10,fontWeight:700,cursor:"pointer",
                              borderColor:isMyBatting===isUs?(isUs?"var(--gold)":"var(--white)"):"var(--border)",
                              background:isMyBatting===isUs?(isUs?"rgba(245,197,24,0.15)":"rgba(240,244,248,0.1)"):"transparent",
                              color:isMyBatting===isUs?(isUs?"var(--gold)":"var(--white)"):"var(--muted)"}}>
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* AT BAT label */}
                  <div style={{padding:"6px 14px 0",display:"flex",alignItems:"center",gap:6}}>
                    <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:12,color:"var(--muted)",letterSpacing:2}}>AT BAT ·</span>
                    <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:12,letterSpacing:1,color:isMyBatting?"var(--gold)":"var(--white)"}}>
                      {isMyBatting?game.myTeamName:game.oppName}
                    </span>
                    <span style={{marginLeft:"auto",fontSize:10,color:"var(--muted)"}}>{currentBatterIdx%(currentRoster.length||1)+1} of {currentRoster.length}</span>
                  </div>

                  {/* Batter */}
                  {currentBatter ? (
                    <div className="batter-row">
                      <div className="batter-num">#{currentBatter.number||"–"}</div>
                      <div className="batter-info">
                        <div className="batter-name">{currentBatter.name}</div>
                        <div className="batter-sub">{currentBatter.pos}</div>
                        {isMyBatting && (()=>{
                          const s=stats.find(x=>x.id===currentBatter.id);
                          if (!s) return null;
                          return (
                            <div style={{display:"flex",gap:8,marginTop:4,flexWrap:"wrap"}}>
                              {[["AVG",avg(s)],["AB",s.ab],["H",s.h],["2B",s["2b"]],["HR",s.hr],["RBI",s.rbi],["K",s.k],["BB",s.bb],["ROB",s.rob||0]].map(([lbl,val])=>(
                                <div key={lbl} style={{textAlign:"center"}}>
                                  <div style={{fontSize:8,color:"var(--muted)",textTransform:"uppercase",letterSpacing:0.5}}>{lbl}</div>
                                  <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:14,color:lbl==="AVG"?"var(--gold2)":"var(--white)",lineHeight:1.2}}>{val}</div>
                                </div>
                              ))}
                            </div>
                          );
                        })()}
                      </div>
                      <div style={{display:"flex",gap:4,flexShrink:0}}>
                        <button className="batter-nav-btn" onClick={()=>selectBatter((currentBatterIdx-1+(currentRoster.length||1))%(currentRoster.length||1))}>‹</button>
                        <button className="batter-nav-btn" onClick={()=>selectBatter((currentBatterIdx+1)%(currentRoster.length||1))}>›</button>
                      </div>
                    </div>
                  ) : (
                    <div className="empty" style={{padding:"12px 0",fontSize:12}}>No lineup for {isMyBatting?"your team":game.oppName}.<br/>Add players in Lineup tab.</div>
                  )}

                  {/* Lineup chips */}
                  {currentRoster.length>0 && (
                    <div className="lineup-scroll">
                      {currentRoster.map((p,idx)=>{
                        const curIdx=currentBatterIdx%currentRoster.length;
                        return (
                          <div key={p.id} className={`lineup-chip ${idx===curIdx?"active":""} ${isMyBatting?"":"them"}`} onClick={()=>selectBatter(idx)}>
                            <div className={`lineup-chip-num ${isMyBatting?"":"them"}`}>#{p.number||idx+1}</div>
                            <div className="lineup-chip-name">{p.name.split(" ")[0]}</div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Diamond */}
                  <div className="diamond-wrap">
                    <div className="diamond-label">ON BASE · {isMyBatting?game.myTeamName:game.oppName}<span style={{marginLeft:8,fontSize:9,color:"var(--border)"}}>tap runner for options</span></div>
                    <Diamond bases={currentBases} isMyTeam={isMyBatting} onAction={handleRunnerAction}/>
                    {runFlash && <div className="run-flash">🏃 {runFlash}</div>}
                  </div>

                  {/* Undo + Hit buttons */}
                  <div className="undo-bar">
                    <button className="undo-btn" onClick={undo} disabled={undoStack.length===0}>↩ Undo {undoStack.length>0?`(${undoStack.length})`:""}</button>
                  </div>
                  <div className="hit-grid">
                    {HIT_BUTTONS.map(({result,label,icon,cls})=>(
                      <button key={result} className={`hit-btn ${cls}`} onClick={()=>recordAB(result)} disabled={!currentBatter}>
                        <span className="hit-btn-icon">{icon}</span>
                        <span className="hit-btn-label">{label}</span>
                      </button>
                    ))}
                  </div>

                  {/* AB log */}
                  {abLog.length>0 && (
                    <div className="ab-log">
                      {abLog.slice(0,8).map((entry,i)=>{
                        const dr=entry.result==="K_OUT"?"K":entry.result;
                        return (
                          <div key={i} className="ab-log-item">
                            <span className={`ab-log-result result-${dr}`}>{dr}</span>
                            <span className="ab-log-name">#{entry.num} {entry.name}</span>
                            <span className="ab-log-inn">I{entry.inning}{entry.half==="top"?"▲":"▼"} {entry.forUs?"US":"OPP"}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                <button className="btn-outline" onClick={nextInning}>Next Half-Inning →</button>
                <button className="btn-outline gold" onClick={saveGame}>💾 Save Final Score</button>
                <button className="btn-outline red" onClick={()=>{setGame(null);setSelectedOppId(null);setAbLog([]);setAbTeamOverride(null);setUndoStack([]);}}>✕ Cancel Game</button>
              </>
            )}
          </>
        )}

        {/* ══ LINEUP ══════════════════════════════════════════════════════════ */}
        {tab==="roster" && (
          <>
            <div className="team-tabs">
              <button className={`team-tab ${rosterTeam==="my"?"active":""}`} onClick={()=>setRosterTeam("my")}>{myTeam.name}</button>
              {oppTeams.map(t=><button key={t.id} className={`team-tab ${rosterTeam===t.id?"active":""}`} onClick={()=>setRosterTeam(t.id)}>{t.name}</button>)}
              <button className="team-tab" style={{padding:"7px 10px",fontSize:18}} onClick={()=>setAddingOpp(true)}>＋</button>
            </div>
            {addingOpp && (
              <div className="card" style={{marginBottom:10}}>
                <div className="form-label">New Opponent Team</div>
                <input className="text-input" placeholder="e.g. Eagles, Cardinals…" value={newOppName} onChange={e=>setNewOppName(e.target.value)} autoFocus/>
                <div className="row">
                  <button className="btn-sm green" onClick={addOppTeam}>Add Team</button>
                  <button className="btn-sm" onClick={()=>{setAddingOpp(false);setNewOppName("");}}>Cancel</button>
                </div>
              </div>
            )}
            {rosterTeam==="my" && (
              <>
                <div className="row" style={{marginBottom:12}}>
                  {editingMyName
                    ? <><input className="text-input" style={{marginBottom:0,flex:1}} value={myNameDraft} onChange={e=>setMyNameDraft(e.target.value)} autoFocus/>
                        <button className="btn-sm green" onClick={()=>{setMyTeam(t=>({...t,name:myNameDraft.trim()||t.name}));setEditingMyName(false);}}>Save</button>
                        <button className="btn-sm" onClick={()=>setEditingMyName(false)}>✕</button></>
                    : <><span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:20,color:"var(--gold)",letterSpacing:1}}>{myTeam.name}</span>
                        <button className="btn-sm" onClick={()=>{setMyNameDraft(myTeam.name);setEditingMyName(true);}}>✏️ Rename</button></>
                  }
                </div>
                <div className="section-title">Batting Order · {myRoster.length} Players</div>
                {myRoster.map(p=>{
                  const s=stats.find(x=>x.id===p.id)||mkStat(p.id);
                  return (
                    <div key={p.id} className="player-card">
                      <div className="order-badge">{p.order}</div>
                      <div className="player-num">{p.number||"–"}</div>
                      <div className="player-info"><div className="player-name">{p.name}</div><div className="player-pos-sub"><span className="pos-badge">{p.pos}</span></div></div>
                      <div style={{textAlign:"right"}}><div className="avg-badge">{avg(s)}</div><div style={{fontSize:10,color:"var(--muted)"}}>{s.ab} AB</div></div>
                      <button className="btn-sm red" style={{padding:"3px 7px"}} onClick={()=>removeMyPlayer(p.id)}>✕</button>
                    </div>
                  );
                })}
                {addingPlayer==="my"
                  ? <AddPlayerForm onSave={addMyPlayer} onCancel={()=>{setAddingPlayer(null);setNewPlayer({name:"",number:"",pos:"OF"});}}/>
                  : <button className="btn-outline blue" onClick={()=>{setAddingPlayer("my");setNewPlayer({name:"",number:"",pos:"OF"});}}>+ Add Player</button>
                }
              </>
            )}
            {rosterTeam!=="my" && viewingOpp && (
              <>
                <div className="row" style={{marginBottom:12}}>
                  {editingOppName===viewingOpp.id
                    ? <><input className="text-input" style={{marginBottom:0,flex:1}} value={oppNameDraft} onChange={e=>setOppNameDraft(e.target.value)} autoFocus/>
                        <button className="btn-sm green" onClick={()=>{setOppTeams(prev=>prev.map(t=>t.id===viewingOpp.id?{...t,name:oppNameDraft.trim()||t.name}:t));setEditingOppName(null);}}>Save</button>
                        <button className="btn-sm" onClick={()=>setEditingOppName(null)}>✕</button></>
                    : <><span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:20,letterSpacing:1}}>{viewingOpp.name}</span>
                        <button className="btn-sm" onClick={()=>{setOppNameDraft(viewingOpp.name);setEditingOppName(viewingOpp.id);}}>✏️ Rename</button>
                        <button className="btn-sm red" style={{marginLeft:"auto"}} onClick={()=>removeOppTeam(viewingOpp.id)}>Remove Team</button></>
                  }
                </div>
                <div className="section-title">Lineup · {viewingOpp.roster.length} Players</div>
                {viewingOpp.roster.length===0 && <div className="empty">No players yet.</div>}
                {[...viewingOpp.roster].sort((a,b)=>a.order-b.order).map(p=>(
                  <div key={p.id} className="player-card">
                    <div className="order-badge">{p.order}</div>
                    <div className="player-num">{p.number||"–"}</div>
                    <div className="player-info"><div className="player-name">{p.name}</div><div className="player-pos-sub"><span className="pos-badge">{p.pos}</span></div></div>
                    <button className="btn-sm red" style={{padding:"3px 7px",marginLeft:"auto"}} onClick={()=>removeOppPlayer(viewingOpp.id,p.id)}>✕</button>
                  </div>
                ))}
                {addingPlayer===viewingOpp.id
                  ? <AddPlayerForm onSave={()=>addOppPlayer(viewingOpp.id)} onCancel={()=>{setAddingPlayer(null);setNewPlayer({name:"",number:"",pos:"OF"});}}/>
                  : <button className="btn-outline blue" onClick={()=>{setAddingPlayer(viewingOpp.id);setNewPlayer({name:"",number:"",pos:"OF"});}}>+ Add Player</button>
                }
              </>
            )}
          </>
        )}

        {/* ══ STATS ═══════════════════════════════════════════════════════════ */}
        {tab==="stats" && (
          <>
            <div className="section-title">{myTeam.name} · Season Batting</div>
            <div className="card" style={{overflowX:"auto"}}>
              <table className="stats-table">
                <thead><tr><th>Player</th><th>AVG</th><th>AB</th><th>H</th><th>2B</th><th>HR</th><th>RBI</th><th>R</th><th>K</th><th>ROB</th></tr></thead>
                <tbody>
                  {myRoster.map(p=>{
                    const s=stats.find(x=>x.id===p.id)||mkStat(p.id);
                    return (
                      <tr key={p.id}>
                        <td><div style={{fontWeight:600}}>{p.name}</div><div style={{fontSize:10,color:"var(--muted)"}}>#{p.number} · {p.pos}</div></td>
                        <td><span className="avg-badge">{avg(s)}</span></td>
                        <td>{s.ab}</td>
                        <td>{s.h}<button className="stat-inc" onClick={()=>incStat(p.id,"h")}>+</button></td>
                        <td>{s["2b"]}<button className="stat-inc" onClick={()=>incStat(p.id,"2b")}>+</button></td>
                        <td>{s.hr}<button className="stat-inc" onClick={()=>incStat(p.id,"hr")}>+</button></td>
                        <td>{s.rbi}<button className="stat-inc" onClick={()=>incStat(p.id,"rbi")}>+</button></td>
                        <td>{s.r}<button className="stat-inc" onClick={()=>incStat(p.id,"r")}>+</button></td>
                        <td>{s.k}<button className="stat-inc" onClick={()=>incStat(p.id,"k")}>+</button></td>
                        <td>{s.rob||0}<button className="stat-inc" onClick={()=>incStat(p.id,"rob")}>+</button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{fontSize:11,color:"var(--muted)",textAlign:"center"}}>Tap + to adjust · Stats auto-track from at-bats &amp; baserunning</div>
          </>
        )}

        {/* ══ HISTORY ═════════════════════════════════════════════════════════ */}
        {tab==="history" && (
          <>
            <div className="section-title">Game History · {games.length} Games</div>
            {games.length===0 ? <div className="empty">No games saved yet.</div>
              : games.map(g=>{
                const result=g.usScore>g.themScore?"W":g.usScore<g.themScore?"L":"T";
                const isExpanded=expandedGame===g.id;
                const pbp=g.playByPlay||[];
                const plays=[...pbp].reverse();
                const inningMap={};
                plays.forEach(e=>{const k=`${e.inning}-${e.half}`;if(!inningMap[k])inningMap[k]={inning:e.inning,half:e.half,plays:[]};inningMap[k].plays.push(e);});
                return (
                  <div key={g.id} style={{marginBottom:isExpanded?0:8}}>
                    <div className={`game-row ${isExpanded?"expanded":""}`} onClick={()=>setExpandedGame(isExpanded?null:g.id)}>
                      <div className={`game-result ${result.toLowerCase()}`}>{result}</div>
                      <div style={{flex:1}}>
                        <div style={{fontWeight:600,fontSize:13}}>{g.myTeamName} vs {g.oppName}</div>
                        <div style={{fontSize:11,color:"var(--muted)"}}>{g.date} · {pbp.length} plays logged</div>
                      </div>
                      <div className="score-pill">{g.usScore}–{g.themScore}</div>
                      <div style={{fontSize:12,color:"var(--muted)",marginLeft:4}}>{isExpanded?"▲":"▼"}</div>
                    </div>
                    {isExpanded && (
                      <div className="pbp-panel">
                        {pbp.length===0
                          ? <div className="empty" style={{padding:"16px 0",fontSize:12}}>No plays logged.</div>
                          : Object.values(inningMap).map(({inning,half,plays})=>(
                            <div key={`${inning}-${half}`}>
                              <div className="pbp-inning-header">Inning {inning} {half==="top"?"▲ Top":"▼ Bottom"} — {half==="bottom"?g.myTeamName:g.oppName} batting</div>
                              {plays.map((entry,i)=>{const dr=entry.result==="K_OUT"?"K":entry.result;return(
                                <div key={i} className="pbp-entry">
                                  <span className={`pbp-result result-${dr}`}>{dr}</span>
                                  <span className="pbp-name">#{entry.num} {entry.name}</span>
                                  <span className="pbp-team">{entry.forUs?g.myTeamName:g.oppName}</span>
                                </div>
                              );})}
                            </div>
                          ))
                        }
                      </div>
                    )}
                  </div>
                );
              })
            }
          </>
        )}

        {/* ══ TEAM ════════════════════════════════════════════════════════════ */}
        {tab==="team" && (
          <>
            <div className="section-title">Your Team</div>
            <div className="card">
              <div style={{marginBottom:12}}>
                <div className="form-label">Signed in as</div>
                <div style={{fontWeight:600}}>{user.displayName}</div>
                <div style={{fontSize:12,color:"var(--muted)"}}>{user.email}</div>
              </div>
              <div style={{marginBottom:16}}>
                <div className="form-label">Join Code — share this to invite others</div>
                <div className="join-code-display" style={{fontSize:28,letterSpacing:4,padding:12}}>{joinCode}</div>
                <div className="join-code-hint">Anyone who enters this code will share your rosters, games, and stats.</div>
              </div>
              <div style={{padding:"10px 12px",background:"var(--navy2)",borderRadius:10,marginBottom:16,fontSize:12,color:"var(--muted)",lineHeight:1.6}}>
                💡 <strong style={{color:"var(--white)"}}>How to invite your wife:</strong> She opens the app, signs in with her Google account, taps "Join a Team", and enters the code above. After that you're synced.
              </div>
              <button className="btn-outline red" onClick={handleLeaveTeam}>Leave This Team</button>
            </div>
          </>
        )}

        {/* ══ FEEDBACK ════════════════════════════════════════════════════════ */}
        {tab==="feedback" && (
          <>
            <div className="section-title">Send Feedback</div>
            <div className="card">
              <div className="form-label" style={{marginBottom:8}}>What kind of feedback?</div>
              <div className="fb-type-row">
                {[["bug","🐛","Bug"],["idea","💡","Idea"],["praise","⭐","Praise"],["other","💬","Other"]].map(([type,icon,label])=>(
                  <button key={type} className={`fb-type-btn ${fbType===type?"active":""} ${fbType===type?type:""}`} onClick={()=>setFbType(type)}>
                    <div style={{fontSize:18}}>{icon}</div><div>{label}</div>
                  </button>
                ))}
              </div>
              <div className="form-label">
                {fbType==="bug"?"Describe what went wrong":fbType==="idea"?"What would make this better?":fbType==="praise"?"What's working well?":"What's on your mind?"}
              </div>
              <textarea className="fb-textarea"
                placeholder={fbType==="bug"?"e.g. When I tapped Single, the runner on 2nd didn't advance…":fbType==="idea"?"e.g. It would be great to track pitch count…":fbType==="praise"?"e.g. The diamond baserunner view is really useful…":"Type your feedback here…"}
                value={fbText} onChange={e=>setFbText(e.target.value)}/>
              {fbSent
                ? <div style={{textAlign:"center",color:"var(--green)",fontWeight:600,padding:"10px 0"}}>✓ Feedback sent — thanks!</div>
                : <button className="btn-gold" onClick={sendFeedback} disabled={fbSending||!fbText.trim()}>{fbSending?"Sending…":"Send Feedback"}</button>
              }
            </div>
            {fbLog.length>0 && (
              <>
                <div className="section-title">Sent this session</div>
                {fbLog.map((entry,i)=>(
                  <div key={i} className="fb-log-item">
                    <div className="fb-log-meta">
                      <span className={`fb-log-type ${entry.type}`}>{entry.type}</span>
                      <span className="fb-log-date">{entry.dateDisplay}</span>
                    </div>
                    <div className="fb-log-text">{entry.text}</div>
                  </div>
                ))}
              </>
            )}
            <div style={{marginTop:16,padding:"12px 16px",background:"var(--navy2)",borderRadius:10,border:"1px solid var(--border)"}}>
              <div style={{fontSize:11,color:"var(--muted)",lineHeight:1.6}}>
                💡 <strong style={{color:"var(--white)"}}>Tip:</strong> Use this during games to log anything that feels off. All feedback goes to Firebase where you can review it anytime.
              </div>
            </div>
          </>
        )}

      </div>
    </div>

    {/* ── HOME PLATE CONFIRMATION MODAL ── */}
    {homePlateConfirm && (
      <div className="homeplate-overlay">
        <div className="homeplate-modal">
          <div className="homeplate-icon">🏠</div>
          <div className="homeplate-title">Play at the Plate</div>
          <div className="homeplate-runner">#{homePlateConfirm.runner.number} {homePlateConfirm.runner.name}</div>
          <div className="homeplate-sub">What happened at home plate?</div>
          <div className="homeplate-btns">
            <button className="homeplate-btn safe" onClick={()=>resolveHomePlate("safe")}>✓ Safe — Run Scores</button>
            <button className="homeplate-btn out"  onClick={()=>resolveHomePlate("out")}>✗ Out at Home</button>
            <button className="homeplate-btn back" onClick={()=>resolveHomePlate("back")}>↩ Sent Back to 3rd</button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
