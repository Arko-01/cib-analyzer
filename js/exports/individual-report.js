/**
 * CIB Analyzer — Individual Report Generator (SheetJS / xlsx-js-style)
 * =====================================================================
 * Generates a single-subject detailed Excel report from the database.
 * This is the "Export Individual" feature — the user selects a subject
 * from the search results and exports their full CIB record as a
 * standalone .xlsx file suitable for credit review.
 *
 * The report reconstructs the parser-style dict from the database so
 * it can reuse the same Excel export engine.
 */

import { APP_NAME, APP_VERSION } from '../config.js';
import { exportSingleReport, downloadBlob } from './excel-export.js';

// ─────────────────────────── DB → Report Converter ───────────────

/**
 * Convert a database get_subject_full() result back into the
 * dict structure that exportSingleReport() expects (parser format).
 *
 * @param {Object} data - full subject record from DB
 * @returns {Object} report dict matching parser output format
 */
function dbSubjectToReport(data) {
  return {
    source_file: data.source_file || '',
    parse_timestamp: data.parse_timestamp || '',
    parser_version: data.parser_version || '',
    extraction_warnings: parseWarnings(data.extraction_warnings || '[]'),

    inquiry: {
      inquiry_date: data.inquiry_date || '',
      user_id: data.inquiry_user_id || '',
      fi_code: data.inquiry_fi_code || '',
      fi_name: data.inquiry_fi_name || '',
      branch_code: data.branch_code || '',
    },

    match_status: {
      match_status: data.match_status || '',
      contract_history_months: data.contract_history_months || '',
      contract_phase: data.contract_phase || '',
    },

    nid_verification: {
      nid_verified: !!data.nid_verified,
      name_from_nid_server: data.name_from_nid || '',
    },

    subject: {
      cib_subject_code: data.cib_subject_code || '',
      subject_type: data.subject_type || '',
      name: data.name || '',
      father_name: data.father_name || '',
      mother_name: data.mother_name || '',
      spouse_name: data.spouse_name || '',
      dob: data.dob || '',
      gender: data.gender || '',
      nid_17: data.nid_17 || '',
      nid_10: data.nid_10 || '',
      tin: data.tin || '',
      telephone: data.telephone || '',
      district: data.district || '',
      trade_name: data.trade_name || '',
      registration_no: data.registration_no || '',
      registration_date: data.registration_date || '',
      legal_form: data.legal_form || '',
      sector_type: data.sector_type || '',
      sector_code: data.sector_code || '',
      reference_number: data.reference_number || '',
    },

    addresses: {
      present: data.present_address || '',
      permanent: data.permanent_address || '',
      office: data.office_address || '',
      factory: data.factory_address || '',
    },

    summary_borrower: {
      reporting_institutes: data.b_reporting_institutes || 0,
      living_contracts: data.b_living_contracts || 0,
      total_outstanding: data.b_total_outstanding || 0,
      total_overdue: data.b_total_overdue || 0,
      stay_order_contracts: data.b_stay_order_contracts || 0,
      stay_order_outstanding: data.b_stay_order_outstanding || 0,
    },

    summary_guarantor: {
      reporting_institutes: data.g_reporting_institutes || 0,
      living_contracts: data.g_living_contracts || 0,
      total_outstanding: data.g_total_outstanding || 0,
      total_overdue: data.g_total_overdue || 0,
      stay_order_contracts: data.g_stay_order_contracts || 0,
      stay_order_outstanding: data.g_stay_order_outstanding || 0,
    },

    metrics: {
      worst_class_borrower: data.worst_class_borrower || 'STD',
      worst_class_guarantor: data.worst_class_guarantor || 'STD',
      ever_overdue_borrower: !!data.ever_overdue_borrower,
      max_overdue_borrower: data.max_overdue_borrower || 0,
      max_npi_borrower: data.max_npi_borrower || 0,
      ever_overdue_guarantor: !!data.ever_overdue_guarantor,
      max_overdue_guarantor: data.max_overdue_guarantor || 0,
      max_npi_guarantor: data.max_npi_guarantor || 0,
      has_willful_default: !!data.has_willful_default,
    },

    owners: data.owners || [],
    proprietorships: data.proprietorships || [],

    non_funded_borrower: (data.non_funded || []).filter(
      nf => (nf.role || '').toUpperCase() === 'BORROWER'
    ),
    non_funded_guarantor: (data.non_funded || []).filter(
      nf => (nf.role || '').toUpperCase() === 'GUARANTOR'
    ),

    contracts: data.contracts || [],
  };
}

/**
 * Parse the JSON warnings string from the DB.
 * @param {string} raw
 * @returns {Array<string>}
 */
function parseWarnings(raw) {
  try {
    return raw ? JSON.parse(raw) : [];
  } catch (_) {
    return [];
  }
}

// ─────────────────────────── Main Export ─────────────────────────

/**
 * Generate a full individual Excel report for a subject and trigger download.
 *
 * @param {Object} subjectData - full subject data from db.get_subject_full()
 * @param {Object} db - database adapter (unused here, kept for API consistency)
 * @param {string} [filename] - optional filename override
 * @returns {Uint8Array} xlsx binary data
 */
export function exportIndividualReport(subjectData, db, filename) {
  if (!subjectData) {
    throw new Error('Subject data is required for individual report');
  }

  const report = dbSubjectToReport(subjectData);

  const xlsxData = exportSingleReport(report);

  // Build filename
  const name = subjectData.name || subjectData.trade_name || subjectData.cib_subject_code || 'unknown';
  const safeName = name.replace(/[^a-zA-Z0-9 _-]/g, '').substring(0, 50).trim();
  const now = new Date();
  const ts = now.toISOString().replace(/[-:T]/g, '').substring(0, 15);
  const fname = filename || `CIB_${safeName}_${ts}.xlsx`;

  downloadBlob(xlsxData, fname, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

  return xlsxData;
}

export { dbSubjectToReport, parseWarnings, downloadBlob };
