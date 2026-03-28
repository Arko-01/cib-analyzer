/**
 * CIB Analyzer — Individual Report Generator (SheetJS / xlsx-js-style)
 * =====================================================================
 * Generates a single-subject detailed Excel report from the database.
 * Uses the same 10-sheet template as Master Export.
 */

import { exportSingleReport, downloadBlob } from './excel-export.js';

/**
 * Generate a full individual Excel report for a subject and trigger download.
 *
 * @param {Object} subjectData - full subject data from db.getSubjectFull()
 * @param {Object} db - database adapter
 * @param {string} [filename] - optional filename override
 * @returns {Uint8Array} xlsx binary data
 */
export function exportIndividualReport(subjectData, db, filename) {
  if (!subjectData) {
    throw new Error('Subject data is required for individual report');
  }

  const xlsxData = exportSingleReport(subjectData, db);

  const name = subjectData.name || subjectData.trade_name || subjectData.cib_subject_code || 'unknown';
  const safeName = name.replace(/[^a-zA-Z0-9 _-]/g, '').substring(0, 50).trim();
  const now = new Date();
  const ts = now.toISOString().replace(/[-:T]/g, '').substring(0, 15);
  const fname = filename || `CIB_${safeName}_${ts}.xlsx`;

  downloadBlob(xlsxData, fname, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

  return xlsxData;
}

export { downloadBlob };
