// ================================================================
//  LibraryOS — server.js  v2
//  Includes: Reservations, Reviews, Chatbot, Email Notifications
// ================================================================
const express    = require('express');
const cors       = require('cors');
const jwt        = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const path       = require('path');
require('dotenv').config();

const db   = require('./config/db');
const { authMiddleware, adminOnly } = require('./middleware/auth');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'library')));

// ── Email transporter ──────────────────────────────────────────
const mailer = nodemailer.createTransport({
  host:   process.env.SMTP_HOST   || 'smtp.gmail.com',
  port:   parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: {
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
  },
});

async function sendEmail(to, subject, html) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.log('[EMAIL SKIPPED] SMTP_USER or SMTP_PASS not set in .env');
    return;
  }
  try {
    const info = await mailer.sendMail({
      from: `"LibraryOS" <${process.env.SMTP_USER}>`,
      to, subject, html,
    });
    console.log('[EMAIL SENT]', subject, '->', to, '| MessageId:', info.messageId);
  } catch(e) {
    console.error('[EMAIL FAILED]', e.message);
    console.error('[EMAIL DEBUG] Check: 1) Gmail 2FA enabled? 2) App Password correct? 3) "Less secure apps" or App Password used?');
  }
}

// ── Email template helper ──────────────────────────────────────
function emailTemplate(title, body, footerNote = '') {
  return `
  <!DOCTYPE html><html><head><meta charset="UTF-8"/>
  <style>
    body{font-family:'DM Sans',Arial,sans-serif;background:#0c0e14;margin:0;padding:20px}
    .wrap{max-width:520px;margin:0 auto;background:#13161f;border-radius:14px;overflow:hidden;border:1px solid #2a2f42}
    .header{background:linear-gradient(135deg,#4f7cff,#7c5cfc);padding:28px 32px;text-align:center}
    .header h1{color:#fff;font-size:20px;margin:0;font-weight:800;letter-spacing:-.3px}
    .header p{color:rgba(255,255,255,.8);font-size:13px;margin:6px 0 0}
    .body{padding:28px 32px;color:#e8ecf5}
    .body h2{font-size:17px;margin:0 0 12px;color:#fff}
    .body p{font-size:14px;color:#8b91a8;line-height:1.6;margin:0 0 10px}
    .detail-row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #2a2f42;font-size:13px}
    .detail-row .label{color:#555c78}
    .detail-row .val{color:#e8ecf5;font-weight:600}
    .badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700}
    .badge-red{background:rgba(255,95,109,.15);color:#ff5f6d}
    .badge-green{background:rgba(45,212,160,.15);color:#2dd4a0}
    .badge-blue{background:rgba(79,124,255,.15);color:#4f7cff}
    .cta{display:inline-block;margin-top:20px;padding:12px 24px;background:linear-gradient(135deg,#4f7cff,#7c5cfc);color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:14px}
    .footer{padding:16px 32px;background:#0c0e14;text-align:center;font-size:11px;color:#555c78}
  </style></head><body>
  <div class="wrap">
    <div class="header">
      <h1>📚 LibraryOS</h1>
      <p>University Library Management System</p>
    </div>
    <div class="body">
      <h2>${title}</h2>
      ${body}
    </div>
    <div class="footer">
      ${footerNote || 'This is an automated message from LibraryOS. Please do not reply.'}
    </div>
  </div></body></html>`;
}

// ── Queue notification to DB ───────────────────────────────────
async function queueNotification(conn, sap_id, email, type, subject, html, reference_id = null, send_at = null) {
  try {
    await conn.execute(
      `INSERT INTO Notification (sap_id,email,type,subject,body_html,reference_id,send_at)
       VALUES (?,?,?,?,?,?,?)`,
      [sap_id, email, type, subject, html, reference_id, send_at || new Date()]
    );
    // Fire email immediately
    await sendEmail(email, subject, html);
    // Mark as sent — use IS NULL safe comparison for reference_id
    const refCondition = reference_id == null ? 'reference_id IS NULL' : 'reference_id=?';
    const refParams    = reference_id == null ? [sap_id, type] : [sap_id, type, reference_id];
    await conn.execute(
      `UPDATE Notification SET status='sent', sent_at=NOW() WHERE sap_id=? AND type=? AND ${refCondition} ORDER BY created_at DESC LIMIT 1`,
      refParams
    );
  } catch(e) {
    console.error('[NOTIF ERROR]', e.message);
  }
}

// ================================================================
// AUTH ROUTES
// ================================================================
app.post('/api/auth/student/login', async (req, res) => {
  try {
    const { sap_id, dob } = req.body;
    const [rows] = await db.execute(
      'SELECT * FROM Student WHERE sap_id=? AND password=? AND is_active=1',
      [sap_id, dob]
    );
    if (!rows.length) return res.status(401).json({ error: 'Invalid SAP ID or date of birth.' });
    const user = rows[0];
    const token = jwt.sign({ sap_id: user.sap_id, role: 'student' }, process.env.JWT_SECRET, { expiresIn: '12h' });
    res.json({ token, user: { sap_id: user.sap_id, username: user.username, role: 'student', department: user.department, email: user.email } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const [rows] = await db.execute('SELECT * FROM Admin WHERE username=? AND password=?', [username, password]);
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials.' });
    const user = rows[0];
    const token = jwt.sign({ admin_id: user.admin_id, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '12h' });
    res.json({ token, user: { admin_id: user.admin_id, username: user.username, role: 'admin' } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ================================================================
// BOOK ROUTES
// ================================================================
app.get('/api/books', async (req, res) => {
  try {
    const { q = '', type = '' } = req.query;
    let sql = 'SELECT * FROM Book WHERE 1=1';
    const params = [];
    if (q)    { sql += ' AND (title LIKE ? OR author LIKE ? OR type LIKE ?)'; params.push(`%${q}%`,`%${q}%`,`%${q}%`); }
    if (type) { sql += ' AND type=?'; params.push(type); }
    sql += ' ORDER BY title';
    const [rows] = await db.execute(sql, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/books/:id', async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM Book WHERE book_id=?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Book not found.' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/books', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { title,author,type,isbn,publisher,published_year,total_copies } = req.body;
    const copies = parseInt(total_copies) || 1;
    const [r] = await db.execute(
      'INSERT INTO Book (title,author,type,isbn,publisher,published_year,total_copies,available_copies) VALUES (?,?,?,?,?,?,?,?)',
      [title,author,type||null,isbn||null,publisher||null,published_year||null,copies,copies]
    );
    res.json({ book_id: r.insertId, message: 'Book added.' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/books/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { title,author,type,isbn,publisher,published_year,total_copies,available_copies } = req.body;
    await db.execute(
      'UPDATE Book SET title=?,author=?,type=?,isbn=?,publisher=?,published_year=?,total_copies=?,available_copies=? WHERE book_id=?',
      [title,author,type,isbn,publisher,published_year,total_copies,available_copies,req.params.id]
    );
    res.json({ message: 'Book updated.' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/books/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    await db.execute('DELETE FROM Book WHERE book_id=?', [req.params.id]);
    res.json({ message: 'Book deleted.' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Book reviews for a book (public)
app.get('/api/books/:id/reviews', async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT br.*, s.username as student_name
       FROM Book_Review br JOIN Student s ON br.sap_id=s.sap_id
       WHERE br.book_id=? AND br.is_visible=1 ORDER BY br.created_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ================================================================
// STUDENT ROUTES
// ================================================================
app.get('/api/students', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { q='', status='' } = req.query;
    let sql = 'SELECT * FROM Student WHERE 1=1';
    const params = [];
    if (q)      { sql += ' AND (username LIKE ? OR sap_id LIKE ? OR email LIKE ?)'; params.push(`%${q}%`,`%${q}%`,`%${q}%`); }
    if (status) { sql += ' AND is_active=?'; params.push(status === 'active' ? 1 : 0); }
    const [rows] = await db.execute(sql, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/students/:sap', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin' && req.user.sap_id !== req.params.sap)
      return res.status(403).json({ error: 'Forbidden.' });
    const [rows] = await db.execute('SELECT * FROM Student WHERE sap_id=?', [req.params.sap]);
    if (!rows.length) return res.status(404).json({ error: 'Student not found.' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/students', authMiddleware, adminOnly, async (req, res) => {
  const conn = await db.getConnection();
  try {
    const { sap_id,username,dob,email,phone,department,year_of_study } = req.body;
    const dobStr = dob.split('T')[0];
    await conn.execute(
      'INSERT INTO Student (sap_id,username,password,dob,email,phone,department,year_of_study) VALUES (?,?,?,?,?,?,?,?)',
      [sap_id,username,dobStr,dobStr,email||null,phone||null,department||null,year_of_study||null]
    );

    // Send welcome email if student has an email address
    if (email) {
      const html = emailTemplate(
        '🎉 Welcome to LibraryOS!',
        `<p>Hello <strong>${username}</strong>, your library account has been created.</p>
         <div class="detail-row"><span class="label">SAP ID</span><span class="val">${sap_id}</span></div>
         <div class="detail-row"><span class="label">Department</span><span class="val">${department || '—'}</span></div>
         <div class="detail-row"><span class="label">Year of Study</span><span class="val">${year_of_study || '—'}</span></div>
         <div class="detail-row"><span class="label">Default Password</span><span class="val">${dobStr} (your date of birth)</span></div>
         <p style="margin-top:16px;">You can now log in and start borrowing books. Please change your password after your first login.</p>`,
        'Welcome to the university library system.'
      );
      await queueNotification(conn, sap_id, email, 'welcome', `🎉 Welcome to LibraryOS, ${username}!`, html);
    }

    res.json({ message: 'Student added.' });
  } catch(e) { res.status(500).json({ error: e.message }); }
  finally { conn.release(); }
});

app.put('/api/students/:sap', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { username,email,phone,department,year_of_study,profile_details } = req.body;
    await db.execute(
      'UPDATE Student SET username=?,email=?,phone=?,department=?,year_of_study=?,profile_details=? WHERE sap_id=?',
      [username,email,phone,department,year_of_study,profile_details,req.params.sap]
    );
    res.json({ message: 'Student updated.' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/students/:sap/toggle', authMiddleware, adminOnly, async (req, res) => {
  try {
    await db.execute('UPDATE Student SET is_active = NOT is_active WHERE sap_id=?', [req.params.sap]);
    res.json({ message: 'Status toggled.' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ================================================================
// ISSUE ROUTES
// ================================================================
app.get('/api/issues', authMiddleware, async (req, res) => {
  try {
    const { sap_id, status, book_id } = req.query;
    let sql = `SELECT bi.*, b.title as book_title, b.author,
                      s.username as student_name, s.email as student_email,
                      f.amount as fine_amount, f.paid_status as fine_paid_status,
                      DATEDIFF(CURDATE(), bi.due_date) as days_overdue
               FROM Book_Issue bi
               JOIN Book b ON bi.book_id=b.book_id
               JOIN Student s ON bi.sap_id=s.sap_id
               LEFT JOIN Fine f ON f.issue_id=bi.issue_id
               WHERE 1=1`;
    const params = [];
    if (sap_id)  { sql += ' AND bi.sap_id=?';   params.push(sap_id); }
    if (status)  { sql += ' AND bi.status=?';    params.push(status); }
    if (book_id) { sql += ' AND bi.book_id=?';   params.push(book_id); }
    if (req.user.role === 'student') { sql += ' AND bi.sap_id=?'; params.push(req.user.sap_id); }
    sql += ' ORDER BY bi.created_at DESC';
    const [rows] = await db.execute(sql, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/issues', authMiddleware, adminOnly, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { sap_id, book_id, due_days = 14 } = req.body;
    const [[book]] = await conn.execute('SELECT * FROM Book WHERE book_id=? FOR UPDATE', [book_id]);
    if (!book) throw new Error('Book not found.');
    if (book.available_copies < 1) throw new Error('No copies available.');

    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + parseInt(due_days));
    const dueDateStr = dueDate.toISOString().split('T')[0];

    const [r] = await conn.execute(
      'INSERT INTO Book_Issue (sap_id,book_id,issue_date,due_date,issued_by) VALUES (?,?,CURDATE(),?,?)',
      [sap_id, book_id, dueDateStr, req.user.admin_id]
    );
    await conn.execute('UPDATE Book SET available_copies=available_copies-1 WHERE book_id=?', [book_id]);

    // Cancel any active reservation for this student+book
    await conn.execute(
      `UPDATE Book_Reservation SET status='collected', collected_at=NOW()
       WHERE sap_id=? AND book_id=? AND status='active'`,
      [sap_id, book_id]
    );

    // Send issue notification
    const [[student]] = await conn.execute('SELECT username,email FROM Student WHERE sap_id=?', [sap_id]);
    if (student?.email) {
      const html = emailTemplate(
        `Book Issued: ${book.title}`,
        `<p>Hi <strong>${student.username}</strong>,</p>
         <p>Your book has been successfully issued. Please return it on time to avoid fines.</p>
         <div style="margin-top:16px">
           <div class="detail-row"><span class="label">Book</span><span class="val">${book.title}</span></div>
           <div class="detail-row"><span class="label">Author</span><span class="val">${book.author}</span></div>
           <div class="detail-row"><span class="label">Issue Date</span><span class="val">${new Date().toDateString()}</span></div>
           <div class="detail-row"><span class="label">Due Date</span><span class="val">${dueDate.toDateString()}</span></div>
           <div class="detail-row"><span class="label">Fine Rate</span><span class="val">₹${process.env.FINE_PER_DAY||2}/day after due date</span></div>
         </div>`,
        'Return on time to avoid late fines.'
      );
      await queueNotification(conn, sap_id, student.email, 'book_issued', `📚 Book Issued: ${book.title}`, html, r.insertId);
    }

    await conn.commit();
    res.json({ issue_id: r.insertId, message: 'Book issued successfully.' });
  } catch(e) {
    await conn.rollback();
    res.status(400).json({ error: e.message });
  } finally { conn.release(); }
});

app.post('/api/issues/:id/return', authMiddleware, adminOnly, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [[issue]] = await conn.execute(
      `SELECT bi.*, b.title as book_title, b.author, s.username as student_name, s.email
       FROM Book_Issue bi JOIN Book b ON bi.book_id=b.book_id JOIN Student s ON bi.sap_id=s.sap_id
       WHERE bi.issue_id=? FOR UPDATE`,
      [req.params.id]
    );
    if (!issue) throw new Error('Issue record not found.');
    if (issue.status === 'returned') throw new Error('Book already returned.');

    await conn.execute(
      'UPDATE Book_Issue SET status=?, return_date=CURDATE(), returned_to=? WHERE issue_id=?',
      ['returned', req.user.admin_id, req.params.id]
    );
    await conn.execute('UPDATE Book SET available_copies=available_copies+1 WHERE book_id=?', [issue.book_id]);

    // Calculate fine
    const daysOverdue = Math.max(0, Math.floor((Date.now() - new Date(issue.due_date)) / 86400000));
    const fineAmount  = daysOverdue * parseFloat(process.env.FINE_PER_DAY || 2);
    const [[existingFine]] = await conn.execute('SELECT fine_id FROM Fine WHERE issue_id=?', [req.params.id]);
    if (!existingFine) {
      await conn.execute('INSERT INTO Fine (issue_id,amount,paid_status) VALUES (?,?,?)', [req.params.id, fineAmount, fineAmount > 0 ? 'unpaid' : 'paid']);
    }

    // Notify student
    if (issue.email) {
      const html = emailTemplate(
        `Book Returned: ${issue.book_title}`,
        `<p>Hi <strong>${issue.student_name}</strong>,</p>
         <p>Your book return has been confirmed. Thank you!</p>
         <div style="margin-top:16px">
           <div class="detail-row"><span class="label">Book</span><span class="val">${issue.book_title}</span></div>
           <div class="detail-row"><span class="label">Returned On</span><span class="val">${new Date().toDateString()}</span></div>
           <div class="detail-row"><span class="label">Fine</span><span class="val">${fineAmount > 0 ? `₹${fineAmount} (unpaid)` : 'None'}</span></div>
         </div>`
      );
      await queueNotification(conn, issue.sap_id, issue.email, 'book_returned', `✅ Book Returned: ${issue.book_title}`, html, parseInt(req.params.id));
    }

    // Auto-reserve for next pending requester
    const [[nextReq]] = await conn.execute(
      `SELECT br.*, s.email, s.username FROM Book_Request br
       JOIN Student s ON br.sap_id=s.sap_id
       WHERE br.book_id=? AND br.status='pending'
       ORDER BY br.request_date ASC LIMIT 1`,
      [issue.book_id]
    );
    if (nextReq) {
      const expires = new Date(); expires.setHours(expires.getHours() + 24);
      await conn.execute(
        `INSERT INTO Book_Reservation (sap_id,book_id,request_id,expires_at,status,created_by)
         VALUES (?,?,?,?,?,?)`,
        [nextReq.sap_id, issue.book_id, nextReq.request_id, expires, 'active', req.user.admin_id]
      );
      await conn.execute('UPDATE Book SET available_copies=available_copies-1 WHERE book_id=?', [issue.book_id]);
      await conn.execute(`UPDATE Book_Request SET status='fulfilled' WHERE request_id=?`, [nextReq.request_id]);

      if (nextReq.email) {
        const [[book2]] = await conn.execute('SELECT title FROM Book WHERE book_id=?', [issue.book_id]);
        const html2 = emailTemplate(
          `📦 Your Reserved Book is Ready!`,
          `<p>Hi <strong>${nextReq.username}</strong>,</p>
           <p>Great news! The book you requested is now available and <strong>reserved for you for 24 hours</strong>. Please collect it from the library counter before it expires.</p>
           <div style="margin-top:16px">
             <div class="detail-row"><span class="label">Book</span><span class="val">${book2?.title}</span></div>
             <div class="detail-row"><span class="label">Reserved Until</span><span class="val">${expires.toLocaleString()}</span></div>
           </div>
           <p style="margin-top:16px;color:#ff5f6d;font-weight:600">⚠️ If not collected within 24 hours, your reservation will be automatically cancelled.</p>`,
          'Visit the library counter with your ID card.'
        );
        await queueNotification(conn, nextReq.sap_id, nextReq.email, 'reservation_created',
          `📦 Book Ready for Pickup: ${book2?.title}`, html2, nextReq.request_id);
      }
    }

    await conn.commit();
    res.json({ message: 'Book returned.', fine_amount: fineAmount });
  } catch(e) {
    await conn.rollback();
    res.status(400).json({ error: e.message });
  } finally { conn.release(); }
});

// ================================================================
// REQUEST ROUTES
// ================================================================
app.get('/api/requests', authMiddleware, async (req, res) => {
  try {
    const { status = '' } = req.query;
    let sql = `SELECT br.*, b.title as book_title, b.author, b.available_copies,
                      s.username as student_name
               FROM Book_Request br
               JOIN Book b ON br.book_id=b.book_id
               JOIN Student s ON br.sap_id=s.sap_id
               WHERE 1=1`;
    const params = [];
    if (req.user.role === 'student') { sql += ' AND br.sap_id=?'; params.push(req.user.sap_id); }
    if (status) { sql += ' AND br.status=?'; params.push(status); }
    sql += ' ORDER BY br.created_at DESC';
    const [rows] = await db.execute(sql, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/requests', authMiddleware, async (req, res) => {
  if (req.user.role !== 'student') return res.status(403).json({ error: 'Students only.' });
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { book_id } = req.body;
    const sap_id = req.user.sap_id;

    // Check duplicate
    const [[dup]] = await conn.execute(
      `SELECT request_id FROM Book_Request WHERE sap_id=? AND book_id=? AND status IN ('pending','approved')`,
      [sap_id, book_id]
    );
    if (dup) throw new Error('You already have a pending request for this book.');

    // Check active reservation
    const [[res2]] = await conn.execute(
      `SELECT reservation_id FROM Book_Reservation WHERE sap_id=? AND book_id=? AND status='active'`,
      [sap_id, book_id]
    );
    if (res2) throw new Error('You already have an active reservation for this book.');

    const [[book]] = await conn.execute('SELECT * FROM Book WHERE book_id=?', [book_id]);
    if (!book) throw new Error('Book not found.');

    const [r] = await conn.execute(
      'INSERT INTO Book_Request (sap_id,book_id,request_date) VALUES (?,?,CURDATE())',
      [sap_id, book_id]
    );

    // If copies are available — auto-approve and create reservation
    let autoReserved = false;
    if (book.available_copies > 0) {
      const expires = new Date(); expires.setHours(expires.getHours() + 24);
      await conn.execute(
        `INSERT INTO Book_Reservation (sap_id,book_id,request_id,expires_at,status)
         VALUES (?,?,?,?,?)`,
        [sap_id, book_id, r.insertId, expires, 'active']
      );
      await conn.execute('UPDATE Book SET available_copies=available_copies-1 WHERE book_id=?', [book_id]);
      await conn.execute(`UPDATE Book_Request SET status='fulfilled' WHERE request_id=?`, [r.insertId]);
      autoReserved = true;

      // Notify
      const [[student]] = await conn.execute('SELECT username,email FROM Student WHERE sap_id=?', [sap_id]);
      if (student?.email) {
        const html = emailTemplate(
          `📦 Book Reserved: ${book.title}`,
          `<p>Hi <strong>${student.username}</strong>,</p>
           <p>Your requested book is available and has been <strong>reserved for 24 hours</strong>. Visit the library counter to collect it.</p>
           <div style="margin-top:16px">
             <div class="detail-row"><span class="label">Book</span><span class="val">${book.title}</span></div>
             <div class="detail-row"><span class="label">Expires</span><span class="val">${expires.toLocaleString()}</span></div>
           </div>
           <p style="margin-top:16px;color:#ff5f6d;font-weight:600">⚠️ Reservation expires in 24 hours.</p>`
        );
        await queueNotification(conn, sap_id, student.email, 'reservation_created',
          `📦 Book Reserved: ${book.title}`, html, r.insertId);
      }
    }

    await conn.commit();
    res.json({ request_id: r.insertId, auto_reserved: autoReserved, message: autoReserved ? 'Book reserved! Collect within 24 hours.' : 'Request placed. You will be notified when available.' });
  } catch(e) {
    await conn.rollback();
    res.status(400).json({ error: e.message });
  } finally { conn.release(); }
});

app.patch('/api/requests/:id/resolve', authMiddleware, adminOnly, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { action, admin_remark = '' } = req.body;
    const newStatus = action === 'approve' ? 'approved' : 'rejected';

    const [[req2]] = await conn.execute(
      `SELECT br.*, b.title as book_title, b.available_copies, s.email, s.username
       FROM Book_Request br JOIN Book b ON br.book_id=b.book_id JOIN Student s ON br.sap_id=s.sap_id
       WHERE br.request_id=?`,
      [req.params.id]
    );
    if (!req2) throw new Error('Request not found.');

    await conn.execute(
      `UPDATE Book_Request SET status=?,admin_remark=?,resolved_by=?,resolved_at=NOW() WHERE request_id=?`,
      [newStatus, admin_remark, req.user.admin_id, req.params.id]
    );

    // If approved and book available — create reservation
    if (action === 'approve' && req2.available_copies > 0) {
      const expires = new Date(); expires.setHours(expires.getHours() + 24);
      await conn.execute(
        `INSERT INTO Book_Reservation (sap_id,book_id,request_id,expires_at,status,created_by) VALUES (?,?,?,?,?,?)`,
        [req2.sap_id, req2.book_id, req.params.id, expires, 'active', req.user.admin_id]
      );
      await conn.execute('UPDATE Book SET available_copies=available_copies-1 WHERE book_id=?', [req2.book_id]);
      await conn.execute(`UPDATE Book_Request SET status='fulfilled' WHERE request_id=?`, [req.params.id]);

      if (req2.email) {
        const html = emailTemplate(
          `✅ Request Approved: ${req2.book_title}`,
          `<p>Hi <strong>${req2.username}</strong>,</p>
           <p>Your book request has been approved and a copy is <strong>reserved for 24 hours</strong>.</p>
           <div style="margin-top:16px">
             <div class="detail-row"><span class="label">Book</span><span class="val">${req2.book_title}</span></div>
             <div class="detail-row"><span class="label">Note</span><span class="val">${admin_remark||'—'}</span></div>
             <div class="detail-row"><span class="label">Expires</span><span class="val">${expires.toLocaleString()}</span></div>
           </div>`
        );
        await queueNotification(conn, req2.sap_id, req2.email, 'request_approved',
          `✅ Book Request Approved: ${req2.book_title}`, html, parseInt(req.params.id));
      }
    } else if (action === 'reject' && req2.email) {
      const html = emailTemplate(
        `❌ Request Rejected: ${req2.book_title}`,
        `<p>Hi <strong>${req2.username}</strong>,</p>
         <p>Unfortunately your book request could not be fulfilled at this time.</p>
         <div style="margin-top:16px">
           <div class="detail-row"><span class="label">Book</span><span class="val">${req2.book_title}</span></div>
           <div class="detail-row"><span class="label">Reason</span><span class="val">${admin_remark||'Not specified'}</span></div>
         </div>`
      );
      await queueNotification(conn, req2.sap_id, req2.email, 'request_rejected',
        `❌ Book Request Rejected: ${req2.book_title}`, html, parseInt(req.params.id));
    }

    await conn.commit();
    res.json({ message: `Request ${newStatus}.` });
  } catch(e) {
    await conn.rollback();
    res.status(400).json({ error: e.message });
  } finally { conn.release(); }
});

// ================================================================
// RESERVATION ROUTES  (NEW)
// ================================================================
app.get('/api/reservations', authMiddleware, async (req, res) => {
  try {
    let sql = `SELECT rv.*, b.title as book_title, b.author, s.username as student_name, s.email
               FROM Book_Reservation rv
               JOIN Book b ON rv.book_id=b.book_id
               JOIN Student s ON rv.sap_id=s.sap_id
               WHERE 1=1`;
    const params = [];
    if (req.user.role === 'student') { sql += ' AND rv.sap_id=?'; params.push(req.user.sap_id); }
    if (req.query.status) { sql += ' AND rv.status=?'; params.push(req.query.status); }
    sql += ' ORDER BY rv.reserved_at DESC';
    const [rows] = await db.execute(sql, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Admin: expire overdue reservations
app.post('/api/admin/expire-reservations', authMiddleware, adminOnly, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [expired] = await conn.execute(
      `SELECT rv.*, b.title as book_title, s.email, s.username
       FROM Book_Reservation rv JOIN Book b ON rv.book_id=b.book_id JOIN Student s ON rv.sap_id=s.sap_id
       WHERE rv.status='active' AND rv.expires_at < NOW()`
    );
    for (const rv of expired) {
      await conn.execute(`UPDATE Book_Reservation SET status='expired' WHERE reservation_id=?`, [rv.reservation_id]);
      await conn.execute('UPDATE Book SET available_copies=available_copies+1 WHERE book_id=?', [rv.book_id]);
      if (rv.email) {
        const html = emailTemplate(
          `⏰ Reservation Expired: ${rv.book_title}`,
          `<p>Hi <strong>${rv.username}</strong>,</p>
           <p>Your reservation for <strong>${rv.book_title}</strong> has expired as it was not collected within 24 hours. The book is now available for others.</p>`
        );
        await queueNotification(conn, rv.sap_id, rv.email, 'reservation_expired',
          `⏰ Reservation Expired: ${rv.book_title}`, html, rv.reservation_id);
      }
    }
    await conn.commit();
    res.json({ message: `${expired.length} reservation(s) expired.`, count: expired.length });
  } catch(e) {
    await conn.rollback();
    res.status(500).json({ error: e.message });
  } finally { conn.release(); }
});

// ================================================================
// REVIEW ROUTES  (NEW)
// ================================================================
app.get('/api/reviews', authMiddleware, async (req, res) => {
  try {
    const sap_id = req.user.role === 'student' ? req.user.sap_id : (req.query.sap_id || null);
    let sql = `SELECT br.*, b.title as book_title, b.author, s.username as student_name
               FROM Book_Review br JOIN Book b ON br.book_id=b.book_id JOIN Student s ON br.sap_id=s.sap_id
               WHERE br.is_visible=1`;
    const params = [];
    if (sap_id) { sql += ' AND br.sap_id=?'; params.push(sap_id); }
    sql += ' ORDER BY br.created_at DESC';
    const [rows] = await db.execute(sql, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/reviews', authMiddleware, async (req, res) => {
  if (req.user.role !== 'student') return res.status(403).json({ error: 'Students only.' });
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { book_id, rating, review_text } = req.body;
    const sap_id = req.user.sap_id;

    if (rating < 1 || rating > 5) throw new Error('Rating must be 1–5.');

    // Check if student has ever borrowed this book
    const [[borrowed]] = await conn.execute(
      `SELECT issue_id FROM Book_Issue WHERE sap_id=? AND book_id=? LIMIT 1`,
      [sap_id, book_id]
    );
    if (!borrowed) throw new Error('You can only review books you have borrowed.');

    await conn.execute(
      `INSERT INTO Book_Review (sap_id,book_id,rating,review_text)
       VALUES (?,?,?,?)
       ON DUPLICATE KEY UPDATE rating=VALUES(rating), review_text=VALUES(review_text), updated_at=NOW()`,
      [sap_id, book_id, rating, review_text || '']
    );

    // Recalculate avg rating
    await conn.execute(
      `UPDATE Book SET
         avg_rating=(SELECT ROUND(AVG(rating),2) FROM Book_Review WHERE book_id=? AND is_visible=1),
         rating_count=(SELECT COUNT(*) FROM Book_Review WHERE book_id=? AND is_visible=1)
       WHERE book_id=?`,
      [book_id, book_id, book_id]
    );

    await conn.commit();
    res.json({ message: 'Review submitted.' });
  } catch(e) {
    await conn.rollback();
    res.status(400).json({ error: e.message });
  } finally { conn.release(); }
});

app.delete('/api/reviews/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    await db.execute('UPDATE Book_Review SET is_visible=0 WHERE review_id=?', [req.params.id]);
    res.json({ message: 'Review hidden.' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ================================================================
// FINE ROUTES
// ================================================================
app.get('/api/fines', authMiddleware, async (req, res) => {
  try {
    const { status = '' } = req.query;
    let sql = `SELECT f.*, bi.sap_id, bi.book_id, bi.due_date, bi.return_date,
                      b.title as book_title, s.username as student_name
               FROM Fine f
               JOIN Book_Issue bi ON f.issue_id=bi.issue_id
               JOIN Book b ON bi.book_id=b.book_id
               JOIN Student s ON bi.sap_id=s.sap_id
               WHERE 1=1`;
    const params = [];
    if (req.user.role === 'student') { sql += ' AND bi.sap_id=?'; params.push(req.user.sap_id); }
    if (status) { sql += ' AND f.paid_status=?'; params.push(status); }
    sql += ' ORDER BY f.created_at DESC';
    const [rows] = await db.execute(sql, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/fines/summary/:sap', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin' && req.user.sap_id !== req.params.sap)
      return res.status(403).json({ error: 'Forbidden.' });
    const [[row]] = await db.execute(
      `SELECT COALESCE(SUM(CASE WHEN f.paid_status='unpaid' THEN f.amount ELSE 0 END),0) as unpaid_amount,
              COUNT(CASE WHEN f.paid_status='unpaid' THEN 1 END) as unpaid_count
       FROM Fine f JOIN Book_Issue bi ON f.issue_id=bi.issue_id WHERE bi.sap_id=?`,
      [req.params.sap]
    );
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/fines/:id', authMiddleware, adminOnly, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { paid_status, amount } = req.body;
    const [[fine]] = await conn.execute(
      `SELECT f.*, bi.sap_id, b.title, s.email, s.username
       FROM Fine f JOIN Book_Issue bi ON f.issue_id=bi.issue_id
       JOIN Book b ON bi.book_id=b.book_id JOIN Student s ON bi.sap_id=s.sap_id
       WHERE f.fine_id=?`,
      [req.params.id]
    );
    if (!fine) throw new Error('Fine not found.');

    const sets = []; const vals = [];
    if (paid_status) { sets.push('paid_status=?'); vals.push(paid_status); }
    if (amount !== undefined) { sets.push('amount=?'); vals.push(amount); }
    if (paid_status === 'paid' || paid_status === 'waived') { sets.push('paid_at=NOW()'); }
    sets.push('updated_by=?'); vals.push(req.user.admin_id);
    vals.push(req.params.id);
    await conn.execute(`UPDATE Fine SET ${sets.join(',')} WHERE fine_id=?`, vals);

    if ((paid_status === 'paid' || paid_status === 'waived') && fine.email) {
      const html = emailTemplate(
        `💰 Fine ${paid_status === 'paid' ? 'Paid' : 'Waived'}: ${fine.title}`,
        `<p>Hi <strong>${fine.username}</strong>,</p>
         <p>Your library fine has been marked as <strong>${paid_status}</strong>.</p>
         <div style="margin-top:16px">
           <div class="detail-row"><span class="label">Book</span><span class="val">${fine.title}</span></div>
           <div class="detail-row"><span class="label">Amount</span><span class="val">₹${fine.amount}</span></div>
           <div class="detail-row"><span class="label">Status</span><span class="val">${paid_status}</span></div>
         </div>`
      );
      await queueNotification(conn, fine.sap_id, fine.email, 'fine_paid',
        `💰 Fine ${paid_status}: ${fine.title}`, html, parseInt(req.params.id));
    }

    await conn.commit();
    res.json({ message: 'Fine updated.' });
  } catch(e) {
    await conn.rollback();
    res.status(400).json({ error: e.message });
  } finally { conn.release(); }
});

// ================================================================
// STATS ROUTE
// ================================================================
app.get('/api/stats', authMiddleware, adminOnly, async (req, res) => {
  try {
    const [[books]]    = await db.execute('SELECT COUNT(*) as total, SUM(available_copies) as available FROM Book');
    const [[students]] = await db.execute('SELECT COUNT(*) as total, SUM(is_active) as active FROM Student');
    const [[issues]]   = await db.execute(`SELECT COUNT(*) as total, SUM(status='issued') as issued, SUM(status='overdue') as overdue FROM Book_Issue`);
    const [[fines]]    = await db.execute(`SELECT COALESCE(SUM(CASE WHEN paid_status='unpaid' THEN amount END),0) as unpaid FROM Fine`);
    const [[pending]]  = await db.execute(`SELECT COUNT(*) as cnt FROM Book_Request WHERE status='pending'`);
    const [[active_res]] = await db.execute(`SELECT COUNT(*) as cnt FROM Book_Reservation WHERE status='active'`);
    res.json({ books, students, issues, fines, pending_requests: pending.cnt, active_reservations: active_res.cnt });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/mark-overdue', authMiddleware, adminOnly, async (req, res) => {
  try {
    const [r] = await db.execute(
      `UPDATE Book_Issue SET status='overdue' WHERE status='issued' AND due_date < CURDATE()`
    );
    // Create fines for newly overdue
    await db.execute(
      `INSERT IGNORE INTO Fine (issue_id, amount, paid_status)
       SELECT bi.issue_id, DATEDIFF(CURDATE(), bi.due_date) * ${process.env.FINE_PER_DAY||2}, 'unpaid'
       FROM Book_Issue bi LEFT JOIN Fine f ON f.issue_id=bi.issue_id
       WHERE bi.status='overdue' AND f.fine_id IS NULL`
    );
    res.json({ message: `${r.affectedRows} record(s) marked overdue.` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ================================================================
// CHATBOT ROUTE  (NEW)
// ================================================================
app.post('/api/chatbot', authMiddleware, async (req, res) => {
  try {
    const { message, session_id } = req.body;
    const sap_id = req.user.role === 'student' ? req.user.sap_id : null;
    const msg = (message || '').toLowerCase().trim();

    let response = '';
    let intent   = 'general';
    let data     = null;

    // ── Intent detection ──────────────────────────────────────
    if (/search|find|book named|looking for|do you have/.test(msg)) {
      intent = 'book_search';
      // Extract search term
      const term = msg.replace(/search|find|book named|looking for|do you have/g,'').replace(/[?!.]/g,'').trim();
      if (term.length > 1) {
        const [books] = await db.execute(
          `SELECT book_id,title,author,type,available_copies,avg_rating,rating_count FROM Book
           WHERE title LIKE ? OR author LIKE ? OR type LIKE ? LIMIT 5`,
          [`%${term}%`,`%${term}%`,`%${term}%`]
        );
        if (books.length) {
          response = `📚 Found ${books.length} result(s) for "<strong>${term}</strong>":`;
          data = { type: 'books', books };
        } else {
          response = `😕 No books found matching "<strong>${term}</strong>". Try a different keyword.`;
        }
      } else {
        response = 'Please tell me what book you are looking for!';
      }
    }
    else if (/my issue|issued books|borrowed|currently have/.test(msg)) {
      intent = 'my_issues';
      if (sap_id) {
        const [issues] = await db.execute(
          `SELECT bi.issue_id, b.title, bi.due_date, bi.status FROM Book_Issue bi
           JOIN Book b ON bi.book_id=b.book_id WHERE bi.sap_id=? AND bi.status != 'returned' LIMIT 5`,
          [sap_id]
        );
        if (issues.length) {
          response = `📖 You have <strong>${issues.length}</strong> active book(s):`;
          data = { type: 'issues', issues };
        } else {
          response = "You don't have any books currently issued. Browse the catalog to find one!";
        }
      } else {
        response = 'Please log in as a student to see your issued books.';
      }
    }
    else if (/fine|penalty|overdue|late fee/.test(msg)) {
      intent = 'fines';
      if (sap_id) {
        const [[fs]] = await db.execute(
          `SELECT COALESCE(SUM(CASE WHEN f.paid_status='unpaid' THEN f.amount ELSE 0 END),0) as unpaid
           FROM Fine f JOIN Book_Issue bi ON f.issue_id=bi.issue_id WHERE bi.sap_id=?`,
          [sap_id]
        );
        const amt = parseFloat(fs.unpaid);
        response = amt > 0
          ? `💰 You have an outstanding fine of <strong>₹${amt.toFixed(2)}</strong>. Please contact the librarian to pay.`
          : '✅ You have no outstanding fines. Keep returning books on time!';
      } else {
        response = 'The fine rate is ₹2 per day for overdue books. Return books before the due date to avoid fines.';
      }
    }
    else if (/recommend|suggest|what should i read|popular|top books|best/.test(msg)) {
      intent = 'recommend';
      const [books] = await db.execute(
        `SELECT book_id,title,author,type,avg_rating,rating_count FROM Book
         WHERE rating_count > 0 ORDER BY avg_rating DESC, rating_count DESC LIMIT 5`
      );
      if (books.length) {
        response = '⭐ Here are our top-rated books:';
        data = { type: 'books', books };
      } else {
        const [books2] = await db.execute(
          `SELECT book_id,title,author,type,available_copies FROM Book WHERE available_copies > 0 LIMIT 5`
        );
        response = '📚 Here are some available books you might enjoy:';
        data = { type: 'books', books: books2 };
      }
    }
    else if (/available|in stock|copies/.test(msg)) {
      intent = 'availability';
      const term = msg.replace(/available|in stock|copies|how many|is|are|there/g,'').replace(/[?!.]/g,'').trim();
      if (term.length > 1) {
        const [[book]] = await db.execute(
          `SELECT title,available_copies,total_copies FROM Book WHERE title LIKE ? OR author LIKE ? LIMIT 1`,
          [`%${term}%`,`%${term}%`]
        );
        if (book) {
          response = book.available_copies > 0
            ? `✅ <strong>${book.title}</strong> has <strong>${book.available_copies}</strong> of ${book.total_copies} copies available.`
            : `❌ <strong>${book.title}</strong> is currently unavailable (0/${book.total_copies}). You can place a request.`;
        } else {
          response = `Couldn't find a book matching "${term}".`;
        }
      } else {
        const [[stats]] = await db.execute('SELECT COUNT(*) as total, SUM(available_copies) as avail FROM Book');
        response = `📊 The library has <strong>${stats.total}</strong> titles with <strong>${stats.avail}</strong> copies currently available.`;
      }
    }
    else if (/due date|when|return|deadline/.test(msg)) {
      intent = 'due_date';
      if (sap_id) {
        const [issues] = await db.execute(
          `SELECT b.title, bi.due_date, bi.status, DATEDIFF(bi.due_date, CURDATE()) as days_left
           FROM Book_Issue bi JOIN Book b ON bi.book_id=b.book_id
           WHERE bi.sap_id=? AND bi.status != 'returned' ORDER BY bi.due_date ASC`,
          [sap_id]
        );
        if (issues.length) {
          const nearest = issues[0];
          const daysLeft = nearest.days_left;
          if (daysLeft < 0) {
            response = `⚠️ Your book "<strong>${nearest.title}</strong>" is <strong>${Math.abs(daysLeft)} day(s) overdue</strong>! Please return it immediately to avoid further fines.`;
          } else if (daysLeft === 0) {
            response = `🔔 "<strong>${nearest.title}</strong>" is due <strong>today</strong>! Please return it.`;
          } else {
            response = `📅 Your nearest due date is "<strong>${nearest.title}</strong>" — due in <strong>${daysLeft} day(s)</strong>.`;
          }
          data = { type: 'issues', issues };
        } else {
          response = "You don't have any active issues to worry about!";
        }
      } else {
        response = 'Standard loan period is 14 days. Log in to check your personal due dates.';
      }
    }
    else if (/hello|hi|hey|help/.test(msg)) {
      intent = 'greeting';
      response = `👋 Hello! I'm the LibraryOS assistant. I can help you with:<br>
        • 🔍 <strong>Search books</strong> — "find Python books"<br>
        • 📖 <strong>Your issues</strong> — "what books do I have?"<br>
        • 📅 <strong>Due dates</strong> — "when is my book due?"<br>
        • 💰 <strong>Fines</strong> — "do I have any fines?"<br>
        • ⭐ <strong>Recommendations</strong> — "suggest a book"<br>
        • 📊 <strong>Availability</strong> — "is Clean Code available?"`;
    }
    else if (/hours|open|timing|contact|library/.test(msg)) {
      intent = 'info';
      response = `ℹ️ <strong>Library Information</strong><br>
        🕐 Hours: Mon–Fri 8 AM – 8 PM, Sat 9 AM – 5 PM<br>
        📍 Location: Main Building, Ground Floor<br>
        📞 Phone: +91-1234567890<br>
        ✉️ Email: library@university.edu`;
    }
    else {
      intent = 'unknown';
      response = `🤔 I'm not sure I understood that. Try asking me to:
        <br>• Search for a book: <em>"find algorithms book"</em>
        <br>• Check availability: <em>"is Clean Code available?"</em>
        <br>• Get recommendations: <em>"suggest a good book"</em>
        <br>• Check your dues: <em>"when is my book due?"</em>`;
    }

    // Log the conversation
    await db.execute(
      `INSERT INTO Chatbot_Log (sap_id,session_id,user_message,bot_response,intent) VALUES (?,?,?,?,?)`,
      [sap_id, session_id || 'anon', message, response, intent]
    );

    res.json({ response, intent, data });
  } catch(e) { res.status(500).json({ error: e.message, response: 'Sorry, something went wrong. Please try again.' }); }
});

// ================================================================
// NOTIFICATION ROUTES
// ================================================================
app.get('/api/notifications', authMiddleware, async (req, res) => {
  try {
    const sap_id = req.user.role === 'student' ? req.user.sap_id : req.query.sap_id;
    let sql = 'SELECT notif_id,type,subject,status,send_at,sent_at FROM Notification WHERE 1=1';
    const params = [];
    if (sap_id) { sql += ' AND sap_id=?'; params.push(sap_id); }
    sql += ' ORDER BY created_at DESC LIMIT 50';
    const [rows] = await db.execute(sql, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Due date reminder — call via cron
app.post('/api/admin/send-reminders', authMiddleware, adminOnly, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [issues] = await conn.execute(
      `SELECT bi.*, b.title, s.email, s.username, s.sap_id,
              DATEDIFF(bi.due_date, CURDATE()) as days_left
       FROM Book_Issue bi
       JOIN Book b ON bi.book_id=b.book_id
       JOIN Student s ON bi.sap_id=s.sap_id
       LEFT JOIN Notification n ON n.reference_id=bi.issue_id AND n.type='due_reminder'
       WHERE bi.status='issued'
         AND DATEDIFF(bi.due_date, CURDATE()) IN (3,1)
         AND n.notif_id IS NULL`
    );
    let sent = 0;
    for (const issue of issues) {
      if (!issue.email) continue;
      const html = emailTemplate(
        `⏰ Due Date Reminder: ${issue.title}`,
        `<p>Hi <strong>${issue.username}</strong>,</p>
         <p>This is a friendly reminder that your borrowed book is due <strong>${issue.days_left === 1 ? 'tomorrow' : `in ${issue.days_left} days`}</strong>.</p>
         <div style="margin-top:16px">
           <div class="detail-row"><span class="label">Book</span><span class="val">${issue.title}</span></div>
           <div class="detail-row"><span class="label">Due Date</span><span class="val">${new Date(issue.due_date).toDateString()}</span></div>
           <div class="detail-row"><span class="label">Days Left</span><span class="val">${issue.days_left} day(s)</span></div>
         </div>`,
        'Return on time to avoid late fines (₹2/day).'
      );
      await queueNotification(conn, issue.sap_id, issue.email, 'due_reminder',
        `⏰ Return Reminder: ${issue.title} due in ${issue.days_left} day(s)`, html, issue.issue_id);
      sent++;
    }
    await conn.commit();
    res.json({ message: `${sent} reminder(s) sent.` });
  } catch(e) {
    await conn.rollback();
    res.status(500).json({ error: e.message });
  } finally { conn.release(); }
});

// ================================================================
// RECOMMENDATION ROUTE  (NEW)
// ================================================================
app.get('/api/recommendations', authMiddleware, async (req, res) => {
  try {
    const sap_id = req.user.role === 'student' ? req.user.sap_id : req.query.sap_id;
    let recs = [];

    if (sap_id) {
      // Get student's reading history genres
      const [history] = await db.execute(
        `SELECT b.type, COUNT(*) as cnt FROM Book_Issue bi
         JOIN Book b ON bi.book_id=b.book_id WHERE bi.sap_id=?
         GROUP BY b.type ORDER BY cnt DESC LIMIT 3`,
        [sap_id]
      );
      const types = history.map(h => h.type);
      const issuedIds = (await db.execute(
        `SELECT book_id FROM Book_Issue WHERE sap_id=?`, [sap_id]
      ))[0].map(r => r.book_id);

      if (types.length > 0) {
        // Books in preferred genres not yet read
        const placeholders = types.map(() => '?').join(',');
        const excludeIds   = issuedIds.length ? issuedIds.join(',') : '0';
        const [preferred] = await db.execute(
          `SELECT book_id,title,author,type,available_copies,avg_rating,rating_count
           FROM Book WHERE type IN (${placeholders})
             AND book_id NOT IN (${excludeIds})
             AND available_copies > 0
           ORDER BY avg_rating DESC, available_copies DESC LIMIT 4`,
          types
        );
        recs = preferred;
      }
    }

    // Fallback: top-rated available books
    if (recs.length < 4) {
      const [topRated] = await db.execute(
        `SELECT book_id,title,author,type,available_copies,avg_rating,rating_count
         FROM Book WHERE available_copies > 0 ORDER BY avg_rating DESC, rating_count DESC LIMIT 6`
      );
      const existIds = new Set(recs.map(r => r.book_id));
      recs = [...recs, ...topRated.filter(b => !existIds.has(b.book_id))].slice(0, 6);
    }

    res.json(recs);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ================================================================
// AI RECOMMENDATIONS ENDPOINT
// ================================================================
app.post('/api/ai-recommendations', authMiddleware, async (req, res) => {
  try {
    const sap_id = req.user.role === 'student' ? req.user.sap_id : null;
    const { preferences } = req.body; // { mood, genres, avoid, freeText }

    // ── 1. Gather ALL student context from DB in parallel ──────
    let studentProfile = null, historyBooks = [], requestedBooks = [],
        overdueCount = 0, allBooks = [];

    if (sap_id) {
      const [
        [profileRows],
        [issued],
        [requested],
        [overdueRows]
      ] = await Promise.all([
        // Student profile: name, department, year
        db.execute(
          `SELECT username, department, year_of_study FROM Student WHERE sap_id = ?`,
          [sap_id]
        ),
        // Full issue history with ratings + reviews
        db.execute(
          `SELECT b.title, b.author, b.type, b.published_year,
                  bi.issue_date, bi.return_date, bi.status,
                  br.rating, br.review_text
           FROM Book_Issue bi
           JOIN Book b ON bi.book_id = b.book_id
           LEFT JOIN Book_Review br ON br.book_id = b.book_id AND br.sap_id = bi.sap_id
           WHERE bi.sap_id = ?
           ORDER BY bi.issue_date DESC LIMIT 30`,
          [sap_id]
        ),
        // Books the student has explicitly requested (signals strong interest)
        db.execute(
          `SELECT b.title, b.author, b.type, br.status, br.request_date
           FROM Book_Request br
           JOIN Book b ON br.book_id = b.book_id
           WHERE br.sap_id = ?
           ORDER BY br.request_date DESC LIMIT 10`,
          [sap_id]
        ),
        // Count overdue books — signals reading behaviour
        db.execute(
          `SELECT COUNT(*) as cnt FROM Book_Issue
           WHERE sap_id = ? AND status = 'overdue'`,
          [sap_id]
        )
      ]);

      studentProfile = profileRows[0] || null;
      historyBooks   = issued;
      requestedBooks = requested;
      overdueCount   = overdueRows[0]?.cnt || 0;
    }

    // ── 2. Fetch all available books with full metadata ────────
    const [books] = await db.execute(
      `SELECT book_id, title, author, type, publisher,
              published_year, available_copies, avg_rating, rating_count
       FROM Book WHERE available_copies > 0
       ORDER BY avg_rating DESC, rating_count DESC`
    );
    allBooks = books;

    if (!allBooks.length) {
      return res.json({ recommendations: [], summary: 'No books currently available in the library.' });
    }

    // -- 3. Smart scoring algorithm (no API key needed) -------
    const alreadyReadTitles = new Set(historyBooks.map(b => b.title));
    const ratedHighly  = historyBooks.filter(b => b.rating >= 4).map(b => b.type);
    const ratedPoorly  = historyBooks.filter(b => b.rating && b.rating <= 2).map(b => b.type);
    const requestedTypes = requestedBooks.map(b => b.type);

    // Preferred genres from history + requests + preferences
    const preferredGenres = new Set([
      ...ratedHighly,
      ...requestedTypes,
      ...(preferences?.genres || [])
    ]);
    const avoidGenres = new Set([
      ...ratedPoorly,
      ...(preferences?.avoid ? [preferences.avoid] : [])
    ]);

    // Score each book
    const scored = allBooks
      .filter(b => !alreadyReadTitles.has(b.title)) // exclude already read
      .map(b => {
        let score = 0;
        let reasons = [];

        // Base score: rating
        const rating = parseFloat(b.avg_rating) || 0;
        score += rating * 10;
        if (rating >= 4) reasons.push(`Highly rated (${rating.toFixed(1)}/5)`);

        // Preferred genre bonus
        if (preferredGenres.has(b.type)) {
          score += 30;
          reasons.push(`Matches your preferred genre (${b.type})`);
        }

        // Avoid genre penalty
        if (avoidGenres.has(b.type)) score -= 40;

        // Department match bonus
        if (studentProfile?.department) {
          const dept = studentProfile.department.toLowerCase();
          const title = b.title.toLowerCase();
          const type  = b.type.toLowerCase();
          if (title.includes(dept) || type.includes(dept)) {
            score += 20;
            reasons.push(`Relevant to your department (${studentProfile.department})`);
          }
        }

        // Mood bonus
        const mood = (preferences?.mood || '').toLowerCase();
        if (mood && b.type.toLowerCase().includes(mood)) {
          score += 15;
          reasons.push(`Matches your current mood (${preferences.mood})`);
        }

        // Free text keyword match
        const freeText = (preferences?.freeText || '').toLowerCase();
        if (freeText && (b.title.toLowerCase().includes(freeText) || b.author.toLowerCase().includes(freeText) || b.type.toLowerCase().includes(freeText))) {
          score += 25;
          reasons.push(`Matches your request "${preferences.freeText}"`);
        }

        // Popularity bonus (rating count)
        if (b.rating_count > 10) { score += 5; }

        const reason = reasons.length
          ? reasons.join('. ') + '.'
          : `Well-rated ${b.type} book available in the library.`;

        return { ...b, score, ai_reason: reason };
      })
      .filter(b => !avoidGenres.has(b.type))
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);

    // Build summary
    const topGenres = [...preferredGenres].slice(0, 3).join(', ') || 'general interest';
    const summary = scored.length
      ? `Recommended based on your reading history and preferences, focusing on ${topGenres} books with high ratings.`
      : 'Here are the top-rated available books in the library.';

    // Fallback: if no scored results, just return top rated
    const finalRecs = scored.length ? scored : allBooks.slice(0, 6).map(b => ({
      ...b, ai_reason: `Top-rated ${b.type} book in the library.`
    }));

    res.json({ recommendations: finalRecs, summary });

  } catch(e) {
    console.error('[AI Recommendations]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ================================================================
app.listen(PORT, () => console.log(`✅  LibraryOS running at http://localhost:${PORT}`));