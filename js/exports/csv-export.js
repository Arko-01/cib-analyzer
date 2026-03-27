/**
 * CIB Analyzer — CSV Exporter (Client-side)
 * ===========================================
 * Exports CIB data to flat CSV files for interoperability with other
 * systems (Excel, R, SAS, etc.). Produces multiple CSV files bundled
 * in a ZIP (using JSZip if available) or individual downloads:
 *
 *   subjects.csv         — one row per subject
 *   contracts.csv        — one row per contract
 *   monthly_history.csv  — one row per month per contract
 *   linked_subjects.csv  — other parties on contracts
 *   non_funded.csv       — non-funded facility summary
 *   processing_log.csv   — audit trail
 *
 * Can export from:
 *   - A single parsed report (dict)
 *   - The database (all or filtered subjects)
 */

import { APP_NAME, APP_VERSION } from '../config.js';

// ─────────────────────────── Helpers ──────────────────────────────

function downloadBlob(data, filename, mimeType) {
  const blob = new Blob([data], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Escape a CSV field value — wraps in double-quotes if it contains
 * comma, double-quote, or newline.
 */
function escapeCSV(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

/**
 * Convert an array of objects to a CSV string.
 * @param {string[]} headers - column header names
 * @param {Object[]|Array[]} rows - data rows (dicts or arrays)
 * @returns {string} CSV content with BOM for Excel compatibility
 */
function toCSV(headers, rows) {
  const lines = [];
  // UTF-8 BOM for Excel compatibility
  lines.push(headers.map(escapeCSV).join(','));

  for (const row of rows) {
    if (Array.isArray(row)) {
      lines.push(row.map(escapeCSV).join(','));
    } else {
      // dict row
      lines.push(headers.map(h => escapeCSV(row[h] !== undefined ? row[h] : '')).join(','));
    }
  }
  return '\uFEFF' + lines.join('\r\n');
}

// ─────────────────────────── Single Report Export ────────────────

/**
 * Build CSV file contents from a single parsed report.
 * Returns a Map of filename -> CSV string.
 *
 * @param {Object} report - parser-style report dict
 * @returns {Map<string, string>} filename -> CSV content
 */
function buildSingleReportCSVs(report) {
  const csvFiles = new Map();

  const subj = report.subject || {};
  const inq = report.inquiry || {};
  const match = report.match_status || {};
  const met = report.metrics || {};
  const addr = report.addresses || {};
  const cibCode = subj.cib_subject_code || 'UNKNOWN';

  // --- subjects.csv ---
  const subjHeaders = [
    'cib_subject_code', 'subject_type', 'name', 'father_name',
    'mother_name', 'spouse_name', 'dob', 'gender', 'nid_17', 'nid_10',
    'tin', 'telephone', 'district', 'trade_name',
    'present_address', 'permanent_address', 'office_address',
    'match_status', 'inquiry_date', 'fi_name',
    'worst_class_borrower', 'worst_class_guarantor',
    'has_willful_default', 'source_file',
  ];
  const subjRow = {};
  for (const k of subjHeaders) {
    if (k in subj) subjRow[k] = subj[k] || '';
  }
  Object.assign(subjRow, {
    present_address: addr.present || '',
    permanent_address: addr.permanent || '',
    office_address: addr.office || '',
    match_status: match.match_status || '',
    inquiry_date: inq.inquiry_date || '',
    fi_name: inq.fi_name || '',
    worst_class_borrower: met.worst_class_borrower || 'STD',
    worst_class_guarantor: met.worst_class_guarantor || 'STD',
    has_willful_default: met.has_willful_default ? 'Yes' : 'No',
    source_file: report.source_file || '',
  });
  csvFiles.set('subjects.csv', toCSV(subjHeaders, [subjRow]));

  // --- contracts.csv ---
  const conHeaders = [
    'cib_contract_code', 'cib_subject_code', 'role', 'phase',
    'facility_category', 'facility_type', 'start_date', 'end_date',
    'sanction_limit', 'installment_amount', 'total_installments',
    'remaining_count', 'remaining_amount', 'payment_method',
    'security_amount', 'security_type', 'reorganized_credit',
    'times_rescheduled', 'classification_date', 'lawsuit_date',
    'last_update',
  ];
  const conRows = [];
  for (const c of (report.contracts || [])) {
    const row = {};
    for (const k of conHeaders) row[k] = c[k] !== undefined ? c[k] : '';
    row.cib_subject_code = c.cib_subject_code || cibCode;
    conRows.push(row);
  }
  csvFiles.set('contracts.csv', toCSV(conHeaders, conRows));

  // --- monthly_history.csv ---
  const histHeaders = [
    'cib_contract_code', 'accounting_date', 'outstanding', 'overdue',
    'npi', 'sanction_limit', 'status', 'default_wd',
  ];
  const histRows = [];
  for (const c of (report.contracts || [])) {
    const code = c.cib_contract_code || '';
    for (const h of (c.monthly_history || [])) {
      const row = {};
      for (const k of histHeaders) row[k] = h[k] !== undefined ? h[k] : '';
      row.cib_contract_code = code;
      histRows.push(row);
    }
  }
  csvFiles.set('monthly_history.csv', toCSV(histHeaders, histRows));

  // --- linked_subjects.csv ---
  const linkHeaders = ['cib_contract_code', 'cib_subject_code', 'role', 'name'];
  const linkRows = [];
  for (const c of (report.contracts || [])) {
    const code = c.cib_contract_code || '';
    for (const ls of (c.linked_subjects || [])) {
      linkRows.push({
        cib_contract_code: code,
        cib_subject_code: ls.cib_subject_code || '',
        role: ls.role || '',
        name: ls.name || '',
      });
    }
  }
  csvFiles.set('linked_subjects.csv', toCSV(linkHeaders, linkRows));

  // --- non_funded.csv ---
  const nfHeaders = [
    'role', 'facility_type', 'living_count', 'living_amount',
    'terminated_count', 'terminated_amount', 'requested_count',
    'requested_amount', 'stay_order_count', 'stay_order_amount',
  ];
  const nfRows = [];
  for (const key of ['non_funded_borrower', 'non_funded_guarantor']) {
    for (const nf of (report[key] || [])) {
      const row = {};
      for (const k of nfHeaders) row[k] = nf[k] !== undefined ? nf[k] : '';
      nfRows.push(row);
    }
  }
  csvFiles.set('non_funded.csv', toCSV(nfHeaders, nfRows));

  return csvFiles;
}

// ─────────────────────────── Batch Export (from DB) ──────────────

/**
 * Build CSV file contents from all subjects in the database.
 * Returns a Map of filename -> CSV string.
 *
 * @param {Array} allSubjects - array of subject summary objects
 * @param {Object} db - database adapter with get_subject_full()
 * @returns {Map<string, string>} filename -> CSV content
 */
function buildBatchCSVs(allSubjects, db) {
  const csvFiles = new Map();

  // Subjects CSV
  if (allSubjects.length) {
    const headers = Object.keys(allSubjects[0]);
    csvFiles.set('subjects.csv', toCSV(headers, allSubjects));
  }

  // Full detail per subject
  const conRows = [];
  const histRows = [];
  const linkRows = [];

  for (const s of allSubjects) {
    const code = s.cib_subject_code;
    const full = db.getSubjectFull ? db.getSubjectFull(code) : (db.get_subject_full ? db.get_subject_full(code) : null);
    if (!full) continue;

    for (const c of (full.contracts || [])) {
      // Contract row (exclude nested arrays)
      const conRow = {};
      for (const [k, v] of Object.entries(c)) {
        if (k !== 'monthly_history' && k !== 'linked_subjects') {
          conRow[k] = v;
        }
      }
      conRows.push(conRow);

      // Monthly history
      for (const h of (c.monthly_history || [])) {
        h.cib_contract_code = c.cib_contract_code || '';
        histRows.push({ ...h });
      }

      // Linked subjects
      for (const ls of (c.linked_subjects || [])) {
        ls.cib_contract_code = c.cib_contract_code || '';
        linkRows.push({ ...ls });
      }
    }
  }

  if (conRows.length) {
    csvFiles.set('contracts.csv', toCSV(Object.keys(conRows[0]), conRows));
  }
  if (histRows.length) {
    csvFiles.set('monthly_history.csv', toCSV(Object.keys(histRows[0]), histRows));
  }
  if (linkRows.length) {
    csvFiles.set('linked_subjects.csv', toCSV(Object.keys(linkRows[0]), linkRows));
  }

  // Processing log
  const plog = db.getProcessingLog ? db.getProcessingLog(10000) : (db.get_processing_log ? db.get_processing_log(10000) : []);
  if (plog && plog.length) {
    csvFiles.set('processing_log.csv', toCSV(Object.keys(plog[0]), plog));
  }

  return csvFiles;
}

// ─────────────────────────── Download Triggers ───────────────────

/**
 * Download multiple CSV files. If JSZip is available globally, bundles
 * into a single ZIP. Otherwise downloads each CSV individually.
 *
 * @param {Map<string, string>} csvFiles - filename -> CSV content map
 * @param {string} zipName - name for the ZIP file
 */
async function downloadCSVFiles(csvFiles, zipName) {
  if (typeof JSZip !== 'undefined') {
    // Bundle into ZIP
    const zip = new JSZip();
    for (const [name, content] of csvFiles) {
      zip.file(name, content);
    }
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = zipName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } else {
    // Download each file individually
    for (const [name, content] of csvFiles) {
      downloadBlob(content, name, 'text/csv;charset=utf-8');
    }
  }
}

// ─────────────────────────── Public API ──────────────────────────

/**
 * Export all subjects from the database to CSV files.
 * Triggers a download (ZIP if JSZip available, else individual CSVs).
 *
 * @param {Array} allSubjects - array of subject summary objects
 * @param {Object} db - database adapter
 * @param {string} [zipFilename] - optional ZIP filename
 * @returns {Promise<Map<string, string>>} the CSV file map
 */
export async function exportCSV(allSubjects, db, zipFilename) {
  const csvFiles = buildBatchCSVs(allSubjects, db);
  const now = new Date();
  const ts = now.toISOString().slice(0, 10);
  const fname = zipFilename || `CIB_CSV_Export_${ts}.zip`;
  await downloadCSVFiles(csvFiles, fname);
  return csvFiles;
}

/**
 * Export a single parsed report to CSV files.
 *
 * @param {Object} report - parser-style report dict
 * @param {string} [zipFilename] - optional ZIP filename
 * @returns {Promise<Map<string, string>>} the CSV file map
 */
export async function exportSingleReportCSV(report, zipFilename) {
  const csvFiles = buildSingleReportCSVs(report);
  const cibCode = (report.subject || {}).cib_subject_code || 'export';
  const fname = zipFilename || `CIB_${cibCode}_CSV.zip`;
  await downloadCSVFiles(csvFiles, fname);
  return csvFiles;
}

export { downloadBlob, toCSV, escapeCSV, buildSingleReportCSVs, buildBatchCSVs };
