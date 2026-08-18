/* ============================================================================
 * Prescribe Portal — application logic.
 * Data + auth now run against a real Supabase project (Postgres + RLS + Auth
 * + TOTP MFA). The in-memory `state` object is kept only as a render cache:
 * it is refilled from Supabase after every change, so all the render*()
 * functions below are unchanged from the prototype.
 * ==========================================================================*/
import { supabase } from './supabaseClient.js';

/* ================= STATE ================= */
let state = null;                // render cache, populated by fetchState()
let currentView = 'dashboard';
let incomingFilter = 'all';
let mineFilter = 'all';
let uploadSource = 'Paper Upload';
let medRowSeq = 0;
let pendingSign = null;          // rx payload awaiting PIN confirmation

// auth working vars
let mfaFactorId = null;          // verified TOTP factor being challenged at login
let enrolFactorId = null;        // TOTP factor being enrolled (first login)

const ROUTES = ['Oral','Topical','Subcutaneous','Intramuscular','Rectal','Ophthalmic','Other'];
const CD_SCHEDULES = ['CD2 (Schedule 2)','CD3 (Schedule 3)','CD4 (Schedule 4)','CD5 (Schedule 5)'];

/* ================= DATA LOADING (Supabase -> state) ================= */
const PRESCRIBER_COLS =
  'id,name,prof_role,reg_body,reg_number,organisation,address,email,id_doc,indemnity,verified,verified_by,verified_at,created_at';
const RX_SELECT =
  'id,ref,patient_id,patient_name,prescriber_id,prescriber_name,prescriber_org,type,source,urgent,status,notes,signature,created_at,updated_at,prescription_items(*),prescription_history(*)';

function mapPrescriber(p){
  return { id:p.id, role:'prescriber', name:p.name, profRole:p.prof_role, regBody:p.reg_body,
    regNumber:p.reg_number, organisation:p.organisation, address:p.address, email:p.email,
    idDoc:p.id_doc, indemnity:p.indemnity, verified:p.verified, verifiedBy:p.verified_by,
    verifiedAt:p.verified_at, createdAt:p.created_at };
}
function mapRx(r){
  const items = (r.prescription_items || []).slice()
    .sort((a,b)=> (a.position||0)-(b.position||0))
    .map(i=>({ drug:i.drug, form:i.form, dose:i.dose, frequency:i.frequency, quantity:i.quantity,
      route:i.route, special:i.special, cd:i.cd, cdSchedule:i.cd_schedule, customItem:i.custom_item }));
  const history = (r.prescription_history || []).slice()
    .sort((a,b)=> new Date(a.ts)-new Date(b.ts))
    .map(h=>({ ts:h.ts, actor:h.actor, action:h.action, detail:h.detail }));
  return { id:r.id, ref:r.ref, patientId:r.patient_id, patientName:r.patient_name,
    prescriberId:r.prescriber_id, prescriberName:r.prescriber_name, prescriberOrg:r.prescriber_org,
    type:r.type, source:r.source, urgent:r.urgent, status:r.status, notes:r.notes,
    signature:r.signature, createdAt:r.created_at, updatedAt:r.updated_at, items, history };
}

// Fetch everything the current user is allowed to see and rebuild `state`.
async function fetchState(){
  const { data:{ user } } = await supabase.auth.getUser();
  if(!user){ state = null; return; }

  // Which kind of account is this? (staff row => pharmacy, else prescriber.)
  const staffSelf = await supabase.from('staff').select('id,name,title,email').eq('id', user.id).maybeSingle();
  let role = staffSelf.data ? 'pharmacy' : null;
  if(!role){
    const preSelf = await supabase.from('prescribers').select('id').eq('id', user.id).maybeSingle();
    if(preSelf.data) role = 'prescriber';
  }
  if(!role) throw new Error('No prescriber or pharmacy profile is linked to this account.');

  const [rx, pat, form, pre, log] = await Promise.all([
    supabase.from('prescriptions').select(RX_SELECT),
    supabase.from('patients').select('id,name,dob,nhs,gp,allergies'),
    supabase.from('formulary').select('id,name,added_by,added_at'),
    supabase.from('prescribers').select(PRESCRIBER_COLS),
    role === 'pharmacy'
      ? supabase.from('account_log').select('ts,actor,action,detail,kind')
      : Promise.resolve({ data: [] }),
  ]);
  const staffRows = role === 'pharmacy'
    ? (await supabase.from('staff').select('id,name,title,email')).data || []
    : (staffSelf.data ? [staffSelf.data] : []);

  const firstErr = [rx,pat,form,pre].find(r=>r.error);
  if(firstErr) throw new Error(firstErr.error.message);

  state = {
    session: { userId:user.id, role },
    prescriptions: (rx.data || []).map(mapRx),
    patients: (pat.data || []).map(p=>({ id:p.id, name:p.name, dob:p.dob, nhs:p.nhs, gp:p.gp, allergies:p.allergies })),
    formulary: (form.data || []).map(f=>({ id:f.id, name:f.name, addedBy:f.added_by, addedAt:f.added_at })),
    prescribers: (pre.data || []).map(mapPrescriber),
    staff: staffRows.map(s=>({ id:s.id, role:'pharmacy', name:s.name, title:s.title, email:s.email })),
    accountLog: (log.data || []).map(a=>({ ts:a.ts, actor:a.actor, action:a.action, detail:a.detail, kind:a.kind })),
  };
}
async function refresh(){ await fetchState(); renderAll(); }
async function refreshAndDrawer(id){ await fetchState(); renderAll(); if(id) openDrawer(id); }

/* ================= UTIL ================= */
function esc(s){ return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function fmtDate(iso){ if(!iso) return '—'; const d = new Date(iso); return d.toLocaleString('en-GB', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }); }
function timeAgo(iso){ const mins = Math.round((Date.now() - new Date(iso).getTime())/60000); if(mins < 60) return mins + 'm ago'; const hrs = Math.round(mins/60); if(hrs < 24) return hrs + 'h ago'; return Math.round(hrs/24) + 'd ago'; }
// NB: the internal status key is still `exported` (DB check constraint);
// only the user-facing wording is "Dispensed".
function statusLabel(s){ return { received:'Received', in_review:'In review', query:'Query raised', exported:'Dispensed', rejected:'Rejected' }[s] || s; }
function toast(msg){ const c = document.getElementById('toast-container'); const el = document.createElement('div'); el.className = 'toast'; el.textContent = msg; c.appendChild(el); setTimeout(()=> el.remove(), 3400); }

function currentUser(){
  if(!state || !state.session) return null;
  const pool = state.session.role === 'prescriber' ? state.prescribers : state.staff;
  return pool.find(u=>u.id === state.session.userId) || null;
}
function actorFunction(name){
  const staff = state.staff.find(s=>s.name===name);
  if(staff) return staff.title;
  const prescriber = state.prescribers.find(p=>p.name===name);
  if(prescriber) return prescriber.profRole;
  return '';
}
function actorLabel(name){
  const fn = actorFunction(name);
  return fn ? `${esc(name)} <span style="color:var(--muted);">— ${esc(fn)}</span>` : esc(name);
}

/* ================= AUTH: TABS ================= */
document.querySelectorAll('.auth-tabs button').forEach(b=>{
  b.addEventListener('click', ()=> activatePanel(b.dataset.panel));
});
function activatePanel(panel){
  document.querySelectorAll('.auth-tabs button').forEach(x=> x.classList.toggle('active', x.dataset.panel === panel));
  document.getElementById('panel-login').hidden = panel !== 'login';
  document.getElementById('panel-register').hidden = panel !== 'register';
}

/* ================= AUTH: LOGIN + MFA ================= */
function showLoginStep(step){ // '1' | 'mfa' | 'enrol' | 'reset' | 'newpw'
  const steps = { '1':'login-step-1', mfa:'login-step-mfa', enrol:'login-step-enrol', reset:'login-step-reset', newpw:'login-step-newpw' };
  for(const [key, id] of Object.entries(steps)){
    document.getElementById(id).style.display = key === step ? 'block' : 'none';
  }
}
function loginError(msg){ const e = document.getElementById('login-error'); e.textContent = msg; e.classList.add('show'); }
function loginSuccess(msg){ const e = document.getElementById('login-success'); e.textContent = msg; e.classList.add('show'); }
function clearLoginError(){ document.getElementById('login-error').classList.remove('show'); document.getElementById('login-success').classList.remove('show'); }

document.getElementById('login-continue-btn').addEventListener('click', async ()=>{
  clearLoginError();
  const email = document.getElementById('login-email').value.trim();
  const pw = document.getElementById('login-password').value;
  if(!email || !pw){ loginError('Enter your email and password.'); return; }
  const { error } = await supabase.auth.signInWithPassword({ email, password: pw });
  if(error){ loginError(error.message); return; }
  await routeMfa();
});

// After a correct password, decide: challenge an existing factor, or enrol one.
async function routeMfa(){
  const { data: factors, error } = await supabase.auth.mfa.listFactors();
  if(error){ loginError(error.message); return; }
  const verified = (factors.totp || []).filter(f=>f.status === 'verified');
  if(verified.length){
    mfaFactorId = verified[0].id;
    document.getElementById('login-mfa-input').value = '';
    showLoginStep('mfa');
    document.getElementById('login-mfa-input').focus();
  } else {
    await startEnrolment();
  }
}

document.getElementById('login-verify-btn').addEventListener('click', async ()=>{
  clearLoginError();
  const code = document.getElementById('login-mfa-input').value.trim();
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: mfaFactorId, code });
  if(error){ loginError(error.message); return; }
  await resolveSessionAndEnter();
});

async function startEnrolment(){
  // Remove any stray half-finished factors so enrolment always starts clean.
  const { data: fl } = await supabase.auth.mfa.listFactors();
  for(const f of (fl?.all || [])){ if(f.status !== 'verified'){ await supabase.auth.mfa.unenroll({ factorId: f.id }); } }
  const { data, error } = await supabase.auth.mfa.enroll({ factorType:'totp', friendlyName:'prescribe-' + Date.now() });
  if(error){ loginError(error.message); return; }
  enrolFactorId = data.id;
  document.getElementById('enrol-qr').innerHTML = `<img alt="Authenticator QR code" style="width:180px;height:180px" src="${data.totp.qr_code}">`;
  document.getElementById('enrol-secret').value = data.totp.secret;
  document.getElementById('enrol-code-input').value = '';
  showLoginStep('enrol');
  document.getElementById('enrol-code-input').focus();
}

document.getElementById('enrol-verify-btn').addEventListener('click', async ()=>{
  clearLoginError();
  const code = document.getElementById('enrol-code-input').value.trim();
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: enrolFactorId, code });
  if(error){ loginError(error.message); return; }
  await resolveSessionAndEnter();
});

async function resolveSessionAndEnter(){
  try { await fetchState(); }
  catch(e){ loginError(e.message); await supabase.auth.signOut(); return; }
  if(!currentUser()){ loginError('No profile found for this account.'); await supabase.auth.signOut(); return; }
  document.getElementById('login-password').value = '';
  enterApp();
}

async function backToLoginStep1(){
  await supabase.auth.signOut();  // drop the aal1 session so we start fresh
  showLoginStep('1');
  clearLoginError();
}

/* ================= AUTH: FORGOT / RESET PASSWORD ================= */
document.getElementById('forgot-link').addEventListener('click', e=>{
  e.preventDefault();
  clearLoginError();
  document.getElementById('reset-email').value = document.getElementById('login-email').value.trim();
  showLoginStep('reset');
  document.getElementById('reset-email').focus();
});

document.getElementById('reset-send-btn').addEventListener('click', async ()=>{
  clearLoginError();
  const email = document.getElementById('reset-email').value.trim();
  if(!email){ loginError('Enter your account email.'); return; }
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
  if(error){ loginError(error.message); return; }
  showLoginStep('1');
  loginSuccess(`If an account exists for ${email}, a password-reset link is on its way — check your inbox (and spam) and open it on this device.`);
});

// The reset-email link lands back on the app with a recovery token; supabase-js
// picks it up (detectSessionInUrl) and fires PASSWORD_RECOVERY.
supabase.auth.onAuthStateChange((event)=>{
  if(event === 'PASSWORD_RECOVERY'){
    clearLoginError();
    showLoginStep('newpw');
  }
});

document.getElementById('newpw-save-btn').addEventListener('click', async ()=>{
  clearLoginError();
  const pw = document.getElementById('newpw-input').value;
  const pw2 = document.getElementById('newpw-confirm').value;
  if(pw.length < 8){ loginError('Choose a password of at least 8 characters.'); return; }
  if(pw !== pw2){ loginError('Passwords don\'t match.'); return; }
  const { error } = await supabase.auth.updateUser({ password: pw });
  if(error){ loginError(error.message); return; }
  document.getElementById('newpw-input').value = '';
  document.getElementById('newpw-confirm').value = '';
  await supabase.auth.signOut();
  showLoginStep('1');
  loginSuccess('Password updated — log in with your new password.');
});

/* ================= AUTH: REGISTER (prescribers only) ================= */
document.getElementById('register-submit-btn').addEventListener('click', async ()=>{
  const errEl = document.getElementById('register-error');
  const okEl = document.getElementById('register-success');
  errEl.classList.remove('show'); okEl.classList.remove('show');
  const fail = m => { errEl.textContent = m; errEl.classList.add('show'); };

  const name = document.getElementById('reg-name').value.trim();
  const profType = document.getElementById('reg-proftype').value;
  const regBody = document.getElementById('reg-regbody').value;
  const regNumber = document.getElementById('reg-regnumber').value.trim();
  const org = document.getElementById('reg-org').value.trim();
  const address = document.getElementById('reg-address').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-password').value;
  const pin = document.getElementById('reg-pin').value.trim();
  const pin2 = document.getElementById('reg-pin2').value.trim();
  const idFile = document.getElementById('reg-iddoc').files[0];
  const indemnity = document.getElementById('reg-indemnity').checked;

  if(!name || !regNumber || !org || !address || !email || !password){ return fail('Please fill in every field.'); }
  if(password.length < 8){ return fail('Choose a password of at least 8 characters.'); }
  if(!/^[0-9]{4}$/.test(pin)){ return fail('Signing PIN must be exactly 4 digits.'); }
  if(pin !== pin2){ return fail('PINs don\'t match.'); }
  if(!idFile){ return fail('Upload a passport or driving licence to verify your identity.'); }
  if(!indemnity){ return fail('You must confirm you hold professional indemnity insurance.'); }

  // 1. create the auth user (real hashed password lives in Supabase Auth)
  const { data: signUp, error: signUpErr } = await supabase.auth.signUp({ email, password });
  if(signUpErr){ return fail(signUpErr.message); }
  if(!signUp.session){
    return fail('Account created — check your email to confirm it, then log in to finish setup. (For internal testing, ask the pharmacy to turn off email confirmation.)');
  }

  // 1b. upload the ID document to the private bucket, under this user's folder
  //     (path: {userId}/{timestamp}-{filename}) so a pharmacist can review it.
  const safeName = idFile.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const idPath = `${signUp.user.id}/${Date.now()}-${safeName}`;
  const { error: upErr } = await supabase.storage.from('prescriber-ids')
    .upload(idPath, idFile, { contentType: idFile.type || undefined, upsert: false });
  if(upErr){ return fail('Could not upload your ID document: ' + upErr.message); }

  // 2. create the prescriber profile (PIN hashed server-side in the RPC)
  const { error: rpcErr } = await supabase.rpc('complete_prescriber_registration', {
    p_name:name, p_prof_role:profType, p_reg_body:regBody, p_reg_number:regNumber,
    p_organisation:org, p_address:address, p_email:email, p_pin:pin,
    p_id_doc: idPath, p_indemnity: true
  });
  if(rpcErr){ return fail(rpcErr.message); }

  // 3. sign out so the first login runs the clean MFA-enrolment path
  await supabase.auth.signOut();

  okEl.textContent = `Registration received. A pharmacist will verify your ${regBody} registration before you can issue prescriptions. Log in to set up two-factor authentication and check your status.`;
  okEl.classList.add('show');
  ['reg-name','reg-regnumber','reg-org','reg-address','reg-email','reg-password','reg-pin','reg-pin2'].forEach(id=> document.getElementById(id).value = '');
  document.getElementById('reg-iddoc').value = '';
  document.getElementById('reg-indemnity').checked = false;
  document.getElementById('login-email').value = email;
  activatePanel('login');
  showLoginStep('1');
});

/* ================= ENTER / EXIT APP ================= */
function enterApp(){
  document.getElementById('auth-wrap').style.display = 'none';
  document.getElementById('app').hidden = false;
  const u = currentUser();
  document.getElementById('chip-name').textContent = u.name;
  const roleEl = document.getElementById('chip-role');
  if(u.role === 'prescriber'){
    roleEl.textContent = u.verified ? u.profRole : u.profRole + ' · pending';
    roleEl.className = 'role-badge' + (u.verified ? '' : ' pending');
  } else {
    roleEl.textContent = u.title;
    roleEl.className = 'role-badge pharmacy';
  }
  buildNav();
  goView('dashboard');
}
async function logout(){
  await supabase.auth.signOut();
  state = null;
  document.getElementById('app').hidden = true;
  document.getElementById('auth-wrap').style.display = 'flex';
  showLoginStep('1');
  document.getElementById('login-email').value = '';
  document.getElementById('login-password').value = '';
  clearLoginError();
  activatePanel('login');
}

/* ================= NAV ================= */
const NAV_ITEMS = {
  dashboard:{ label:'Dashboard', title:'Dashboard', eyebrow:'Overview',
    icon:'<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>' },
  incoming:{ label:'Incoming', title:'Incoming prescriptions', eyebrow:'Queue',
    icon:'<path d="M4 12h6l2 3h0l2-3h6"/><path d="M4 12V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v6"/><path d="M4 12v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6"/>' },
  prescriptions:{ label:'Prescriptions', title:'Prescriptions', eyebrow:'Full record',
    icon:'<rect x="4" y="3" width="12" height="16" rx="1.5"/><path d="M8 8h4M8 11h4M8 14h2"/><path d="M16 6h2a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H10"/>' },
  new:{ label:'New prescription', title:'New prescription', eyebrow:'Prescriber',
    icon:'<path d="M12 5v14M5 12h14"/>' },
  mine:{ label:'My prescriptions', title:'My prescriptions', eyebrow:'Prescriber',
    icon:'<path d="M9 3h6l1 4H8l1-4Z"/><path d="M5 7h14v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7Z"/><path d="M9 12h6M9 16h6"/>' },
  upload:{ label:'Upload / transcribe', title:'Upload / transcribe', eyebrow:'Paper & email',
    icon:'<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>' },
  patients:{ label:'Patients', title:'Patients', eyebrow:'Records',
    icon:'<circle cx="9" cy="8" r="3.4"/><path d="M2.5 20c0-3.5 3-6 6.5-6s6.5 2.5 6.5 6"/><circle cx="17.5" cy="8.5" r="2.6"/><path d="M15.7 14.2c2.8.3 5.3 2.4 5.3 5.8"/>' },
  formulary:{ label:'Target Formulary', title:'Target Formulary', eyebrow:'Pharmacy-controlled',
    icon:'<path d="M9 2h6l1.5 4.5H7.5L9 2Z"/><path d="M6 6.5h12l1.5 13a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5l1.5-13Z"/><path d="M10 12h4M10 15h4"/>' },
  audit:{ label:'Audit trail', title:'Audit trail', eyebrow:'Compliance',
    icon:'<path d="M9 3h6l1 4H8l1-4Z"/><path d="M5 7h14v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7Z"/><path d="M9 12h6M9 16h6"/>' },
  prescribers:{ label:'Prescriber accounts', title:'Prescriber accounts', eyebrow:'Admin',
    icon:'<circle cx="12" cy="8" r="4"/><path d="M4 20c0-4.4 3.6-7 8-7s8 2.6 8 7"/><path d="m16 5 1.6 1.6L21 3"/>' },
};
function navForRole(role){
  if(role === 'prescriber') return ['dashboard','new','mine'];
  return ['dashboard','incoming','prescriptions','upload','patients','formulary','audit','prescribers'];
}
function buildNav(){
  const u = currentUser();
  const items = navForRole(u.role);
  document.getElementById('mainnav').innerHTML = items.map(key=>{
    const m = NAV_ITEMS[key];
    let countHtml = '';
    if(key==='incoming') countHtml = `<span class="count" id="nav-count-incoming">0</span>`;
    if(key==='prescribers') countHtml = `<span class="count warn" id="nav-count-prescribers" style="display:none;">0</span>`;
    if(key==='mine') countHtml = `<span class="count" id="nav-count-mine">0</span>`;
    return `<button class="navlink" data-view="${key}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">${m.icon}</svg>${m.label}${countHtml}</button>`;
  }).join('');
  document.querySelectorAll('.navlink').forEach(b=>{
    b.addEventListener('click', ()=> goView(b.dataset.view));
  });
  document.getElementById('sidebar-foot').textContent = u.role === 'prescriber'
    ? 'Prescriptions you sign use your registered ' + u.regBody + ' number and PIN — every submission is logged.'
    : 'Every entry is timestamped and logged for GPhC-aligned recordkeeping.';
  document.getElementById('search-wrap').style.display = u.role === 'pharmacy' ? 'flex' : 'none';
}
function goView(view){
  currentView = view;
  document.querySelectorAll('.view').forEach(v => v.hidden = (v.id !== 'view-'+view));
  document.querySelectorAll('.navlink').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  document.getElementById('view-title').textContent = NAV_ITEMS[view].title;
  document.getElementById('view-eyebrow').textContent = NAV_ITEMS[view].eyebrow;
  renderAll();
  window.scrollTo(0,0);
}

/* ================= SCRIPT CARD ================= */
function scriptCardHtml(rx){
  const itemsHtml = rx.items.slice(0,2).map(i => `<div class="script-item"><span class="drug">${esc(i.drug)}</span> — ${esc(i.dose)}, ${esc(i.frequency)}</div>`).join('');
  const more = rx.items.length > 2 ? `<div class="script-item" style="color:var(--muted)">+${rx.items.length-2} more item(s)</div>` : '';
  const cd = rx.items.some(i=>i.cd);
  const hasCustomItem = rx.items.some(i=>i.customItem);
  return `
  <div class="script-card" onclick="openDrawer('${rx.id}')">
    <div class="script-row1">
      <div>
        <div class="script-ref">${rx.ref}</div>
        <div class="script-patient">${esc(rx.patientName)}</div>
        <div class="script-meta">${esc(rx.prescriberName)} · ${esc(rx.prescriberOrg)} · ${rx.source}</div>
      </div>
      <div class="script-badges">
        ${rx.urgent ? '<span class="badge urgent">Urgent</span>' : ''}
        <span class="badge ${rx.type==='NHS'?'nhs':'private'}">${rx.type}</span>
        <span class="badge ${rx.status}">${statusLabel(rx.status)}</span>
        ${cd ? '<span class="badge cd">CD</span>' : ''}
        ${hasCustomItem ? '<span class="badge flagged">Off-formulary</span>' : ''}
        ${rx.signature ? '<span class="badge signed">e-signed</span>' : ''}
      </div>
    </div>
    <div class="script-items">${itemsHtml}${more}</div>
    <div class="script-foot"><span>Updated ${timeAgo(rx.updatedAt)}</span><span>${fmtDate(rx.createdAt)}</span></div>
  </div>`;
}

/* ================= DASHBOARD ================= */
function renderDashboard(){
  const u = currentUser();
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const todayShort = new Date().toLocaleDateString('en-GB', { day:'numeric', month:'short' });
  const ctaEl = document.getElementById('dashboard-cta');
  const gridEl = document.getElementById('stat-grid');
  const feedEl = document.getElementById('dashboard-feed');

  if(u.role === 'pharmacy'){
    const list = state.prescriptions;
    const receivedToday = list.filter(r => new Date(r.createdAt) >= todayStart).length;
    const pending = list.filter(r => r.status === 'received' || r.status === 'query').length;
    const urgentOpen = list.filter(r => r.urgent && r.status !== 'exported' && r.status !== 'rejected').length;
    const pendingVerify = state.prescribers.filter(p=>!p.verified).length;

    gridEl.innerHTML = `
      <div class="stat-card" onclick="goIncoming('today')"><div class="label">Received today <span class="date-tag">${todayShort}</span></div><div class="value">${receivedToday}</div><div class="foot">Across all sources</div></div>
      <div class="stat-card" onclick="goIncoming('awaiting')"><div class="label">Awaiting review</div><div class="value">${pending}</div><div class="foot">Received or queried</div></div>
      <div class="stat-card" onclick="goIncoming('urgent')"><div class="label">Urgent</div><div class="value ${urgentOpen?'alert':''}">${urgentOpen}</div><div class="foot">Flagged urgent, still open</div></div>
      <div class="stat-card" onclick="goView('prescribers')"><div class="label">Prescriber verifications</div><div class="value ${pendingVerify?'alert':''}">${pendingVerify}</div><div class="foot">Pending sign-off</div></div>`;
    document.getElementById('feed-heading').textContent = 'Recent activity';
    document.getElementById('feed-desc').textContent = `Prescriptions received today, ${todayShort}.`;
    ctaEl.innerHTML = `<button class="btn primary" onclick="goView('incoming')">View queue</button>`;
    const feed = list.filter(r => new Date(r.createdAt) >= todayStart).sort((a,b)=> new Date(b.createdAt)-new Date(a.createdAt));
    feedEl.innerHTML = feed.map(scriptCardHtml).join('') || `<div class="empty"><div class="big">Nothing received today</div>Prescriptions received today will appear here.</div>`;
  } else {
    const mine = state.prescriptions.filter(r=>r.prescriberId === u.id);
    const submittedToday = mine.filter(r => new Date(r.createdAt) >= todayStart).length;
    const awaiting = mine.filter(r=> r.status==='received' || r.status==='in_review').length;
    const queries = mine.filter(r=> r.status==='query').length;
    const exported = mine.filter(r=> r.status==='exported').length;

    gridEl.innerHTML = `
      <div class="stat-card" onclick="goMine('today')"><div class="label">Submitted today <span class="date-tag">${todayShort}</span></div><div class="value">${submittedToday}</div><div class="foot">By you</div></div>
      <div class="stat-card" onclick="goMine('awaiting')"><div class="label">Awaiting pharmacy review</div><div class="value">${awaiting}</div><div class="foot">Received or in review</div></div>
      <div class="stat-card" onclick="goMine('query')"><div class="label">Queries needing you</div><div class="value ${queries?'alert':''}">${queries}</div><div class="foot">Reply from My prescriptions</div></div>
      <div class="stat-card" onclick="goMine('exported')"><div class="label">Dispensed</div><div class="value">${exported}</div><div class="foot">All time</div></div>`;
    document.getElementById('feed-heading').textContent = 'Your recent submissions';
    document.getElementById('feed-desc').textContent = 'The latest scripts you\'ve signed and sent.';
    if(u.verified){
      ctaEl.innerHTML = `<button class="btn primary" onclick="goView('new')">+ New prescription</button>`;
    } else {
      ctaEl.innerHTML = '';
    }
    const feed = [...mine].sort((a,b)=> new Date(b.updatedAt)-new Date(a.updatedAt)).slice(0,6);
    feedEl.innerHTML = feed.map(scriptCardHtml).join('') || `<div class="empty"><div class="big">Nothing submitted yet</div>${u.verified ? 'Use New prescription to send your first script.' : 'Once your account is verified you\'ll be able to submit prescriptions.'}</div>`;
    if(!u.verified){
      feedEl.innerHTML = `<div class="locked-state"><div class="icon"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg></div><div class="big">Account pending verification</div><p>Your ${u.regBody} registration (${u.regNumber}) is being checked by the pharmacy team. You'll be able to submit prescriptions once it's approved.</p></div>` + feedEl.innerHTML;
    }
  }
}

/* ================= INCOMING (pharmacy) ================= */
// Incoming is the live work queue: only pre-dispensed scripts appear there,
// so no Dispensed tab. Dispensed/rejected live on the Prescriptions page.
const INCOMING_TABS = [ {key:'all',label:'All'}, {key:'urgent',label:'Urgent'}, {key:'received',label:'Received'}, {key:'in_review',label:'In review'}, {key:'query',label:'Query raised'}, {key:'uploaded',label:'Uploaded'} ];
// The prescriber's own view still tracks scripts through to Dispensed.
const MINE_TABS = [ {key:'all',label:'All'}, {key:'urgent',label:'Urgent'}, {key:'received',label:'Received'}, {key:'in_review',label:'In review'}, {key:'query',label:'Query raised'}, {key:'exported',label:'Dispensed'} ];
function todayStartDate(){ const d = new Date(); d.setHours(0,0,0,0); return d; }
// Date-range helper: from/to are yyyy-mm-dd values from <input type="date">.
function inDateRange(iso, fromVal, toVal){
  const t = new Date(iso).getTime();
  if(fromVal && t < new Date(fromVal + 'T00:00:00').getTime()) return false;
  if(toVal && t > new Date(toVal + 'T23:59:59.999').getTime()) return false;
  return true;
}
function goIncoming(filterKey){ incomingFilter = filterKey; goView('incoming'); }
function goMine(filterKey){ mineFilter = filterKey; goView('mine'); }
function renderIncoming(){
  document.getElementById('incoming-tabs').innerHTML = INCOMING_TABS.map(t => `<button type="button" class="tab ${incomingFilter===t.key?'active':''}" data-key="${t.key}">${t.label}</button>`).join('');
  document.querySelectorAll('#incoming-tabs .tab').forEach(b=>{ b.onclick = ()=>{ incomingFilter = b.dataset.key; renderIncoming(); }; });
  // The queue only holds open work — anything not yet dispensed or rejected.
  let list = state.prescriptions.filter(r=> r.status==='received' || r.status==='in_review' || r.status==='query');
  const from = document.getElementById('incoming-from').value;
  const to = document.getElementById('incoming-to').value;
  if(from || to) list = list.filter(r=> inDateRange(r.createdAt, from, to));
  if(incomingFilter === 'urgent') list = list.filter(r=>r.urgent);
  else if(incomingFilter === 'today') list = list.filter(r=> new Date(r.createdAt) >= todayStartDate());
  else if(incomingFilter === 'awaiting') list = list.filter(r=> r.status==='received' || r.status==='query');
  else if(incomingFilter === 'uploaded') list = list.filter(r=> r.source !== 'Portal');
  else if(incomingFilter !== 'all') list = list.filter(r=>r.status===incomingFilter);
  list.sort((a,b)=> new Date(b.createdAt)-new Date(a.createdAt));
  document.getElementById('incoming-list').innerHTML = list.map(scriptCardHtml).join('') || `<div class="empty"><div class="big">No prescriptions in this view</div>Try a different filter${(from||to)?' or date range':''}. Dispensed and rejected scripts are on the Prescriptions page.</div>`;
}

/* ================= PRESCRIPTIONS (pharmacy — full record store) ================= */
// Shared by the on-screen list and the CSV export so they always agree.
function filteredPrescriptions(){
  const q = (document.getElementById('prescriptions-search').value || '').trim().toLowerCase();
  let list = [...state.prescriptions];
  const from = document.getElementById('prescriptions-from').value;
  const to = document.getElementById('prescriptions-to').value;
  if(from || to) list = list.filter(r=> inDateRange(r.createdAt, from, to));
  if(q){
    list = list.filter(r =>
      r.ref.toLowerCase().includes(q) ||
      r.patientName.toLowerCase().includes(q) ||
      r.prescriberName.toLowerCase().includes(q) ||
      r.items.some(i=>i.drug.toLowerCase().includes(q))
    );
  }
  list.sort((a,b)=> new Date(b.createdAt)-new Date(a.createdAt));
  return list;
}
function renderPrescriptionsModule(){
  const q = (document.getElementById('prescriptions-search').value || '').trim();
  const list = filteredPrescriptions();
  document.getElementById('prescriptions-list').innerHTML = list.map(scriptCardHtml).join('') ||
    (q ? `<div class="empty"><div class="big">No matches</div>Try a different reference, patient, drug, or prescriber.</div>`
        : `<div class="empty"><div class="big">No prescriptions yet</div>Everything received or submitted will be stored here permanently.</div>`);
}
document.getElementById('prescriptions-search').addEventListener('input', renderPrescriptionsModule);

/* ---- CSV export (one row per medication item) ---- */
function csvField(v){ return '"' + String(v ?? '').replace(/"/g,'""') + '"'; }
function exportPrescriptionsCsv(){
  const list = filteredPrescriptions();
  if(!list.length){ toast('Nothing to export for the current filters.'); return; }
  const header = ['Ref','Created','Status','Type','Priority','Source','Patient','DOB','NHS number',
    'GP practice / clinic','Allergies','Prescriber','Registration','Organisation','Item','Drug',
    'Dose','Frequency','Quantity','Route','Unlicensed / special','Controlled drug','CD schedule',
    'Off-formulary','Notes','Signature ID','Signed at'];
  const rows = [header];
  for(const r of list){
    const p = state.patients.find(x=>x.id===r.patientId);
    const reg = r.signature ? `${r.signature.regBody} ${r.signature.regNumber}` : '';
    const base = [
      r.ref, new Date(r.createdAt).toLocaleString('en-GB'), statusLabel(r.status), r.type,
      r.urgent ? 'Urgent' : 'Routine', r.source, r.patientName, p?.dob || '', p?.nhs || '',
      p?.gp || '', p?.allergies || '', r.prescriberName, reg, r.prescriberOrg || ''
    ];
    const items = r.items.length ? r.items : [{}];
    items.forEach((i, idx)=>{
      rows.push([...base, idx+1, i.drug || '', i.dose || '', i.frequency || '', i.quantity || '',
        i.route || '', i.special ? 'Yes' : 'No', i.cd ? 'Yes' : 'No', i.cdSchedule || '',
        i.customItem ? 'Yes' : 'No', r.notes || '', r.signature?.signatureId || '',
        r.signature ? new Date(r.signature.signedAt).toLocaleString('en-GB') : '']);
    });
  }
  // BOM so Excel opens it with correct encoding
  const csv = '\uFEFF' + rows.map(row=>row.map(csvField).join(',')).join('\r\n');
  const from = document.getElementById('prescriptions-from').value;
  const to = document.getElementById('prescriptions-to').value;
  const blob = new Blob([csv], { type:'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'prescriptions' + (from ? '_from-'+from : '') + (to ? '_to-'+to : '') + '.csv';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(a.href);
  toast(`Exported ${list.length} prescription(s) as CSV.`);
}
document.getElementById('prescriptions-export-btn').addEventListener('click', exportPrescriptionsCsv);

/* ---- date-range filters ---- */
['incoming-from','incoming-to'].forEach(id=> document.getElementById(id).addEventListener('change', renderIncoming));
document.getElementById('incoming-dates-clear').addEventListener('click', ()=>{
  document.getElementById('incoming-from').value = '';
  document.getElementById('incoming-to').value = '';
  renderIncoming();
});
['prescriptions-from','prescriptions-to'].forEach(id=> document.getElementById(id).addEventListener('change', renderPrescriptionsModule));
document.getElementById('prescriptions-dates-clear').addEventListener('click', ()=>{
  document.getElementById('prescriptions-from').value = '';
  document.getElementById('prescriptions-to').value = '';
  renderPrescriptionsModule();
});

/* ================= MY PRESCRIPTIONS (prescriber) ================= */
function renderMine(){
  const u = currentUser();
  document.getElementById('mine-tabs').innerHTML = MINE_TABS.map(t => `<button type="button" class="tab ${mineFilter===t.key?'active':''}" data-key="${t.key}">${t.label}</button>`).join('');
  document.querySelectorAll('#mine-tabs .tab').forEach(b=>{ b.onclick = ()=>{ mineFilter = b.dataset.key; renderMine(); }; });
  let list = state.prescriptions.filter(r=>r.prescriberId===u.id);
  if(mineFilter === 'urgent') list = list.filter(r=>r.urgent);
  else if(mineFilter === 'today') list = list.filter(r=> new Date(r.createdAt) >= todayStartDate());
  else if(mineFilter === 'awaiting') list = list.filter(r=> r.status==='received' || r.status==='in_review');
  else if(mineFilter !== 'all') list = list.filter(r=>r.status===mineFilter);
  list.sort((a,b)=> new Date(b.createdAt)-new Date(a.createdAt));
  document.getElementById('mine-list').innerHTML = list.map(scriptCardHtml).join('') || `<div class="empty"><div class="big">Nothing here</div>Try a different filter.</div>`;
}

/* ================= NEW PRESCRIPTION GATE ================= */
function renderNewGate(){
  const u = currentUser();
  const gate = document.getElementById('new-rx-gate');
  const form = document.getElementById('rx-form');
  if(u.role !== 'prescriber'){
    gate.innerHTML = `<div class="locked-state"><div class="icon"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg></div><div class="big">Prescriber accounts only</div><p>Pharmacy team members review and dispense — prescriptions are written and signed by verified prescribers. Use Upload / transcribe for paper or emailed scripts.</p></div>`;
    form.style.display = 'none'; return;
  }
  if(!u.verified){
    gate.innerHTML = `<div class="locked-state"><div class="icon"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg></div><div class="big">Your account is pending verification</div><p>We've received your ${u.regBody} registration (${u.regNumber}) and ID. A pharmacist checks this independently before you can issue prescriptions — usually within one working day.</p></div>`;
    form.style.display = 'none'; return;
  }
  gate.innerHTML = '';
  form.style.display = 'block';
  if(document.querySelectorAll('#med-rows .med-row').length === 0) addMedRow();
}

/* ================= DRAWER ================= */
function openDrawer(id){
  const rx = state.prescriptions.find(r=>r.id===id);
  if(!rx) return;
  const u = currentUser();
  const patient = state.patients.find(p=>p.id===rx.patientId);
  const prescriberAccount = rx.prescriberId ? state.prescribers.find(p=>p.id===rx.prescriberId) : null;
  const regInfo = rx.signature
    ? { regBody: rx.signature.regBody, regNumber: rx.signature.regNumber, address: rx.signature.address || (prescriberAccount ? prescriberAccount.address : '') }
    : (prescriberAccount ? { regBody: prescriberAccount.regBody, regNumber: prescriberAccount.regNumber, address: prescriberAccount.address } : null);
  const drawer = document.getElementById('drawer');
  const cd = rx.items.some(i=>i.cd);

  const itemsHtml = rx.items.map(i => `
    <div class="detail-item">
      <div class="drug">${esc(i.drug)} ${i.cd ? `<span class="badge cd" style="margin-left:6px;">${esc(i.cdSchedule||'CD')}</span>` : ''} ${i.special ? '<span class="badge nhs" style="margin-left:4px;">Unlicensed / special</span>' : ''} ${i.customItem ? '<span class="badge flagged" style="margin-left:4px;">Off-formulary — needs review</span>' : ''}</div>
      <div class="specs">${esc(i.dose)} · ${esc(i.frequency)} · Qty ${esc(i.quantity)} · ${esc(i.route)}</div>
    </div>`).join('');

  const historyHtml = [...rx.history].reverse().map(h => `
    <div class="audit-entry"><div class="dot"></div><div>
      <div><strong>${esc(h.action)}</strong> — ${actorLabel(h.actor)}</div>
      ${h.detail ? `<div style="color:var(--muted); margin-top:2px;">${esc(h.detail)}</div>` : ''}
      <div class="ts">${fmtDate(h.ts)}</div>
    </div></div>`).join('');

  const sigHtml = rx.signature ? `
    <div class="sig-block">
      <div class="head">Advanced electronic signature</div>
      Signature ID <span class="sig-id">${rx.signature.signatureId}</span><br>
      ${rx.signature.regBody} ${rx.signature.regNumber} · signed ${fmtDate(rx.signature.signedAt)}
    </div>` : '';

  let actions = '';
  if(u.role === 'pharmacy'){
    if(rx.status === 'received' || rx.status === 'query') actions += `<button class="btn primary" onclick="advanceStatus('${rx.id}','in_review')">Start review</button>`;
    if(rx.status === 'in_review'){
      actions += `<button class="btn primary" onclick="exportToPMR('${rx.id}')">Validate &amp; dispense</button>`;
      actions += `<button class="btn" onclick="promptQuery('${rx.id}')">Raise query</button>`;
    }
    if(rx.status === 'exported') actions += `<button class="btn primary" onclick="promptTracking('${rx.id}')">Add prescription tracking details</button>`;
    if(rx.status !== 'exported' && rx.status !== 'rejected') actions += `<button class="btn danger" onclick="promptReject('${rx.id}')">Reject</button>`;
  } else if(u.role === 'prescriber' && rx.prescriberId === u.id && rx.status === 'query'){
    actions += `<button class="btn primary" onclick="promptRespond('${rx.id}')">Respond to query</button>`;
  }

  // Latest tracking details (if any) get their own section; the full trail
  // stays in the audit history below.
  const lastTracking = [...rx.history].reverse().find(h=>h.action === 'Tracking details added');
  const trackingHtml = lastTracking ? `
    <h4 style="font-size:12.5px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin:14px 0 6px;">Tracking</h4>
    <p style="font-size:13px; margin:0;">${esc(lastTracking.detail)} <span style="color:var(--muted);">— ${fmtDate(lastTracking.ts)}</span></p>` : '';

  // Attachments are internal pharmacy working documents: prescribers never
  // see them (enforced by storage RLS too, not just here).
  const canSeeAttach = u.role === 'pharmacy';
  const canAttach = canSeeAttach && (rx.status === 'in_review' || rx.status === 'exported');
  const attachHtml = canSeeAttach ? `
    <h4 style="font-size:12.5px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin:14px 0 6px;">Attachments</h4>
    <div id="rx-attachments-list"><span style="color:var(--muted); font-size:12.5px;">Loading…</span></div>
    ${canAttach ? `
      <input type="file" id="attach-input" accept=".pdf,.jpg,.jpeg,.png" style="display:none">
      <button class="btn ghost" style="margin-top:8px; padding:5px 10px; font-size:11.5px;" onclick="document.getElementById('attach-input').click()">+ Add attachment</button>` : ''}` : '';

  drawer.innerHTML = `
    <div class="drawer-head">
      <button class="close" onclick="closeDrawer()" aria-label="Close">&times;</button>
      <div class="script-ref">${rx.ref}</div>
      <h3>${esc(rx.patientName)}</h3>
      <div class="script-badges" style="margin-top:6px;">
        ${rx.urgent ? '<span class="badge urgent">Urgent</span>' : ''}
        <span class="badge ${rx.type==='NHS'?'nhs':'private'}">${rx.type}</span>
        <span class="badge ${rx.status}">${statusLabel(rx.status)}</span>
        ${cd ? '<span class="badge cd">Controlled drug</span>' : ''}
      </div>
    </div>
    <div class="drawer-body">
      <dl class="kv">
        <dt>Prescriber</dt><dd>${esc(rx.prescriberName)}</dd>
        <dt>Registration</dt><dd>${regInfo ? esc(regInfo.regBody + ' ' + regInfo.regNumber) : '—'}</dd>
        <dt>Organisation</dt><dd>${esc(rx.prescriberOrg)}</dd>
        <dt>Address</dt><dd>${regInfo && regInfo.address ? esc(regInfo.address) : '—'}</dd>
        <dt>Source</dt><dd>${esc(rx.source)}</dd>
        <dt>DOB</dt><dd>${patient ? esc(patient.dob) : '—'}</dd>
        <dt>Allergies</dt><dd>${patient ? esc(patient.allergies||'NKDA') : '—'}</dd>
        <dt>NHS number</dt><dd>${patient && patient.nhs ? esc(patient.nhs) : '—'}</dd>
      </dl>
      <h4 style="font-size:12.5px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin-bottom:8px;">Medication</h4>
      ${itemsHtml}
      ${rx.notes ? `<h4 style="font-size:12.5px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin:14px 0 6px;">Notes</h4><p style="font-size:13px; margin:0;">${esc(rx.notes)}</p>` : ''}
      ${trackingHtml}
      ${attachHtml}
      ${sigHtml}
      <div class="drawer-actions">${actions}</div>
      <h4 style="font-size:12.5px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin:20px 0 4px;">Audit trail</h4>
      <div>${historyHtml}</div>
    </div>`;
  drawer.hidden = false;
  document.getElementById('overlay').hidden = false;
  if(canAttach){
    const inp = document.getElementById('attach-input');
    inp.addEventListener('change', ()=>{ if(inp.files.length) uploadAttachment(rx.id, inp.files[0]); });
  }
  if(canSeeAttach) renderAttachments(rx.id);
}

/* ---- prescription attachments (private rx-attachments bucket) ---- */
async function renderAttachments(rxId){
  const box = document.getElementById('rx-attachments-list');
  if(!box) return;
  const { data, error } = await supabase.storage.from('rx-attachments').list(rxId, { sortBy:{ column:'name', order:'asc' } });
  if(error){ box.innerHTML = `<span style="color:var(--muted); font-size:12.5px;">Couldn't load attachments (${esc(error.message)}).</span>`; return; }
  if(!data || !data.length){ box.innerHTML = `<span style="color:var(--muted); font-size:12.5px;">No attachments.</span>`; return; }
  // filenames are sanitised at upload to [a-zA-Z0-9._-], so safe inline
  box.innerHTML = data.map(f=>`
    <div style="margin:4px 0;"><a href="#" style="font-size:13px;" onclick="viewAttachment('${rxId}','${f.name}'); return false;">${esc(f.name.replace(/^\d+-/,''))}</a></div>`).join('');
}
async function uploadAttachment(rxId, file){
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `${rxId}/${Date.now()}-${safeName}`;
  const { error } = await supabase.storage.from('rx-attachments').upload(path, file, { contentType: file.type || undefined });
  if(error){ toast('Upload failed: ' + error.message); return; }
  const { error: logErr } = await supabase.rpc('log_rx_attachment', { p_rx_id: rxId, p_filename: safeName });
  if(logErr){ toast(logErr.message); }
  await refreshAndDrawer(rxId);
  toast('Attachment added.');
}
async function viewAttachment(rxId, name){
  const { data, error } = await supabase.storage.from('rx-attachments').createSignedUrl(`${rxId}/${name}`, 120);
  if(error){ toast(error.message); return; }
  window.open(data.signedUrl, '_blank', 'noopener');
}
function closeDrawer(){ document.getElementById('drawer').hidden = true; document.getElementById('overlay').hidden = true; }

async function advanceStatus(id, status){
  const { error } = await supabase.rpc('update_prescription_status', { p_rx_id:id, p_status:status, p_detail:'' });
  if(error){ toast(error.message); return; }
  await refreshAndDrawer(id); toast('Marked as in review.');
}
async function exportToPMR(id){
  const { error } = await supabase.rpc('update_prescription_status', { p_rx_id:id, p_status:'exported', p_detail:'Dispensed via Target Pharmacy PMR.' });
  if(error){ toast(error.message); return; }
  await refreshAndDrawer(id);
  const rx = state.prescriptions.find(r=>r.id===id);
  toast(`${rx ? rx.ref : 'Prescription'} marked as dispensed.`);
}
async function promptTracking(id){
  const detail = prompt('Tracking details (courier, tracking number, expected delivery):');
  if(detail === null) return;
  if(!detail.trim()){ toast('Enter the tracking details.'); return; }
  const { error } = await supabase.rpc('add_tracking_details', { p_rx_id:id, p_detail:detail.trim() });
  if(error){ toast(error.message); return; }
  await refreshAndDrawer(id); toast('Tracking details added.');
}
async function promptQuery(id){
  const reason = prompt('What needs clarifying before this can be dispensed?');
  if(reason === null) return;
  const { error } = await supabase.rpc('update_prescription_status', { p_rx_id:id, p_status:'query', p_detail:reason||'' });
  if(error){ toast(error.message); return; }
  await refreshAndDrawer(id); toast('Query logged and prescriber will need to respond.');
}
async function promptReject(id){
  const reason = prompt('Reason for rejecting this prescription:');
  if(reason === null) return;
  const { error } = await supabase.rpc('update_prescription_status', { p_rx_id:id, p_status:'rejected', p_detail:reason||'' });
  if(error){ toast(error.message); return; }
  await refreshAndDrawer(id); toast('Prescription rejected.');
}
async function promptRespond(id){
  const reply = prompt('Add your response to the pharmacy\'s query:');
  if(reply === null) return;
  const { error } = await supabase.rpc('respond_to_query', { p_rx_id:id, p_reply:reply||'' });
  if(error){ toast(error.message); return; }
  await refreshAndDrawer(id); toast('Response sent to the pharmacy.');
}

/* ================= NEW PRESCRIPTION FORM ================= */
function addMedRow(){
  medRowSeq += 1;
  const rowId = 'med-' + medRowSeq;
  const formulary = (state && state.formulary) || [];
  const wrap = document.createElement('div');
  wrap.className = 'med-row'; wrap.id = rowId;
  wrap.innerHTML = `
    <span class="med-number">Item</span>
    <button type="button" class="med-remove" onclick="document.getElementById('${rowId}').remove()">Remove</button>
    <div class="field">
      <label>Drug, strength &amp; form</label>
      <select class="m-drug-select">
        <option value="">Select from formulary…</option>
        ${formulary.map(f=>`<option>${esc(f.name)}</option>`).join('')}
        <option value="__custom__">+ Item not listed</option>
      </select>
      <input type="text" class="m-drug-custom" placeholder="Enter drug name, strength and form" style="display:none; margin-top:8px;">
      <div class="hint" style="margin-top:4px;">Formulary is set by the pharmacy team. Items not listed are flagged for review before dispensing.</div>
    </div>
    <div class="drug-line-3-even">
      <div class="field"><label>Dose</label><input type="text" class="m-dose" placeholder="e.g. 5ml"></div>
      <div class="field"><label>Frequency</label><input type="text" class="m-freq" placeholder="e.g. Twice daily"></div>
      <div class="field"><label>Quantity</label><input type="text" class="m-qty" placeholder="e.g. 150ml"></div>
    </div>
    <div class="drug-line-3">
      <div class="field"><label>Route</label><select class="m-route">${ROUTES.map(r=>`<option>${r}</option>`).join('')}</select></div>
      <div class="field"><label>&nbsp;</label><label class="checkline"><input type="checkbox" class="m-special"> Unlicensed / special</label></div>
      <div class="field"><label>&nbsp;</label><label class="checkline"><input type="checkbox" class="m-cd"> Controlled drug</label></div>
    </div>
    <div class="field m-cd-wrap" style="display:none;">
      <label>CD schedule</label>
      <select class="m-cd-schedule">${CD_SCHEDULES.map(s=>`<option>${s}</option>`).join('')}</select>
      <div class="cd-banner show">This item will require your PIN and a signed audit entry as a controlled drug on submission.</div>
    </div>`;
  document.getElementById('med-rows').appendChild(wrap);
  wrap.querySelector('.m-cd').addEventListener('change', e=>{ wrap.querySelector('.m-cd-wrap').style.display = e.target.checked ? 'block' : 'none'; });
  wrap.querySelector('.m-drug-select').addEventListener('change', e=>{
    const custom = wrap.querySelector('.m-drug-custom');
    if(e.target.value === '__custom__'){ custom.style.display = 'block'; custom.focus(); }
    else { custom.style.display = 'none'; custom.value = ''; }
  });
  renumberMeds();
}
function renumberMeds(){ document.querySelectorAll('#med-rows .med-row').forEach((el,i)=>{ el.querySelector('.med-number').textContent = 'Item ' + (i+1); }); }
document.getElementById('add-med-btn').addEventListener('click', ()=> addMedRow());
function patientOptionsHtml(){
  return '<option value="">Select existing patient…</option>' + state.patients.map(p=>`<option value="${p.id}">${esc(p.name)} — ${esc(p.dob)}</option>`).join('');
}
document.getElementById('rx-new-patient-toggle').addEventListener('change', e=>{
  const sel = document.getElementById('rx-patient');
  document.getElementById('new-patient-fields').style.display = e.target.checked ? 'block' : 'none';
  sel.disabled = e.target.checked;
  sel.innerHTML = e.target.checked ? '<option value="">New patient — see details below</option>' : patientOptionsHtml();
});
function populatePatientSelect(){
  const toggle = document.getElementById('rx-new-patient-toggle');
  if(toggle && toggle.checked) return; // don't clobber the "new patient" placeholder while it's active
  const sel = document.getElementById('rx-patient');
  const current = sel.value;
  sel.innerHTML = patientOptionsHtml();
  sel.value = current;
}
function resetRxForm(){
  document.getElementById('rx-form').reset();
  document.getElementById('med-rows').innerHTML = '';
  document.getElementById('new-patient-fields').style.display = 'none';
  document.getElementById('rx-patient').disabled = false;
  document.getElementById('rx-patient').innerHTML = patientOptionsHtml();
  addMedRow();
}

document.getElementById('rx-form').addEventListener('submit', e=>{
  e.preventDefault();
  const u = currentUser();
  const isNewPatient = document.getElementById('rx-new-patient-toggle').checked;
  let patientId, patientName, newPatientRecord = null;

  if(isNewPatient){
    const name = document.getElementById('np-name').value.trim();
    if(!name){ toast('Enter the new patient\'s name.'); return; }
    patientId = null;
    patientName = name;
    newPatientRecord = { name, dob: document.getElementById('np-dob').value || '', nhs: document.getElementById('np-nhs').value.trim(), gp: document.getElementById('np-gp').value.trim(), allergies: document.getElementById('np-allergies').value.trim() || 'NKDA' };
  } else {
    patientId = document.getElementById('rx-patient').value;
    if(!patientId){ toast('Select or add a patient first.'); return; }
    patientName = state.patients.find(p=>p.id===patientId).name;
  }

  const medRows = [...document.querySelectorAll('#med-rows .med-row')];
  if(medRows.length === 0){ toast('Add at least one medication.'); return; }
  const items = medRows.map(r=>{
    const selectVal = r.querySelector('.m-drug-select').value;
    const isCustom = selectVal === '__custom__';
    const drugName = isCustom ? r.querySelector('.m-drug-custom').value.trim() : selectVal;
    return {
      drug: drugName, customItem: isCustom,
      dose: r.querySelector('.m-dose').value.trim(), frequency: r.querySelector('.m-freq').value.trim(),
      quantity: r.querySelector('.m-qty').value.trim(), route: r.querySelector('.m-route').value,
      special: r.querySelector('.m-special').checked, cd: r.querySelector('.m-cd').checked,
      cdSchedule: r.querySelector('.m-cd').checked ? r.querySelector('.m-cd-schedule').value : ''
    };
  }).filter(i=>i.drug);
  if(items.length === 0){ toast('Select or enter at least one drug.'); return; }

  pendingSign = {
    patientId, patientName, newPatientRecord, items,
    type: document.getElementById('rx-type').value,
    urgent: document.getElementById('rx-urgent').value === '1',
    notes: document.getElementById('rx-notes').value.trim(),
  };
  openSignModal(u);
});

/* ================= SIGNING MODAL ================= */
// Real signing: the prescriber re-enters their signing PIN, which is verified
// server-side by create_prescription (MFA already happened at login).
function openSignModal(u){
  const cdCount = pendingSign.items.filter(i=>i.cd).length;
  const root = document.getElementById('sign-modal-root');
  root.innerHTML = `
    <div class="modal-overlay" id="sign-overlay">
      <div class="modal-card">
        <h3>Sign &amp; send prescription</h3>
        <div class="summary">
          ${esc(pendingSign.patientName)} · ${pendingSign.items.length} item(s)${cdCount ? ` · ${cdCount} controlled drug item(s)` : ''}<br>
          Signing as ${esc(u.name)} — ${esc(u.regBody)} ${esc(u.regNumber)}
        </div>
        <div class="field"><label>Signing PIN</label><input type="password" id="sign-pin-input" class="pin-input" maxlength="4" inputmode="numeric" placeholder="••••"></div>
        <div class="auth-error" id="sign-error"></div>
        <div style="display:flex; gap:10px; margin-top:6px;">
          <button type="button" class="btn primary" style="flex:1;" onclick="confirmSign()">Sign &amp; send</button>
          <button type="button" class="btn" onclick="closeSignModal()">Cancel</button>
        </div>
      </div>
    </div>`;
  document.getElementById('sign-pin-input').focus();
}
function closeSignModal(){ document.getElementById('sign-modal-root').innerHTML = ''; pendingSign = null; }

async function confirmSign(){
  const errEl = document.getElementById('sign-error');
  const pin = document.getElementById('sign-pin-input').value.trim();
  if(!/^[0-9]{4}$/.test(pin)){ errEl.textContent = 'Enter your 4-digit signing PIN.'; errEl.classList.add('show'); return; }
  errEl.classList.remove('show');
  const payload = pendingSign;

  const { data, error } = await supabase.rpc('create_prescription', {
    p_patient_id: payload.newPatientRecord ? null : payload.patientId,
    p_new_patient: payload.newPatientRecord,
    p_items: payload.items,
    p_type: payload.type,
    p_urgent: payload.urgent,
    p_notes: payload.notes,
    p_pin: pin
  });
  if(error){ errEl.textContent = error.message; errEl.classList.add('show'); return; }

  closeSignModal();
  await refresh();
  const box = document.getElementById('new-confirm');
  box.innerHTML = `Signed and sent to the pharmacy queue as <span class="ref">${esc(data)}</span>.`;
  box.classList.add('show');
  resetRxForm();
  renderAll();
  toast('Prescription signed and submitted.');
}

/* ================= UPLOAD ================= */
document.querySelectorAll('.source-toggle .tab').forEach(b=>{
  b.addEventListener('click', ()=>{ document.querySelectorAll('.source-toggle .tab').forEach(x=>x.classList.remove('active')); b.classList.add('active'); uploadSource = b.dataset.src; });
});
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
['dragover','dragenter'].forEach(ev=> dropzone.addEventListener(ev, e=>{ e.preventDefault(); dropzone.classList.add('drag'); }));
['dragleave','drop'].forEach(ev=> dropzone.addEventListener(ev, e=>{ e.preventDefault(); dropzone.classList.remove('drag'); }));
dropzone.addEventListener('drop', e=>{ if(e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]); });
fileInput.addEventListener('change', ()=>{ if(fileInput.files.length) handleFile(fileInput.files[0]); });

// NOTE: OCR is still simulated (README "What's simulated") — real text
// extraction is future work. The transcribed values are what actually persist.
const SAMPLE_EXTRACTS = [
  { patient:'Priya Chandran', dob:'1991-11-24', prescriber:'Dr. E. Vance', org:'Willowburn Surgery', drug:'Melatonin 1mg/ml oral solution (unlicensed) — 2ml at night, 100ml' },
  { patient:'Tom Fenwick', dob:'1955-05-30', prescriber:'Dr. H. Marsh', org:'Fenwick Private Care', drug:'Sildenafil 25mg tablets — one as required, 8 tablets' },
  { patient:'', dob:'', prescriber:'', org:'', drug:'' },
];
function handleFile(file){
  document.getElementById('ocr-status').style.display = 'block';
  document.getElementById('ocr-status-text').textContent = `Reading ${file.name}…`;
  document.getElementById('upload-form').style.display = 'none';
  setTimeout(()=>{
    document.getElementById('ocr-status').style.display = 'none';
    const sample = SAMPLE_EXTRACTS[Math.floor(Math.random()*SAMPLE_EXTRACTS.length)];
    document.getElementById('upload-filename').textContent = file.name;
    document.getElementById('up-patient').value = sample.patient;
    document.getElementById('up-dob').value = sample.dob;
    document.getElementById('up-prescriber').value = sample.prescriber;
    document.getElementById('up-org').value = sample.org;
    document.getElementById('up-drug').value = sample.drug;
    document.getElementById('up-notes').value = '';
    document.getElementById('upload-form').style.display = 'block';
    toast(sample.patient ? 'Text extracted — please check every field.' : 'Could not confidently read this file — enter the details manually.');
  }, 900);
}
document.getElementById('upload-form').addEventListener('submit', async e=>{
  e.preventDefault();
  const { data, error } = await supabase.rpc('create_upload', {
    p_patient_name: document.getElementById('up-patient').value.trim(),
    p_dob: document.getElementById('up-dob').value || '',
    p_prescriber_name: document.getElementById('up-prescriber').value.trim(),
    p_org: document.getElementById('up-org').value.trim(),
    p_drug: document.getElementById('up-drug').value.trim(),
    p_notes: document.getElementById('up-notes').value.trim(),
    p_source: uploadSource
  });
  if(error){ toast(error.message); return; }
  e.target.reset(); e.target.style.display = 'none';
  document.getElementById('dz-text').innerHTML = 'Drag a file here, or <label for="file-input" style="color:var(--primary); font-weight:600; cursor:pointer; text-decoration:underline;">browse</label>';
  await refresh();
  toast(`${data} added to the incoming queue.`);
});

/* ================= PATIENTS ================= */
function initials(name){ return name.split(' ').filter(Boolean).slice(0,2).map(n=>n[0]).join('').toUpperCase(); }
function renderPatients(){
  const list = document.getElementById('patient-list');
  if(state.patients.length === 0){ list.innerHTML = `<div class="empty"><div class="big">No patients yet</div>They'll appear here once a prescription is submitted.</div>`; return; }
  list.innerHTML = state.patients.map(p=>{
    const count = state.prescriptions.filter(r=>r.patientId===p.id).length;
    return `<div class="patient-row" onclick="openPatient('${p.id}')">
      <div class="patient-avatar">${initials(p.name)}</div>
      <div><div class="name">${esc(p.name)}</div><div class="sub">DOB ${esc(p.dob||'—')} · ${esc(p.gp||'No practice on file')}${p.allergies && p.allergies!=='NKDA' ? ' · Allergy: '+esc(p.allergies) : ''}</div></div>
      <div class="count-pill">${count} script${count===1?'':'s'}</div>
    </div>`;
  }).join('');
}
function openPatient(id){
  const rx = state.prescriptions.filter(r=>r.patientId===id).sort((a,b)=> new Date(b.createdAt)-new Date(a.createdAt))[0];
  if(rx) openDrawer(rx.id); else toast('No prescriptions on file for this patient yet.');
}

/* ================= FORMULARY (pharmacy only) ================= */
function renderFormulary(){
  const list = document.getElementById('formulary-list');
  if(!state.formulary.length){
    list.innerHTML = `<div class="empty"><div class="big">Formulary is empty</div>Add an item above — prescribers won't see anything to choose from until you do.</div>`;
    return;
  }
  const sorted = [...state.formulary].sort((a,b)=> a.name.localeCompare(b.name));
  list.innerHTML = sorted.map(item => `
    <div class="formulary-row">
      <div class="icon">℞</div>
      <div><div class="name">${esc(item.name)}</div><div class="sub">Added by ${esc(item.addedBy)} · ${fmtDate(item.addedAt)}</div></div>
      <div class="row-actions">
        <button class="btn ghost" style="padding:5px 10px; font-size:11.5px;" onclick="editFormularyItem('${item.id}')">Edit</button>
        <button class="btn danger" style="padding:5px 10px; font-size:11.5px;" onclick="removeFormularyItem('${item.id}')">Remove</button>
      </div>
    </div>`).join('');
}
document.getElementById('formulary-add-btn').addEventListener('click', async ()=>{
  const u = currentUser();
  if(!u || u.role !== 'pharmacy') return;
  const input = document.getElementById('formulary-new-item');
  const name = input.value.trim();
  if(!name){ toast('Enter a drug name and strength first.'); return; }
  if(state.formulary.some(f=>f.name.toLowerCase()===name.toLowerCase())){ toast('That item is already on the formulary.'); return; }
  const { error } = await supabase.rpc('add_formulary_item', { p_name:name });
  if(error){ toast(error.message); return; }
  input.value = '';
  await refresh();
  toast('Added to the formulary.');
});
async function editFormularyItem(id){
  const u = currentUser();
  if(!u || u.role !== 'pharmacy') return;
  const item = state.formulary.find(f=>f.id===id);
  if(!item) return;
  const updated = prompt('Edit formulary item:', item.name);
  if(updated === null) return;
  const trimmed = updated.trim();
  if(!trimmed){ toast('Name can\'t be empty.'); return; }
  const { error } = await supabase.rpc('edit_formulary_item', { p_id:id, p_name:trimmed });
  if(error){ toast(error.message); return; }
  await refresh();
  toast('Formulary item updated.');
}
async function removeFormularyItem(id){
  const u = currentUser();
  if(!u || u.role !== 'pharmacy') return;
  const item = state.formulary.find(f=>f.id===id);
  if(!item) return;
  if(!confirm(`Remove "${item.name}" from the formulary? Prescribers will no longer be able to select it.`)) return;
  const { error } = await supabase.rpc('remove_formulary_item', { p_id:id });
  if(error){ toast(error.message); return; }
  await refresh();
  toast('Removed from the formulary.');
}

/* ================= AUDIT (pharmacy) ================= */
function renderAudit(){
  const rows = [];
  state.prescriptions.forEach(rx=>{ rx.history.forEach(h=> rows.push({ ...h, ref: rx.ref, id: rx.id, kind:'rx' })); });
  state.accountLog.forEach(h=> rows.push({ ...h, ref: h.kind==='formulary' ? 'FORMULARY' : 'ACCOUNT', id:null, kind: h.kind==='formulary' ? 'formulary' : 'account' }));
  rows.sort((a,b)=> new Date(b.ts)-new Date(a.ts));
  const head = `<div class="row head"><div>Timestamp</div><div>Reference</div><div>Action</div><div>By</div></div>`;
  const body = rows.map(r=>`
    <div class="row">
      <div class="ts" style="font-family:var(--font-mono); font-size:11px;">${fmtDate(r.ts)}</div>
      ${r.kind==='rx' ? `<button class="ref-link" onclick="openDrawer('${r.id}')">${r.ref}</button>` : `<span style="font-family:var(--font-mono); color:var(--muted); font-size:11px;">${r.ref}</span>`}
      <div>${esc(r.action)}${r.detail ? ' — ' + esc(r.detail) : ''}</div>
      <div>${esc(r.actor)}${actorFunction(r.actor) ? `<br><span style="color:var(--muted); font-size:10.5px;">${esc(actorFunction(r.actor))}</span>` : ''}</div>
    </div>`).join('');
  document.getElementById('audit-table').innerHTML = head + (body || `<div class="row"><div style="grid-column:1/-1; color:var(--muted);">No activity logged yet.</div></div>`);
}

/* ================= PRESCRIBERS ADMIN (pharmacy) ================= */
// id_doc holds a storage path ({userId}/{ts}-{filename}) for accounts registered
// with real file upload; older/seed accounts may hold just a bare filename.
function idFileName(path){ return String(path||'').split('/').pop().replace(/^\d+-/, ''); }
function idDocCellHtml(p){
  const indem = p.indemnity ? ' · Indemnity ✓' : ' · Indemnity ✗';
  if(p.idDoc && p.idDoc.includes('/')){
    return `<button class="btn ghost" style="padding:4px 9px; font-size:11px;" onclick="viewIdDoc('${p.id}')">View ID</button> <span style="color:var(--muted); font-size:11px;">${esc(idFileName(p.idDoc))}</span>${indem}`;
  }
  return `<span>${esc(p.idDoc || 'No ID')}${p.idDoc ? ' <span style="color:var(--muted); font-size:11px;">(no file stored)</span>' : ''}</span>${indem}`;
}
async function viewIdDoc(id){
  const p = state.prescribers.find(x=>x.id===id);
  if(!p || !p.idDoc){ toast('No ID document on file.'); return; }
  if(!p.idDoc.includes('/')){ toast('This account was registered before ID files were stored — no file to view.'); return; }
  const { data, error } = await supabase.storage.from('prescriber-ids').createSignedUrl(p.idDoc, 120);
  if(error){ toast(error.message); return; }
  window.open(data.signedUrl, '_blank', 'noopener');
}
function renderPrescribersAdmin(){
  const rows = [...state.prescribers].sort((a,b)=> (a.verified === b.verified) ? 0 : (a.verified ? 1 : -1));
  const head = `<div class="row head"><div>Prescriber</div><div>Registration</div><div>ID &amp; indemnity</div><div>Status</div><div>Action</div></div>`;
  const body = rows.map(p=>`
    <div class="row">
      <div><strong>${esc(p.name)}</strong><br><span style="color:var(--muted);">${esc(p.profRole)} · ${esc(p.organisation)}</span></div>
      <div>${esc(p.regBody)} ${esc(p.regNumber)}<br><span style="color:var(--muted); font-size:11px;">${esc(p.address||'No address on file')}</span></div>
      <div>${idDocCellHtml(p)}</div>
      <div><span class="badge ${p.verified?'verified':'pending'}">${p.verified ? 'Verified' : 'Pending'}</span></div>
      <div>${p.verified
          ? `<span style="color:var(--muted); font-size:11.5px;">by ${esc(p.verifiedBy)}<br>${fmtDate(p.verifiedAt)}</span>`
          : `<button class="btn primary" style="padding:5px 10px; font-size:11.5px;" onclick="verifyPrescriber('${p.id}')">Verify</button>
             <button class="btn danger" style="padding:5px 10px; font-size:11.5px; margin-top:5px;" onclick="rejectPrescriber('${p.id}')">Reject</button>`}
      </div>
    </div>`).join('');
  document.getElementById('verify-table').innerHTML = head + body;
}
async function verifyPrescriber(id){
  const { error } = await supabase.rpc('verify_prescriber', { p_id:id });
  if(error){ toast(error.message); return; }
  const p = state.prescribers.find(x=>x.id===id);
  await refresh(); toast(`${p ? p.name : 'Prescriber'} verified — they can now issue prescriptions.`);
}
async function rejectPrescriber(id){
  const reason = prompt('Reason for rejecting this registration:');
  if(reason === null) return;
  const { error } = await supabase.rpc('reject_prescriber', { p_id:id, p_reason:reason||'' });
  if(error){ toast(error.message); return; }
  await refresh(); toast('Registration rejected and removed.');
}

/* ================= SEARCH ================= */
document.getElementById('global-search').addEventListener('input', e=>{
  const u = currentUser();
  if(!u || u.role !== 'pharmacy') return;
  const q = e.target.value.trim();
  if(!q){ renderAll(); return; }
  if(currentView !== 'prescriptions') goView('prescriptions');
  document.getElementById('prescriptions-search').value = q;
  renderPrescriptionsModule();
});

/* ================= COUNTS / MASTER RENDER ================= */
function renderNavCounts(){
  const u = currentUser();
  const incomingCount = document.getElementById('nav-count-incoming');
  if(incomingCount) incomingCount.textContent = state.prescriptions.filter(r=> r.status==='received' || r.status==='in_review' || r.status==='query').length;
  const prescCount = document.getElementById('nav-count-prescribers');
  if(prescCount){ const n = state.prescribers.filter(p=>!p.verified).length; prescCount.textContent = n; prescCount.style.display = n ? 'inline' : 'none'; }
  const mineCount = document.getElementById('nav-count-mine');
  if(mineCount && u) mineCount.textContent = state.prescriptions.filter(r=>r.prescriberId===u.id && (r.status==='received'||r.status==='in_review'||r.status==='query')).length;
}
function renderAll(){
  const u = currentUser();
  if(!u) return;
  renderNavCounts();
  populatePatientSelect();
  if(currentView === 'dashboard') renderDashboard();
  if(currentView === 'incoming') renderIncoming();
  if(currentView === 'prescriptions') renderPrescriptionsModule();
  if(currentView === 'new') renderNewGate();
  if(currentView === 'mine') renderMine();
  if(currentView === 'patients') renderPatients();
  if(currentView === 'formulary') renderFormulary();
  if(currentView === 'audit') renderAudit();
  if(currentView === 'prescribers') renderPrescribersAdmin();
}

/* ================= EXPOSE INLINE HANDLERS ================= */
// app.js is an ES module, so top-level functions are NOT global. The markup
// uses inline onclick="..." handlers, so attach the ones it references.
Object.assign(window, {
  openDrawer, closeDrawer, goView, goIncoming, goMine, logout, backToLoginStep1,
  resetRxForm, confirmSign, closeSignModal, advanceStatus, exportToPMR, promptTracking, promptQuery,
  promptReject, promptRespond, verifyPrescriber, rejectPrescriber, editFormularyItem,
  removeFormularyItem, openPatient, viewIdDoc, viewAttachment
});

/* ================= INIT ================= */
// Captured before supabase-js consumes the URL hash.
const initialHash = new URLSearchParams(window.location.hash.replace(/^#/, ''));

(async function init(){
  showLoginStep('1');
  // Arriving from a password-reset email: let the PASSWORD_RECOVERY event
  // drive the UI instead of the normal session routing below.
  if(initialHash.get('type') === 'recovery') return;
  // Expired/invalid recovery link: Supabase returns the reason in the hash.
  if(initialHash.get('error_description')){
    loginError(initialHash.get('error_description').replace(/\+/g,' ') + ' — request a new reset link via "Forgot password?".');
    return;
  }
  const { data:{ session } } = await supabase.auth.getSession();
  if(!session) return;
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if(aal && aal.currentLevel === 'aal2'){
    await resolveSessionAndEnter();
    return;
  }
  // Session exists but MFA not satisfied this session: resume verify if a
  // factor is enrolled, otherwise drop the session and start clean.
  const { data: factors } = await supabase.auth.mfa.listFactors();
  const verified = (factors?.totp || []).filter(f=>f.status === 'verified');
  if(verified.length){ mfaFactorId = verified[0].id; showLoginStep('mfa'); }
  else { await supabase.auth.signOut(); showLoginStep('1'); }
})();
