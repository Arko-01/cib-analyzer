/**
 * CIB Analyzer — Excel Exporter (SheetJS / xlsx-js-style)
 * ========================================================
 * Exports parsed CIB data to professionally formatted .xlsx workbooks.
 *
 * Two export modes share the same 10-sheet template:
 *   - Master Export: all subjects aggregated
 *   - Individual Report: single subject
 *
 * Sheets:
 *   1. Subjects           — Identity, demographics, addresses
 *   2. Summary Snapshots  — BB-reported totals per role
 *   3. Classification Matrix — Funded facility breakdown
 *   4. Non-Funded          — GU/LC/OF facility summary
 *   5. Contracts           — All contracts with full metadata
 *   6. Monthly History     — Time series per contract
 *   7. Linked Subjects     — Borrower/Guarantor per contract
 *   8. Owners & Directors  — Company ownership
 *   9. Proprietorships     — Sole proprietorship linkages
 *  10. Dashboard Summary   — Portfolio overview with key metrics
 */

import {
  HEADER_BG_COLOR, HEADER_FONT_COLOR, TITLE_BG_COLOR, TITLE_FONT_COLOR,
  SECTION_BG_COLOR, ALERT_BG_COLOR, GREEN_BG_COLOR, AMBER_BG_COLOR,
  AMOUNT_FORMAT, ADVERSE_CLASSIFICATIONS,
  APP_NAME, APP_VERSION,
} from '../config.js';

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

// ─────────────────────────── Styles ──────────────────────────────

const _HEADER_FONT = { name: 'Arial', bold: true, color: { rgb: HEADER_FONT_COLOR }, sz: 10 };
const _HEADER_FILL = { patternType: 'solid', fgColor: { rgb: HEADER_BG_COLOR } };
const _TITLE_FONT = { name: 'Arial', bold: true, color: { rgb: TITLE_FONT_COLOR }, sz: 12 };
const _TITLE_FILL = { patternType: 'solid', fgColor: { rgb: TITLE_BG_COLOR } };
const _SECTION_FILL = { patternType: 'solid', fgColor: { rgb: SECTION_BG_COLOR } };
const _SECTION_FONT = { name: 'Arial', bold: true, sz: 10 };
const _ALERT_FILL = { patternType: 'solid', fgColor: { rgb: ALERT_BG_COLOR } };
const _GREEN_FILL = { patternType: 'solid', fgColor: { rgb: GREEN_BG_COLOR } };
const _AMBER_FILL = { patternType: 'solid', fgColor: { rgb: AMBER_BG_COLOR } };
const _NORMAL_FONT = { name: 'Arial', sz: 10 };
const _BOLD_FONT = { name: 'Arial', bold: true, sz: 10 };
const _ALT_FILL = { patternType: 'solid', fgColor: { rgb: 'F2F6FC' } };

const _THIN_BORDER = {
  top:    { style: 'thin', color: { rgb: 'D0D0D0' } },
  bottom: { style: 'thin', color: { rgb: 'D0D0D0' } },
  left:   { style: 'thin', color: { rgb: 'D0D0D0' } },
  right:  { style: 'thin', color: { rgb: 'D0D0D0' } },
};

const _CENTER = { horizontal: 'center', vertical: 'center', wrapText: true };

function cellRef(r, c) {
  return XLSX.utils.encode_cell({ r, c });
}

function setCell(ws, r, c, value, style) {
  const ref = cellRef(r, c);
  ws[ref] = { v: value, t: typeof value === 'number' ? 'n' : 's', s: style || {} };
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
  if (r > range.e.r) range.e.r = r;
  if (c > range.e.c) range.e.c = c;
  ws['!ref'] = XLSX.utils.encode_range(range);
}

function initSheet() {
  const ws = {};
  ws['!ref'] = 'A1';
  ws['!merges'] = [];
  ws['!cols'] = [];
  return ws;
}

function autoWidth(ws, minWidth = 10, maxWidth = 45) {
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
  const cols = [];
  for (let c = range.s.c; c <= range.e.c; c++) {
    let best = minWidth;
    for (let r = range.s.r; r <= Math.min(range.e.r, 100); r++) {
      const cell = ws[cellRef(r, c)];
      if (cell && cell.v != null) {
        best = Math.max(best, Math.min(String(cell.v).length + 2, maxWidth));
      }
    }
    cols.push({ wch: best });
  }
  ws['!cols'] = cols;
}

/**
 * Write a data table to a worksheet with headers, alternating row fills, and formatting.
 */
function writeTable(ws, headers, rows, { startRow = 0, amountCols = [], dateCols = [] } = {}) {
  const amountSet = new Set(amountCols);
  const dateSet = new Set(dateCols);

  // Header row
  for (let c = 0; c < headers.length; c++) {
    setCell(ws, startRow, c, headers[c], {
      font: _HEADER_FONT, fill: _HEADER_FILL, alignment: _CENTER, border: _THIN_BORDER,
    });
  }

  // Data rows
  for (let r = 0; r < rows.length; r++) {
    const rowData = rows[r];
    const altFill = r % 2 === 1 ? _ALT_FILL : null;
    for (let c = 0; c < rowData.length; c++) {
      const val = rowData[c] ?? '';
      const style = { font: _NORMAL_FONT, border: _THIN_BORDER };
      if (altFill) style.fill = altFill;

      if (amountSet.has(headers[c])) {
        style.numFmt = AMOUNT_FORMAT;
        style.alignment = { horizontal: 'right' };
        setCell(ws, startRow + 1 + r, c, typeof val === 'number' ? val : 0, style);
        ws[cellRef(startRow + 1 + r, c)].t = 'n';
      } else if (dateSet.has(headers[c])) {
        style.alignment = { horizontal: 'center' };
        setCell(ws, startRow + 1 + r, c, val, style);
      } else {
        setCell(ws, startRow + 1 + r, c, val, style);
      }
    }
  }

  return startRow + 1 + rows.length;
}

// ─────────────────────────── Data Collection ────────────────────

/**
 * Collect comprehensive data for one or more subjects.
 * @param {string[]} cibCodes - array of CIB subject codes
 * @param {Object} db - database adapter with getSubjectFull()
 * @returns {Object} collected data across all tables
 */
function collectData(cibCodes, db) {
  const subjects = [];
  const summaries = [];
  const clsMatrix = [];
  const nonFunded = [];
  const contracts = [];
  const history = [];
  const linked = [];
  const owners = [];
  const proprietorships = [];

  for (const code of cibCodes) {
    const full = db.getSubjectFull(code);
    if (!full) continue;

    // Subject row
    subjects.push(full);

    // Summary snapshots
    for (const ss of (full.summary_snapshots || [])) {
      summaries.push({ ...ss, cib_subject_code: code });
    }

    // Classification matrix
    for (const cm of (full.classification_matrix || [])) {
      clsMatrix.push({ ...cm, cib_subject_code: code });
    }

    // Non-funded
    for (const nf of (full.non_funded || [])) {
      nonFunded.push({ ...nf, cib_subject_code: code });
    }

    // Contracts, history, linked subjects
    for (const c of (full.contracts || [])) {
      contracts.push({ ...c, cib_subject_code: code });

      for (const h of (c.monthly_history || [])) {
        history.push({
          ...h,
          cib_subject_code: code,
          cib_contract_code: c.cib_contract_code || '',
        });
      }

      for (const ls of (c.linked_subjects || [])) {
        linked.push({
          ...ls,
          parent_subject_code: code,
          cib_contract_code: c.cib_contract_code || '',
        });
      }
    }

    // Relationships (owners, directors, proprietorships)
    for (const rel of (full.relationships || [])) {
      const relRole = (rel.role || '').toLowerCase();
      if (relRole.includes('proprietor') || rel.trade_name) {
        proprietorships.push({ ...rel, parent_subject_code: code });
      } else {
        owners.push({ ...rel, parent_subject_code: code });
      }
    }
  }

  return { subjects, summaries, clsMatrix, nonFunded, contracts, history, linked, owners, proprietorships };
}

// ─────────────────────────── Sheet Builders ──────────────────────

function buildSubjectsSheet(wb, data) {
  const ws = initSheet();
  const headers = [
    'CIB Subject Code', 'Subject Type', 'Name', 'Trade Name', 'Father Name', 'Mother Name',
    'Spouse Name', 'Date of Birth', 'Gender', 'NID (17)', 'NID (10)', 'TIN',
    'District', 'Sector Type', 'Sector Code', 'Legal Form',
    'Registration No', 'Registration Date', 'Telephone', 'NID Match Status',
    'Name from NID', 'Present Address', 'Permanent Address', 'Office Address', 'Factory Address',
    'Contract History Period', 'Risk Rating', 'Source File',
  ];

  const rows = data.subjects.map(s => [
    s.cib_subject_code || '', s.subject_type || '', s.name || '', s.trade_name || '',
    s.father_name || '', s.mother_name || '', s.spouse_name || '',
    s.dob || '', s.gender || '', s.nid_17 || '', s.nid_10 || '', s.tin || '',
    s.district || '', s.sector_type || '', s.sector_code || '', s.legal_form || '',
    s.registration_no || '', s.registration_date || '', s.telephone || '',
    s.match_status || '', s.name_from_nid || '',
    s.present_address || '', s.permanent_address || '', s.office_address || '', s.factory_address || '',
    s.contract_history_period || '', s.risk_rating || '', s.source_file || '',
  ]);

  writeTable(ws, headers, rows, { dateCols: ['Date of Birth', 'Registration Date'] });
  autoWidth(ws);
  XLSX.utils.book_append_sheet(wb, ws, 'Subjects');
}

function buildSummarySheet(wb, data) {
  const ws = initSheet();
  const headers = [
    'CIB Subject Code', 'Role', 'Reporting Institutes', 'Living Contracts',
    'Total Outstanding', 'Total Overdue', 'Stay Order Contracts',
    'Stay Order Outstanding', 'Worst Classification', 'Ever Overdue', 'Max Overdue',
    'Max NPI', 'Willful Default',
  ];

  const rows = data.summaries.map(s => [
    s.cib_subject_code || '', s.role || '',
    s.bb_reporting_institutes || 0, s.bb_living_contracts || 0,
    s.bb_total_outstanding || 0, s.bb_total_overdue || 0,
    s.bb_stay_order_contracts || 0, s.bb_stay_order_outstanding || 0,
    s.bb_worst_classification || '', s.bb_ever_overdue || '',
    s.bb_max_overdue || 0, s.bb_max_npi || 0, s.bb_willful_default || '',
  ]);

  writeTable(ws, headers, rows, {
    amountCols: ['Total Outstanding', 'Total Overdue', 'Stay Order Outstanding', 'Max Overdue'],
  });
  autoWidth(ws);
  XLSX.utils.book_append_sheet(wb, ws, 'Summary Snapshots');
}

function buildClassificationSheet(wb, data) {
  const ws = initSheet();
  const headers = [
    'CIB Subject Code', 'Role', 'Facility Type', 'Classification',
    'Contract Count', 'Outstanding Amount',
  ];

  const rows = data.clsMatrix.map(c => [
    c.cib_subject_code || '', c.role || '', c.facility_type || '', c.classification || '',
    c.contract_count || 0, c.outstanding_amount || 0,
  ]);

  writeTable(ws, headers, rows, { amountCols: ['Outstanding Amount'] });
  autoWidth(ws);
  XLSX.utils.book_append_sheet(wb, ws, 'Classification Matrix');
}

function buildNonFundedSheet(wb, data) {
  const ws = initSheet();
  const headers = [
    'CIB Subject Code', 'Role', 'Facility Type',
    'Living Count', 'Living Amount', 'Terminated Count', 'Terminated Amount',
    'Requested Count', 'Requested Amount', 'Stay Order Count', 'Stay Order Amount',
  ];

  const rows = data.nonFunded.map(n => [
    n.cib_subject_code || '', n.role || '', n.facility_type || '',
    n.living_count || 0, n.living_amount || 0,
    n.terminated_count || 0, n.terminated_amount || 0,
    n.requested_count || 0, n.requested_amount || 0,
    n.stay_order_count || 0, n.stay_order_amount || 0,
  ]);

  writeTable(ws, headers, rows, {
    amountCols: ['Living Amount', 'Terminated Amount', 'Requested Amount', 'Stay Order Amount'],
  });
  autoWidth(ws);
  XLSX.utils.book_append_sheet(wb, ws, 'Non-Funded Facilities');
}

function buildContractsSheet(wb, data) {
  const ws = initSheet();
  const headers = [
    'CIB Subject Code', 'CIB Contract Code', 'FI Code', 'Role', 'Phase',
    'Facility Type', 'Facility Category', 'Start Date', 'End Date', 'Last Update',
    'Last Payment Date', 'Sanction Limit', 'Total Disbursement', 'Installment Amount',
    'Total Installments', 'Remaining Count', 'Remaining Amount',
    'Payment Method', 'Periodicity', 'Security Amount', 'Security Type',
    'Third Party Guarantee', 'Reorganized Credit', 'Times Rescheduled',
    'Classification Date', 'Rescheduling Date', 'Lawsuit Date',
    'Worst Classification', 'Max Overdue', 'Max NPI', 'Contract Risk', 'Source File',
  ];

  const rows = data.contracts.map(c => [
    c.cib_subject_code || '', c.cib_contract_code || '', c.fi_code || '',
    c.role || '', c.phase || '', c.facility_type || '', c.facility_category || '',
    c.start_date || '', c.end_date || '', c.last_update || '', c.last_payment_date || '',
    c.sanction_limit || 0, c.total_disbursement || 0, c.installment_amount || 0,
    c.total_installments || 0, c.remaining_count || 0, c.remaining_amount || 0,
    c.payment_method || '', c.periodicity || '', c.security_amount || 0, c.security_type || '',
    c.third_party_guarantee || 0, c.reorganized_credit || '', c.times_rescheduled || 0,
    c.classification_date || '', c.rescheduling_date || '', c.lawsuit_date || '',
    c.worst_ever_classification || '', c.max_overdue_amount || 0, c.max_npi || 0,
    c.contract_risk || '', c.source_file || '',
  ]);

  writeTable(ws, headers, rows, {
    amountCols: ['Sanction Limit', 'Total Disbursement', 'Installment Amount', 'Remaining Amount',
                 'Security Amount', 'Third Party Guarantee', 'Max Overdue'],
    dateCols: ['Start Date', 'End Date', 'Last Update', 'Last Payment Date',
               'Classification Date', 'Rescheduling Date', 'Lawsuit Date'],
  });
  autoWidth(ws);
  XLSX.utils.book_append_sheet(wb, ws, 'Contracts');
}

function buildHistorySheet(wb, data) {
  const ws = initSheet();
  const headers = [
    'CIB Subject Code', 'CIB Contract Code', 'Accounting Date',
    'Outstanding', 'Overdue', 'NPI', 'Sanction Limit', 'Status', 'Default & WD', 'Remarks WD',
  ];

  const rows = data.history.map(h => [
    h.cib_subject_code || '', h.cib_contract_code || '', h.accounting_date || '',
    h.outstanding || 0, h.overdue || 0, h.npi ?? '', h.sanction_limit ?? '',
    h.status || '', h.default_wd || '', h.remarks_wd || '',
  ]);

  writeTable(ws, headers, rows, {
    amountCols: ['Outstanding', 'Overdue', 'Sanction Limit'],
    dateCols: ['Accounting Date'],
  });
  autoWidth(ws);
  XLSX.utils.book_append_sheet(wb, ws, 'Monthly History');
}

function buildLinkedSheet(wb, data) {
  const ws = initSheet();
  const headers = ['Parent Subject Code', 'CIB Contract Code', 'Linked CIB Code', 'Role', 'Name'];

  const rows = data.linked.map(l => [
    l.parent_subject_code || '', l.cib_contract_code || '',
    l.cib_subject_code || '', l.role || '', l.name || '',
  ]);

  writeTable(ws, headers, rows);
  autoWidth(ws);
  XLSX.utils.book_append_sheet(wb, ws, 'Linked Subjects');
}

function buildOwnersSheet(wb, data) {
  const ws = initSheet();
  const headers = ['Parent Subject Code', 'CIB Subject Code', 'Name', 'Role', 'Stay Order'];

  const rows = data.owners.map(o => [
    o.parent_subject_code || '', o.cib_subject_code || '',
    o.name || '', o.role || '', o.stay_order || '',
  ]);

  writeTable(ws, headers, rows);
  autoWidth(ws);
  XLSX.utils.book_append_sheet(wb, ws, 'Owners & Directors');
}

function buildProprietorshipsSheet(wb, data) {
  const ws = initSheet();
  const headers = ['Parent Subject Code', 'CIB Subject Code', 'Trade Name', 'Sector Type', 'Sector Code'];

  const rows = data.proprietorships.map(p => [
    p.parent_subject_code || '', p.cib_subject_code || '',
    p.trade_name || '', p.sector_type || '', p.sector_code || '',
  ]);

  writeTable(ws, headers, rows);
  autoWidth(ws);
  XLSX.utils.book_append_sheet(wb, ws, 'Proprietorships');
}

function buildDashboardSheet(wb, data) {
  const ws = initSheet();

  // Title
  setCell(ws, 0, 0, `CIB Portfolio Dashboard \u2014 ${APP_NAME} v${APP_VERSION}`, {
    font: _TITLE_FONT, fill: _TITLE_FILL, alignment: _CENTER,
  });
  ws['!merges'].push({ s: { r: 0, c: 0 }, e: { r: 0, c: 6 } });

  const now = new Date();
  setCell(ws, 1, 0, `Generated: ${now.toISOString().replace('T', ' ').substring(0, 19)}`, {
    font: { name: 'Arial', sz: 9, italic: true, color: { rgb: '888888' } },
  });

  // Portfolio metrics
  let row = 3;
  setCell(ws, row, 0, 'PORTFOLIO OVERVIEW', { font: _SECTION_FONT, fill: _SECTION_FILL });
  ws['!merges'].push({ s: { r: row, c: 0 }, e: { r: row, c: 1 } });
  row++;

  const livingContracts = data.contracts.filter(c => (c.phase || '').toLowerCase() === 'living');
  const terminatedContracts = data.contracts.filter(c => (c.phase || '').toLowerCase() !== 'living');

  const metrics = [
    ['Total Subjects', data.subjects.length],
    ['Total Contracts', data.contracts.length],
    ['Living Contracts', livingContracts.length],
    ['Terminated Contracts', terminatedContracts.length],
    ['Total History Records', data.history.length],
    ['Total Linked Parties', data.linked.length],
  ];
  for (const [label, val] of metrics) {
    setCell(ws, row, 0, label, { font: _NORMAL_FONT, border: _THIN_BORDER });
    setCell(ws, row, 1, val, { font: _BOLD_FONT, border: _THIN_BORDER });
    ws[cellRef(row, 1)].t = 'n';
    ws[cellRef(row, 1)].s.numFmt = '#,##0';
    row++;
  }

  // Subject breakdown
  row++;
  setCell(ws, row, 0, 'SUBJECT BREAKDOWN', { font: _SECTION_FONT, fill: _SECTION_FILL });
  ws['!merges'].push({ s: { r: row, c: 0 }, e: { r: row, c: 6 } });
  row++;

  const breakdownHeaders = ['Subject', 'Type', 'Risk', 'Living (B)', 'Living (G)', 'Total Outstanding', 'Contracts'];
  for (let c = 0; c < breakdownHeaders.length; c++) {
    setCell(ws, row, c, breakdownHeaders[c], {
      font: _HEADER_FONT, fill: _HEADER_FILL, alignment: _CENTER, border: _THIN_BORDER,
    });
  }
  row++;

  for (const s of data.subjects) {
    const code = s.cib_subject_code;
    const subjContracts = data.contracts.filter(c => c.cib_subject_code === code);
    const livingB = subjContracts.filter(c => (c.phase || '').toLowerCase() === 'living' && (c.role || '').toLowerCase().includes('orrower')).length;
    const livingG = subjContracts.filter(c => (c.phase || '').toLowerCase() === 'living' && (c.role || '').toLowerCase().includes('uarantor')).length;
    const totalOut = data.summaries
      .filter(ss => ss.cib_subject_code === code)
      .reduce((sum, ss) => sum + (ss.bb_total_outstanding || 0), 0);

    const vals = [
      s.name || s.trade_name || '', s.subject_type || '', s.risk_rating || '',
      livingB, livingG, totalOut, subjContracts.length,
    ];
    for (let c = 0; c < vals.length; c++) {
      const style = { font: _NORMAL_FONT, border: _THIN_BORDER };
      if (c === 5) { style.numFmt = AMOUNT_FORMAT; style.alignment = { horizontal: 'right' }; }
      setCell(ws, row, c, vals[c], style);
      if (typeof vals[c] === 'number') ws[cellRef(row, c)].t = 'n';
    }
    row++;
  }

  // Set column widths
  ws['!cols'] = [
    { wch: 35 }, { wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 20 }, { wch: 12 },
  ];

  XLSX.utils.book_append_sheet(wb, ws, 'Dashboard Summary');
}

// ─────────────────────────── Build Workbook ──────────────────────

function buildWorkbook(data) {
  const wb = XLSX.utils.book_new();
  buildSubjectsSheet(wb, data);
  buildSummarySheet(wb, data);
  buildClassificationSheet(wb, data);
  buildNonFundedSheet(wb, data);
  buildContractsSheet(wb, data);
  buildHistorySheet(wb, data);
  buildLinkedSheet(wb, data);
  buildOwnersSheet(wb, data);
  buildProprietorshipsSheet(wb, data);
  buildDashboardSheet(wb, data);
  return wb;
}

// ─────────────────────────── Public API ──────────────────────────

/**
 * Export all subjects into a comprehensive 10-sheet Excel workbook.
 * Triggers a browser download.
 */
export function exportMasterExcel(allSubjects, db, filename) {
  const cibCodes = allSubjects.map(s => s.cib_subject_code);
  const data = collectData(cibCodes, db);
  const wb = buildWorkbook(data);
  const xlsxData = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const fname = filename || `CIB_Master_Export_${new Date().toISOString().slice(0, 10)}.xlsx`;
  downloadBlob(xlsxData, fname, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  return xlsxData;
}

/**
 * Export a single subject into the same 10-sheet Excel format.
 * Called from individual-report.js.
 */
export function exportSingleReport(subjectData, db) {
  const code = subjectData.cib_subject_code;
  const data = collectData([code], db);
  const wb = buildWorkbook(data);
  return XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
}

export { downloadBlob, collectData, buildWorkbook };
