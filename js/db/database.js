/**
 * CIB Analyzer — Client-side Database (sql.js / WASM SQLite)
 * ============================================================
 * Complete port of the Python database layer (connection.py + store.py +
 * queries.py + database.py) using sql.js backed by IndexedDB persistence.
 */

import { APP_VERSION, PARSER_VERSION } from '../config.js';
import {
    TABLES_SQL, INDEX_SQL, VIEWS_SQL,
    SCHEMA_VERSION, DEFAULT_METADATA, DEFAULT_RISK_CONFIG,
} from './schema.js';

// =============================================================================
// IndexedDB persistence helpers
// =============================================================================

const IDB_NAME = 'CIBAnalyzerDB';
const IDB_STORE = 'databases';
const IDB_VERSION = 1;

function openIDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = () => {
            const idb = req.result;
            if (!idb.objectStoreNames.contains(IDB_STORE)) {
                idb.createObjectStore(IDB_STORE);
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function saveToIndexedDB(dbName, uint8Array) {
    const idb = await openIDB();
    return new Promise((resolve, reject) => {
        const tx = idb.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(uint8Array, dbName);
        tx.oncomplete = () => { idb.close(); resolve(); };
        tx.onerror = () => { idb.close(); reject(tx.error); };
    });
}

async function loadFromIndexedDB(dbName) {
    const idb = await openIDB();
    return new Promise((resolve, reject) => {
        const tx = idb.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).get(dbName);
        req.onsuccess = () => { idb.close(); resolve(req.result || null); };
        req.onerror = () => { idb.close(); reject(req.error); };
    });
}

async function deleteFromIndexedDB(dbName) {
    const idb = await openIDB();
    return new Promise((resolve, reject) => {
        const tx = idb.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(dbName);
        tx.oncomplete = () => { idb.close(); resolve(); };
        tx.onerror = () => { idb.close(); reject(tx.error); };
    });
}

// =============================================================================
// Helper: run a SELECT and return array of plain objects
// =============================================================================

function queryAll(db, sql, params = []) {
    const results = [];
    const stmt = db.prepare(sql);
    stmt.bind(params);
    while (stmt.step()) {
        results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
}

function queryOne(db, sql, params = []) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    let row = null;
    if (stmt.step()) {
        row = stmt.getAsObject();
    }
    stmt.free();
    return row;
}

function getLastInsertRowId(db) {
    const result = db.exec("SELECT last_insert_rowid()");
    return result[0].values[0][0];
}

function localNow() {
    // ISO-ish local datetime matching SQLite datetime('now','localtime')
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
           `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// =============================================================================
// CIBDatabase
// =============================================================================

class CIBDatabase {
    /**
     * @param {string} dbName  Logical name used as IndexedDB key (default 'cib_master')
     */
    constructor(dbName = 'cib_master') {
        this.dbName = dbName;
        this.db = null;
        this._dirty = false;
    }

    // ────────────────────────────────────────────────────────────────────────
    // Lifecycle
    // ────────────────────────────────────────────────────────────────────────

    /**
     * Initialise the database. Loads from IndexedDB if a previous copy exists,
     * otherwise creates a fresh in-memory SQLite database.
     *
     * @param {Object} [sqlPromise]  Optional — the resolved SQL module from
     *     initSqlJs(). If omitted we call the global `initSqlJs()`.
     */
    async init(sqlPromise) {
        const SQL = await (sqlPromise || initSqlJs());

        // Try to restore from IndexedDB
        const saved = await loadFromIndexedDB(this.dbName);
        if (saved) {
            this.db = new SQL.Database(new Uint8Array(saved));
        } else {
            this.db = new SQL.Database();
        }

        // Enable foreign keys
        this.db.run("PRAGMA foreign_keys = ON;");

        this._initSchema();
        this._seedMetadata();
        await this._persist();
    }

    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }

    // ────────────────────────────────────────────────────────────────────────
    // Schema bootstrap (mirrors connection.py _init_schema / _seed_metadata)
    // ────────────────────────────────────────────────────────────────────────

    _initSchema() {
        this.db.run(TABLES_SQL);
        this.db.run(INDEX_SQL);

        // Migration: remove UNIQUE(cib_contract_code, cib_subject_code) from contracts
        // This constraint caused INSERT OR REPLACE to overwrite masked (###) contracts
        this._migrateContractsUnique();

        // Drop and recreate views (they're cheap)
        for (const viewName of ['v_exposure_summary', 'v_relationship_risk', 'v_portfolio_dashboard']) {
            this.db.run(`DROP VIEW IF EXISTS ${viewName}`);
        }
        this.db.run(VIEWS_SQL);
    }

    _migrateContractsUnique() {
        const tableInfo = queryOne(this.db,
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='contracts'", []);
        if (!tableInfo || !tableInfo.sql) return;

        const needsUniqueRemoval = tableInfo.sql.includes('UNIQUE(cib_contract_code');
        const needsFiCode = !tableInfo.sql.includes('fi_code');

        if (!needsUniqueRemoval && !needsFiCode) return;

        if (needsFiCode && !needsUniqueRemoval) {
            // Just add the missing column
            this.db.run("ALTER TABLE contracts ADD COLUMN fi_code TEXT DEFAULT ''");
        } else {
            // Need to recreate table (can't drop UNIQUE with ALTER)
            this.db.run("ALTER TABLE contracts RENAME TO contracts_old");
            this.db.run(TABLES_SQL);
            // Copy data — old table lacks fi_code, so list columns explicitly
            const oldCols = tableInfo.sql.match(/\([\s\S]+\)/)[0];
            const hasOldFiCode = oldCols.includes('fi_code');
            const baseCols = `id, cib_contract_code, cib_subject_code, inquiry_id,
                contract_subtype, facility_category, role, phase,
                facility_type, last_update, start_date, end_date,
                sanction_limit, total_disbursement,
                installment_amount, total_installments,
                remaining_count, remaining_amount,
                payment_method, periodicity,
                security_amount, security_type, third_party_guarantee,
                reorganized_credit, times_rescheduled,
                classification_date, last_payment_date,
                rescheduling_date, lawsuit_date, subsidized_credit,
                stay_order_flag,
                worst_ever_classification, max_overdue_amount, max_npi,
                ever_overdue, months_in_overdue, classification_trend,
                last_classification_date, on_time_payment_rate,
                overdue_streak_max, outstanding_trend, contract_risk,
                source_file, updated_at`;
            if (hasOldFiCode) {
                this.db.run(`INSERT INTO contracts (${baseCols}, fi_code) SELECT ${baseCols}, fi_code FROM contracts_old`);
            } else {
                this.db.run(`INSERT INTO contracts (${baseCols}) SELECT ${baseCols} FROM contracts_old`);
            }
            this.db.run("DROP TABLE contracts_old");
        }
    }

    _seedMetadata() {
        for (const [key, value] of Object.entries(DEFAULT_METADATA)) {
            this.db.run(
                "INSERT OR IGNORE INTO db_metadata (key, value) VALUES (?, ?)",
                [key, value]
            );
        }
        // Always update app/parser version
        this.db.run("UPDATE db_metadata SET value=? WHERE key='app_version'", [APP_VERSION]);
        this.db.run("UPDATE db_metadata SET value=? WHERE key='parser_version'", [PARSER_VERSION]);

        for (const [key, value] of Object.entries(DEFAULT_RISK_CONFIG)) {
            this.db.run(
                "INSERT OR IGNORE INTO risk_config (key, value) VALUES (?, ?)",
                [key, value]
            );
        }
    }

    // ────────────────────────────────────────────────────────────────────────
    // Persistence helpers
    // ────────────────────────────────────────────────────────────────────────

    async _persist() {
        if (!this.db) return;
        const data = this.db.export();
        await saveToIndexedDB(this.dbName, data);
    }

    /**
     * Export the entire database as a Uint8Array (for download).
     */
    exportDatabase() {
        if (!this.db) throw new Error('Database not initialised');
        return this.db.export();
    }

    /**
     * Replace the current database with data from a Uint8Array.
     */
    async importDatabase(uint8Array) {
        if (this.db) this.db.close();

        // We need SQL module — grab it from global
        const SQL = await initSqlJs();
        this.db = new SQL.Database(new Uint8Array(uint8Array));
        this.db.run("PRAGMA foreign_keys = ON;");

        // Re-run views in case schema version differs
        for (const viewName of ['v_exposure_summary', 'v_relationship_risk', 'v_portfolio_dashboard']) {
            this.db.run(`DROP VIEW IF EXISTS ${viewName}`);
        }
        this.db.run(VIEWS_SQL);

        await this._persist();
    }

    /**
     * Delete the IndexedDB copy (factory reset).
     */
    async deleteDatabase() {
        if (this.db) this.db.close();
        this.db = null;
        await deleteFromIndexedDB(this.dbName);
    }

    // ────────────────────────────────────────────────────────────────────────
    // Settings / Metadata (mirrors connection.py)
    // ────────────────────────────────────────────────────────────────────────

    getSetting(key, defaultValue = '') {
        const row = queryOne(this.db, "SELECT value FROM settings WHERE key=?", [key]);
        return row ? row.value : defaultValue;
    }

    async setSetting(key, value) {
        this.db.run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [key, value]);
        await this._persist();
    }

    getMetadata(key) {
        const row = queryOne(this.db, "SELECT value FROM db_metadata WHERE key=?", [key]);
        return row ? row.value : '';
    }

    async setMetadata(key, value) {
        this.db.run("INSERT OR REPLACE INTO db_metadata (key, value) VALUES (?, ?)", [key, value]);
        await this._persist();
    }

    // ────────────────────────────────────────────────────────────────────────
    // Batch management (mirrors store.py)
    // ────────────────────────────────────────────────────────────────────────

    async createBatch() {
        this.db.run(
            "INSERT INTO batches (started_at) VALUES (?)",
            [localNow()]
        );
        const batchId = getLastInsertRowId(this.db);
        await this._persist();
        return batchId;
    }

    async finishBatch(batchId, total, success, replaced, failed, adverse = 0) {
        this.db.run(`
            UPDATE batches SET
                finished_at = ?,
                total_files = ?, success_count = ?,
                replaced_count = ?, failed_count = ?, adverse_count = ?
            WHERE id = ?
        `, [localNow(), total, success, replaced, failed, adverse, batchId]);
        await this._persist();
    }

    // ────────────────────────────────────────────────────────────────────────
    // Store full report (mirrors store.py store_report — the big one)
    // ────────────────────────────────────────────────────────────────────────

    async storeReport(report) {
        const subj = report.subject || {};
        const inq = report.inquiry || {};
        const nid = report.nid_verification || {};
        const addr = report.addresses || {};
        const warnings = report.extraction_warnings || [];

        const cibCode = subj.cib_subject_code || '';
        if (!cibCode) {
            throw new Error('Report has no CIB Subject Code — cannot store.');
        }

        const now = localNow();

        // ── Upsert subject ──
        this.db.run(`
            INSERT INTO subjects (
                cib_subject_code, subject_type, name, father_name, mother_name,
                spouse_name, dob, dob_verified, gender, nid_17, nid_17_verified,
                nid_10, nid_10_verified, tin, telephone, district,
                trade_name, registration_no, registration_date, legal_form,
                sector_type, sector_code, reference_number,
                cib_subject_code_1, cib_subject_code_2, cib_subject_code_3,
                cib_subject_code_4, cib_subject_code_5,
                nid_verified, name_verified, name_from_nid, match_status,
                present_address, permanent_address, office_address, factory_address,
                owner_name, owner_address, contract_history_period,
                source_file, file_hash, parse_timestamp, parser_version,
                extraction_warnings, updated_at
            ) VALUES (
                ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,
                ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
            )
            ON CONFLICT(cib_subject_code) DO UPDATE SET
                subject_type=excluded.subject_type,
                name=excluded.name, father_name=excluded.father_name,
                mother_name=excluded.mother_name, spouse_name=excluded.spouse_name,
                dob=excluded.dob, dob_verified=excluded.dob_verified,
                gender=excluded.gender,
                nid_17=excluded.nid_17, nid_17_verified=excluded.nid_17_verified,
                nid_10=excluded.nid_10, nid_10_verified=excluded.nid_10_verified,
                tin=excluded.tin, telephone=excluded.telephone,
                district=excluded.district, trade_name=excluded.trade_name,
                registration_no=excluded.registration_no,
                registration_date=excluded.registration_date,
                legal_form=excluded.legal_form,
                sector_type=excluded.sector_type, sector_code=excluded.sector_code,
                reference_number=excluded.reference_number,
                cib_subject_code_1=excluded.cib_subject_code_1,
                cib_subject_code_2=excluded.cib_subject_code_2,
                cib_subject_code_3=excluded.cib_subject_code_3,
                cib_subject_code_4=excluded.cib_subject_code_4,
                cib_subject_code_5=excluded.cib_subject_code_5,
                nid_verified=excluded.nid_verified,
                name_verified=excluded.name_verified,
                name_from_nid=excluded.name_from_nid,
                match_status=excluded.match_status,
                present_address=excluded.present_address,
                permanent_address=excluded.permanent_address,
                office_address=excluded.office_address,
                factory_address=excluded.factory_address,
                owner_name=excluded.owner_name,
                owner_address=excluded.owner_address,
                contract_history_period=excluded.contract_history_period,
                source_file=excluded.source_file,
                file_hash=excluded.file_hash,
                parse_timestamp=excluded.parse_timestamp,
                parser_version=excluded.parser_version,
                extraction_warnings=excluded.extraction_warnings,
                updated_at=excluded.updated_at
        `, [
            cibCode,
            subj.subject_type || '',
            subj.name || '',
            subj.fathers_name || subj.father_name || '',
            subj.mothers_name || subj.mother_name || '',
            subj.spouse_name || '',
            subj.dob || '',
            subj.dob_verified || '',
            subj.gender || '',
            subj.nid_17 || '',
            subj.nid_17_verified || '',
            subj.nid_10 || '',
            subj.nid_10_verified || '',
            subj.tin || '',
            subj.telephone || '',
            subj.district || '',
            subj.trade_name || '',
            subj.registration_no || '',
            subj.registration_date || '',
            subj.legal_form || '',
            subj.sector_type || '',
            subj.sector_code || '',
            subj.reference_number || '',
            subj.cib_subject_code_1 || '',
            subj.cib_subject_code_2 || '',
            subj.cib_subject_code_3 || '',
            subj.cib_subject_code_4 || '',
            subj.cib_subject_code_5 || '',
            nid.nid_verified ? 1 : 0,
            nid.name_verified || '',
            nid.name_from_nid_server || '',
            (report.match_status || {}).match_result || '',
            addr.present || '',
            addr.permanent || '',
            addr.office || '',
            addr.factory || '',
            subj.owner_name || '',
            subj.owner_address || '',
            subj.contract_history_period || '',
            report.source_file || '',
            report.file_hash || '',
            report.parse_timestamp || '',
            report.parser_version || '',
            warnings.length ? JSON.stringify(warnings) : '[]',
            now,
        ]);

        const subjectRow = queryOne(
            this.db,
            "SELECT id FROM subjects WHERE cib_subject_code=?",
            [cibCode]
        );
        const subjectId = subjectRow.id;

        // ── Create inquiry record ──
        this.db.run(`
            INSERT INTO inquiries (
                cib_subject_code, inquiry_date, inquiry_user_id,
                inquiry_fi_code, inquiry_fi_name, source_file, file_hash
            ) VALUES (?,?,?,?,?,?,?)
        `, [
            cibCode,
            inq.inquiry_date || '',
            inq.user_id || '',
            inq.fi_code || '',
            inq.fi_name || '',
            report.source_file || '',
            report.file_hash || '',
        ]);
        const inquiryId = getLastInsertRowId(this.db);

        // ── Delete old child records for this subject (full replace) ──
        const contractRows = queryAll(
            this.db,
            "SELECT id FROM contracts WHERE cib_subject_code=?",
            [cibCode]
        );
        for (const cr of contractRows) {
            this.db.run("DELETE FROM monthly_history WHERE contract_id=?", [cr.id]);
            this.db.run("DELETE FROM linked_subjects WHERE contract_id=?", [cr.id]);
        }
        this.db.run("DELETE FROM contracts WHERE cib_subject_code=?", [cibCode]);
        this.db.run("DELETE FROM non_funded WHERE cib_subject_code=?", [cibCode]);
        this.db.run("DELETE FROM relationships WHERE parent_subject_code=?", [cibCode]);
        this.db.run("DELETE FROM classification_matrix WHERE cib_subject_code=?", [cibCode]);
        this.db.run("DELETE FROM external_debt WHERE cib_subject_code=?", [cibCode]);
        this.db.run("DELETE FROM alert_flags WHERE cib_subject_code=?", [cibCode]);

        // ── Insert contracts + monthly history + linked subjects ──
        const contracts = report.contracts || [];
        for (const c of contracts) {
            const contractCode = c.cib_contract_code || '###';
            this.db.run(`
                INSERT INTO contracts (
                    cib_contract_code, cib_subject_code, inquiry_id, fi_code,
                    contract_subtype, facility_category, role, phase,
                    facility_type, last_update, start_date, end_date,
                    sanction_limit, total_disbursement,
                    installment_amount, total_installments,
                    remaining_count, remaining_amount,
                    payment_method, periodicity,
                    security_amount, security_type, third_party_guarantee,
                    reorganized_credit, times_rescheduled,
                    classification_date, last_payment_date,
                    rescheduling_date, lawsuit_date, subsidized_credit,
                    stay_order_flag, source_file, updated_at
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            `, [
                contractCode,
                c.cib_subject_code || cibCode,
                inquiryId,
                c.fi_code || '',
                c.contract_subtype || 'standard',
                c.facility_category || '',
                c.role || '',
                c.phase || '',
                c.facility_type || '',
                c.last_update || '',
                c.start_date || '',
                c.end_date || '',
                c.sanction_limit || 0,
                c.total_disbursement || 0,
                c.installment_amount || 0,
                c.total_installments || 0,
                c.remaining_count || 0,
                c.remaining_amount || 0,
                c.payment_method || '',
                c.periodicity || '',
                c.security_amount || 0,
                c.security_type || '',
                c.third_party_guarantee || 0,
                c.reorganized_credit || '',
                c.times_rescheduled || 0,
                c.classification_date || '',
                c.last_payment_date || '',
                c.rescheduling_date || '',
                c.lawsuit_date || '',
                c.subsidized_credit || '',
                c.stay_order_flag || 'No',
                report.source_file || '',
                now,
            ]);
            const contractId = getLastInsertRowId(this.db);

            // Monthly history
            const history = c.monthly_history || [];
            for (const h of history) {
                this.db.run(`
                    INSERT INTO monthly_history (
                        contract_id, cib_contract_code, accounting_date,
                        outstanding, overdue, npi, sanction_limit,
                        status, default_wd, remarks_wd
                    ) VALUES (?,?,?,?,?,?,?,?,?,?)
                `, [
                    contractId, contractCode,
                    h.accounting_date || '',
                    h.outstanding || 0,
                    h.overdue || 0,
                    h.npi != null ? h.npi : null,
                    h.sanction_limit != null ? h.sanction_limit : null,
                    h.status || '',
                    h.default_wd || '',
                    h.remarks_wd || '',
                ]);
            }

            // Linked subjects
            const linked = c.linked_subjects || [];
            for (const ls of linked) {
                this.db.run(`
                    INSERT INTO linked_subjects (
                        contract_id, cib_subject_code, role, name
                    ) VALUES (?,?,?,?)
                `, [
                    contractId,
                    ls.cib_subject_code || '',
                    ls.role || '',
                    ls.name || '',
                ]);
            }
        }

        // ── Summary snapshots (borrower + guarantor) ──
        for (const [roleKey, roleLabel] of [['summary_borrower', 'Borrower'], ['summary_guarantor', 'Guarantor']]) {
            const s = report[roleKey] || {};
            if (Object.keys(s).length > 0) {
                this.db.run(`
                    INSERT INTO summary_snapshots (
                        inquiry_id, cib_subject_code, role,
                        bb_reporting_institutes, bb_living_contracts,
                        bb_total_outstanding, bb_total_overdue,
                        bb_stay_order_contracts, bb_stay_order_outstanding,
                        bb_worst_classification, bb_ever_overdue,
                        bb_max_overdue, bb_max_npi, bb_willful_default
                    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                `, [
                    inquiryId, cibCode, roleLabel,
                    s.reporting_institutes || 0,
                    s.living_contracts || 0,
                    s.total_outstanding || 0,
                    s.total_overdue || 0,
                    s.stay_order_contracts || 0,
                    s.stay_order_outstanding || 0,
                    s.worst_classification || '',
                    s.ever_overdue || '',
                    s.max_overdue || 0,
                    s.max_npi || 0,
                    s.willful_default || '',
                ]);
            }
        }

        // ── Non-funded summary ──
        for (const roleKey of ['non_funded_borrower', 'non_funded_guarantor']) {
            const items = report[roleKey] || [];
            for (const nf of items) {
                this.db.run(`
                    INSERT INTO non_funded (
                        cib_subject_code, inquiry_id, role, facility_type,
                        living_count, living_amount,
                        terminated_count, terminated_amount,
                        requested_count, requested_amount,
                        stay_order_count, stay_order_amount
                    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                `, [
                    cibCode, inquiryId,
                    nf.role || '',
                    nf.facility_type || '',
                    nf.living_count || 0,
                    nf.living_amount || 0,
                    nf.terminated_count || 0,
                    nf.terminated_amount || 0,
                    nf.requested_count || 0,
                    nf.requested_amount || 0,
                    nf.stay_order_count || 0,
                    nf.stay_order_amount || 0,
                ]);
            }
        }

        // ── Classification matrix ──
        for (const roleKey of ['matrix_borrower', 'matrix_guarantor']) {
            const items = report[roleKey] || [];
            for (const m of items) {
                this.db.run(`
                    INSERT INTO classification_matrix (
                        inquiry_id, cib_subject_code, role,
                        facility_type, classification,
                        contract_count, outstanding_amount
                    ) VALUES (?,?,?,?,?,?,?)
                `, [
                    inquiryId, cibCode,
                    m.role || '',
                    m.facility_type || '',
                    m.classification || '',
                    m.contract_count || 0,
                    m.outstanding_amount || 0,
                ]);
            }
        }

        // ── Relationships (owners + proprietorships combined) ──
        const owners = report.owners || [];
        for (const ow of owners) {
            this.db.run(`
                INSERT INTO relationships (
                    parent_subject_code, cib_subject_code, name,
                    role, relationship_type, stay_order
                ) VALUES (?,?,?,?,?,?)
            `, [
                cibCode,
                ow.cib_subject_code || '',
                ow.name || '',
                ow.role || '',
                'owner',
                ow.stay_order || '',
            ]);
        }

        const proprietorships = report.proprietorships || [];
        for (const pr of proprietorships) {
            this.db.run(`
                INSERT INTO relationships (
                    parent_subject_code, cib_subject_code, name,
                    role, relationship_type, trade_name,
                    reference_number, sector_type, sector_code
                ) VALUES (?,?,?,?,?,?,?,?,?)
            `, [
                cibCode,
                pr.cib_subject_code || '',
                pr.name || '',
                pr.role || '',
                'proprietorship',
                pr.trade_name || '',
                pr.reference_number || '',
                pr.sector_type || '',
                pr.sector_code || '',
            ]);
        }

        // ── External debt ──
        const extDebt = report.external_debt || [];
        for (const ed of extDebt) {
            this.db.run(`
                INSERT INTO external_debt (
                    inquiry_id, cib_subject_code, debt_type, amount, currency, details
                ) VALUES (?,?,?,?,?,?)
            `, [
                inquiryId, cibCode,
                ed.debt_type || '',
                ed.amount || 0,
                ed.currency || 'BDT',
                ed.details || '',
            ]);
        }

        // Update metadata
        await this.setMetadata('last_updated', now);

        // Persist is called inside setMetadata, but let's be explicit
        await this._persist();

        return subjectId;
    }

    // ────────────────────────────────────────────────────────────────────────
    // Risk scoring update (mirrors store.py)
    // ────────────────────────────────────────────────────────────────────────

    async updateSubjectRisk(cibCode, rating, factors) {
        this.db.run(
            "UPDATE subjects SET risk_rating=?, risk_factors=? WHERE cib_subject_code=?",
            [rating, JSON.stringify(factors), cibCode]
        );
        await this._persist();
    }

    async storeAlertFlags(cibCode, flags) {
        this.db.run("DELETE FROM alert_flags WHERE cib_subject_code=?", [cibCode]);
        for (const f of flags) {
            this.db.run(`
                INSERT INTO alert_flags (
                    cib_subject_code, flag_type, severity, details, related_contract
                ) VALUES (?,?,?,?,?)
            `, [
                cibCode,
                f.flag_type || '',
                f.severity || 'WARNING',
                f.details || '',
                f.related_contract || '',
            ]);
        }
        await this._persist();
    }

    async updateContractRiskColumns(contractId, riskData) {
        this.db.run(`
            UPDATE contracts SET
                worst_ever_classification = ?,
                max_overdue_amount = ?,
                max_npi = ?,
                ever_overdue = ?,
                months_in_overdue = ?,
                classification_trend = ?,
                last_classification_date = ?,
                on_time_payment_rate = ?,
                overdue_streak_max = ?,
                outstanding_trend = ?,
                contract_risk = ?
            WHERE id = ?
        `, [
            riskData.worst_ever_classification || '',
            riskData.max_overdue_amount || 0,
            riskData.max_npi || 0,
            riskData.ever_overdue || 0,
            riskData.months_in_overdue || 0,
            riskData.classification_trend || '',
            riskData.last_classification_date || '',
            riskData.on_time_payment_rate || 0,
            riskData.overdue_streak_max || 0,
            riskData.outstanding_trend || '',
            riskData.contract_risk || '',
            contractId,
        ]);
        await this._persist();
    }

    // ────────────────────────────────────────────────────────────────────────
    // Processing log (mirrors store.py)
    // ────────────────────────────────────────────────────────────────────────

    async logProcessing({
        sourceFile, fileHash = '', cibCode = '', name = '',
        status, message = '', contracts = 0,
        historyRows = 0, warnings = 0, duration = 0,
        parserVersion = '', replacement = false,
        uncertainFields = null, batchId = null,
    }) {
        this.db.run(`
            INSERT INTO processing_log (
                source_file, file_hash, cib_subject_code, subject_name,
                status, message, contracts_found, history_rows_extracted,
                warnings_count, replacement_flag,
                fields_with_uncertain_extraction,
                duration_seconds, parser_version, batch_id
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `, [
            sourceFile, fileHash, cibCode, name,
            status, message, contracts, historyRows,
            warnings, replacement ? 1 : 0,
            JSON.stringify(uncertainFields || []),
            duration, parserVersion, batchId,
        ]);
        await this._persist();
    }

    // ────────────────────────────────────────────────────────────────────────
    // Delete (mirrors store.py)
    // ────────────────────────────────────────────────────────────────────────

    async deleteSubject(cibCode) {
        const contractRows = queryAll(
            this.db,
            "SELECT id FROM contracts WHERE cib_subject_code=?",
            [cibCode]
        );
        for (const cr of contractRows) {
            this.db.run("DELETE FROM monthly_history WHERE contract_id=?", [cr.id]);
            this.db.run("DELETE FROM linked_subjects WHERE contract_id=?", [cr.id]);
        }
        this.db.run("DELETE FROM contracts WHERE cib_subject_code=?", [cibCode]);
        this.db.run("DELETE FROM non_funded WHERE cib_subject_code=?", [cibCode]);
        this.db.run("DELETE FROM relationships WHERE parent_subject_code=?", [cibCode]);
        this.db.run("DELETE FROM classification_matrix WHERE cib_subject_code=?", [cibCode]);
        this.db.run("DELETE FROM external_debt WHERE cib_subject_code=?", [cibCode]);
        this.db.run("DELETE FROM alert_flags WHERE cib_subject_code=?", [cibCode]);
        this.db.run("DELETE FROM summary_snapshots WHERE cib_subject_code=?", [cibCode]);
        this.db.run("DELETE FROM inquiries WHERE cib_subject_code=?", [cibCode]);
        this.db.run("DELETE FROM subjects WHERE cib_subject_code=?", [cibCode]);
        await this._persist();
    }

    // ────────────────────────────────────────────────────────────────────────
    // Query (read) operations — mirrors queries.py
    // ────────────────────────────────────────────────────────────────────────

    searchSubjects(query, limit = 50) {
        const q = `%${query}%`;
        return queryAll(this.db, `
            SELECT id, cib_subject_code, subject_type, name, trade_name,
                   nid_17, father_name, match_status, risk_rating,
                   source_file, inquiry_date
            FROM subjects
            LEFT JOIN (
                SELECT cib_subject_code AS inq_code,
                       MAX(inquiry_date) AS inquiry_date
                FROM inquiries GROUP BY cib_subject_code
            ) inq ON inq.inq_code = subjects.cib_subject_code
            WHERE subjects.cib_subject_code LIKE ?
               OR name LIKE ?
               OR trade_name LIKE ?
               OR nid_17 LIKE ?
               OR father_name LIKE ?
            ORDER BY updated_at DESC
            LIMIT ?
        `, [q, q, q, q, q, limit]);
    }

    subjectExists(cibCode) {
        const row = queryOne(
            this.db,
            "SELECT 1 FROM subjects WHERE cib_subject_code=? LIMIT 1",
            [cibCode]
        );
        return row !== null;
    }

    fileHashExists(fileHash) {
        const row = queryOne(
            this.db,
            "SELECT 1 FROM subjects WHERE file_hash=? LIMIT 1",
            [fileHash]
        );
        return row !== null;
    }

    /**
     * Get the CIB subject code for a given file hash.
     * Returns the code string if found, or null if not.
     */
    getSubjectByFileHash(fileHash) {
        const row = queryOne(
            this.db,
            "SELECT cib_subject_code FROM subjects WHERE file_hash=? LIMIT 1",
            [fileHash]
        );
        return row ? row.cib_subject_code : null;
    }

    getSubjectFull(cibCode) {
        const row = queryOne(this.db, "SELECT * FROM subjects WHERE cib_subject_code=?", [cibCode]);
        if (!row) return null;

        const data = { ...row };

        // Inquiries
        data.inquiries = queryAll(
            this.db,
            "SELECT * FROM inquiries WHERE cib_subject_code=? ORDER BY inquiry_date DESC",
            [cibCode]
        );

        // Latest inquiry ID
        const latestInquiry = data.inquiries.length > 0 ? data.inquiries[0] : null;
        const latestInqId = latestInquiry ? latestInquiry.id : null;

        // Summary snapshots (latest inquiry)
        if (latestInqId) {
            data.summary_snapshots = queryAll(
                this.db,
                "SELECT * FROM summary_snapshots WHERE inquiry_id=?",
                [latestInqId]
            );
        } else {
            data.summary_snapshots = [];
        }

        // Contracts + history + linked
        const contractRows = queryAll(
            this.db,
            "SELECT * FROM contracts WHERE cib_subject_code=? ORDER BY id",
            [cibCode]
        );
        data.contracts = contractRows.map(cd => {
            cd.monthly_history = queryAll(
                this.db,
                "SELECT * FROM monthly_history WHERE contract_id=? ORDER BY accounting_date DESC",
                [cd.id]
            );
            cd.linked_subjects = queryAll(
                this.db,
                "SELECT * FROM linked_subjects WHERE contract_id=?",
                [cd.id]
            );
            return cd;
        });

        // Non-funded
        data.non_funded = queryAll(
            this.db,
            "SELECT * FROM non_funded WHERE cib_subject_code=?",
            [cibCode]
        );

        // Relationships
        data.relationships = queryAll(
            this.db,
            "SELECT * FROM relationships WHERE parent_subject_code=?",
            [cibCode]
        );

        // Classification matrix (latest inquiry)
        if (latestInqId) {
            data.classification_matrix = queryAll(
                this.db,
                "SELECT * FROM classification_matrix WHERE inquiry_id=?",
                [latestInqId]
            );
        } else {
            data.classification_matrix = [];
        }

        // External debt
        data.external_debt = queryAll(
            this.db,
            "SELECT * FROM external_debt WHERE cib_subject_code=?",
            [cibCode]
        );

        // Alert flags
        data.alert_flags = queryAll(
            this.db,
            "SELECT * FROM alert_flags WHERE cib_subject_code=? ORDER BY severity DESC",
            [cibCode]
        );

        return data;
    }

    getAllSubjects() {
        return queryAll(this.db, `
            SELECT s.id, s.cib_subject_code, s.subject_type, s.name,
                   s.trade_name, s.nid_17, s.match_status, s.risk_rating,
                   s.source_file, s.updated_at,
                   MAX(i.inquiry_date) AS inquiry_date
            FROM subjects s
            LEFT JOIN inquiries i ON i.cib_subject_code = s.cib_subject_code
            GROUP BY s.cib_subject_code
            ORDER BY s.updated_at DESC
        `);
    }

    getSubjectCount() {
        const row = queryOne(this.db, "SELECT COUNT(*) AS cnt FROM subjects");
        return row ? row.cnt : 0;
    }

    getContractCount() {
        const row = queryOne(this.db, "SELECT COUNT(*) AS cnt FROM contracts");
        return row ? row.cnt : 0;
    }

    getAdverseSubjects() {
        return queryAll(this.db, `
            SELECT id, cib_subject_code, subject_type, name, trade_name,
                   risk_rating, risk_factors, source_file, updated_at
            FROM subjects
            WHERE risk_rating IN ('ADVERSE', 'HIGH RISK')
            ORDER BY updated_at DESC
        `);
    }

    getAdverseCount() {
        const row = queryOne(this.db, `
            SELECT COUNT(*) AS cnt FROM subjects
            WHERE risk_rating IN ('ADVERSE', 'HIGH RISK')
        `);
        return row ? row.cnt : 0;
    }

    getRelationshipData(cibCode) {
        // Borrowers guaranteed by this subject
        const borrowersRows = queryAll(this.db, `
            SELECT DISTINCT ls.cib_subject_code, ls.name, ls.role,
                   c.cib_contract_code
            FROM contracts c
            JOIN linked_subjects ls ON ls.contract_id = c.id
            WHERE c.cib_subject_code = ?
              AND c.role LIKE '%UARANTOR%'
              AND ls.role LIKE '%ORROWER%'
        `, [cibCode]);

        const borrowers = borrowersRows.map(entry => ({
            ...entry,
            in_db: this.subjectExists(entry.cib_subject_code || ''),
        }));

        // Co-guarantors
        const coGuarRows = queryAll(this.db, `
            SELECT DISTINCT ls.cib_subject_code, ls.name, ls.role,
                   c.cib_contract_code
            FROM contracts c
            JOIN linked_subjects ls ON ls.contract_id = c.id
            WHERE c.cib_subject_code = ?
              AND c.role LIKE '%UARANTOR%'
              AND ls.role LIKE '%UARANTOR%'
              AND ls.cib_subject_code != ?
        `, [cibCode, cibCode]);

        const coGuarantors = coGuarRows.map(entry => ({
            ...entry,
            in_db: this.subjectExists(entry.cib_subject_code || ''),
        }));

        // Proprietorships / owners from relationships table
        const relRows = queryAll(
            this.db,
            "SELECT * FROM relationships WHERE parent_subject_code = ?",
            [cibCode]
        );

        const owners = relRows.filter(r => r.relationship_type === 'owner');
        const proprietorshipsData = relRows
            .filter(r => r.relationship_type === 'proprietorship')
            .map(p => ({
                ...p,
                in_db: this.subjectExists(p.cib_subject_code || ''),
            }));

        return {
            borrowers,
            co_guarantors: coGuarantors,
            owners,
            proprietorships: proprietorshipsData,
        };
    }

    getProcessingLog(limit = 500) {
        return queryAll(this.db, `
            SELECT * FROM processing_log ORDER BY processed_at DESC LIMIT ?
        `, [limit]);
    }

    getCumulativeStats() {
        const batchRow = queryOne(this.db, `
            SELECT COUNT(*) AS total_batches,
                   COALESCE(SUM(success_count), 0) AS total_success,
                   COALESCE(SUM(replaced_count), 0) AS total_replaced,
                   COALESCE(SUM(failed_count), 0) AS total_failed
            FROM batches
        `);

        const totalBatches = batchRow ? batchRow.total_batches : 0;
        const totalSuccess = batchRow ? batchRow.total_success : 0;
        const totalReplaced = batchRow ? batchRow.total_replaced : 0;
        const totalFailed = batchRow ? batchRow.total_failed : 0;

        const totalSubjects = this.getSubjectCount();
        const totalContracts = this.getContractCount();

        const denom = totalSuccess + totalReplaced + totalFailed;
        const successRate = denom > 0 ? (totalSuccess + totalReplaced) / denom : 0.0;

        return {
            total_batches: totalBatches,
            total_subjects: totalSubjects,
            total_contracts: totalContracts,
            success_rate: successRate,
            parser_version: PARSER_VERSION,
        };
    }

    getAlertFlags(cibCode) {
        return queryAll(this.db, `
            SELECT * FROM alert_flags
            WHERE cib_subject_code = ? ORDER BY severity DESC, created_at DESC
        `, [cibCode]);
    }

    getPortfolioDashboard() {
        return queryOne(this.db, "SELECT * FROM v_portfolio_dashboard");
    }

    getExposureSummary(cibCode) {
        return queryOne(
            this.db,
            "SELECT * FROM v_exposure_summary WHERE cib_subject_code=?",
            [cibCode]
        );
    }

    getBatchList(limit = 50) {
        return queryAll(this.db,
            "SELECT * FROM batches ORDER BY id DESC LIMIT ?",
            [limit]
        );
    }

    getBatchEntries(batchId) {
        return queryAll(this.db, `
            SELECT * FROM processing_log
            WHERE batch_id = ? ORDER BY processed_at ASC
        `, [batchId]);
    }

    getLastBatchId() {
        const row = queryOne(this.db,
            "SELECT id FROM batches ORDER BY id DESC LIMIT 1"
        );
        return row ? row.id : null;
    }

    getLastUpdated() {
        const row = queryOne(this.db,
            "SELECT MAX(updated_at) AS last FROM subjects"
        );
        return (row && row.last) ? row.last : 'Never';
    }

    getInquiryTimeline(cibCode) {
        return queryAll(this.db, `
            SELECT i.*, ss.role, ss.bb_total_outstanding, ss.bb_total_overdue,
                   ss.bb_worst_classification
            FROM inquiries i
            LEFT JOIN summary_snapshots ss ON ss.inquiry_id = i.id
            WHERE i.cib_subject_code = ?
            ORDER BY i.inquiry_date DESC
        `, [cibCode]);
    }
}

export default CIBDatabase;
