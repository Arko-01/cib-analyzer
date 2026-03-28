/**
 * CIB Analyzer — CSV Exporter (Client-side)
 * ===========================================
 * Exports CIB data to flat CSV files matching the comprehensive Excel format.
 * Produces 9 CSV files bundled in a ZIP (via JSZip):
 *
 *   subjects.csv            — one row per subject (full demographics)
 *   summary_snapshots.csv   — BB-reported totals per role
 *   classification_matrix.csv — funded facility breakdown
 *   non_funded.csv          — non-funded facility summary
 *   contracts.csv           — all contracts with full metadata
 *   monthly_history.csv     — time series per contract
 *   linked_subjects.csv     — borrower/guarantor per contract
 *   owners_directors.csv    — company ownership
 *   proprietorships.csv     — sole proprietorship linkages
 */

import { APP_NAME, APP_VERSION } from '../config.js';
import { collectData } from './excel-export.js';

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

function escapeCSV(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function toCSV(headers, rows) {
  const lines = [];
  lines.push(headers.map(escapeCSV).join(','));
  for (const row of rows) {
    if (Array.isArray(row)) {
      lines.push(row.map(escapeCSV).join(','));
    } else {
      lines.push(headers.map(h => escapeCSV(row[h] !== undefined ? row[h] : '')).join(','));
    }
  }
  return '\uFEFF' + lines.join('\r\n');
}

// ─────────────────────────── Build CSVs ─────────────────────────

function buildCSVsFromData(data) {
  const csvFiles = new Map();

  // 1. Subjects
  const subjHeaders = [
    'cib_subject_code', 'subject_type', 'name', 'trade_name', 'father_name', 'mother_name',
    'spouse_name', 'dob', 'gender', 'nid_17', 'nid_10', 'tin',
    'district', 'sector_type', 'sector_code', 'legal_form',
    'registration_no', 'registration_date', 'telephone', 'match_status',
    'name_from_nid', 'present_address', 'permanent_address', 'office_address', 'factory_address',
    'contract_history_period', 'risk_rating', 'source_file',
  ];
  const subjRows = data.subjects.map(s => {
    const row = {};
    for (const h of subjHeaders) row[h] = s[h] ?? '';
    return row;
  });
  csvFiles.set('subjects.csv', toCSV(subjHeaders, subjRows));

  // 2. Summary Snapshots
  const sumHeaders = [
    'cib_subject_code', 'role', 'bb_reporting_institutes', 'bb_living_contracts',
    'bb_total_outstanding', 'bb_total_overdue', 'bb_stay_order_contracts',
    'bb_stay_order_outstanding', 'bb_worst_classification', 'bb_ever_overdue',
    'bb_max_overdue', 'bb_max_npi', 'bb_willful_default',
  ];
  const sumRows = data.summaries.map(s => {
    const row = {};
    for (const h of sumHeaders) row[h] = s[h] ?? '';
    return row;
  });
  csvFiles.set('summary_snapshots.csv', toCSV(sumHeaders, sumRows));

  // 3. Classification Matrix
  const clsHeaders = [
    'cib_subject_code', 'role', 'facility_type', 'classification',
    'contract_count', 'outstanding_amount',
  ];
  const clsRows = data.clsMatrix.map(c => {
    const row = {};
    for (const h of clsHeaders) row[h] = c[h] ?? '';
    return row;
  });
  csvFiles.set('classification_matrix.csv', toCSV(clsHeaders, clsRows));

  // 4. Non-Funded
  const nfHeaders = [
    'cib_subject_code', 'role', 'facility_type',
    'living_count', 'living_amount', 'terminated_count', 'terminated_amount',
    'requested_count', 'requested_amount', 'stay_order_count', 'stay_order_amount',
  ];
  const nfRows = data.nonFunded.map(n => {
    const row = {};
    for (const h of nfHeaders) row[h] = n[h] ?? '';
    return row;
  });
  csvFiles.set('non_funded.csv', toCSV(nfHeaders, nfRows));

  // 5. Contracts
  const conHeaders = [
    'cib_subject_code', 'cib_contract_code', 'fi_code', 'role', 'phase',
    'facility_type', 'facility_category', 'start_date', 'end_date', 'last_update',
    'last_payment_date', 'sanction_limit', 'total_disbursement', 'installment_amount',
    'total_installments', 'remaining_count', 'remaining_amount',
    'payment_method', 'periodicity', 'security_amount', 'security_type',
    'third_party_guarantee', 'reorganized_credit', 'times_rescheduled',
    'classification_date', 'rescheduling_date', 'lawsuit_date',
    'worst_ever_classification', 'max_overdue_amount', 'max_npi', 'contract_risk', 'source_file',
  ];
  const conRows = data.contracts.map(c => {
    const row = {};
    for (const h of conHeaders) row[h] = c[h] ?? '';
    return row;
  });
  csvFiles.set('contracts.csv', toCSV(conHeaders, conRows));

  // 6. Monthly History
  const histHeaders = [
    'cib_subject_code', 'cib_contract_code', 'accounting_date',
    'outstanding', 'overdue', 'npi', 'sanction_limit', 'status', 'default_wd', 'remarks_wd',
  ];
  const histRows = data.history.map(h => {
    const row = {};
    for (const k of histHeaders) row[k] = h[k] ?? '';
    return row;
  });
  csvFiles.set('monthly_history.csv', toCSV(histHeaders, histRows));

  // 7. Linked Subjects
  const linkHeaders = ['parent_subject_code', 'cib_contract_code', 'cib_subject_code', 'role', 'name'];
  const linkRows = data.linked.map(l => {
    const row = {};
    for (const h of linkHeaders) row[h] = l[h] ?? '';
    return row;
  });
  csvFiles.set('linked_subjects.csv', toCSV(linkHeaders, linkRows));

  // 8. Owners & Directors
  const ownHeaders = ['parent_subject_code', 'cib_subject_code', 'name', 'role', 'stay_order'];
  const ownRows = data.owners.map(o => {
    const row = {};
    for (const h of ownHeaders) row[h] = o[h] ?? '';
    return row;
  });
  csvFiles.set('owners_directors.csv', toCSV(ownHeaders, ownRows));

  // 9. Proprietorships
  const propHeaders = ['parent_subject_code', 'cib_subject_code', 'trade_name', 'sector_type', 'sector_code'];
  const propRows = data.proprietorships.map(p => {
    const row = {};
    for (const h of propHeaders) row[h] = p[h] ?? '';
    return row;
  });
  csvFiles.set('proprietorships.csv', toCSV(propHeaders, propRows));

  return csvFiles;
}

// ─────────────────────────── Download ───────────────────────────

async function downloadCSVFiles(csvFiles, zipName) {
  if (typeof JSZip !== 'undefined') {
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
    for (const [name, content] of csvFiles) {
      downloadBlob(content, name, 'text/csv;charset=utf-8');
    }
  }
}

// ─────────────────────────── Public API ──────────────────────────

/**
 * Export all subjects from the database to CSV files (comprehensive format).
 */
export async function exportCSV(allSubjects, db, zipFilename) {
  const cibCodes = allSubjects.map(s => s.cib_subject_code);
  const data = collectData(cibCodes, db);
  const csvFiles = buildCSVsFromData(data);
  const fname = zipFilename || `CIB_CSV_Export_${new Date().toISOString().slice(0, 10)}.zip`;
  await downloadCSVFiles(csvFiles, fname);
  return csvFiles;
}

export { downloadBlob, toCSV, escapeCSV };
