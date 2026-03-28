/**
 * CIB Analyzer — Database Schema (ported from schema.py)
 * 15 tables + 3 views. Schema version tracked in db_metadata.
 */

export const SCHEMA_VERSION = 1;

// =============================================================================
// TABLE DEFINITIONS
// =============================================================================

export const TABLES_SQL = `
-- ─────────────────────── Metadata ───────────────────────

CREATE TABLE IF NOT EXISTS db_metadata (
    key     TEXT PRIMARY KEY,
    value   TEXT
);

CREATE TABLE IF NOT EXISTS settings (
    key     TEXT PRIMARY KEY,
    value   TEXT
);

CREATE TABLE IF NOT EXISTS risk_config (
    key     TEXT PRIMARY KEY,
    value   TEXT,
    description TEXT
);

-- ─────────────────────── Lookups ───────────────────────

CREATE TABLE IF NOT EXISTS lookup_sectors (
    sector_code TEXT PRIMARY KEY,
    sector_name TEXT
);

CREATE TABLE IF NOT EXISTS lookup_districts (
    district_code TEXT PRIMARY KEY,
    district_name TEXT
);

-- ─────────────────────── Core Data ───────────────────────

CREATE TABLE IF NOT EXISTS subjects (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    cib_subject_code        TEXT UNIQUE NOT NULL,
    subject_type            TEXT,
    name                    TEXT,
    father_name             TEXT,
    mother_name             TEXT,
    spouse_name             TEXT,
    dob                     TEXT,
    dob_verified            TEXT,
    gender                  TEXT,
    nid_17                  TEXT,
    nid_17_verified         TEXT,
    nid_10                  TEXT,
    nid_10_verified         TEXT,
    tin                     TEXT,
    telephone               TEXT,
    district                TEXT,
    trade_name              TEXT,
    registration_no         TEXT,
    registration_date       TEXT,
    legal_form              TEXT,
    sector_type             TEXT,
    sector_code             TEXT,
    reference_number        TEXT,
    -- CIB Subject Codes 1-5 under reference number
    cib_subject_code_1      TEXT,
    cib_subject_code_2      TEXT,
    cib_subject_code_3      TEXT,
    cib_subject_code_4      TEXT,
    cib_subject_code_5      TEXT,
    -- NID verification
    nid_verified            INTEGER DEFAULT 0,
    name_verified           TEXT,
    name_from_nid           TEXT,
    match_status            TEXT,
    -- Addresses
    present_address         TEXT,
    permanent_address       TEXT,
    office_address          TEXT,
    factory_address         TEXT,
    owner_name              TEXT,
    owner_address           TEXT,
    -- Contract history period
    contract_history_period TEXT,
    -- Risk scoring (computed)
    risk_rating             TEXT DEFAULT '',
    risk_factors            TEXT DEFAULT '[]',
    -- Source tracking
    source_file             TEXT,
    file_hash               TEXT,
    parse_timestamp         TEXT,
    parser_version          TEXT,
    extraction_warnings     TEXT DEFAULT '[]',
    updated_at              TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS inquiries (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    cib_subject_code    TEXT NOT NULL,
    inquiry_date        TEXT,
    inquiry_user_id     TEXT,
    inquiry_fi_code     TEXT,
    inquiry_fi_name     TEXT,
    source_file         TEXT,
    file_hash           TEXT,
    parsed_at           TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (cib_subject_code) REFERENCES subjects(cib_subject_code) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS summary_snapshots (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    inquiry_id              INTEGER NOT NULL,
    cib_subject_code        TEXT NOT NULL,
    role                    TEXT NOT NULL,
    -- BB-reported values
    bb_reporting_institutes INTEGER DEFAULT 0,
    bb_living_contracts     INTEGER DEFAULT 0,
    bb_total_outstanding    REAL DEFAULT 0,
    bb_total_overdue        REAL DEFAULT 0,
    bb_stay_order_contracts INTEGER DEFAULT 0,
    bb_stay_order_outstanding REAL DEFAULT 0,
    bb_worst_classification TEXT DEFAULT '',
    bb_ever_overdue         TEXT DEFAULT '',
    bb_max_overdue          REAL DEFAULT 0,
    bb_max_npi              INTEGER DEFAULT 0,
    bb_willful_default      TEXT DEFAULT '',
    -- Computed values (from our extraction)
    computed_living_contracts     INTEGER DEFAULT 0,
    computed_total_outstanding    REAL DEFAULT 0,
    computed_total_overdue        REAL DEFAULT 0,
    computed_worst_classification TEXT DEFAULT '',
    -- Mismatch flags
    mismatch_flags          TEXT DEFAULT '[]',
    FOREIGN KEY (inquiry_id) REFERENCES inquiries(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS contracts (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    cib_contract_code       TEXT NOT NULL,
    cib_subject_code        TEXT NOT NULL,
    inquiry_id              INTEGER,
    contract_subtype        TEXT DEFAULT 'standard',
    facility_category       TEXT,
    role                    TEXT,
    phase                   TEXT,
    facility_type           TEXT,
    last_update             TEXT,
    start_date              TEXT,
    end_date                TEXT,
    sanction_limit          REAL DEFAULT 0,
    total_disbursement      REAL DEFAULT 0,
    installment_amount      REAL DEFAULT 0,
    total_installments      INTEGER DEFAULT 0,
    remaining_count         INTEGER DEFAULT 0,
    remaining_amount        REAL DEFAULT 0,
    payment_method          TEXT,
    periodicity             TEXT,
    security_amount         REAL DEFAULT 0,
    security_type           TEXT,
    third_party_guarantee   REAL DEFAULT 0,
    reorganized_credit      TEXT,
    times_rescheduled       INTEGER DEFAULT 0,
    classification_date     TEXT,
    last_payment_date       TEXT,
    rescheduling_date       TEXT,
    lawsuit_date            TEXT,
    subsidized_credit       TEXT,
    stay_order_flag         TEXT DEFAULT 'No',
    -- 10 computed per-contract risk columns
    worst_ever_classification   TEXT DEFAULT '',
    max_overdue_amount          REAL DEFAULT 0,
    max_npi                     INTEGER DEFAULT 0,
    ever_overdue                INTEGER DEFAULT 0,
    months_in_overdue           INTEGER DEFAULT 0,
    classification_trend        TEXT DEFAULT '',
    last_classification_date    TEXT DEFAULT '',
    on_time_payment_rate        REAL DEFAULT 0,
    overdue_streak_max          INTEGER DEFAULT 0,
    outstanding_trend           TEXT DEFAULT '',
    -- Contract-level risk
    contract_risk               TEXT DEFAULT '',
    -- Source
    source_file             TEXT,
    updated_at              TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (inquiry_id) REFERENCES inquiries(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS monthly_history (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id         INTEGER NOT NULL,
    cib_contract_code   TEXT NOT NULL,
    accounting_date     TEXT,
    outstanding         REAL DEFAULT 0,
    overdue             REAL DEFAULT 0,
    npi                 INTEGER,
    sanction_limit      REAL,
    status              TEXT,
    default_wd          TEXT,
    remarks_wd          TEXT,
    FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS linked_subjects (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id         INTEGER NOT NULL,
    cib_subject_code    TEXT,
    role                TEXT,
    name                TEXT,
    FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS relationships (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_subject_code     TEXT NOT NULL,
    cib_subject_code        TEXT,
    name                    TEXT,
    role                    TEXT,
    relationship_type       TEXT,
    trade_name              TEXT,
    reference_number        TEXT,
    sector_type             TEXT,
    sector_code             TEXT,
    stay_order              TEXT,
    FOREIGN KEY (parent_subject_code) REFERENCES subjects(cib_subject_code) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS non_funded (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    cib_subject_code    TEXT NOT NULL,
    inquiry_id          INTEGER,
    role                TEXT,
    facility_type       TEXT,
    living_count        INTEGER DEFAULT 0,
    living_amount       REAL DEFAULT 0,
    terminated_count    INTEGER DEFAULT 0,
    terminated_amount   REAL DEFAULT 0,
    requested_count     INTEGER DEFAULT 0,
    requested_amount    REAL DEFAULT 0,
    stay_order_count    INTEGER DEFAULT 0,
    stay_order_amount   REAL DEFAULT 0,
    FOREIGN KEY (inquiry_id) REFERENCES inquiries(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS classification_matrix (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    inquiry_id          INTEGER NOT NULL,
    cib_subject_code    TEXT NOT NULL,
    role                TEXT NOT NULL,
    facility_type       TEXT NOT NULL,
    classification      TEXT NOT NULL,
    contract_count      INTEGER DEFAULT 0,
    outstanding_amount  REAL DEFAULT 0,
    FOREIGN KEY (inquiry_id) REFERENCES inquiries(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS external_debt (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    inquiry_id          INTEGER NOT NULL,
    cib_subject_code    TEXT NOT NULL,
    debt_type           TEXT,
    amount              REAL DEFAULT 0,
    currency            TEXT DEFAULT 'BDT',
    details             TEXT,
    FOREIGN KEY (inquiry_id) REFERENCES inquiries(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS alert_flags (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    cib_subject_code    TEXT NOT NULL,
    flag_type           TEXT NOT NULL,
    severity            TEXT DEFAULT 'WARNING',
    details             TEXT,
    related_contract    TEXT,
    created_at          TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (cib_subject_code) REFERENCES subjects(cib_subject_code) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS processing_log (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    source_file         TEXT NOT NULL,
    file_hash           TEXT,
    cib_subject_code    TEXT,
    subject_name        TEXT,
    status              TEXT NOT NULL,
    message             TEXT,
    contracts_found     INTEGER DEFAULT 0,
    history_rows_extracted INTEGER DEFAULT 0,
    warnings_count      INTEGER DEFAULT 0,
    replacement_flag    INTEGER DEFAULT 0,
    fields_with_uncertain_extraction TEXT DEFAULT '[]',
    duration_seconds    REAL DEFAULT 0,
    parser_version      TEXT,
    processed_at        TEXT DEFAULT (datetime('now','localtime')),
    batch_id            INTEGER
);

CREATE TABLE IF NOT EXISTS batches (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at      TEXT DEFAULT (datetime('now','localtime')),
    finished_at     TEXT,
    total_files     INTEGER DEFAULT 0,
    success_count   INTEGER DEFAULT 0,
    replaced_count  INTEGER DEFAULT 0,
    failed_count    INTEGER DEFAULT 0,
    adverse_count   INTEGER DEFAULT 0
);
`;

// =============================================================================
// INDEXES
// =============================================================================

export const INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_subjects_code ON subjects(cib_subject_code);
CREATE INDEX IF NOT EXISTS idx_subjects_name ON subjects(name);
CREATE INDEX IF NOT EXISTS idx_subjects_nid17 ON subjects(nid_17);
CREATE INDEX IF NOT EXISTS idx_subjects_trade ON subjects(trade_name);
CREATE INDEX IF NOT EXISTS idx_subjects_risk ON subjects(risk_rating);

CREATE INDEX IF NOT EXISTS idx_inquiries_subject ON inquiries(cib_subject_code);
CREATE INDEX IF NOT EXISTS idx_inquiries_date ON inquiries(inquiry_date);

CREATE INDEX IF NOT EXISTS idx_contracts_code ON contracts(cib_contract_code);
CREATE INDEX IF NOT EXISTS idx_contracts_subject ON contracts(cib_subject_code);
CREATE INDEX IF NOT EXISTS idx_contracts_inquiry ON contracts(inquiry_id);

CREATE INDEX IF NOT EXISTS idx_history_contract ON monthly_history(contract_id);
CREATE INDEX IF NOT EXISTS idx_history_code ON monthly_history(cib_contract_code);

CREATE INDEX IF NOT EXISTS idx_linked_contract ON linked_subjects(contract_id);

CREATE INDEX IF NOT EXISTS idx_relationships_parent ON relationships(parent_subject_code);

CREATE INDEX IF NOT EXISTS idx_nonfunded_subject ON non_funded(cib_subject_code);

CREATE INDEX IF NOT EXISTS idx_matrix_inquiry ON classification_matrix(inquiry_id);

CREATE INDEX IF NOT EXISTS idx_alerts_subject ON alert_flags(cib_subject_code);
CREATE INDEX IF NOT EXISTS idx_alerts_type ON alert_flags(flag_type);

CREATE INDEX IF NOT EXISTS idx_log_file ON processing_log(source_file);
CREATE INDEX IF NOT EXISTS idx_log_subject ON processing_log(cib_subject_code);
CREATE INDEX IF NOT EXISTS idx_log_batch ON processing_log(batch_id);
`;

// =============================================================================
// VIEWS
// =============================================================================

export const VIEWS_SQL = `
CREATE VIEW IF NOT EXISTS v_exposure_summary AS
SELECT
    s.cib_subject_code,
    s.name,
    s.risk_rating,
    COUNT(DISTINCT CASE WHEN c.role LIKE '%ORROWER%' AND c.phase = 'Living' THEN c.id END) AS living_borrower_contracts,
    COUNT(DISTINCT CASE WHEN c.role LIKE '%UARANTOR%' AND c.phase = 'Living' THEN c.id END) AS living_guarantor_contracts,
    COALESCE(SUM(CASE WHEN c.role LIKE '%ORROWER%' AND c.phase = 'Living' THEN c.sanction_limit END), 0) AS total_borrower_limit,
    COALESCE(SUM(CASE WHEN c.role LIKE '%UARANTOR%' AND c.phase = 'Living' THEN c.sanction_limit END), 0) AS total_guarantor_limit,
    MAX(c.worst_ever_classification) AS worst_classification,
    MAX(c.max_npi) AS max_npi_across_contracts
FROM subjects s
LEFT JOIN contracts c ON c.cib_subject_code = s.cib_subject_code
GROUP BY s.cib_subject_code;

CREATE VIEW IF NOT EXISTS v_relationship_risk AS
SELECT
    ls.cib_subject_code AS linked_code,
    ls.name AS linked_name,
    ls.role AS linked_role,
    c.cib_contract_code,
    c.cib_subject_code AS primary_code,
    c.worst_ever_classification,
    c.contract_risk,
    s.risk_rating AS primary_risk_rating
FROM linked_subjects ls
JOIN contracts c ON c.id = ls.contract_id
LEFT JOIN subjects s ON s.cib_subject_code = c.cib_subject_code;

CREATE VIEW IF NOT EXISTS v_portfolio_dashboard AS
SELECT
    COUNT(*) AS total_subjects,
    SUM(CASE WHEN risk_rating = 'LOW RISK' THEN 1 ELSE 0 END) AS low_risk_count,
    SUM(CASE WHEN risk_rating = 'NO HISTORY' THEN 1 ELSE 0 END) AS no_history_count,
    SUM(CASE WHEN risk_rating = 'MODERATE' THEN 1 ELSE 0 END) AS moderate_count,
    SUM(CASE WHEN risk_rating = 'HIGH RISK' THEN 1 ELSE 0 END) AS high_risk_count,
    SUM(CASE WHEN risk_rating = 'ADVERSE' THEN 1 ELSE 0 END) AS adverse_count,
    (SELECT COUNT(*) FROM contracts WHERE phase = 'Living') AS total_living_contracts,
    (SELECT COUNT(*) FROM alert_flags) AS total_alerts
FROM subjects;
`;

// =============================================================================
// DEFAULT METADATA
// =============================================================================

export const DEFAULT_METADATA = {
    schema_version: String(SCHEMA_VERSION),
    app_version: "",
    parser_version: "",
    last_updated: "",
};

export const DEFAULT_RISK_CONFIG = {
    adverse_classifications: '["DF", "BL", "BLW"]',
    willful_default_values: '["Yes", "WD"]',
    high_classifications: '["SS"]',
    high_npi_min: "6",
    high_overdue_chronic_months: "6",
    high_rescheduled_min: "2",
    moderate_classifications: '["SMA"]',
    moderate_npi_min: "1",
};
