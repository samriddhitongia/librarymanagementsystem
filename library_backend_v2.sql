-- ================================================================
--   LIBRARY MANAGEMENT SYSTEM — COMPLETE SQL BACKEND v2
--   Adds: Book Reservations (24h lock), Ratings/Reviews,
--         Chatbot Logs, Notification Queue
-- ================================================================

CREATE DATABASE IF NOT EXISTS LibraryDB;
USE LibraryDB;

-- ================================================================
-- 1. ADMIN TABLE
-- ================================================================
CREATE TABLE IF NOT EXISTS Admin (
    admin_id   INT          AUTO_INCREMENT PRIMARY KEY,
    username   VARCHAR(50)  NOT NULL UNIQUE,
    password   VARCHAR(255) NOT NULL,
    created_at TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

-- ================================================================
-- 2. STUDENT TABLE
-- ================================================================
CREATE TABLE IF NOT EXISTS Student (
    sap_id          VARCHAR(20)  PRIMARY KEY,
    username        VARCHAR(100) NOT NULL UNIQUE,
    password        VARCHAR(255) NOT NULL,
    profile_details TEXT,
    dob             DATE         NOT NULL,
    email           VARCHAR(100),
    phone           VARCHAR(15),
    department      VARCHAR(100),
    year_of_study   TINYINT,
    is_active       BOOLEAN      DEFAULT TRUE,
    created_at      TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

-- ================================================================
-- 3. BOOK TABLE
-- ================================================================
CREATE TABLE IF NOT EXISTS Book (
    book_id          INT          AUTO_INCREMENT PRIMARY KEY,
    title            VARCHAR(255) NOT NULL,
    author           VARCHAR(255) NOT NULL,
    type             VARCHAR(50),
    isbn             VARCHAR(20)  UNIQUE,
    publisher        VARCHAR(100),
    published_year   YEAR,
    total_copies     INT          NOT NULL DEFAULT 1,
    available_copies INT          NOT NULL DEFAULT 1,
    avg_rating       DECIMAL(3,2) DEFAULT 0.00,
    rating_count     INT          DEFAULT 0,
    created_at       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_copies CHECK (available_copies >= 0 AND available_copies <= total_copies)
);

-- ================================================================
-- 4. BOOK ISSUE TABLE
-- ================================================================
CREATE TABLE IF NOT EXISTS Book_Issue (
    issue_id      INT         AUTO_INCREMENT PRIMARY KEY,
    sap_id        VARCHAR(20) NOT NULL,
    book_id       INT         NOT NULL,
    issue_date    DATE        NOT NULL DEFAULT (CURRENT_DATE),
    due_date      DATE        NOT NULL,
    return_date   DATE,
    status        ENUM('issued','returned','overdue') DEFAULT 'issued',
    issued_by     INT,
    returned_to   INT,
    created_at    TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (sap_id)      REFERENCES Student(sap_id)  ON DELETE RESTRICT,
    FOREIGN KEY (book_id)     REFERENCES Book(book_id)    ON DELETE RESTRICT,
    FOREIGN KEY (issued_by)   REFERENCES Admin(admin_id),
    FOREIGN KEY (returned_to) REFERENCES Admin(admin_id)
);

-- ================================================================
-- 5. BOOK REQUEST TABLE
-- ================================================================
CREATE TABLE IF NOT EXISTS Book_Request (
    request_id    INT         AUTO_INCREMENT PRIMARY KEY,
    sap_id        VARCHAR(20) NOT NULL,
    book_id       INT         NOT NULL,
    request_date  DATE        NOT NULL DEFAULT (CURRENT_DATE),
    status        ENUM('pending','approved','rejected','fulfilled') DEFAULT 'pending',
    admin_remark  VARCHAR(255),
    resolved_by   INT,
    resolved_at   TIMESTAMP,
    created_at    TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (sap_id)      REFERENCES Student(sap_id) ON DELETE CASCADE,
    FOREIGN KEY (book_id)     REFERENCES Book(book_id)   ON DELETE CASCADE,
    FOREIGN KEY (resolved_by) REFERENCES Admin(admin_id)
);

-- ================================================================
-- 6. FINE TABLE
-- ================================================================
CREATE TABLE IF NOT EXISTS Fine (
    fine_id      INT  AUTO_INCREMENT PRIMARY KEY,
    issue_id     INT  NOT NULL UNIQUE,
    amount       DECIMAL(8,2) NOT NULL DEFAULT 0.00,
    paid_status  ENUM('unpaid','paid','waived') DEFAULT 'unpaid',
    paid_at      TIMESTAMP,
    updated_by   INT,
    created_at   TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (issue_id)   REFERENCES Book_Issue(issue_id) ON DELETE CASCADE,
    FOREIGN KEY (updated_by) REFERENCES Admin(admin_id)
);

-- ================================================================
-- 7. BOOK RESERVATION TABLE  (NEW — 24-hour pickup lock)
-- ================================================================
-- When a student requests a book and it's available (or admin
-- approves the request), a reservation is created that locks
-- one copy for 24 hours. If not collected, it auto-expires.
-- ================================================================
CREATE TABLE IF NOT EXISTS Book_Reservation (
    reservation_id  INT         AUTO_INCREMENT PRIMARY KEY,
    sap_id          VARCHAR(20) NOT NULL,
    book_id         INT         NOT NULL,
    request_id      INT,                          -- linked request if any
    reserved_at     TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
    expires_at      TIMESTAMP   NOT NULL,          -- reserved_at + 24h
    collected_at    TIMESTAMP   NULL,
    status          ENUM('active','collected','expired','cancelled') DEFAULT 'active',
    notified        BOOLEAN     DEFAULT FALSE,
    created_by      INT,                           -- admin who created
    FOREIGN KEY (sap_id)      REFERENCES Student(sap_id)      ON DELETE CASCADE,
    FOREIGN KEY (book_id)     REFERENCES Book(book_id)        ON DELETE CASCADE,
    FOREIGN KEY (request_id)  REFERENCES Book_Request(request_id) ON DELETE SET NULL,
    FOREIGN KEY (created_by)  REFERENCES Admin(admin_id)
);

-- ================================================================
-- 8. BOOK REVIEW & RATING TABLE  (NEW)
-- ================================================================
CREATE TABLE IF NOT EXISTS Book_Review (
    review_id    INT         AUTO_INCREMENT PRIMARY KEY,
    sap_id       VARCHAR(20) NOT NULL,
    book_id      INT         NOT NULL,
    rating       TINYINT     NOT NULL CHECK (rating BETWEEN 1 AND 5),
    review_text  TEXT,
    is_visible   BOOLEAN     DEFAULT TRUE,
    created_at   TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMP   DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_student_book (sap_id, book_id),
    FOREIGN KEY (sap_id)  REFERENCES Student(sap_id) ON DELETE CASCADE,
    FOREIGN KEY (book_id) REFERENCES Book(book_id)   ON DELETE CASCADE
);

-- ================================================================
-- 9. NOTIFICATION TABLE  (NEW)
-- ================================================================
-- Stores all outgoing email notifications. A background job
-- (cron/worker) reads 'pending' rows and sends via Nodemailer.
-- ================================================================
CREATE TABLE IF NOT EXISTS Notification (
    notif_id      INT         AUTO_INCREMENT PRIMARY KEY,
    sap_id        VARCHAR(20) NOT NULL,
    email         VARCHAR(100) NOT NULL,
    type          ENUM(
                    'book_issued',
                    'due_reminder',
                    'overdue_alert',
                    'book_returned',
                    'reservation_created',
                    'reservation_expiring',
                    'reservation_expired',
                    'request_approved',
                    'request_rejected',
                    'fine_paid'
                  ) NOT NULL,
    subject       VARCHAR(255) NOT NULL,
    body_html     TEXT         NOT NULL,
    status        ENUM('pending','sent','failed') DEFAULT 'pending',
    reference_id  INT          COMMENT 'issue_id, request_id, reservation_id etc.',
    send_at       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    sent_at       TIMESTAMP,
    error_msg     VARCHAR(500),
    created_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (sap_id) REFERENCES Student(sap_id) ON DELETE CASCADE,
    INDEX idx_notif_status (status),
    INDEX idx_notif_sap    (sap_id),
    INDEX idx_notif_type   (type)
);

-- ================================================================
-- 10. CHATBOT LOG TABLE  (NEW)
-- ================================================================
CREATE TABLE IF NOT EXISTS Chatbot_Log (
    log_id       INT         AUTO_INCREMENT PRIMARY KEY,
    sap_id       VARCHAR(20),
    session_id   VARCHAR(64) NOT NULL,
    user_message TEXT        NOT NULL,
    bot_response TEXT        NOT NULL,
    intent       VARCHAR(50),
    created_at   TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (sap_id) REFERENCES Student(sap_id) ON DELETE SET NULL,
    INDEX idx_chat_session (session_id)
);

-- ================================================================
-- INDEXES
-- ================================================================
CREATE INDEX idx_issue_sap      ON Book_Issue(sap_id);
CREATE INDEX idx_issue_book     ON Book_Issue(book_id);
CREATE INDEX idx_issue_status   ON Book_Issue(status);
CREATE INDEX idx_req_sap        ON Book_Request(sap_id);
CREATE INDEX idx_req_status     ON Book_Request(status);
CREATE INDEX idx_fine_paid      ON Fine(paid_status);
CREATE INDEX idx_book_title     ON Book(title);
CREATE INDEX idx_book_author    ON Book(author);
CREATE INDEX idx_res_sap        ON Book_Reservation(sap_id);
CREATE INDEX idx_res_status     ON Book_Reservation(status);
CREATE INDEX idx_res_expires    ON Book_Reservation(expires_at);
CREATE INDEX idx_review_book    ON Book_Review(book_id);

-- ================================================================
-- SAMPLE DATA
-- ================================================================
INSERT INTO Admin (username, password) VALUES
('admin',     'admin123'),
('librarian', 'lib456');

INSERT INTO Student (sap_id, username, password, profile_details, dob, email, phone, department, year_of_study) VALUES
('500123456', 'John Doe',     '2002-05-15', 'B.Tech CS Year 3',   '2002-05-15', 'john@uni.edu',  '9876543210', 'Computer Science',       3),
('500123457', 'Jane Smith',   '2003-08-22', 'B.Tech IT Year 2',   '2003-08-22', 'jane@uni.edu',  '9876543211', 'Information Technology', 2),
('500123458', 'Raj Kumar',    '2000-12-01', 'MBA Year 1',         '2000-12-01', 'raj@uni.edu',   '9876543212', 'Management',             1),
('500123459', 'Priya Sharma', '2001-04-10', 'B.Tech ECE Year 4',  '2001-04-10', 'priya@uni.edu', '9876543213', 'Electronics',            4),
('500123460', 'Arjun Mehta',  '2002-11-20', 'B.Tech CS Year 2',   '2002-11-20', 'arjun@uni.edu', '9876543214', 'Computer Science',       2);

INSERT INTO Book (title, author, type, isbn, publisher, published_year, total_copies, available_copies) VALUES
('Introduction to Algorithms',  'Cormen et al.',        'Computer Science', '978-0262033848', 'MIT Press',         2009, 5, 4),
('Clean Code',                  'Robert C. Martin',     'Computer Science', '978-0132350884', 'Prentice Hall',     2008, 3, 2),
('The Great Gatsby',            'F. Scott Fitzgerald',  'Fiction',          '978-0743273565', 'Scribner',          1925, 4, 0),
('Data Structures in C',        'Reema Thareja',        'Computer Science', '978-0198066236', 'Oxford',            2014, 6, 5),
('Operating System Concepts',   'Silberschatz et al.',  'Computer Science', '978-1119800361', 'Wiley',             2018, 4, 3),
('Engineering Mathematics',     'B.V. Ramana',          'Mathematics',      '978-0070667235', 'McGraw-Hill',       2006, 5, 5),
('To Kill a Mockingbird',       'Harper Lee',           'Fiction',          '978-0061935466', 'HarperCollins',     1960, 3, 3),
('Database Management Systems', 'Raghu Ramakrishnan',   'Computer Science', '978-0072465631', 'McGraw-Hill',       2002, 4, 2),
('Discrete Mathematics',        'Kenneth H. Rosen',     'Mathematics',      '978-0072880083', 'McGraw-Hill',       2007, 3, 3),
('Computer Networks',           'Andrew S. Tanenbaum',  'Computer Science', '978-0132126953', 'Prentice Hall',     2011, 4, 4),
('Calculus',                    'James Stewart',        'Mathematics',      '978-1285740621', 'Cengage',           2015, 3, 2),
('Wings of Fire',               'A.P.J. Abdul Kalam',   'Biography',        '978-8173711466', 'Universities Press',1999, 4, 4);

INSERT INTO Book_Issue (sap_id, book_id, issue_date, due_date, return_date, status, issued_by) VALUES
('500123456', 2,  '2026-03-01', '2026-03-15', NULL,         'overdue',  1),
('500123457', 8,  '2026-03-05', '2026-03-30', NULL,         'issued',   1),
('500123458', 1,  '2026-02-20', '2026-03-06', '2026-03-04', 'returned', 1),
('500123456', 5,  '2026-03-10', '2026-03-24', NULL,         'issued',   1),
('500123459', 3,  '2026-02-15', '2026-03-01', '2026-03-05', 'returned', 2),
('500123457', 11, '2026-03-01', '2026-03-08', NULL,         'overdue',  1);

INSERT INTO Book_Request (sap_id, book_id, request_date, status, admin_remark) VALUES
('500123456', 3, '2026-03-12', 'pending',  ''),
('500123457', 1, '2026-03-10', 'approved', 'Approved'),
('500123458', 2, '2026-03-08', 'rejected', 'All copies currently issued'),
('500123459', 4, '2026-03-13', 'pending',  '');

INSERT INTO Fine (issue_id, amount, paid_status) VALUES
(1, 6.00,  'unpaid'),
(5, 8.00,  'paid'),
(6, 14.00, 'unpaid');

-- Sample reviews
INSERT INTO Book_Review (sap_id, book_id, rating, review_text) VALUES
('500123458', 1, 5, 'Absolutely essential for any CS student. Dense but rewarding.'),
('500123456', 1, 4, 'Great reference book, quite heavy to get through.'),
('500123459', 7, 5, 'A timeless classic. Beautifully written, highly recommended.'),
('500123457', 11, 4, 'Excellent for engineering maths fundamentals.');

-- Update avg ratings for seeded reviews
UPDATE Book SET avg_rating=4.50, rating_count=2 WHERE book_id=1;
UPDATE Book SET avg_rating=5.00, rating_count=1 WHERE book_id=7;
UPDATE Book SET avg_rating=4.00, rating_count=1 WHERE book_id=11;

-- ================================================================
-- DONE!
-- ================================================================
