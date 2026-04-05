// library/js/db.js — talks to the Node.js backend API
const API = '/api';

// ── Session ──────────────────────────────────────────────────
function getSession()      { const s = sessionStorage.getItem('libSession'); return s ? JSON.parse(s) : null; }
function setSession(d)     { sessionStorage.setItem('libSession', JSON.stringify(d)); }
function clearSession()    { sessionStorage.removeItem('libSession'); }
function getToken()        { const s = getSession(); return s ? s.token : null; }

function requireAuth(role) {
  const s = getSession();
  if (!s || !s.token) { window.location.href = rootPath() + 'index.html'; return null; }
  if (role && s.role !== role) { window.location.href = rootPath() + 'index.html'; return null; }
  return s;
}
function rootPath() {
  const d = window.location.pathname.split('/').filter(Boolean).length;
  return d >= 2 ? '../../' : '';
}

// ── Fetch wrapper ─────────────────────────────────────────────
async function api(endpoint, opts = {}) {
  const token = getToken();
  const cfg = {
    headers: { 'Content-Type':'application/json', ...(token ? { Authorization:`Bearer ${token}` } : {}) },
    ...opts,
  };
  if (cfg.body && typeof cfg.body === 'object') cfg.body = JSON.stringify(cfg.body);
  const res  = await fetch(API + endpoint, cfg);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ── Auth ──────────────────────────────────────────────────────
const Auth = {
  async loginStudent(sap_id, dob) {
    const d = await api('/auth/student/login', { method:'POST', body:{sap_id,dob} });
    setSession({ ...d.user, token: d.token });
    return d.user;
  },
  async loginAdmin(username, password) {
    const d = await api('/auth/admin/login', { method:'POST', body:{username,password} });
    setSession({ ...d.user, token: d.token });
    return d.user;
  },
};

// ── Books ─────────────────────────────────────────────────────
const Books = {
  getAll(q='', type='') { const p=new URLSearchParams(); if(q) p.append('q',q); if(type) p.append('type',type); return api('/books?'+p); },
  getOne(id)            { return api(`/books/${id}`); },
  add(data)             { return api('/books',         { method:'POST',   body:data }); },
  update(id,data)       { return api(`/books/${id}`,   { method:'PUT',    body:data }); },
  delete(id)            { return api(`/books/${id}`,   { method:'DELETE'           }); },
};

// ── Students ──────────────────────────────────────────────────
const Students = {
  getAll(q='',status='') { const p=new URLSearchParams(); if(q) p.append('q',q); if(status) p.append('status',status); return api('/students?'+p); },
  getOne(sap)            { return api(`/students/${sap}`); },
  add(data)              { return api('/students',            { method:'POST',  body:data }); },
  update(sap,data)       { return api(`/students/${sap}`,    { method:'PUT',   body:data }); },
  toggle(sap)            { return api(`/students/${sap}/toggle`, { method:'PATCH'        }); },
};

// ── Issues ────────────────────────────────────────────────────
const Issues = {
  getAll(f={})        { return api('/issues?'+new URLSearchParams(f)); },
  issue(sap,book,days=14) { return api('/issues', { method:'POST', body:{sap_id:sap,book_id:book,due_days:days} }); },
  returnBook(id)      { return api(`/issues/${id}/return`, { method:'POST' }); },
};

// ── Requests ──────────────────────────────────────────────────
const Requests = {
  getAll(status='')   { return api('/requests'+(status?`?status=${status}`:'')); },
  place(book_id)      { return api('/requests', { method:'POST',  body:{book_id} }); },
  resolve(id,action,remark='') { return api(`/requests/${id}/resolve`, { method:'PATCH', body:{action,admin_remark:remark} }); },
};

// ── Fines ─────────────────────────────────────────────────────
const Fines = {
  getAll(status='')   { return api('/fines'+(status?`?status=${status}`:'')); },
  getSummary(sap)     { return api(`/fines/summary/${sap}`); },
  update(id,paid_status,amount) {
    const b={};
    if(paid_status!==undefined) b.paid_status=paid_status;
    if(amount!==undefined)      b.amount=amount;
    return api(`/fines/${id}`,{method:'PATCH',body:b});
  },
};

// ── Stats ─────────────────────────────────────────────────────
const Stats = {
  get()         { return api('/stats'); },
  markOverdue() { return api('/admin/mark-overdue',{method:'POST'}); },
};

// ── Helpers ───────────────────────────────────────────────────
function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });
}
function getInitials(name) { return (name||'?').split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase(); }

const BADGE_MAP = { issued:'blue',returned:'green',overdue:'red',pending:'amber',approved:'green',rejected:'red',unpaid:'red',paid:'green',waived:'amber' };
function badge(s) { return `<span class="badge badge-${BADGE_MAP[s]||'gray'}">${s}</span>`; }

function showToast(msg, type='info') {
  const icons = { success:'✅', error:'❌', info:'ℹ️', warning:'⚠️' };
  let c = document.getElementById('toast-container');
  if (!c) { c=document.createElement('div'); c.id='toast-container'; c.className='toast-container'; document.body.appendChild(c); }
  const t=document.createElement('div'); t.className=`toast ${type}`;
  t.innerHTML=`<span style="font-size:16px">${icons[type]||'ℹ️'}</span><span>${msg}</span>`;
  c.appendChild(t); setTimeout(()=>t.style.opacity='0',3000); setTimeout(()=>t.remove(),3500);
}

function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
document.addEventListener('click', e => {
  document.querySelectorAll('.modal-bg.open').forEach(m => { if(e.target===m) m.classList.remove('open'); });
});

function showLoading(id) {
  const el=document.getElementById(id);
  if(el) el.innerHTML=`<div style="text-align:center;padding:48px;color:var(--text3)"><div style="font-size:28px;animation:spin 1s linear infinite;display:inline-block">⚙️</div><p style="margin-top:12px">Loading…</p></div>`;
}
function showErr(id, msg) {
  const el=document.getElementById(id);
  if(el) el.innerHTML=`<div class="alert alert-error">❌ ${msg}<br><small>Make sure the server is running at localhost:3000</small></div>`;
}

function buildTopbar(session) {
  const tb=document.getElementById('topbar'); if(!tb) return;
  const root=rootPath();
  tb.innerHTML=`
    <a href="${root}index.html" class="topbar-logo"><div class="topbar-logo-dot"></div>LibraryOS</a>
    <span class="topbar-role">${session.role.toUpperCase()}</span>
    <div class="topbar-right">
      <div class="topbar-user">Signed in as <span>${session.username}</span></div>
      <a href="${root}index.html" class="btn-logout" onclick="clearSession()">Sign Out</a>
    </div>`;
}

const STUDENT_NAV = [{ section:'Student', items:[
  {href:'dashboard.html',icon:'🏠',label:'Dashboard'},
  {href:'books.html',icon:'📚',label:'Browse Books'},
  {href:'recommendations.html',icon:'✨',label:'Recommendations'},
  {href:'my-issues.html',icon:'📖',label:'My Issued Books'},
  {href:'reservations.html',icon:'🔖',label:'My Reservations'},
  {href:'requests.html',icon:'🔔',label:'My Requests'},
  {href:'reviews.html',icon:'⭐',label:'My Reviews'},
  {href:'fines.html',icon:'💰',label:'Fine Details'},
  {href:'chatbot.html',icon:'🤖',label:'Book Assistant'},
  {href:'profile.html',icon:'👤',label:'My Profile'},
]}];
const ADMIN_NAV = [
  {section:'Overview',items:[{href:'dashboard.html',icon:'📊',label:'Dashboard'}]},
  {section:'Books',items:[{href:'books.html',icon:'📚',label:'Book Management'},{href:'issue-return.html',icon:'📤',label:'Issue & Return'},{href:'search-issued.html',icon:'🔍',label:'Search Issued'}]},
  {section:'Students',items:[{href:'students.html',icon:'👥',label:'Registered Users'},{href:'requests.html',icon:'📋',label:'Book Requests',badge:true},{href:'reservations.html',icon:'🔖',label:'Reservations'},{href:'fines.html',icon:'💳',label:'Fine Records'}]},
];

async function buildSidebar(role, activePage) {
  const sb=document.getElementById('sidebar'); if(!sb) return;
  const nav=role==='admin'?ADMIN_NAV:STUDENT_NAV;
  let pendingCount=0;
  if(role==='admin') { try { const r=await Requests.getAll('pending'); pendingCount=r.length; } catch{} }
  sb.innerHTML=nav.map(sec=>`
    <div class="nav-section">
      <div class="nav-section-label">${sec.section}</div>
      ${sec.items.map(item=>{
        const isActive=item.href===activePage;
        const badgeHtml=item.badge&&pendingCount>0?`<span class="nav-badge">${pendingCount}</span>`:'';
        return`<a href="${item.href}" class="nav-item${isActive?' active':''}"><span class="nav-icon">${item.icon}</span>${item.label}${badgeHtml}</a>`;
      }).join('')}
    </div>`).join('');
}

// ── Reservations ──────────────────────────────────────────────
const Reservations = {
  getAll(status='') { return api('/reservations'+(status?`?status=${status}`:'')); },
  expireOld()       { return api('/admin/expire-reservations',{method:'POST'}); },
};

// ── Reviews ───────────────────────────────────────────────────
const Reviews = {
  getAll()             { return api('/reviews'); },
  forBook(book_id)     { return api(`/books/${book_id}/reviews`); },
  submit(book_id,rating,review_text) { return api('/reviews',{method:'POST',body:{book_id,rating,review_text}}); },
  hide(id)             { return api(`/reviews/${id}`,{method:'DELETE'}); },
};

// ── Chatbot ───────────────────────────────────────────────────
const Chatbot = {
  send(message,session_id) { return api('/chatbot',{method:'POST',body:{message,session_id}}); },
};

// ── Recommendations ───────────────────────────────────────────
const Recommendations = {
  get() { 
    return api('/recommendations'); 
  },

getAI(preferences) {
  return api('/ai-recommendations', {
    method: 'POST',
    body: { preferences }
  });
}
};


// ── Notifications ─────────────────────────────────────────────
const Notifications = {
  getAll()       { return api('/notifications'); },
  sendReminders(){ return api('/admin/send-reminders',{method:'POST'}); },
};

// ── Star rating helper ────────────────────────────────────────
function starRating(avg, count) {
  const avgNum = parseFloat(avg) || 0;
  const full  = Math.round(avgNum);
  const stars = '★'.repeat(full) + '☆'.repeat(5 - full);
  return `<span style="color:var(--amber);font-size:14px" title="${avgNum.toFixed(1)} / 5">${stars}</span>
          <span style="font-size:11px;color:var(--text3)">${count||0} review${count!==1?'s':''}</span>`;
}