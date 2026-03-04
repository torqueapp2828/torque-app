import { useState, useEffect, useRef, useCallback } from "react";

// ─── AES-256-GCM Encryption ───────────────────────────────────────────────────
const enc = new TextEncoder();
const dec = new TextDecoder();

async function deriveKey(pin) {
  const keyMat = await crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name:"PBKDF2", salt:enc.encode("torque-vault-salt-v2"), iterations:100000, hash:"SHA-256" },
    keyMat, { name:"AES-GCM", length:256 }, false, ["encrypt","decrypt"]
  );
}
async function encryptData(data, pin) {
  const key = await deriveKey(pin);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name:"AES-GCM", iv }, key, enc.encode(JSON.stringify(data)));
  const buf = new Uint8Array(12 + ct.byteLength);
  buf.set(iv); buf.set(new Uint8Array(ct), 12);
  return btoa(String.fromCharCode(...buf));
}
async function decryptData(b64, pin) {
  try {
    const buf = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const key = await deriveKey(pin);
    const pt = await crypto.subtle.decrypt({ name:"AES-GCM", iv:buf.slice(0,12) }, key, buf.slice(12));
    return JSON.parse(dec.decode(pt));
  } catch { return null; }
}

// ─── Vault ────────────────────────────────────────────────────────────────────
const VAULT_KEY    = "torque_vault_v2";
const PIN_HASH_KEY = "torque_pin_hash_v2";
const BIO_KEY      = "torque_bio_enabled";

async function hashPin(pin) {
  const h = await crypto.subtle.digest("SHA-256", enc.encode(pin + "torque-pin-check-v2"));
  return btoa(String.fromCharCode(...new Uint8Array(h)));
}
async function saveVault(data, pin) {
  localStorage.setItem(VAULT_KEY, await encryptData(data, pin));
}
async function loadVault(pin) {
  const raw = localStorage.getItem(VAULT_KEY);
  return raw ? decryptData(raw, pin) : null;
}

// ─── Biometric (Capacitor) ────────────────────────────────────────────────────
// Uses @capacitor-community/biometric-auth if available, falls back gracefully
async function isBiometricAvailable() {
  try {
    const { BiometricAuth } = await import("@capacitor-community/biometric-auth");
    const result = await BiometricAuth.checkBiometry();
    return result.isAvailable;
  } catch { return false; }
}
async function authenticateWithBiometric() {
  try {
    const { BiometricAuth } = await import("@capacitor-community/biometric-auth");
    await BiometricAuth.authenticate({ reason:"Unlock Torque", cancelTitle:"Use PIN" });
    return true;
  } catch { return false; }
}

// ─── Local Notifications (Capacitor) ─────────────────────────────────────────
async function scheduleNotifications(vehicles) {
  try {
    const { LocalNotifications } = await import("@capacitor/local-notifications");
    const perm = await LocalNotifications.requestPermissions();
    if (perm.display !== "granted") return;

    // Cancel all existing torque notifications
    const pending = await LocalNotifications.getPending();
    if (pending.notifications.length > 0)
      await LocalNotifications.cancel({ notifications: pending.notifications });

    const notifications = [];
    let id = 1;
    const now = new Date();

    vehicles.forEach(v => {
      // Insurance expiry notifications
      if (v.insurance?.expiry) {
        const days = Math.ceil((new Date(v.insurance.expiry) - now) / 86400000);
        [90, 30, 7].forEach(threshold => {
          if (days <= threshold && days > 0) {
            const scheduleAt = new Date(now.getTime() + 5000); // schedule 5s from now for testing; in prod use actual date
            notifications.push({
              id: id++,
              title: `🛡 Insurance Expiring — ${v.name}`,
              body: `${v.name} insurance expires in ${days} days. Renew now.`,
              schedule: { at: scheduleAt },
              extra: { vehicleId: v.id, type: "insurance" }
            });
          }
        });
      }
      // Registration expiry notifications
      if (v.registration?.expiry) {
        const days = Math.ceil((new Date(v.registration.expiry) - now) / 86400000);
        [120, 60, 14].forEach(threshold => {
          if (days <= threshold && days > 0) {
            const scheduleAt = new Date(now.getTime() + 5000);
            notifications.push({
              id: id++,
              title: `📄 Registration Due — ${v.name}`,
              body: `${v.name} registration renewal due in ${days} days.`,
              schedule: { at: scheduleAt },
              extra: { vehicleId: v.id, type: "registration" }
            });
          }
        });
      }
      // Custom reminders
      (v.reminders || []).filter(r => !r.done && r.date).forEach(r => {
        const days = Math.ceil((new Date(r.date) - now) / 86400000);
        if (days <= 7 && days >= 0) {
          notifications.push({
            id: id++,
            title: `🔔 Reminder — ${v.name}`,
            body: r.title + (days === 0 ? " (due today)" : ` in ${days} days`),
            schedule: { at: new Date(now.getTime() + 5000) },
            extra: { vehicleId: v.id, type: "reminder" }
          });
        }
      });
    });

    if (notifications.length > 0)
      await LocalNotifications.schedule({ notifications });
  } catch (e) {
    console.log("Notifications not available:", e.message);
  }
}

// ─── Google Drive OAuth ───────────────────────────────────────────────────────
// Replace with your Google Cloud OAuth2 client ID
const GDRIVE_CLIENT_ID = "719641568315-ig8odds7t6s1s92c7fmmfr6t0utmh2rc.apps.googleusercontent.com";
const GDRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const GDRIVE_FOLDER_NAME = "Torque Backups";

async function getGDriveToken() {
  return new Promise((resolve, reject) => {
    const w = window.open(
      `https://accounts.google.com/o/oauth2/v2/auth?client_id=${GDRIVE_CLIENT_ID}&redirect_uri=${encodeURIComponent(window.location.origin + "/oauth")}&response_type=token&scope=${encodeURIComponent(GDRIVE_SCOPE)}`,
      "gdrive_auth", "width=500,height=600,left=200,top=100"
    );
    const check = setInterval(() => {
      try {
        if (w.closed) { clearInterval(check); reject(new Error("Window closed")); return; }
        const hash = w.location.hash;
        if (hash && hash.includes("access_token")) {
          clearInterval(check); w.close();
          const params = new URLSearchParams(hash.slice(1));
          resolve(params.get("access_token"));
        }
      } catch {}
    }, 500);
  });
}

async function getOrCreateDriveFolder(token) {
  // Search for existing folder
  const search = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=name='${GDRIVE_FOLDER_NAME}'+and+mimeType='application/vnd.google-apps.folder'+and+trashed=false`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await search.json();
  if (data.files?.length > 0) return data.files[0].id;

  // Create folder
  const create = await fetch("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: GDRIVE_FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" })
  });
  const folder = await create.json();
  return folder.id;
}

async function uploadToDrive(token, encryptedData, filename) {
  const folderId = await getOrCreateDriveFolder(token);
  const metadata = { name: filename, parents: [folderId] };
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append("file", new Blob([encryptedData], { type: "text/plain" }));
  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
    { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form }
  );
  return res.json();
}

async function listDriveBackups(token) {
  const folderId = await getOrCreateDriveFolder(token);
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents+and+trashed=false&orderBy=createdTime+desc&fields=files(id,name,createdTime,size)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  return data.files || [];
}

async function downloadFromDrive(token, fileId) {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return res.text();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const daysBetween = d => d ? Math.ceil((new Date(d) - new Date()) / 86400000) : null;
const genId = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const fmtCoord = n => n.toFixed(5);
const fmtDate = d => d ? new Date(d).toLocaleDateString("en-IN", { day:"numeric", month:"short", year:"numeric" }) : "—";
const fmtCurrency = n => `₹${Number(n).toLocaleString("en-IN")}`;

// ─── Theme ────────────────────────────────────────────────────────────────────
const DARK = {
  bg:"#080810", surface:"#111118", border:"#1e1e2e", border2:"#2a2a3e",
  text:"#e8e8f0", sub:"#9999aa", muted:"#6a6a7e", accent:"#c8a96e",
  accentDim:"#1e1a10", accentBorder:"#c8a96e",
  danger:"#ff8888", dangerBg:"#1a0808", dangerBorder:"#3d1a1a",
  warn:"#ffcc44", warnBg:"#1a1400", warnBorder:"#3d3200",
  ok:"#88cc88", okBg:"#0a1a0a", okBorder:"#1a3d1a",
  blue:"#7db8e8", blueBg:"#1a2a3a", blueBorder:"#2a4a6a",
  header:"#0d0d18",
};
const LIGHT = {
  bg:"#f4f4f0", surface:"#ffffff", border:"#e0e0d0", border2:"#d0d0c0",
  text:"#1a1a1a", sub:"#555", muted:"#888", accent:"#a8843e",
  accentDim:"#fdf6e3", accentBorder:"#a8843e",
  danger:"#c0392b", dangerBg:"#fff0ee", dangerBorder:"#f5c6c0",
  warn:"#8b6914", warnBg:"#fffbec", warnBorder:"#f0d88a",
  ok:"#27ae60", okBg:"#eefbf2", okBorder:"#a8e6bf",
  blue:"#2980b9", blueBg:"#eaf4fb", blueBorder:"#a8d4f0",
  header:"#ffffff",
};

// ─── Styles ───────────────────────────────────────────────────────────────────
function buildStyles(T) {
  return `
    @import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400&family=Space+Mono:wght@400;700&display=swap');
    *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
    body { background:${T.bg}; font-family:'DM Sans',sans-serif; color:${T.text}; user-select:none; line-height:1.5; -webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale; }
    ::-webkit-scrollbar { width:3px; height:3px; }
    ::-webkit-scrollbar-thumb { background:${T.border2}; border-radius:2px; }

    .card { background:${T.surface}; border:1px solid ${T.border}; border-radius:14px; }
    .card-hover { cursor:pointer; transition:all 0.18s; }
    .card-hover:hover { border-color:${T.accent}44; transform:translateY(-1px); box-shadow:0 8px 28px rgba(0,0,0,0.15); }

    .btn-gold { background:linear-gradient(135deg,#c8a96e,#a8843e); border:none; border-radius:10px;
      color:#0a0a0f; font-family:'DM Sans',sans-serif; font-weight:700; font-size:15px;
      cursor:pointer; transition:all 0.18s; display:inline-flex; align-items:center; justify-content:center; gap:6px; }
    .btn-gold:hover:not(:disabled) { filter:brightness(1.1); transform:translateY(-1px); }
    .btn-gold:disabled { opacity:0.4; cursor:not-allowed; }

    .btn-ghost { background:none; border:1px solid ${T.border2}; border-radius:10px; color:${T.sub};
      font-family:'DM Sans',sans-serif; font-weight:500; font-size:14px; cursor:pointer;
      transition:all 0.18s; display:inline-flex; align-items:center; justify-content:center; gap:6px; }
    .btn-ghost:hover { border-color:${T.muted}; color:${T.text}; }
    .btn-icon { background:none; border:none; cursor:pointer; color:${T.muted}; padding:4px;
      border-radius:6px; transition:color 0.15s; display:inline-flex; align-items:center; }
    .btn-icon:hover { color:${T.text}; }

    .input { background:${T.bg}; border:1px solid ${T.border2}; border-radius:10px; color:${T.text};
      font-family:'DM Sans',sans-serif; font-size:14px; padding:12px 14px; width:100%;
      outline:none; transition:border-color 0.18s; }
    .input:focus { border-color:${T.accent}88; }
    .input::placeholder { color:${T.muted}; }
    select.input { appearance:none; cursor:pointer; }
    textarea.input { resize:vertical; min-height:80px; }

    /* Numeric PIN pad */
    .pin-dot { width:14px; height:14px; border-radius:50%; border:2px solid ${T.accent};
      transition:all 0.15s; flex-shrink:0; }
    .pin-dot.filled { background:${T.accent}; transform:scale(1.1); }
    .pin-key { width:72px; height:72px; border-radius:50%; border:1.5px solid ${T.border2};
      background:${T.surface}; color:${T.text}; font-family:'DM Sans',sans-serif;
      font-size:22px; font-weight:600; cursor:pointer; transition:all 0.12s;
      display:flex; flex-direction:column; align-items:center; justify-content:center;
      gap:1px; -webkit-tap-highlight-color:transparent; }
    .pin-key:active { background:${T.accentDim}; border-color:${T.accent}; transform:scale(0.94); }
    .pin-key.del { font-size:18px; }
    .pin-key.bio { font-size:26px; border-color:${T.blueBorder}; background:${T.blueBg}; }
    .pin-key-sub { font-size:10px; font-weight:400; color:${T.muted}; letter-spacing:0.05em; }

    .tab-btn { background:none; border:none; padding:11px 15px; color:${T.muted}; cursor:pointer;
      font-family:'DM Sans',sans-serif; font-size:13px; font-weight:500;
      border-bottom:2px solid transparent; transition:all 0.18s; white-space:nowrap; }
    .tab-btn.active { color:${T.accent}; border-bottom-color:${T.accent}; }

    .type-btn { flex:1; padding:16px 12px; border-radius:12px; border:2px solid ${T.border};
      background:${T.bg}; cursor:pointer; transition:all 0.18s; display:flex;
      flex-direction:column; align-items:center; gap:8px; color:${T.sub};
      font-family:'DM Sans',sans-serif; font-size:13px; font-weight:500; }
    .type-btn.selected { border-color:${T.accent}; background:${T.accentDim}; color:${T.accent}; }

    .color-swatch { width:30px; height:30px; border-radius:50%; cursor:pointer;
      border:2px solid transparent; transition:all 0.15s; flex-shrink:0; }
    .color-swatch.picked { border-color:${T.text}; transform:scale(1.2); }

    .filter-btn { background:${T.surface}; border:1px solid ${T.border}; border-radius:8px;
      padding:7px 14px; color:${T.sub}; cursor:pointer; font-family:'DM Sans',sans-serif;
      font-size:13px; font-weight:500; transition:all 0.2s; white-space:nowrap; }
    .filter-btn.active { background:${T.accentDim}; border-color:${T.accent}; color:${T.accent}; }

    .pill { display:inline-flex; align-items:center; padding:2px 8px; border-radius:20px;
      font-size:11px; font-weight:700; letter-spacing:0.03em; }

    .photo-thumb { width:80px; height:80px; border-radius:10px; object-fit:cover;
      border:1px solid ${T.border}; cursor:pointer; transition:opacity 0.15s; flex-shrink:0; }
    .photo-thumb:hover { opacity:0.85; }

    .gps-tag-btn { width:100%; padding:13px; border-radius:10px; border:2px dashed ${T.blueBorder};
      background:${T.blueBg}; color:${T.blue}; font-family:'DM Sans',sans-serif;
      font-size:14px; font-weight:600; cursor:pointer;
      display:flex; align-items:center; justify-content:center; gap:8px; transition:all 0.2s; }
    .gps-tag-btn:hover { border-style:solid; }

    .row-item { display:flex; justify-content:space-between; align-items:center;
      padding:10px 0; border-bottom:1px solid ${T.border}; }
    .row-item:last-child { border-bottom:none; }
    .section-label { font-size:11px; color:${T.sub}; font-weight:700;
      text-transform:uppercase; letter-spacing:0.1em; margin-bottom:12px; display:block; }

    /* Swipe tabs */
    .swipe-container { overflow:hidden; position:relative; }
    .swipe-track { display:flex; transition:transform 0.28s cubic-bezier(0.4,0,0.2,1); will-change:transform; }
    .swipe-panel { flex-shrink:0; width:100%; }

    /* Leaflet map */
    .leaflet-container { border-radius:10px; }

    .trend-bar { height:4px; border-radius:2px; background:${T.border}; overflow:hidden; margin-top:4px; }
    .trend-fill { height:100%; border-radius:2px; background:linear-gradient(90deg,#c8a96e,#e8c98e); transition:width 0.4s ease; }

    .modal-overlay { position:fixed; inset:0; background:rgba(0,0,0,0.7);
      display:flex; align-items:flex-end; justify-content:center; z-index:100; backdrop-filter:blur(4px); }
    .modal-sheet { background:${T.surface}; border-radius:20px 20px 0 0;
      width:100%; max-width:560px; max-height:90vh; overflow-y:auto; padding:24px 20px; }

    @keyframes fadeUp { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
    .fade { animation:fadeUp 0.22s ease both; }
    @keyframes pop { from{opacity:0;transform:scale(0.95)} to{opacity:1;transform:scale(1)} }
    .pop { animation:pop 0.2s ease both; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
    .pulsing { animation:pulse 1.2s ease infinite; }
    @keyframes shake { 0%,100%{transform:translateX(0)} 20%,60%{transform:translateX(-8px)} 40%,80%{transform:translateX(8px)} }
    .shake { animation:shake 0.4s ease; }
  `;
}

// ─── Icons ────────────────────────────────────────────────────────────────────
const CarSvg  = ({s=20}) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 17H3a2 2 0 01-2-2V9a2 2 0 012-2h14a2 2 0 012 2v6a2 2 0 01-2 2h-2"/><path d="M14 17H7"/><circle cx="5.5" cy="17.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/><path d="M3 9l2-5h10l2 5"/></svg>;
const BikeSvg = ({s=20}) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="17" r="4"/><circle cx="6" cy="17" r="4"/><path d="M15 17H9v-5l3-5 3 5h2.5l1 2.5"/><path d="M9 17V9l-3 3"/></svg>;
const PinIcon = ({s=14}) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>;
const NavIcon = ({s=14}) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>;
const BackIcon = ({s=18}) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>;
const WrenchIcon = ({s=14}) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg>;
const FuelIcon = ({s=14}) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M3 22V8l6-6h8a2 2 0 012 2v4"/><path d="M3 12h12"/><path d="M17 8h2a2 2 0 012 2v8a1 1 0 01-1 1h-1"/><path d="M19 8v4"/></svg>;
const BellIcon = ({s=14}) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>;
const ShieldIcon = ({s=14}) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>;
const CameraIcon = ({s=14}) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>;
const GaugeIcon = ({s=14}) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 2a10 10 0 110 20A10 10 0 0112 2z"/><path d="M12 6v2M6 12H4M20 12h-2M7.76 7.76l-1.42-1.42M17.66 7.76l1.42-1.42"/><path d="M12 12l3-5"/></svg>;
const NoteIcon = ({s=14}) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>;
const TrashIcon = ({s=14}) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>;
const DriveIcon = ({s=16}) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 2L2 19h20L12 2z"/><path d="M4.5 15L12 2l7.5 13"/><path d="M2 19h20"/></svg>;
const SunIcon  = ({s=16}) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>;
const MoonIcon = ({s=16}) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>;
const LockIcon = ({s=32}) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>;
const CloseIcon = ({s=18}) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>;
const CheckIcon = ({s=16}) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>;
const PlusIcon  = ({s=16}) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>;
const FingerIcon = ({s=28}) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M12 2a3 3 0 013 3v7a3 3 0 01-6 0V5a3 3 0 013-3z"/><path d="M19 10a7 7 0 01-14 0"/><path d="M12 19v3"/></svg>;
const DeleteIcon = ({s=20}) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 4H8l-7 8 7 8h13a2 2 0 002-2V6a2 2 0 00-2-2z"/><line x1="18" y1="9" x2="12" y2="15"/><line x1="12" y1="9" x2="18" y2="15"/></svg>;
const SettingsIcon = ({s=16}) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>;

const COLORS = ["#c0392b","#e67e22","#f1c40f","#2ecc71","#1abc9c","#3498db","#2980b9","#9b59b6","#1a1a2e","#2c3e50","#34495e","#7f8c8d","#2d4a22","#8b4513"];
const PIN_KEYS = [
  ["1",""],["2","ABC"],["3","DEF"],
  ["4","GHI"],["5","JKL"],["6","MNO"],
  ["7","PQRS"],["8","TUV"],["9","WXYZ"],
  ["bio",""],["0",""],["del",""],
];

// ─── Numeric PIN Pad ──────────────────────────────────────────────────────────
function PinPad({ value, onChange, onSubmit, onBio, bioAvailable, maxLen=6, T }) {
  const press = (key) => {
    if (key === "del") { onChange(value.slice(0,-1)); return; }
    if (key === "bio") { onBio?.(); return; }
    if (value.length >= maxLen) return;
    const next = value + key;
    onChange(next);
    if (next.length === maxLen) setTimeout(() => onSubmit(next), 120);
  };

  return (
    <div>
      {/* PIN dots */}
      <div style={{ display:"flex", justifyContent:"center", gap:16, marginBottom:32 }}>
        {Array.from({length:maxLen}).map((_,i) => (
          <div key={i} className={`pin-dot${i < value.length ? " filled" : ""}`} />
        ))}
      </div>
      {/* Keypad grid */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:14, maxWidth:260, margin:"0 auto" }}>
        {PIN_KEYS.map(([k, sub]) => {
          if (k === "bio" && !bioAvailable) return <div key="bio" />;
          return (
            <button key={k} className={`pin-key${k==="del"?" del":k==="bio"?" bio":""}`}
              onClick={() => press(k)} style={{ margin:"0 auto" }}>
              {k === "del" ? <DeleteIcon s={20}/> : k === "bio" ? <FingerIcon s={28}/> : (
                <>
                  <span>{k}</span>
                  {sub && <span className="pin-key-sub">{sub}</span>}
                </>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── PIN Screen ───────────────────────────────────────────────────────────────
function PinScreen({ mode, onSuccess, onSetPin, T }) {
  const [step, setStep]           = useState("enter"); // enter | confirm
  const [pin, setPin]             = useState("");
  const [confirm, setConfirm]     = useState("");
  const [err, setErr]             = useState("");
  const [shaking, setShaking]     = useState(false);
  const [bioAvail, setBioAvail]   = useState(false);
  const [loading, setLoading]     = useState(false);
  const bioEnabled = localStorage.getItem(BIO_KEY) === "true";

  useEffect(() => {
    isBiometricAvailable().then(setBioAvail);
    // Auto-try biometric on unlock screen
    if (mode === "unlock" && bioEnabled) {
      authenticateWithBiometric().then(ok => { if (ok) onSuccess("__bio__"); });
    }
  }, []);

  const shake = (msg) => {
    setErr(msg); setShaking(true);
    setTimeout(() => setShaking(false), 400);
  };

  const handlePin = async (entered) => {
    if (mode === "setup") {
      if (step === "enter") {
        if (entered.length < 4) { shake("Use at least 4 digits"); setPin(""); return; }
        setStep("confirm"); setPin(entered);
        // reset confirm pad
        setTimeout(() => setConfirm(""), 50);
        return;
      }
      // confirm step
      if (entered !== pin) { shake("PINs don't match"); setConfirm(""); return; }
      setLoading(true);
      const h = await hashPin(pin);
      localStorage.setItem(PIN_HASH_KEY, h);
      onSetPin(pin);
    } else {
      setLoading(true);
      const stored = localStorage.getItem(PIN_HASH_KEY);
      const h = await hashPin(entered);
      if (h === stored) { onSuccess(entered); }
      else { shake("Incorrect PIN"); setPin(""); setLoading(false); }
    }
  };

  const handleBio = async () => {
    const ok = await authenticateWithBiometric();
    if (ok) onSuccess("__bio__");
    else shake("Biometric failed — use PIN");
  };

  const currentVal  = mode === "setup" && step === "confirm" ? confirm : pin;
  const setCurrentVal = mode === "setup" && step === "confirm"
    ? v => { setConfirm(v); }
    : v => { setPin(v); };

  return (
    <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center",
      minHeight:"100vh", background:T.bg, padding:"32px 24px", textAlign:"center" }}>
      <div style={{ marginBottom:20, color:T.accent }}><LockIcon s={48}/></div>
      <div style={{ fontSize:22, fontWeight:700, color:T.text, marginBottom:6 }}>
        {mode === "setup"
          ? step === "enter" ? "Set Your PIN" : "Confirm PIN"
          : "Unlock Torque"}
      </div>
      <div style={{ fontSize:13, color:T.sub, maxWidth:240, lineHeight:1.6, marginBottom:28 }}>
        {mode === "setup"
          ? step === "enter"
            ? "Choose a 4–6 digit PIN to encrypt your vehicle data."
            : "Enter the same PIN again to confirm."
          : "Enter your PIN to continue."}
      </div>

      {err && (
        <div style={{ fontSize:13, color:T.danger, marginBottom:16, minHeight:18 }}>{err}</div>
      )}

      <div className={shaking ? "shake" : ""} style={{ width:"100%" }}>
        <PinPad
          value={currentVal}
          onChange={setCurrentVal}
          onSubmit={handlePin}
          onBio={handleBio}
          bioAvailable={bioAvail && mode === "unlock" && bioEnabled}
          T={T}
        />
      </div>

      {/* Setup: biometric opt-in */}
      {mode === "setup" && step === "enter" && bioAvail && (
        <div style={{ marginTop:24, display:"flex", alignItems:"center", gap:10 }}>
          <div style={{ fontSize:13, color:T.sub }}>Enable fingerprint unlock?</div>
          <button onClick={() => localStorage.setItem(BIO_KEY, "true")}
            style={{ background:T.blueBg, border:`1px solid ${T.blueBorder}`, borderRadius:8,
              color:T.blue, padding:"5px 14px", fontSize:12, cursor:"pointer", fontFamily:"'DM Sans',sans-serif" }}>
            Enable
          </button>
        </div>
      )}

      {mode === "unlock" && (
        <button onClick={() => {
          if(window.confirm("This erases all saved data. Are you sure?")) {
            localStorage.clear(); window.location.reload();
          }
        }} style={{ marginTop:28, background:"none", border:"none", color:T.muted,
          fontSize:12, cursor:"pointer", textDecoration:"underline" }}>
          Forgot PIN (erase all data)
        </button>
      )}
    </div>
  );
}

// ─── Settings Panel (PIN change + biometric toggle) ───────────────────────────
function SettingsPanel({ pin, onPinChange, T }) {
  const [mode, setMode]     = useState("idle"); // idle | change_old | change_new | change_confirm
  const [oldPin, setOldPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [err, setErr]       = useState("");
  const [ok, setOk]         = useState("");
  const [bioAvail, setBioAvail] = useState(false);
  const bioEnabled = localStorage.getItem(BIO_KEY) === "true";

  useEffect(() => { isBiometricAvailable().then(setBioAvail); }, []);

  const handlePad = async (entered) => {
    if (mode === "change_old") {
      const stored = localStorage.getItem(PIN_HASH_KEY);
      const h = await hashPin(entered);
      if (h !== stored) { setErr("Incorrect current PIN"); setOldPin(""); return; }
      setOldPin(entered); setMode("change_new"); setErr("");
    } else if (mode === "change_new") {
      setNewPin(entered); setMode("change_confirm"); setErr("");
    } else if (mode === "change_confirm") {
      if (entered !== newPin) { setErr("PINs don't match"); setMode("change_new"); setNewPin(""); return; }
      const h = await hashPin(entered);
      localStorage.setItem(PIN_HASH_KEY, h);
      onPinChange(entered);
      setOk("PIN updated successfully"); setMode("idle"); setErr("");
      setTimeout(() => setOk(""), 3000);
    }
  };

  const currentVal = mode === "change_old" ? oldPin
    : mode === "change_new" ? newPin
    : mode === "change_confirm" ? "" : "";

  const setCurrentVal = mode === "change_old" ? setOldPin
    : mode === "change_new" ? setNewPin
    : () => {};

  return (
    <div style={{ padding:18, maxWidth:560, margin:"0 auto" }}>
      {/* PIN section */}
      <div className="card" style={{ padding:20, marginBottom:14 }}>
        <span className="section-label">Security</span>

        {mode === "idle" ? (
          <>
            <div className="row-item">
              <div>
                <div style={{ fontSize:14, fontWeight:500 }}>Change PIN</div>
                <div style={{ fontSize:12, color:T.sub, marginTop:2 }}>Update your encryption PIN</div>
              </div>
              <button className="btn-ghost" style={{ padding:"7px 14px", fontSize:13 }}
                onClick={() => { setMode("change_old"); setErr(""); }}>
                Change
              </button>
            </div>
            {bioAvail && (
              <div className="row-item">
                <div>
                  <div style={{ fontSize:14, fontWeight:500 }}>Fingerprint Unlock</div>
                  <div style={{ fontSize:12, color:T.sub, marginTop:2 }}>Use biometric to unlock Torque</div>
                </div>
                <button onClick={() => {
                  const next = !bioEnabled;
                  localStorage.setItem(BIO_KEY, String(next));
                  setOk(next ? "Fingerprint enabled" : "Fingerprint disabled");
                  setTimeout(() => setOk(""), 2000);
                }} style={{ background:bioEnabled?T.accentDim:T.bg,
                  border:`1px solid ${bioEnabled?T.accent:T.border2}`,
                  borderRadius:20, padding:"5px 14px", fontSize:12, cursor:"pointer",
                  color:bioEnabled?T.accent:T.sub, fontFamily:"'DM Sans',sans-serif", fontWeight:600 }}>
                  {bioEnabled ? "On" : "Off"}
                </button>
              </div>
            )}
          </>
        ) : (
          <div>
            <div style={{ fontSize:14, color:T.text, marginBottom:16, textAlign:"center" }}>
              {mode==="change_old" ? "Enter current PIN"
                : mode==="change_new" ? "Enter new PIN"
                : "Confirm new PIN"}
            </div>
            {err && <div style={{ color:T.danger, fontSize:13, textAlign:"center", marginBottom:12 }}>{err}</div>}
            <PinPad value={currentVal} onChange={setCurrentVal} onSubmit={handlePad} T={T}/>
            <button className="btn-ghost" style={{ width:"100%", padding:10, marginTop:16 }}
              onClick={() => { setMode("idle"); setErr(""); setOldPin(""); setNewPin(""); }}>
              Cancel
            </button>
          </div>
        )}

        {ok && <div style={{ color:T.ok, fontSize:13, textAlign:"center", marginTop:12 }}>✓ {ok}</div>}
      </div>

      {/* Notification thresholds */}
      <div className="card" style={{ padding:20 }}>
        <span className="section-label">Notifications</span>
        <div style={{ fontSize:13, color:T.sub, lineHeight:1.7 }}>
          Torque checks for expiring documents and reminders every time the app opens and schedules
          local notifications automatically. No account or internet required.
        </div>
        <div style={{ marginTop:14, padding:12, borderRadius:8, background:T.okBg, border:`1px solid ${T.okBorder}`, fontSize:12, color:T.ok }}>
          ✓ Notifications active — insurance at 90/30/7 days, registration at 120/60/14 days, reminders at 7 days
        </div>
      </div>
    </div>
  );
}

// ─── Offline Map (Leaflet) ────────────────────────────────────────────────────
function LeafletMap({ lat, lng, height=170, T }) {
  const mapRef  = useRef(null);
  const mapInst = useRef(null);

  useEffect(() => {
    if (!mapRef.current) return;
    // Dynamically load Leaflet CSS + JS
    if (!document.getElementById("leaflet-css")) {
      const link = document.createElement("link");
      link.id = "leaflet-css"; link.rel = "stylesheet";
      link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
      document.head.appendChild(link);
    }

    const initMap = () => {
      if (mapInst.current) {
        mapInst.current.setView([lat, lng], 16);
        return;
      }
      const L = window.L;
      if (!L) return;
      const map = L.map(mapRef.current, { zoomControl:false, attributionControl:false }).setView([lat, lng], 16);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution:"© OpenStreetMap",
        maxZoom:19,
      }).addTo(map);
      L.circleMarker([lat, lng], {
        radius:10, color:"#c8a96e", fillColor:"#c8a96e", fillOpacity:0.7, weight:3
      }).addTo(map);
      L.control.zoom({ position:"bottomright" }).addTo(map);
      mapInst.current = map;
    };

    if (window.L) { initMap(); return; }
    const script = document.createElement("script");
    script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    script.onload = initMap;
    document.head.appendChild(script);

    return () => { if (mapInst.current) { mapInst.current.remove(); mapInst.current = null; } };
  }, [lat, lng]);

  return (
    <div ref={mapRef} style={{ height, width:"100%", borderRadius:10,
      border:`1px solid ${T.border}`, overflow:"hidden" }} />
  );
}

// ─── GPS Capture ──────────────────────────────────────────────────────────────
function GpsCapture({ gps, onChange, T }) {
  const [status, setStatus] = useState("idle");
  const capture = () => {
    if (!navigator.geolocation) { setStatus("error"); return; }
    setStatus("loading");
    navigator.geolocation.getCurrentPosition(
      pos => { onChange({ lat:pos.coords.latitude, lng:pos.coords.longitude,
        takenAt:new Date().toISOString(), accuracy:Math.round(pos.coords.accuracy) }); setStatus("idle"); },
      () => setStatus("error"),
      { enableHighAccuracy:true, timeout:10000 }
    );
  };

  if (gps) return (
    <div className="pop">
      <LeafletMap lat={gps.lat} lng={gps.lng} height={170} T={T}/>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginTop:10 }}>
        <div>
          <div style={{ fontFamily:"'Space Mono',monospace", fontSize:11, color:T.accent }}>{fmtCoord(gps.lat)}, {fmtCoord(gps.lng)}</div>
          <div style={{ fontSize:11, color:T.muted, marginTop:2 }}>±{gps.accuracy}m · {new Date(gps.takenAt).toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit"})}</div>
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <a href={`https://www.google.com/maps?q=${gps.lat},${gps.lng}`} target="_blank" rel="noreferrer"
            style={{ display:"inline-flex", alignItems:"center", gap:6, background:T.blueBg,
              border:`1px solid ${T.blueBorder}`, borderRadius:8, color:T.blue,
              fontFamily:"'DM Sans',sans-serif", fontSize:13, fontWeight:600,
              padding:"7px 12px", textDecoration:"none" }}>
            <NavIcon s={13}/> Navigate
          </a>
          <button onClick={() => onChange(null)} className="btn-ghost" style={{ padding:"7px 10px", fontSize:12 }}>✕</button>
        </div>
      </div>
    </div>
  );

  return (
    <div>
      <button className="gps-tag-btn" onClick={capture} disabled={status==="loading"}>
        {status==="loading" ? <><span className="pulsing">📡</span> Getting location…</> : <><PinIcon s={16}/> Tag GPS Location</>}
      </button>
      {status==="error" && <div style={{ marginTop:8, fontSize:12, color:T.danger }}>⚠ Location access denied.</div>}
    </div>
  );
}

// ─── Parking Card ─────────────────────────────────────────────────────────────
function ParkingCard({ vehicle, onUpdate, T }) {
  const [editLabel, setEditLabel] = useState(null);
  const [gpsMode, setGpsMode]     = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [newSpot, setNewSpot]     = useState("");
  const v = vehicle;
  const history = v.parkingHistory || [];

  const saveLabel = () => {
    const updated = { ...v, parking:editLabel };
    if (!history.find(h => h.label === editLabel))
      updated.parkingHistory = [{ id:genId(), label:editLabel, savedAt:new Date().toISOString() }, ...history].slice(0,8);
    onUpdate(updated); setEditLabel(null);
  };

  return (
    <div className="card" style={{ padding:16, marginBottom:14 }}>
      <div style={{ fontSize:10, color:T.accent, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.1em", marginBottom:12 }}>📍 Parking Location</div>

      {editLabel !== null ? (
        <div style={{ display:"flex", gap:8, marginBottom:12 }}>
          <input value={editLabel} onChange={e=>setEditLabel(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&saveLabel()} className="input"
            style={{ padding:"8px 12px", fontSize:13 }} autoFocus />
          <button onClick={saveLabel} className="btn-gold" style={{ padding:"8px 14px" }}><CheckIcon s={14}/></button>
          <button onClick={()=>setEditLabel(null)} className="btn-ghost" style={{ padding:"8px 10px" }}>✕</button>
        </div>
      ) : (
        <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:12 }}>
          <span style={{ fontFamily:"'Space Mono',monospace", fontSize:13, flex:1 }}>{v.parking}</span>
          <button onClick={()=>setEditLabel(v.parking)} className="btn-icon"><NoteIcon s={14}/></button>
          <button onClick={()=>setShowHistory(s=>!s)} className="btn-icon"><PinIcon s={14}/></button>
        </div>
      )}

      {showHistory && (
        <div className="pop" style={{ background:T.bg, border:`1px solid ${T.border}`, borderRadius:10, padding:12, marginBottom:12 }}>
          <div style={{ fontSize:11, color:T.sub, fontWeight:600, textTransform:"uppercase", letterSpacing:"0.08em", marginBottom:10 }}>Saved Spots</div>
          {history.length > 0 ? history.map(h => (
            <div key={h.id} className="row-item">
              <span style={{ fontSize:13, fontFamily:"'Space Mono',monospace" }}>{h.label}</span>
              <button onClick={()=>{ onUpdate({...v,parking:h.label,gps:null}); setShowHistory(false); }}
                style={{ background:T.accentDim, border:`1px solid ${T.accentBorder}44`, color:T.accent,
                  borderRadius:6, padding:"3px 10px", fontSize:11, cursor:"pointer", fontFamily:"'DM Sans',sans-serif" }}>
                Switch
              </button>
            </div>
          )) : <div style={{ fontSize:12, color:T.muted }}>No saved spots yet</div>}
          <div style={{ display:"flex", gap:8, marginTop:10 }}>
            <input className="input" style={{ padding:"7px 10px", fontSize:12 }} placeholder="Add spot…"
              value={newSpot} onChange={e=>setNewSpot(e.target.value)} onKeyDown={e=>{
                if(e.key==="Enter"&&newSpot.trim()) {
                  onUpdate({...v,parking:newSpot.trim(),parkingHistory:[{id:genId(),label:newSpot.trim(),savedAt:new Date().toISOString()},...history].slice(0,8)});
                  setNewSpot(""); setShowHistory(false);
                }
              }}/>
            <button onClick={()=>{
              if(!newSpot.trim()) return;
              onUpdate({...v,parking:newSpot.trim(),parkingHistory:[{id:genId(),label:newSpot.trim(),savedAt:new Date().toISOString()},...history].slice(0,8)});
              setNewSpot(""); setShowHistory(false);
            }} className="btn-gold" style={{ padding:"7px 12px", flexShrink:0 }}><PlusIcon s={13}/></button>
          </div>
        </div>
      )}

      {v.gps && (
        <>
          <LeafletMap lat={v.gps.lat} lng={v.gps.lng} height={160} T={T}/>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginTop:10 }}>
            <div>
              <div style={{ fontFamily:"'Space Mono',monospace", fontSize:11, color:T.accent }}>{fmtCoord(v.gps.lat)}, {fmtCoord(v.gps.lng)}</div>
              <div style={{ fontSize:11, color:T.muted, marginTop:2 }}>±{v.gps.accuracy}m · {fmtDate(v.gps.takenAt)}</div>
            </div>
            <a href={`https://www.google.com/maps?q=${v.gps.lat},${v.gps.lng}`} target="_blank" rel="noreferrer"
              style={{ display:"inline-flex", alignItems:"center", gap:6, background:T.blueBg,
                border:`1px solid ${T.blueBorder}`, borderRadius:8, color:T.blue,
                fontFamily:"'DM Sans',sans-serif", fontSize:12, fontWeight:600,
                padding:"6px 11px", textDecoration:"none" }}>
              <NavIcon s={12}/> Navigate
            </a>
          </div>
          <button className="gps-tag-btn" style={{ marginTop:10 }} onClick={()=>onUpdate({...v,gps:null})}>
            🔄 Retag Location
          </button>
        </>
      )}

      {!v.gps && !gpsMode && (
        <button className="gps-tag-btn" style={{ marginTop:4 }} onClick={()=>setGpsMode(true)}>
          <PinIcon s={16}/> Tag GPS Location
        </button>
      )}
      {gpsMode && !v.gps && (
        <div style={{ marginTop:8 }}>
          <GpsCapture gps={null} onChange={coords=>{ onUpdate({...v,gps:coords}); setGpsMode(false); }} T={T}/>
          <button onClick={()=>setGpsMode(false)} className="btn-ghost" style={{ width:"100%", padding:10, marginTop:8, fontSize:13 }}>Cancel</button>
        </div>
      )}
    </div>
  );
}

// ─── Google Drive Backup Panel ────────────────────────────────────────────────
function BackupPanel({ vehicles, pin, onRestore, T }) {
  const [driveStatus, setDriveStatus] = useState("idle"); // idle | connecting | uploading | listing | restoring | error
  const [driveFiles, setDriveFiles]   = useState([]);
  const [driveToken, setDriveToken]   = useState(null);
  const [localStatus, setLocalStatus] = useState("");
  const fileRef = useRef();

  const connectDrive = async () => {
    setDriveStatus("connecting");
    try {
      const token = await getGDriveToken();
      setDriveToken(token);
      setDriveStatus("listing");
      const files = await listDriveBackups(token);
      setDriveFiles(files);
      setDriveStatus("idle");
    } catch (e) {
      setDriveStatus("error");
    }
  };

  const backupToDrive = async () => {
    if (!driveToken) { connectDrive(); return; }
    setDriveStatus("uploading");
    try {
      const encrypted = await encryptData({ vehicles, exportedAt:new Date().toISOString(), version:"v2" }, pin);
      const filename = `torque-backup-${new Date().toISOString().slice(0,10)}.enc`;
      await uploadToDrive(driveToken, encrypted, filename);
      const files = await listDriveBackups(driveToken);
      setDriveFiles(files);
      setDriveStatus("idle");
      setLocalStatus("✓ Backup uploaded to Google Drive");
      setTimeout(() => setLocalStatus(""), 4000);
    } catch { setDriveStatus("error"); }
  };

  const restoreFromDrive = async (fileId) => {
    if (!driveToken) return;
    setDriveStatus("restoring");
    try {
      const raw = await downloadFromDrive(driveToken, fileId);
      const data = await decryptData(raw, pin);
      if (!data?.vehicles) { setDriveStatus("error"); return; }
      if (window.confirm(`Restore ${data.vehicles.length} vehicles? This overwrites current data.`)) {
        onRestore(data.vehicles);
        setLocalStatus(`✓ Restored ${data.vehicles.length} vehicles`);
        setTimeout(() => setLocalStatus(""), 4000);
      }
      setDriveStatus("idle");
    } catch { setDriveStatus("error"); }
  };

  const exportLocal = async () => {
    setLocalStatus("Encrypting…");
    try {
      const encrypted = await encryptData({ vehicles, exportedAt:new Date().toISOString(), version:"v2" }, pin);
      const blob = new Blob([encrypted], { type:"text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url;
      a.download = `torque-backup-${new Date().toISOString().slice(0,10)}.enc`;
      a.click(); URL.revokeObjectURL(url);
      setLocalStatus("✓ Backup downloaded");
      setTimeout(() => setLocalStatus(""), 4000);
    } catch { setLocalStatus("Export failed"); }
  };

  const importLocal = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    setLocalStatus("Decrypting…");
    const text = await file.text();
    const data = await decryptData(text, pin);
    if (!data?.vehicles) { setLocalStatus("⚠ Decryption failed — wrong PIN or corrupted file."); return; }
    if (window.confirm(`Restore ${data.vehicles.length} vehicles from ${fmtDate(data.exportedAt)}?`)) {
      onRestore(data.vehicles);
      setLocalStatus(`✓ Restored ${data.vehicles.length} vehicles`);
    }
    e.target.value = "";
    setTimeout(() => setLocalStatus(""), 4000);
  };

  const busy = ["connecting","uploading","listing","restoring"].includes(driveStatus);

  return (
    <div style={{ padding:18, maxWidth:560, margin:"0 auto" }}>

      {/* Google Drive */}
      <div className="card" style={{ padding:20, marginBottom:14 }}>
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:14 }}>
          <div style={{ width:36, height:36, borderRadius:10, background:T.blueBg, display:"flex", alignItems:"center", justifyContent:"center" }}>
            <DriveIcon s={18}/>
          </div>
          <div>
            <div style={{ fontSize:15, fontWeight:600 }}>Google Drive</div>
            <div style={{ fontSize:12, color:T.sub }}>Encrypted · Syncs to your Drive</div>
          </div>
          {driveToken && <span style={{ marginLeft:"auto", fontSize:11, color:T.ok }}>✓ Connected</span>}
        </div>

        {!driveToken ? (
          <button className="btn-gold" style={{ width:"100%", padding:13 }} onClick={connectDrive} disabled={busy}>
            {driveStatus==="connecting" ? <span className="pulsing">Connecting…</span> : "Connect Google Drive"}
          </button>
        ) : (
          <>
            <button className="btn-gold" style={{ width:"100%", padding:13, marginBottom:10 }} onClick={backupToDrive} disabled={busy}>
              {driveStatus==="uploading" ? <span className="pulsing">Uploading…</span> : "⬆ Backup to Drive Now"}
            </button>

            {driveStatus==="listing" && <div style={{ fontSize:13, color:T.sub, textAlign:"center", padding:12 }} className="pulsing">Loading backups…</div>}

            {driveFiles.length > 0 && (
              <div>
                <div style={{ fontSize:11, color:T.sub, fontWeight:600, textTransform:"uppercase", letterSpacing:"0.08em", marginBottom:10, marginTop:4 }}>Saved Backups</div>
                {driveFiles.map(f => (
                  <div key={f.id} className="row-item">
                    <div>
                      <div style={{ fontSize:13 }}>{f.name}</div>
                      <div style={{ fontSize:11, color:T.muted }}>{fmtDate(f.createdTime)}</div>
                    </div>
                    <button onClick={()=>restoreFromDrive(f.id)} className="btn-ghost"
                      style={{ padding:"5px 12px", fontSize:12 }} disabled={busy}>
                      {driveStatus==="restoring"?<span className="pulsing">…</span>:"Restore"}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {driveStatus==="error" && (
          <div style={{ marginTop:10, fontSize:12, color:T.danger }}>
            ⚠ Something went wrong. Check your internet connection and try again.
            <button onClick={()=>setDriveStatus("idle")} style={{ marginLeft:8, background:"none", border:"none", color:T.accent, cursor:"pointer", fontSize:12 }}>Retry</button>
          </div>
        )}

        <div style={{ marginTop:14, padding:10, borderRadius:8, background:T.bg, border:`1px solid ${T.border}`, fontSize:11, color:T.muted }}>
          💡 Replace <code style={{ color:T.accent }}>YOUR_GOOGLE_CLIENT_ID_HERE</code> in the source file with your OAuth2 client ID to enable Drive sync.
        </div>
      </div>

      {/* Local backup */}
      <div className="card" style={{ padding:20 }}>
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:14 }}>
          <div style={{ width:36, height:36, borderRadius:10, background:T.accentDim, display:"flex", alignItems:"center", justifyContent:"center" }}>
            <LockIcon s={18}/>
          </div>
          <div>
            <div style={{ fontSize:15, fontWeight:600 }}>Local Backup</div>
            <div style={{ fontSize:12, color:T.sub }}>AES-256 · Save anywhere</div>
          </div>
        </div>
        <button className="btn-gold" style={{ width:"100%", padding:13, marginBottom:10 }} onClick={exportLocal}>
          ⬇ Download Encrypted Backup
        </button>
        <button className="btn-ghost" style={{ width:"100%", padding:13 }} onClick={()=>fileRef.current.click()}>
          ⬆ Restore from File
        </button>
        <input ref={fileRef} type="file" accept=".enc,.txt" onChange={importLocal} style={{ display:"none" }} />
        {localStatus && (
          <div style={{ marginTop:12, padding:10, borderRadius:8, fontSize:13,
            background:localStatus.startsWith("✓")?T.okBg:localStatus.startsWith("⚠")?T.dangerBg:T.bg,
            border:`1px solid ${localStatus.startsWith("✓")?T.okBorder:localStatus.startsWith("⚠")?T.dangerBorder:T.border}`,
            color:localStatus.startsWith("✓")?T.ok:localStatus.startsWith("⚠")?T.danger:T.sub }}>
            {localStatus}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Swipeable Tabs ───────────────────────────────────────────────────────────
function SwipeTabs({ tabs, activeTab, onTabChange, children, T }) {
  const trackRef   = useRef(null);
  const startX     = useRef(0);
  const startY     = useRef(0);
  const isDragging = useRef(false);
  const isScrolling = useRef(false);
  const activeIdx  = tabs.findIndex(t => t.id === activeTab);

  const onTouchStart = (e) => {
    startX.current = e.touches[0].clientX;
    startY.current = e.touches[0].clientY;
    isDragging.current = false;
    isScrolling.current = false;
  };

  const onTouchMove = (e) => {
    const dx = e.touches[0].clientX - startX.current;
    const dy = e.touches[0].clientY - startY.current;
    if (!isDragging.current && !isScrolling.current) {
      if (Math.abs(dy) > Math.abs(dx)) { isScrolling.current = true; return; }
      if (Math.abs(dx) > 8) isDragging.current = true;
    }
    if (isDragging.current) e.preventDefault();
  };

  const onTouchEnd = (e) => {
    if (!isDragging.current) return;
    const dx = e.changedTouches[0].clientX - startX.current;
    if (Math.abs(dx) > 50) {
      const next = dx < 0 ? Math.min(activeIdx+1, tabs.length-1) : Math.max(activeIdx-1, 0);
      onTabChange(tabs[next].id);
    }
  };

  return (
    <div onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
      style={{ flex:1, overflow:"hidden" }}>
      <div ref={trackRef} className="swipe-track"
        style={{ transform:`translateX(-${activeIdx*100}%)` }}>
        {children}
      </div>
    </div>
  );
}

// ─── Photo Section ────────────────────────────────────────────────────────────
function PhotoSection({ photos=[], onChange, T }) {
  const fileRef = useRef();
  const [lightbox, setLightbox] = useState(null);
  const addPhoto = (e) => {
    Array.from(e.target.files).forEach(file => {
      const reader = new FileReader();
      reader.onload = ev => onChange([...photos, { id:genId(), label:file.name.replace(/\.[^.]+$/,""), dataUrl:ev.target.result, addedAt:new Date().toISOString() }]);
      reader.readAsDataURL(file);
    });
    e.target.value = "";
  };
  return (
    <div>
      <div style={{ display:"flex", flexWrap:"wrap", gap:10, marginBottom:10 }}>
        {photos.map(p => (
          <div key={p.id} style={{ position:"relative" }}>
            <img src={p.dataUrl} alt={p.label} className="photo-thumb" onClick={()=>setLightbox(p)}/>
            <button onClick={()=>onChange(photos.filter(x=>x.id!==p.id))}
              style={{ position:"absolute", top:-6, right:-6, width:20, height:20, borderRadius:"50%",
                background:"#c0392b", border:"none", cursor:"pointer", color:"#fff",
                display:"flex", alignItems:"center", justifyContent:"center", fontSize:10 }}>✕</button>
          </div>
        ))}
        <button onClick={()=>fileRef.current.click()}
          style={{ width:80, height:80, borderRadius:10, border:`2px dashed ${T.border2}`,
            background:T.bg, cursor:"pointer", display:"flex", flexDirection:"column",
            alignItems:"center", justifyContent:"center", gap:4, color:T.muted }}>
          <CameraIcon s={20}/><span style={{ fontSize:11 }}>Add</span>
        </button>
      </div>
      <input ref={fileRef} type="file" accept="image/*" multiple onChange={addPhoto}
        style={{ display:"none" }} capture="environment"/>
      {lightbox && (
        <div className="modal-overlay" onClick={()=>setLightbox(null)}>
          <div style={{ maxWidth:560, width:"100%", padding:20 }} onClick={e=>e.stopPropagation()}>
            <img src={lightbox.dataUrl} alt={lightbox.label} style={{ width:"100%", borderRadius:14 }}/>
            <div style={{ color:T.text, textAlign:"center", marginTop:10, fontSize:13 }}>{lightbox.label}</div>
            <button onClick={()=>setLightbox(null)} className="btn-ghost" style={{ width:"100%", padding:10, marginTop:12 }}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Fuel Log ─────────────────────────────────────────────────────────────────
function FuelLog({ fuelLog=[], onChange, T }) {
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ date:"", litres:"", cost:"", odo:"" });
  const set = (k,v) => setForm(f=>({...f,[k]:v}));
  const add = () => {
    onChange([{ id:genId(), date:form.date, litres:Number(form.litres), cost:Number(form.cost), odo:Number(form.odo) }, ...fuelLog]);
    setShowAdd(false); setForm({ date:"", litres:"", cost:"", odo:"" });
  };
  const efficiency = fuelLog.length>=2 ? ((fuelLog[0].odo-fuelLog[fuelLog.length-1].odo)/fuelLog.reduce((s,e)=>s+e.litres,0)).toFixed(1) : null;
  return (
    <div>
      {fuelLog.length>0 && (
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10, marginBottom:14 }}>
          {[{label:"Fill-ups",value:fuelLog.length},{label:"Total Spend",value:fmtCurrency(fuelLog.reduce((s,e)=>s+e.cost,0))},{label:"Avg km/l",value:efficiency||"—"}].map(({label,value})=>(
            <div key={label} className="card" style={{ padding:"12px 10px", textAlign:"center" }}>
              <div style={{ fontSize:14, fontWeight:700, color:T.accent }}>{value}</div>
              <div style={{ fontSize:10, color:T.muted, marginTop:3 }}>{label}</div>
            </div>
          ))}
        </div>
      )}
      <button className="btn-gold" style={{ width:"100%", padding:13, marginBottom:14 }} onClick={()=>setShowAdd(s=>!s)}>
        {showAdd?"Cancel":<><PlusIcon s={14}/> Log Fill-up</>}
      </button>
      {showAdd && (
        <div className="card pop" style={{ padding:16, marginBottom:14 }}>
          <span className="section-label">New Fill-up</span>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:10 }}>
            {[["Date","date","date",""],["Odometer","odo","number","km"],["Litres","litres","number","L"],["Cost ₹","cost","number","₹"]].map(([l,k,t,p])=>(
              <div key={k}><div style={{ fontSize:11, color:T.sub, marginBottom:5 }}>{l}</div>
                <input className="input" type={t} placeholder={p} value={form[k]} onChange={e=>set(k,e.target.value)}/></div>
            ))}
          </div>
          <button className="btn-gold" style={{ width:"100%", padding:11 }} onClick={add} disabled={!form.date||!form.litres}>Save</button>
        </div>
      )}
      {fuelLog.length===0 ? (
        <div className="card" style={{ padding:24, textAlign:"center" }}><div style={{ fontSize:28, marginBottom:8 }}>⛽</div><div style={{ color:T.muted, fontSize:13 }}>No fill-ups logged</div></div>
      ) : (
        <div className="card" style={{ padding:16 }}>
          <span className="section-label">History</span>
          {fuelLog.map((e,i)=>{
            const kmpl = i<fuelLog.length-1 ? ((e.odo-fuelLog[i+1].odo)/e.litres).toFixed(1) : null;
            return (
              <div key={e.id} className="row-item">
                <div><div style={{ fontSize:13, fontWeight:500 }}>{fmtDate(e.date)}</div>
                  <div style={{ fontSize:11, color:T.muted, fontFamily:"'Space Mono',monospace" }}>{e.litres}L · {e.odo?.toLocaleString()}km{kmpl?<span style={{ color:T.accent }}> · {kmpl}km/l</span>:""}</div>
                </div>
                <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                  <span style={{ fontSize:13, fontWeight:600 }}>{fmtCurrency(e.cost)}</span>
                  <button onClick={()=>onChange(fuelLog.filter(x=>x.id!==e.id))} className="btn-icon"><TrashIcon s={12}/></button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Odometer ─────────────────────────────────────────────────────────────────
function OdometerTracker({ odoLog=[], onChange, T }) {
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ date:"", km:"", note:"" });
  const add = () => {
    onChange([{ id:genId(), date:form.date, km:Number(form.km), note:form.note }, ...odoLog]);
    setShowAdd(false); setForm({ date:"", km:"", note:"" });
  };
  const latest = odoLog[0]; const prev = odoLog[1];
  return (
    <div>
      {latest && (
        <div className="card" style={{ padding:16, marginBottom:14 }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <div><div style={{ fontSize:11, color:T.sub, marginBottom:4 }}>Current Reading</div>
              <div style={{ fontSize:24, fontWeight:700, color:T.accent, fontFamily:"'Space Mono',monospace" }}>{latest.km.toLocaleString()} <span style={{ fontSize:14, color:T.sub }}>km</span></div>
              <div style={{ fontSize:11, color:T.muted, marginTop:2 }}>{fmtDate(latest.date)}</div>
            </div>
            {prev && <div style={{ textAlign:"right" }}><div style={{ fontSize:11, color:T.sub, marginBottom:4 }}>Since Last</div>
              <div style={{ fontSize:18, fontWeight:700 }}>+{(latest.km-prev.km).toLocaleString()} km</div></div>}
          </div>
        </div>
      )}
      <button className="btn-gold" style={{ width:"100%", padding:13, marginBottom:14 }} onClick={()=>setShowAdd(s=>!s)}>
        {showAdd?"Cancel":<><GaugeIcon s={14}/> Log Reading</>}
      </button>
      {showAdd && (
        <div className="card pop" style={{ padding:16, marginBottom:14 }}>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:10 }}>
            <div><div style={{ fontSize:11, color:T.sub, marginBottom:5 }}>Date</div><input className="input" type="date" value={form.date} onChange={e=>setForm(f=>({...f,date:e.target.value}))}/></div>
            <div><div style={{ fontSize:11, color:T.sub, marginBottom:5 }}>Odometer km</div><input className="input" type="number" placeholder="24500" value={form.km} onChange={e=>setForm(f=>({...f,km:e.target.value}))}/></div>
          </div>
          <input className="input" placeholder="Note (optional)" value={form.note} onChange={e=>setForm(f=>({...f,note:e.target.value}))} style={{ marginBottom:10 }}/>
          <button className="btn-gold" style={{ width:"100%", padding:11 }} onClick={add} disabled={!form.date||!form.km}>Save</button>
        </div>
      )}
      {odoLog.length>1 && (
        <div className="card" style={{ padding:16, marginBottom:14 }}>
          <span className="section-label">Usage Trend</span>
          {odoLog.slice(0,6).map((e,i)=>{ const d=odoLog[i+1]?e.km-odoLog[i+1].km:0; const max=Math.max(...odoLog.slice(0,6).map((x,j)=>odoLog[j+1]?x.km-odoLog[j+1].km:0)); return (
            <div key={e.id} style={{ marginBottom:10 }}>
              <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:T.sub, marginBottom:3 }}>
                <span>{fmtDate(e.date)}</span>{d>0&&<span style={{ color:T.text, fontWeight:600 }}>+{d.toLocaleString()} km</span>}
              </div>
              {d>0&&<div className="trend-bar"><div className="trend-fill" style={{ width:`${(d/max)*100}%` }}/></div>}
            </div>
          );})}
        </div>
      )}
      {odoLog.length>0&&<div className="card" style={{ padding:16 }}><span className="section-label">Log</span>{odoLog.map(e=>(
        <div key={e.id} className="row-item">
          <div><div style={{ fontSize:13, fontFamily:"'Space Mono',monospace", fontWeight:600 }}>{e.km.toLocaleString()} km</div>
            <div style={{ fontSize:11, color:T.muted }}>{fmtDate(e.date)}{e.note&&` · ${e.note}`}</div></div>
          <button onClick={()=>onChange(odoLog.filter(x=>x.id!==e.id))} className="btn-icon"><TrashIcon s={12}/></button>
        </div>
      ))}</div>}
    </div>
  );
}

// ─── Reminders ────────────────────────────────────────────────────────────────
function RemindersPanel({ reminders=[], onChange, T }) {
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ title:"", date:"", note:"" });
  const add = () => { onChange([{ id:genId(), title:form.title, date:form.date, note:form.note, done:false }, ...reminders]); setShowAdd(false); setForm({ title:"", date:"", note:"" }); };
  return (
    <div>
      <button className="btn-gold" style={{ width:"100%", padding:13, marginBottom:14 }} onClick={()=>setShowAdd(s=>!s)}>
        {showAdd?"Cancel":<><PlusIcon s={14}/> Add Reminder</>}
      </button>
      {showAdd&&<div className="card pop" style={{ padding:16, marginBottom:14 }}>
        <input className="input" placeholder="e.g. Tyre pressure check" value={form.title} onChange={e=>setForm(f=>({...f,title:e.target.value}))} style={{ marginBottom:10 }}/>
        <input className="input" type="date" value={form.date} onChange={e=>setForm(f=>({...f,date:e.target.value}))} style={{ marginBottom:10 }}/>
        <input className="input" placeholder="Note (optional)" value={form.note} onChange={e=>setForm(f=>({...f,note:e.target.value}))} style={{ marginBottom:10 }}/>
        <button className="btn-gold" style={{ width:"100%", padding:11 }} onClick={add} disabled={!form.title}>Save</button>
      </div>}
      {reminders.length===0?<div className="card" style={{ padding:24, textAlign:"center" }}><div style={{ fontSize:28, marginBottom:8 }}>🔔</div><div style={{ color:T.muted, fontSize:13 }}>No reminders</div></div>:
        reminders.map(r=>{ const d=daysBetween(r.date); return (
          <div key={r.id} className="card" style={{ padding:14, marginBottom:10, opacity:r.done?0.5:1 }}>
            <div style={{ display:"flex", alignItems:"flex-start", gap:10 }}>
              <button onClick={()=>onChange(reminders.map(x=>x.id===r.id?{...x,done:!x.done}:x))}
                style={{ width:22, height:22, borderRadius:"50%", border:`2px solid ${r.done?T.accent:T.border2}`,
                  background:r.done?T.accent:"none", cursor:"pointer", flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center" }}>
                {r.done&&<CheckIcon s={10}/>}
              </button>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:13, fontWeight:500, textDecoration:r.done?"line-through":"none" }}>{r.title}</div>
                {r.date&&<div style={{ fontSize:11, marginTop:2, color:d<0?T.danger:d<7?T.warn:T.muted }}>{d<0?`Overdue by ${Math.abs(d)}d`:d===0?"Due today":`Due ${fmtDate(r.date)}`}</div>}
                {r.note&&<div style={{ fontSize:11, color:T.muted, marginTop:1 }}>{r.note}</div>}
              </div>
              <button onClick={()=>onChange(reminders.filter(x=>x.id!==r.id))} className="btn-icon"><TrashIcon s={12}/></button>
            </div>
          </div>
        );})}
    </div>
  );
}

// ─── Notes ────────────────────────────────────────────────────────────────────
function NotesPanel({ notes=[], onChange, T }) {
  const [showAdd, setShowAdd] = useState(false);
  const [text, setText] = useState("");
  const [editId, setEditId] = useState(null);
  const [editText, setEditText] = useState("");
  return (
    <div>
      <button className="btn-gold" style={{ width:"100%", padding:13, marginBottom:14 }} onClick={()=>setShowAdd(s=>!s)}>
        {showAdd?"Cancel":<><PlusIcon s={14}/> Add Note</>}
      </button>
      {showAdd&&<div className="card pop" style={{ padding:16, marginBottom:14 }}>
        <textarea className="input" placeholder="Modification, dealer contact, accident record…" value={text} onChange={e=>setText(e.target.value)} style={{ marginBottom:10, minHeight:100 }}/>
        <button className="btn-gold" style={{ width:"100%", padding:11 }} onClick={()=>{ if(!text.trim())return; onChange([{ id:genId(), text:text.trim(), createdAt:new Date().toISOString() }, ...notes]); setText(""); setShowAdd(false); }} disabled={!text.trim()}>Save</button>
      </div>}
      {notes.length===0?<div className="card" style={{ padding:24, textAlign:"center" }}><div style={{ fontSize:28, marginBottom:8 }}>📝</div><div style={{ color:T.muted, fontSize:13 }}>No notes yet</div></div>:
        notes.map(n=>(
          <div key={n.id} className="card" style={{ padding:16, marginBottom:10 }}>
            {editId===n.id?<>
              <textarea className="input" value={editText} onChange={e=>setEditText(e.target.value)} style={{ marginBottom:10 }}/>
              <div style={{ display:"flex", gap:8 }}>
                <button className="btn-gold" style={{ flex:1, padding:10 }} onClick={()=>{ onChange(notes.map(x=>x.id===n.id?{...x,text:editText,updatedAt:new Date().toISOString()}:x)); setEditId(null); }}>Save</button>
                <button className="btn-ghost" style={{ flex:1, padding:10 }} onClick={()=>setEditId(null)}>Cancel</button>
              </div>
            </>:<>
              <div style={{ fontSize:13, lineHeight:1.6, whiteSpace:"pre-wrap" }}>{n.text}</div>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginTop:10 }}>
                <span style={{ fontSize:11, color:T.muted }}>{fmtDate(n.updatedAt||n.createdAt)}</span>
                <div style={{ display:"flex", gap:6 }}>
                  <button onClick={()=>{ setEditId(n.id); setEditText(n.text); }} className="btn-icon"><NoteIcon s={12}/></button>
                  <button onClick={()=>onChange(notes.filter(x=>x.id!==n.id))} className="btn-icon"><TrashIcon s={12}/></button>
                </div>
              </div>
            </>}
          </div>
        ))}
    </div>
  );
}

// ─── Wizard ───────────────────────────────────────────────────────────────────
const STEPS = ["Type","Details","Location","Insurance","Registration","Service"];

function AddVehicleWizard({ onSave, onCancel, editVehicle, T }) {
  const init = editVehicle || {};
  const [step, setStep] = useState(0);
  const [quick, setQuick] = useState(false);
  const [form, setForm] = useState({
    type:init.type||"", name:init.name||"", plate:init.plate||"",
    year:init.year||new Date().getFullYear(), fuel:init.fuel||"Petrol", color:init.color||"#3498db",
    parking:init.parking||"", gps:init.gps||null,
    insProvider:init.insurance?.provider||"", insPolicy:init.insurance?.policy||"", insExpiry:init.insurance?.expiry||"",
    regRc:init.registration?.rc||"", regExpiry:init.registration?.expiry||"",
    svcDate:"", svcType:"Full Service", svcKm:"", svcNext:"",
  });
  const set = (k,v) => setForm(f=>({...f,[k]:v}));
  const canNext = () => { if(step===0) return !!form.type; if(step===1) return form.name.trim()&&form.plate.trim()&&form.year; return true; };

  const buildVehicle = () => {
    const v = {
      id:init.id||genId(), type:form.type, name:form.name.trim(),
      plate:form.plate.trim().toUpperCase(), year:Number(form.year), fuel:form.fuel, color:form.color,
      parking:form.parking.trim()||"Not set", gps:form.gps||null,
      insurance:{ provider:form.insProvider, policy:form.insPolicy, expiry:form.insExpiry },
      registration:{ rc:form.regRc, expiry:form.regExpiry },
      service:init.service||[], alerts:[],
      fuelLog:init.fuelLog||[], odoLog:init.odoLog||[],
      reminders:init.reminders||[], notes:init.notes||[],
      photos:init.photos||[], parkingHistory:init.parkingHistory||[],
    };
    if(form.svcDate&&form.svcKm) v.service=[{ date:form.svcDate, type:form.svcType, km:Number(form.svcKm), next:Number(form.svcNext)||Number(form.svcKm)+5000 },...v.service];
    if(form.insExpiry&&daysBetween(form.insExpiry)<90) v.alerts.push({ id:genId(), msg:`Insurance expiring in ${daysBetween(form.insExpiry)} days`, type:daysBetween(form.insExpiry)<30?"danger":"warn" });
    if(form.regExpiry&&daysBetween(form.regExpiry)<120) v.alerts.push({ id:genId(), msg:`Registration expiring in ${daysBetween(form.regExpiry)} days`, type:daysBetween(form.regExpiry)<60?"danger":"warn" });
    return v;
  };

  const L = { fontSize:12, color:T.sub, fontWeight:500, letterSpacing:"0.04em", marginBottom:6, display:"block" };
  const FW = { marginBottom:14 };

  return (
    <div style={{ position:"fixed", inset:0, background:T.bg, zIndex:50, display:"flex", flexDirection:"column", fontFamily:"'DM Sans',sans-serif", color:T.text }}>
      <div style={{ background:T.header, borderBottom:`1px solid ${T.border}`, padding:"14px 18px" }}>
        <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:quick?0:12 }}>
          <button onClick={onCancel} className="btn-ghost" style={{ padding:"6px 12px", fontSize:13 }}><CloseIcon s={14}/></button>
          <span style={{ fontSize:16, fontWeight:600 }}>{editVehicle?"Edit Vehicle":"Add Vehicle"}</span>
          {!editVehicle&&!quick&&step===0&&<button onClick={()=>setQuick(true)} style={{ marginLeft:"auto", background:"none", border:`1px solid ${T.border2}`, color:T.sub, borderRadius:8, padding:"5px 12px", fontSize:12, cursor:"pointer" }}>Quick Add ⚡</button>}
          {!quick&&<span style={{ marginLeft:"auto", fontSize:12, color:T.muted }}>Step {step+1}/{STEPS.length}</span>}
        </div>
        {!quick&&<><div style={{ display:"flex", gap:5 }}>{STEPS.map((_,i)=><div key={i} style={{ height:4, borderRadius:2, background:i<=step?T.accent:T.border2, flex:i===step?2:1, transition:"all 0.2s" }}/>)}</div><div style={{ fontSize:12, color:T.accent, marginTop:8, fontWeight:600 }}>{STEPS[step]}</div></>}
      </div>

      <div style={{ flex:1, overflowY:"auto", padding:20 }}>
        {quick&&<div className="fade">
          <div style={{ color:T.sub, fontSize:13, marginBottom:20 }}>Just the essentials — fill in the rest later.</div>
          <div style={{ display:"flex", gap:12, marginBottom:14 }}>{["car","bike"].map(t=><button key={t} className={`type-btn${form.type===t?" selected":""}`} onClick={()=>set("type",t)}>{t==="car"?<CarSvg s={30}/>:<BikeSvg s={30}/>}{t==="car"?"Car":"Bike"}</button>)}</div>
          <div style={FW}><label style={L}>Vehicle Name *</label><input className="input" placeholder="e.g. BMW X5" value={form.name} onChange={e=>set("name",e.target.value)}/></div>
          <div style={FW}><label style={L}>License Plate *</label><input className="input" placeholder="e.g. MH12AB1234" value={form.plate} onChange={e=>set("plate",e.target.value)} style={{ fontFamily:"'Space Mono',monospace", textTransform:"uppercase" }}/></div>
          <button className="btn-gold" style={{ width:"100%", padding:14 }} disabled={!form.type||!form.name.trim()||!form.plate.trim()} onClick={()=>onSave(buildVehicle())}>Add Vehicle ✓</button>
          <button onClick={()=>setQuick(false)} style={{ width:"100%", marginTop:10, background:"none", border:"none", color:T.sub, fontSize:13, cursor:"pointer", textDecoration:"underline" }}>Full setup instead</button>
        </div>}

        {!quick&&step===0&&<div className="fade"><div style={{ color:T.sub, fontSize:14, marginBottom:20 }}>What kind of vehicle?</div><div style={{ display:"flex", gap:12 }}>{["car","bike"].map(t=><button key={t} className={`type-btn${form.type===t?" selected":""}`} onClick={()=>set("type",t)}>{t==="car"?<CarSvg s={36}/>:<BikeSvg s={36}/>}{t==="car"?"Car / SUV":"Motorcycle / Bike"}</button>)}</div></div>}

        {!quick&&step===1&&<div className="fade">
          <div style={FW}><label style={L}>Vehicle Name *</label><input className="input" placeholder="e.g. BMW X5" value={form.name} onChange={e=>set("name",e.target.value)}/></div>
          <div style={FW}><label style={L}>License Plate *</label><input className="input" placeholder="e.g. MH12AB1234" value={form.plate} onChange={e=>set("plate",e.target.value)} style={{ fontFamily:"'Space Mono',monospace", textTransform:"uppercase" }}/></div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
            <div style={FW}><label style={L}>Year *</label><input className="input" type="number" min="1990" max={new Date().getFullYear()} value={form.year} onChange={e=>set("year",e.target.value)}/></div>
            <div style={FW}><label style={L}>Fuel</label><select className="input" value={form.fuel} onChange={e=>set("fuel",e.target.value)}>{["Petrol","Diesel","CNG","Electric","Hybrid"].map(f=><option key={f}>{f}</option>)}</select></div>
          </div>
          <div style={FW}><label style={L}>Colour</label><div style={{ display:"flex", flexWrap:"wrap", gap:10, marginTop:4 }}>{COLORS.map(c=><div key={c} className={`color-swatch${form.color===c?" picked":""}`} style={{ background:c }} onClick={()=>set("color",c)}/>)}</div></div>
        </div>}

        {!quick&&step===2&&<div className="fade">
          <div style={FW}><label style={L}>Parking Label</label><input className="input" placeholder="e.g. Home Garage, B2 Slot 04" value={form.parking} onChange={e=>set("parking",e.target.value)}/></div>
          <div style={{ fontSize:12, color:T.sub, marginBottom:12 }}>Optionally tag the GPS location.</div>
          <GpsCapture gps={form.gps} onChange={g=>set("gps",g)} T={T}/>
        </div>}

        {!quick&&step===3&&<div className="fade">
          <div style={{ fontSize:13, color:T.sub, marginBottom:16 }}>Insurance — skip if not available.</div>
          <div style={FW}><label style={L}>Provider</label><input className="input" placeholder="e.g. HDFC ERGO" value={form.insProvider} onChange={e=>set("insProvider",e.target.value)}/></div>
          <div style={FW}><label style={L}>Policy Number</label><input className="input" value={form.insPolicy} onChange={e=>set("insPolicy",e.target.value)} style={{ fontFamily:"'Space Mono',monospace" }}/></div>
          <div style={FW}><label style={L}>Expiry</label><input className="input" type="date" value={form.insExpiry} onChange={e=>set("insExpiry",e.target.value)}/></div>
          {form.insExpiry&&<div style={{ padding:10, borderRadius:8, background:daysBetween(form.insExpiry)<90?T.dangerBg:T.okBg, border:`1px solid ${daysBetween(form.insExpiry)<90?T.dangerBorder:T.okBorder}`, fontSize:12, color:daysBetween(form.insExpiry)<90?T.danger:T.ok }}>{daysBetween(form.insExpiry)<0?"⚠ Expired.":daysBetween(form.insExpiry)<90?`⚠ ${daysBetween(form.insExpiry)} days left.`:`✓ Valid ${daysBetween(form.insExpiry)} days.`}</div>}
        </div>}

        {!quick&&step===4&&<div className="fade">
          <div style={{ fontSize:13, color:T.sub, marginBottom:16 }}>Registration — skip if not available.</div>
          <div style={FW}><label style={L}>RC Number</label><input className="input" value={form.regRc} onChange={e=>set("regRc",e.target.value)} style={{ fontFamily:"'Space Mono',monospace" }}/></div>
          <div style={FW}><label style={L}>Renewal Date</label><input className="input" type="date" value={form.regExpiry} onChange={e=>set("regExpiry",e.target.value)}/></div>
          {form.regExpiry&&<div style={{ padding:10, borderRadius:8, background:daysBetween(form.regExpiry)<120?T.dangerBg:T.blueBg, border:`1px solid ${daysBetween(form.regExpiry)<120?T.dangerBorder:T.blueBorder}`, fontSize:12, color:daysBetween(form.regExpiry)<120?T.danger:T.blue }}>{daysBetween(form.regExpiry)<0?"⚠ Expired.":daysBetween(form.regExpiry)<120?`⚠ ${daysBetween(form.regExpiry)} days to renewal.`:`✓ Valid ${daysBetween(form.regExpiry)} days.`}</div>}
        </div>}

        {!quick&&step===5&&<div className="fade">
          <div style={{ fontSize:13, color:T.sub, marginBottom:16 }}>Most recent service — skip if not applicable.</div>
          <div style={FW}><label style={L}>Service Type</label><select className="input" value={form.svcType} onChange={e=>set("svcType",e.target.value)}>{["Full Service","Oil Change","Brake Check","Tyre Rotation","Battery Check","AC Service","Other"].map(s=><option key={s}>{s}</option>)}</select></div>
          <div style={FW}><label style={L}>Date</label><input className="input" type="date" value={form.svcDate} onChange={e=>set("svcDate",e.target.value)}/></div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
            <div style={FW}><label style={L}>Odometer km</label><input className="input" type="number" value={form.svcKm} onChange={e=>set("svcKm",e.target.value)}/></div>
            <div style={FW}><label style={L}>Next Service km</label><input className="input" type="number" value={form.svcNext} onChange={e=>set("svcNext",e.target.value)}/></div>
          </div>
        </div>}
      </div>

      {!quick&&<div style={{ background:T.header, borderTop:`1px solid ${T.border}`, padding:"14px 18px", display:"flex", gap:10 }}>
        {step>0&&<button className="btn-ghost" style={{ flex:1, padding:14 }} onClick={()=>setStep(s=>s-1)}>← Back</button>}
        {step<STEPS.length-1
          ?<button className="btn-gold" style={{ flex:2, padding:14, opacity:canNext()?1:0.4 }} disabled={!canNext()} onClick={()=>setStep(s=>s+1)}>{step<=1?"Continue →":"Next →"}</button>
          :<button className="btn-gold" style={{ flex:2, padding:14 }} onClick={()=>onSave(buildVehicle())}>{editVehicle?"Save Changes ✓":"Add Vehicle ✓"}</button>}
      </div>}
    </div>
  );
}

// ─── Service Tab ──────────────────────────────────────────────────────────────
const SVC_TYPES = ["Full Service","Oil Change","Brake Check","Tyre Rotation","Battery Check","AC Service","Other"];

function ServiceTab({ vehicle, onUpdate, T }) {
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ type:"Full Service", date:"", km:"", next:"" });
  const set = (k,v) => setForm(f=>({...f,[k]:v}));
  const v = vehicle;

  const add = () => {
    if (!form.date || !form.km) return;
    const entry = { date:form.date, type:form.type, km:Number(form.km), next:Number(form.next)||Number(form.km)+5000 };
    onUpdate({ ...v, service:[entry, ...(v.service||[])] });
    setShowAdd(false);
    setForm({ type:"Full Service", date:"", km:"", next:"" });
  };

  return (
    <div className="fade">
      <button className="btn-gold" style={{ width:"100%", padding:13, marginBottom:14 }}
        onClick={()=>setShowAdd(s=>!s)}>
        {showAdd ? "Cancel" : <><WrenchIcon s={14}/> Log Service</>}
      </button>
      {showAdd && (
        <div className="card pop" style={{ padding:16, marginBottom:14 }}>
          <span className="section-label">New Service Record</span>
          <div style={{ marginBottom:12 }}>
            <div style={{ fontSize:12, color:T.sub, marginBottom:5 }}>Service Type</div>
            <select className="input" value={form.type} onChange={e=>set("type",e.target.value)}>
              {SVC_TYPES.map(s=><option key={s}>{s}</option>)}
            </select>
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:10 }}>
            <div>
              <div style={{ fontSize:12, color:T.sub, marginBottom:5 }}>Date</div>
              <input className="input" type="date" value={form.date} onChange={e=>set("date",e.target.value)}/>
            </div>
            <div>
              <div style={{ fontSize:12, color:T.sub, marginBottom:5 }}>Odometer km</div>
              <input className="input" type="number" placeholder="24500" value={form.km} onChange={e=>set("km",e.target.value)}/>
            </div>
            <div style={{ gridColumn:"1/-1" }}>
              <div style={{ fontSize:12, color:T.sub, marginBottom:5 }}>Next Service km <span style={{ color:T.muted }}>(optional)</span></div>
              <input className="input" type="number" placeholder="Auto: +5000 km" value={form.next} onChange={e=>set("next",e.target.value)}/>
            </div>
          </div>
          <button className="btn-gold" style={{ width:"100%", padding:11 }} onClick={add} disabled={!form.date||!form.km}>Save</button>
        </div>
      )}
      {(v.service||[]).length===0
        ? <div className="card" style={{ padding:24, textAlign:"center" }}><div style={{ fontSize:28, marginBottom:8 }}>🔧</div><div style={{ color:T.muted, fontSize:13 }}>No service records</div></div>
        : <div className="card" style={{ padding:16 }}>
            <span className="section-label">History</span>
            {(v.service||[]).map((s,i)=>(
              <div key={i} style={{ borderLeft:`2px solid ${T.border2}`, paddingLeft:16, position:"relative", marginBottom:i<v.service.length-1?20:0 }}>
                <div style={{ position:"absolute", left:-5, top:5, width:8, height:8, borderRadius:"50%", background:T.accent }}/>
                <div style={{ fontSize:14, fontWeight:600 }}>{s.type}</div>
                <div style={{ fontSize:12, color:T.muted, marginTop:2 }}>{fmtDate(s.date)}</div>
                <div style={{ fontSize:12, color:T.accent, fontFamily:"'Space Mono',monospace", marginTop:3 }}>@ {s.km?.toLocaleString()} km → next {s.next?.toLocaleString()} km</div>
              </div>
            ))}
          </div>}
    </div>
  );
}

// ─── Detail View (with swipe tabs) ────────────────────────────────────────────
const DETAIL_TABS = [
  { id:"overview",     label:"Overview" },
  { id:"parking",      label:"Parking"  },
  { id:"service",      label:"Service"  },
  { id:"fuel",         label:"Fuel"     },
  { id:"odometer",     label:"Odometer" },
  { id:"photos",       label:"Photos"   },
  { id:"reminders",    label:"Reminders"},
  { id:"notes",        label:"Notes"    },
  { id:"insurance",    label:"Insurance"},
  { id:"registration", label:"Reg."     },
  { id:"alerts",       label:"Alerts"   },
];

function DetailView({ vehicle, onBack, onUpdate, onDelete, T }) {
  const [tab, setTab]             = useState("overview");
  const [showEdit, setShowEdit]   = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const tabBarRef = useRef(null);
  const v = vehicle;
  const insDays = daysBetween(v.insurance?.expiry);
  const regDays = daysBetween(v.registration?.expiry);
  const upd = patch => onUpdate({ ...v, ...patch });
  const activeReminders = (v.reminders||[]).filter(r=>!r.done&&r.date&&daysBetween(r.date)<7);
  const alertBadge = v.alerts.length + activeReminders.length;

  // Scroll active tab into view
  useEffect(() => {
    if (!tabBarRef.current) return;
    const active = tabBarRef.current.querySelector(".tab-btn.active");
    if (active) active.scrollIntoView({ behavior:"smooth", block:"nearest", inline:"center" });
  }, [tab]);

  const row = (k,val,mono=false) => (
    <div className="row-item">
      <span style={{ color:T.sub, fontSize:13 }}>{k}</span>
      <span style={{ fontSize:13, fontFamily:mono?"'Space Mono',monospace":"inherit", textAlign:"right", maxWidth:"60%" }}>{val||"—"}</span>
    </div>
  );

  if (showEdit) return <AddVehicleWizard editVehicle={v} onSave={u=>{ onUpdate(u); setShowEdit(false); }} onCancel={()=>setShowEdit(false)} T={T}/>;

  return (
    <div style={{ fontFamily:"'DM Sans',sans-serif", background:T.bg, minHeight:"100vh", color:T.text, display:"flex", flexDirection:"column" }}>
      {/* Header */}
      <div style={{ background:T.header, borderBottom:`1px solid ${T.border}`, padding:"13px 16px", display:"flex", alignItems:"center", gap:10, flexShrink:0 }}>
        <button onClick={onBack} style={{ background:T.surface, border:`1px solid ${T.border2}`, borderRadius:8, padding:8, cursor:"pointer", color:T.text, display:"flex" }}><BackIcon s={16}/></button>
        <div style={{ width:36, height:36, borderRadius:"50%", background:v.color, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, boxShadow:`0 0 12px ${v.color}55` }}>
          {v.type==="car"?<CarSvg s={15}/>:<BikeSvg s={15}/>}
        </div>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontSize:15, fontWeight:700, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{v.name}</div>
          <div style={{ fontSize:10, color:T.muted, fontFamily:"'Space Mono',monospace" }}>{v.plate} · {v.year}</div>
        </div>
        {alertBadge>0&&<div style={{ background:T.dangerBg, border:`1px solid ${T.dangerBorder}`, borderRadius:20, padding:"3px 9px", fontSize:11, color:T.danger, display:"flex", alignItems:"center", gap:4, flexShrink:0 }}><BellIcon s={11}/>{alertBadge}</div>}
        <button onClick={()=>setShowEdit(true)} style={{ background:"none", border:`1px solid ${T.border2}`, borderRadius:8, padding:"5px 11px", cursor:"pointer", color:T.sub, fontSize:12, flexShrink:0 }}>Edit</button>
      </div>

      {/* Tab bar */}
      <div ref={tabBarRef} style={{ display:"flex", borderBottom:`1px solid ${T.border}`, background:T.header, overflowX:"auto", flexShrink:0 }}>
        {DETAIL_TABS.map(t=>(
          <button key={t.id} className={`tab-btn${tab===t.id?" active":""}`} onClick={()=>setTab(t.id)}>
            {t.label}
            {t.id==="alerts"&&alertBadge>0&&<span style={{ marginLeft:4, background:"#c0392b", borderRadius:10, padding:"1px 5px", fontSize:9, color:"#fff" }}>{alertBadge}</span>}
          </button>
        ))}
      </div>

      {/* Swipeable content */}
      <SwipeTabs tabs={DETAIL_TABS} activeTab={tab} onTabChange={setTab} T={T}>
        {DETAIL_TABS.map(t => (
          <div key={t.id} className="swipe-panel">
            <div style={{ padding:16, maxWidth:560, margin:"0 auto" }}>

              {t.id==="overview"&&<div className="fade">
                <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:10, marginBottom:14 }}>
                  {[{icon:"🛡",label:"Insurance",val:insDays===null?"—":insDays<0?"EXPIRED":`${insDays}d`,bad:insDays!==null&&insDays<90},
                    {icon:"📄",label:"Reg.",val:regDays===null?"—":regDays<0?"EXPIRED":`${regDays}d`,bad:regDays!==null&&regDays<120},
                    {icon:"🔧",label:"Next Svc",val:v.service?.length?`${v.service[0].next.toLocaleString()}km`:"—",bad:false}
                  ].map(({icon,label,val,bad})=>(
                    <div key={label} className="card" style={{ padding:"12px 10px", textAlign:"center" }}>
                      <div style={{ fontSize:18, marginBottom:4 }}>{icon}</div>
                      <div style={{ fontSize:13, fontWeight:700, color:bad?T.danger:T.accent, fontFamily:"'Space Mono',monospace" }}>{val}</div>
                      <div style={{ fontSize:10, color:T.muted, marginTop:2 }}>{label}</div>
                    </div>
                  ))}
                </div>
                <div className="card" style={{ padding:14, marginBottom:12 }}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                    <div><div style={{ fontSize:10, color:T.accent, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.1em", marginBottom:4 }}>📍 Parking</div>
                      <div style={{ fontFamily:"'Space Mono',monospace", fontSize:13 }}>{v.parking}</div></div>
                    <div style={{ display:"flex", gap:6, alignItems:"center" }}>
                      {v.gps&&<a href={`https://www.google.com/maps?q=${v.gps.lat},${v.gps.lng}`} target="_blank" rel="noreferrer"
                        style={{ display:"inline-flex", alignItems:"center", gap:5, background:T.blueBg, border:`1px solid ${T.blueBorder}`, borderRadius:8, color:T.blue, fontSize:12, fontWeight:600, padding:"5px 10px", textDecoration:"none" }}>
                        <NavIcon s={11}/> Navigate
                      </a>}
                      <button onClick={()=>setTab("parking")} className="btn-ghost" style={{ padding:"5px 10px", fontSize:12 }}>Manage</button>
                    </div>
                  </div>
                </div>
                {v.fuelLog?.length>0&&<div className="card" style={{ padding:14, marginBottom:12 }}>
                  <div style={{ fontSize:10, color:T.accent, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.1em", marginBottom:8 }}>⛽ Latest Fill-up</div>
                  <div style={{ display:"flex", justifyContent:"space-between" }}>
                    <div><div style={{ fontSize:13, fontWeight:600 }}>{fmtDate(v.fuelLog[0].date)}</div>
                      <div style={{ fontSize:11, color:T.muted }}>{v.fuelLog[0].litres}L · {v.fuelLog[0].odo?.toLocaleString()} km</div></div>
                    <div style={{ fontSize:15, fontWeight:700 }}>{fmtCurrency(v.fuelLog[0].cost)}</div>
                  </div>
                </div>}
                {v.odoLog?.length>0&&<div className="card" style={{ padding:14, marginBottom:12 }}>
                  <div style={{ fontSize:10, color:T.accent, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.1em", marginBottom:6 }}>📏 Odometer</div>
                  <div style={{ fontFamily:"'Space Mono',monospace", fontSize:20, fontWeight:700, color:T.accent }}>{v.odoLog[0].km.toLocaleString()} <span style={{ fontSize:13, color:T.sub }}>km</span></div>
                </div>}
                <div className="card" style={{ padding:16, marginBottom:12 }}>
                  <span className="section-label">Vehicle Info</span>
                  {row("Fuel",v.fuel)}{row("Year",v.year)}{row("Plate",v.plate,true)}{row("Category",v.type==="car"?"Automobile":"Motorcycle")}
                </div>
                {activeReminders.length>0&&<div className="card" style={{ padding:14, marginBottom:12, borderColor:T.warnBorder, background:T.warnBg }}>
                  <div style={{ fontSize:11, color:T.warn, fontWeight:700, marginBottom:8 }}>🔔 Upcoming Reminders</div>
                  {activeReminders.map(r=><div key={r.id} style={{ fontSize:13, color:T.text, marginBottom:4 }}>• {r.title}{r.date?` — ${fmtDate(r.date)}`:""}</div>)}
                </div>}
                <button onClick={()=>setConfirmDel(s=>!s)} style={{ width:"100%", background:"none", border:`1px solid ${T.dangerBorder}`, color:T.danger, borderRadius:10, padding:11, cursor:"pointer", fontSize:13 }}>Remove Vehicle</button>
                {confirmDel&&<div className="card pop" style={{ padding:16, marginTop:10, borderColor:T.dangerBorder }}>
                  <div style={{ fontSize:13, color:T.sub, marginBottom:12 }}>Remove <strong>{v.name}</strong>? This cannot be undone.</div>
                  <div style={{ display:"flex", gap:10 }}>
                    <button onClick={()=>setConfirmDel(false)} className="btn-ghost" style={{ flex:1, padding:10 }}>Cancel</button>
                    <button onClick={onDelete} style={{ flex:1, padding:10, background:"#c0392b", border:"none", borderRadius:10, color:"#fff", fontFamily:"'DM Sans',sans-serif", fontWeight:700, cursor:"pointer" }}>Remove</button>
                  </div>
                </div>}
              </div>}

              {t.id==="parking"&&<div className="fade"><ParkingCard vehicle={v} onUpdate={onUpdate} T={T}/></div>}

              {t.id==="service"&&<ServiceTab vehicle={v} onUpdate={onUpdate} T={T}/>}

              {t.id==="fuel"&&<div className="fade"><FuelLog fuelLog={v.fuelLog||[]} onChange={fl=>upd({fuelLog:fl})} T={T}/></div>}
              {t.id==="odometer"&&<div className="fade"><OdometerTracker odoLog={v.odoLog||[]} onChange={ol=>upd({odoLog:ol})} T={T}/></div>}
              {t.id==="photos"&&<div className="fade"><div style={{ fontSize:13, color:T.sub, marginBottom:14, lineHeight:1.6 }}>Attach RC, insurance docs, damage photos.</div><PhotoSection photos={v.photos||[]} onChange={p=>upd({photos:p})} T={T}/></div>}
              {t.id==="reminders"&&<div className="fade"><RemindersPanel reminders={v.reminders||[]} onChange={r=>upd({reminders:r})} T={T}/></div>}
              {t.id==="notes"&&<div className="fade"><NotesPanel notes={v.notes||[]} onChange={n=>upd({notes:n})} T={T}/></div>}

              {t.id==="insurance"&&<div className="fade"><div className="card" style={{ padding:16 }}>
                <span className="section-label">Insurance</span>
                {row("Provider",v.insurance?.provider)}{row("Policy No.",v.insurance?.policy,true)}{row("Expiry",v.insurance?.expiry?new Date(v.insurance.expiry).toLocaleDateString("en-IN",{day:"numeric",month:"long",year:"numeric"}):null)}
                {insDays!==null&&<div style={{ marginTop:12, padding:12, borderRadius:8, background:insDays<90?T.dangerBg:T.okBg, border:`1px solid ${insDays<90?T.dangerBorder:T.okBorder}`, fontSize:12, color:insDays<90?T.danger:T.ok }}>
                  {insDays<0?"⚠ Expired.":insDays<30?`⚠ ${insDays} days left.`:insDays<90?`⚠ Renew in ${insDays} days.`:`✓ Active ${insDays} days.`}
                </div>}
                {!v.insurance?.provider&&<div style={{ fontSize:13, color:T.muted, marginTop:8 }}>No insurance info. Tap Edit.</div>}
              </div></div>}

              {t.id==="registration"&&<div className="fade"><div className="card" style={{ padding:16 }}>
                <span className="section-label">Registration</span>
                {row("RC Number",v.registration?.rc,true)}{row("Plate",v.plate,true)}{row("Renewal",v.registration?.expiry?new Date(v.registration.expiry).toLocaleDateString("en-IN",{day:"numeric",month:"long",year:"numeric"}):null)}
                {regDays!==null&&<div style={{ marginTop:12, padding:12, borderRadius:8, background:regDays<120?T.dangerBg:T.blueBg, border:`1px solid ${regDays<120?T.dangerBorder:T.blueBorder}`, fontSize:12, color:regDays<120?T.danger:T.blue }}>
                  {regDays<0?"⚠ Expired.":regDays<60?`⚠ ${regDays} days to renewal.`:`✓ Valid ${regDays} days.`}
                </div>}
                {!v.registration?.rc&&<div style={{ fontSize:13, color:T.muted, marginTop:8 }}>No registration info. Tap Edit.</div>}
              </div></div>}

              {t.id==="alerts"&&<div className="fade"><div className="card" style={{ padding:16 }}>
                <span className="section-label">Alerts</span>
                {v.alerts.length===0&&activeReminders.length===0?<div style={{ textAlign:"center", padding:"24px 0", color:T.muted }}><div style={{ fontSize:24, marginBottom:8 }}>✓</div><div style={{ fontSize:13 }}>All clear</div></div>:<>
                  {v.alerts.map(a=><div key={a.id} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"10px 12px", borderRadius:8, marginBottom:8, background:a.type==="danger"?T.dangerBg:T.warnBg, border:`1px solid ${a.type==="danger"?T.dangerBorder:T.warnBorder}` }}>
                    <span style={{ fontSize:13, color:a.type==="danger"?T.danger:T.warn }}>{a.type==="danger"?"🔴 ":"🟡 "}{a.msg}</span>
                    <button style={{ background:"none", border:`1px solid ${T.border2}`, color:T.muted, padding:"3px 8px", borderRadius:4, fontSize:11, cursor:"pointer" }} onClick={()=>onUpdate({...v,alerts:v.alerts.filter(x=>x.id!==a.id)})}>✕</button>
                  </div>)}
                  {activeReminders.map(r=><div key={r.id} style={{ padding:"10px 12px", borderRadius:8, marginBottom:8, background:T.warnBg, border:`1px solid ${T.warnBorder}` }}>
                    <span style={{ fontSize:13, color:T.warn }}>🔔 {r.title}{r.date?` — ${fmtDate(r.date)}`:""}</span>
                  </div>)}
                </>}
              </div></div>}

            </div>
          </div>
        ))}
      </SwipeTabs>
    </div>
  );
}

// ─── Empty State ──────────────────────────────────────────────────────────────
function EmptyState({ onAdd, T }) {
  return (
    <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", minHeight:"65vh", padding:32, textAlign:"center" }}>
      <div style={{ fontSize:56, marginBottom:20, opacity:0.5 }}>🚗</div>
      <div style={{ fontSize:20, fontWeight:700, color:T.text, marginBottom:8 }}>Your garage is empty</div>
      <div style={{ fontSize:14, color:T.sub, maxWidth:260, lineHeight:1.7, marginBottom:28 }}>Add your vehicles to track GPS parking, insurance, registration, service, fuel, and more.</div>
      <button className="btn-gold" style={{ padding:"14px 32px", fontSize:15, borderRadius:12 }} onClick={onAdd}>+ Add Your First Vehicle</button>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [theme, setTheme]       = useState("dark");
  const T = theme==="dark" ? DARK : LIGHT;
  const [authState, setAuthState] = useState("loading");
  const [pin, setPin]           = useState("");
  const [vehicles, setVehicles] = useState([]);
  const [view, setView]         = useState("fleet");
  const [selectedId, setSelectedId] = useState(null);
  const [filter, setFilter]     = useState("all");
  const [sort, setSort]         = useState("urgency");
  const [search, setSearch]     = useState("");

  useEffect(() => {
    setAuthState(localStorage.getItem(PIN_HASH_KEY) ? "unlock" : "setup");
  }, []);

  // Auto-save on change
  useEffect(() => {
    if (authState==="ready" && pin && pin!=="__bio__") saveVault({ vehicles }, pin).catch(console.error);
  }, [vehicles, authState, pin]);

  // Schedule notifications on load
  useEffect(() => {
    if (authState==="ready" && vehicles.length>0) scheduleNotifications(vehicles);
  }, [authState]);

  const handleSetPin = async (newPin) => {
    setPin(newPin); await saveVault({ vehicles:[] }, newPin); setAuthState("ready");
  };

  const handleUnlock = async (enteredPin) => {
    // Biometric unlock — load vault with stored PIN
    if (enteredPin==="__bio__") {
      const storedEncrypted = localStorage.getItem(VAULT_KEY);
      if (!storedEncrypted) { setAuthState("setup"); return; }
      // For bio, we need the PIN to decrypt — prompt PIN first time bio is set up
      // Here we store a session PIN separately (not persisted, just in state from last full PIN unlock)
      // On fresh launch with bio, we still need PIN once then bio takes over
      setAuthState("ready"); return;
    }
    setPin(enteredPin);
    const data = await loadVault(enteredPin);
    if (data?.vehicles) setVehicles(data.vehicles);
    setAuthState("ready");
  };

  const urgencyScore = v => {
    let s=0;
    const ins=daysBetween(v.insurance?.expiry); const reg=daysBetween(v.registration?.expiry);
    if(ins!==null&&ins<30)s+=100; else if(ins!==null&&ins<90)s+=50;
    if(reg!==null&&reg<60)s+=80; else if(reg!==null&&reg<120)s+=40;
    s+=v.alerts?.filter(a=>a.type==="danger").length*60;
    s+=v.alerts?.filter(a=>a.type==="warn").length*20;
    return s;
  };

  const sorted = [...vehicles]
    .filter(v=>(filter==="all"||v.type===filter)&&(v.name.toLowerCase().includes(search.toLowerCase())||v.plate.toLowerCase().includes(search.toLowerCase())))
    .sort((a,b)=>sort==="urgency"?urgencyScore(b)-urgencyScore(a):sort==="name"?a.name.localeCompare(b.name):a.type.localeCompare(b.type)||a.name.localeCompare(b.name));

  const urgentCount = vehicles.reduce((s,v)=>s+v.alerts.filter(a=>a.type==="danger").length,0);
  const selectedVehicle = vehicles.find(v=>v.id===selectedId);

  const saveVehicle = v => {
    setVehicles(prev=>prev.some(x=>x.id===v.id)?prev.map(x=>x.id===v.id?v:x):[...prev,v]);
    setSelectedId(v.id); setView("detail");
  };

  // ── Render ──
  if (authState==="loading") return <div style={{ display:"flex", alignItems:"center", justifyContent:"center", minHeight:"100vh", background:DARK.bg }}><style>{buildStyles(DARK)}</style><div className="pulsing" style={{ fontSize:32 }}>🔐</div></div>;
  if (authState==="setup")   return <><style>{buildStyles(T)}</style><PinScreen mode="setup" onSetPin={handleSetPin} T={T}/></>;
  if (authState==="unlock")  return <><style>{buildStyles(T)}</style><PinScreen mode="unlock" onSuccess={handleUnlock} T={T}/></>;
  if (view==="add")          return <><style>{buildStyles(T)}</style><AddVehicleWizard onSave={saveVehicle} onCancel={()=>setView("fleet")} T={T}/></>;
  if (view==="detail"&&selectedVehicle) return <><style>{buildStyles(T)}</style><DetailView vehicle={selectedVehicle} onBack={()=>setView("fleet")} onUpdate={u=>setVehicles(prev=>prev.map(x=>x.id===u.id?u:x))} onDelete={()=>{ setVehicles(prev=>prev.filter(x=>x.id!==selectedVehicle.id)); setView("fleet"); }} T={T}/></>;
  if (view==="backup")       return <><style>{buildStyles(T)}</style><div style={{ fontFamily:"'DM Sans',sans-serif", background:T.bg, minHeight:"100vh", color:T.text }}><div style={{ background:T.header, borderBottom:`1px solid ${T.border}`, padding:"13px 16px", display:"flex", alignItems:"center", gap:10 }}><button onClick={()=>setView("fleet")} style={{ background:T.surface, border:`1px solid ${T.border2}`, borderRadius:8, padding:8, cursor:"pointer", color:T.text, display:"flex" }}><BackIcon s={16}/></button><span style={{ fontSize:16, fontWeight:600 }}>Backup & Restore</span></div><BackupPanel vehicles={vehicles} pin={pin} onRestore={v=>{ setVehicles(v); setView("fleet"); }} T={T}/></div></>;
  if (view==="settings")     return <><style>{buildStyles(T)}</style><div style={{ fontFamily:"'DM Sans',sans-serif", background:T.bg, minHeight:"100vh", color:T.text }}><div style={{ background:T.header, borderBottom:`1px solid ${T.border}`, padding:"13px 16px", display:"flex", alignItems:"center", gap:10 }}><button onClick={()=>setView("fleet")} style={{ background:T.surface, border:`1px solid ${T.border2}`, borderRadius:8, padding:8, cursor:"pointer", color:T.text, display:"flex" }}><BackIcon s={16}/></button><span style={{ fontSize:16, fontWeight:600 }}>Settings</span></div><SettingsPanel pin={pin} onPinChange={p=>setPin(p)} T={T}/></div></>;

  // Fleet list
  return (
    <div style={{ fontFamily:"'DM Sans',sans-serif", background:T.bg, minHeight:"100vh", color:T.text }}>
      <style>{buildStyles(T)}</style>
      <div style={{ background:T.header, borderBottom:`1px solid ${T.border}`, padding:"16px 16px 14px" }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:12 }}>
          <div>
            <div style={{ fontSize:10, color:T.muted, textTransform:"uppercase", letterSpacing:"0.15em", marginBottom:4 }}>Fleet Manager</div>
            <div style={{ fontSize:24, fontWeight:700, letterSpacing:"-0.02em" }}>Torque</div>
          </div>
          <div style={{ display:"flex", gap:8, alignItems:"center" }}>
            <button onClick={()=>setTheme(t=>t==="dark"?"light":"dark")} style={{ background:"none", border:`1px solid ${T.border2}`, borderRadius:8, padding:7, cursor:"pointer", color:T.sub, display:"flex" }}>
              {theme==="dark"?<SunIcon s={16}/>:<MoonIcon s={16}/>}
            </button>
            <button onClick={()=>setView("settings")} style={{ background:"none", border:`1px solid ${T.border2}`, borderRadius:8, padding:7, cursor:"pointer", color:T.sub, display:"flex" }}>
              <SettingsIcon s={16}/>
            </button>
            <button onClick={()=>setView("backup")} style={{ background:"none", border:`1px solid ${T.border2}`, borderRadius:8, padding:7, cursor:"pointer", color:T.sub, display:"flex" }}>
              <DriveIcon s={16}/>
            </button>
            <button className="btn-gold" style={{ padding:"9px 16px", fontSize:14, borderRadius:10 }} onClick={()=>setView("add")}><PlusIcon s={14}/> Add</button>
          </div>
        </div>
        {vehicles.length>0&&<div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:8 }}>
          {[{v:vehicles.filter(x=>x.type==="car").length,l:"Cars",c:T.accent},
            {v:vehicles.filter(x=>x.type==="bike").length,l:"Bikes",c:T.blue},
            {v:urgentCount,l:"Urgent",c:urgentCount>0?T.danger:T.muted},
            {v:vehicles.reduce((s,v)=>s+(v.fuelLog?.length||0),0),l:"Fill-ups",c:T.ok}
          ].map(({v:val,l,c})=>(
            <div key={l} style={{ background:T.surface, border:`1px solid ${T.border}`, borderRadius:10, padding:"10px 0", textAlign:"center" }}>
              <div style={{ fontSize:17, fontWeight:700, color:c }}>{val}</div>
              <div style={{ fontSize:10, color:T.muted, marginTop:1 }}>{l}</div>
            </div>
          ))}
        </div>}
      </div>

      {urgentCount>0&&<div style={{ background:T.dangerBg, borderBottom:`1px solid ${T.dangerBorder}`, padding:"9px 16px", fontSize:12, color:T.danger }}>
        🔴 {urgentCount} urgent issue{urgentCount!==1?"s":""} — tap a vehicle to review
      </div>}

      <div style={{ padding:16 }}>
        {vehicles.length===0?<EmptyState onAdd={()=>setView("add")} T={T}/>:<>
          <input placeholder="Search by name or plate…" value={search} onChange={e=>setSearch(e.target.value)} className="input" style={{ marginBottom:10 }}/>
          <div style={{ display:"flex", gap:8, marginBottom:14, overflowX:"auto" }}>
            {[["all","All"],["car","🚗 Cars"],["bike","🏍️ Bikes"]].map(([f,l])=>(
              <button key={f} className={`filter-btn${filter===f?" active":""}`} onClick={()=>setFilter(f)}>{l}</button>
            ))}
            <div style={{ marginLeft:"auto", display:"flex", gap:6, flexShrink:0 }}>
              {[["urgency","⚠ Urgent"],["name","A–Z"],["type","Type"]].map(([s,l])=>(
                <button key={s} className={`filter-btn${sort===s?" active":""}`} onClick={()=>setSort(s)} style={{ padding:"7px 10px", fontSize:11 }}>{l}</button>
              ))}
            </div>
          </div>
          <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
            {sorted.map((veh,i)=>{
              const ins=daysBetween(veh.insurance?.expiry); const reg=daysBetween(veh.registration?.expiry);
              const urgent=veh.alerts.some(a=>a.type==="danger"); const hasWarn=veh.alerts.some(a=>a.type==="warn");
              return (
                <div key={veh.id} className="card card-hover fade" style={{ padding:14, animationDelay:`${i*0.03}s`, borderColor:urgent?T.dangerBorder+"88":"" }}
                  onClick={()=>{ setSelectedId(veh.id); setView("detail"); }}>
                  <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                    <div style={{ width:44, height:44, borderRadius:"50%", background:veh.color, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, boxShadow:`0 0 12px ${veh.color}44` }}>
                      {veh.type==="car"?<CarSvg s={17}/>:<BikeSvg s={17}/>}
                    </div>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:2, flexWrap:"wrap" }}>
                        <span style={{ fontWeight:600, fontSize:14 }}>{veh.name}</span>
                        {urgent&&<span className="pill" style={{ background:T.dangerBg, color:T.danger, border:`1px solid ${T.dangerBorder}` }}>URGENT</span>}
                        {hasWarn&&!urgent&&<span className="pill" style={{ background:T.warnBg, color:T.warn, border:`1px solid ${T.warnBorder}` }}>ALERT</span>}
                        {veh.gps&&<span className="pill" style={{ background:T.blueBg, color:T.blue, border:`1px solid ${T.blueBorder}` }}>📍GPS</span>}
                      </div>
                      <div style={{ fontSize:10, color:T.muted, fontFamily:"'Space Mono',monospace", marginBottom:4 }}>{veh.plate} · {veh.year}</div>
                      <div style={{ fontSize:12, color:T.sub }}>{veh.parking}{veh.odoLog?.[0]?` · ${veh.odoLog[0].km.toLocaleString()} km`:""}</div>
                    </div>
                    <div style={{ display:"flex", flexDirection:"column", gap:4, alignItems:"flex-end", flexShrink:0 }}>
                      <span className="pill" style={{ background:ins===null?T.surface:ins<90?T.dangerBg:T.okBg, color:ins===null?T.muted:ins<90?T.danger:T.ok, border:`1px solid ${ins===null?T.border:ins<90?T.dangerBorder:T.okBorder}` }}>INS {ins===null?"—":`${ins}d`}</span>
                      <span className="pill" style={{ background:reg===null?T.surface:reg<120?T.dangerBg:T.blueBg, color:reg===null?T.muted:reg<120?T.danger:T.blue, border:`1px solid ${reg===null?T.border:reg<120?T.dangerBorder:T.blueBorder}` }}>REG {reg===null?"—":`${reg}d`}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {sorted.length===0&&<div style={{ textAlign:"center", padding:"40px 0", color:T.muted, fontSize:13 }}>No vehicles match</div>}
          <div style={{ textAlign:"center", padding:"18px 0 6px", color:T.muted, fontSize:12 }}>
            {sorted.length} vehicle{sorted.length!==1?"s":""} · 🔐 AES-256 encrypted
          </div>
        </>}
      </div>
    </div>
  );
}
