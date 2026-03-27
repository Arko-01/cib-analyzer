/**
 * CIB Analyzer — Excel Exporter (SheetJS / xlsx-js-style)
 * ========================================================
 * Exports parsed CIB data to a professionally formatted .xlsx workbook
 * with 8 sheets:
 *
 *   1. Summary         — Key metrics, risk flags, classification overview
 *   2. Subject Info     — Personal / company identity details
 *   3. Facility Matrix  — Funded facility classification matrix (1A/2A)
 *   4. Non-Funded       — Non-funded facility summary (1B/2B)
 *   5. Contract Details — All contracts with key fields
 *   6. Monthly History  — Full monthly history for all contracts
 *   7. Linked Parties   — Owners, proprietorships, linked subjects
 *   8. Processing Info  — Extraction metadata, warnings, inquiry details
 *
 * Can export:
 *   - A single report (from parser output dict)
 *   - A batch of subjects (from database query results)
 */

import {
  HEADER_BG_COLOR, HEADER_FONT_COLOR, TITLE_BG_COLOR, TITLE_FONT_COLOR,
  SECTION_BG_COLOR, ALERT_BG_COLOR, GREEN_BG_COLOR, AMBER_BG_COLOR,
  AMOUNT_FORMAT, DATE_FORMAT, ADVERSE_CLASSIFICATIONS, CLASSIFICATION_ORDER,
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

const _THIN_BORDER = {
  top:    { style: 'thin' },
  bottom: { style: 'thin' },
  left:   { style: 'thin' },
  right:  { style: 'thin' },
};

const _CENTER = { horizontal: 'center', vertical: 'center', wrapText: true };
const _LEFT_WRAP = { horizontal: 'left', vertical: 'top', wrapText: true };

/**
 * Encode a (row, col) pair into an Excel cell address like "A1".
 * row and col are 0-based.
 */
function cellRef(r, c) {
  return XLSX.utils.encode_cell({ r, c });
}

function setCell(ws, r, c, value, style) {
  const ref = cellRef(r, c);
  ws[ref] = { v: value, t: typeof value === 'number' ? 'n' : 's', s: style || {} };
  // Expand range
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

function styleHeaderRow(ws, row, maxCol) {
  for (let c = 0; c < maxCol; c++) {
    const ref = cellRef(row, c);
    if (!ws[ref]) ws[ref] = { v: '', t: 's' };
    ws[ref].s = {
      font: _HEADER_FONT,
      fill: _HEADER_FILL,
      alignment: _CENTER,
      border: _THIN_BORDER,
    };
  }
}

function styleCell(ws, r, c, { isAmount = false, isAlert = false, isGreen = false, isAmber = false } = {}) {
  const ref = cellRef(r, c);
  if (!ws[ref]) return;
  const s = { font: _NORMAL_FONT, border: _THIN_BORDER };
  if (isAmount) {
    s.numFmt = AMOUNT_FORMAT;
    s.alignment = { horizontal: 'right' };
    ws[ref].t = 'n';
    if (ws[ref].v === '' || ws[ref].v === null || ws[ref].v === undefined) ws[ref].v = 0;
  }
  if (isAlert)      s.fill = _ALERT_FILL;
  else if (isGreen) s.fill = _GREEN_FILL;
  else if (isAmber) s.fill = _AMBER_FILL;
  ws[ref].s = s;
}

function autoWidth(ws, minWidth = 10, maxWidth = 45) {
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
  const cols = [];
  for (let c = range.s.c; c <= range.e.c; c++) {
    let best = minWidth;
    for (let r = range.s.r; r <= range.e.r; r++) {
      const cell = ws[cellRef(r, c)];
      if (cell && cell.v != null) {
        best = Math.max(best, Math.min(String(cell.v).length + 2, maxWidth));
      }
    }
    cols.push({ wch: best });
  }
  ws['!cols'] = cols;
}

function writeTitle(ws, title, row = 0, colSpan = 8) {
  setCell(ws, row, 0, title, {
    font: _TITLE_FONT,
    fill: _TITLE_FILL,
    alignment: _CENTER,
  });
  ws['!merges'].push({ s: { r: row, c: 0 }, e: { r: row, c: colSpan - 1 } });
}

function writeSection(ws, label, row, colSpan = 8) {
  setCell(ws, row, 0, label, {
    font: _SECTION_FONT,
    fill: _SECTION_FILL,
  });
  ws['!merges'].push({ s: { r: row, c: 0 }, e: { r: row, c: colSpan - 1 } });
}

// ─────────────────────────── Sheet 1: Summary ────────────────────

function writeSummarySheet(wb, report) {
  const ws = initSheet();
  const subj = report.subject || {};
  const sb = report.summary_borrower || {};
  const sg = report.summary_guarantor || {};
  const met = report.metrics || {};
  const match = report.match_status || {};

  const name = subj.name || subj.trade_name || 'N/A';
  const cibCode = subj.cib_subject_code || 'N/A';

  writeTitle(ws, `CIB Analysis Summary \u2014 ${name}`, 0, 6);

  // Key info block
  const kvData = [
    ['CIB Subject Code', cibCode],
    ['Subject Type', subj.subject_type || ''],
    ['Name / Trade Name', name],
    ["Father's Name", subj.father_name || ''],
    ['NID (17-digit)', subj.nid_17 || ''],
    ['Match Status', match.match_status || ''],
    ['Inquiry Date', (report.inquiry || {}).inquiry_date || ''],
    ['Source File', report.source_file || ''],
  ];

  let row = 2;
  for (const [label, value] of kvData) {
    setCell(ws, row, 0, label, { font: _BOLD_FONT, border: _THIN_BORDER });
    setCell(ws, row, 1, value, { font: _NORMAL_FONT, border: _THIN_BORDER });
    row++;
  }

  // Risk summary section
  row++;
  writeSection(ws, 'Risk Summary', row, 6);
  row++;

  const riskData = [
    ['Worst Classification (Borrower)', met.worst_class_borrower || 'STD'],
    ['Worst Classification (Guarantor)', met.worst_class_guarantor || 'STD'],
    ['Ever Overdue (Borrower)', met.ever_overdue_borrower ? 'Yes' : 'No'],
    ['Max Overdue Amount (Borrower)', met.max_overdue_borrower || 0],
    ['Max NPI (Borrower)', met.max_npi_borrower || 0],
    ['Willful Default', met.has_willful_default ? 'YES' : 'No'],
  ];

  for (const [label, value] of riskData) {
    setCell(ws, row, 0, label, { font: _BOLD_FONT, border: _THIN_BORDER });

    let isAlert = false;
    if (typeof value === 'string' && ADVERSE_CLASSIFICATIONS.includes(value)) isAlert = true;
    if (value === 'YES') isAlert = true;

    const valStyle = { font: _NORMAL_FONT, border: _THIN_BORDER };
    if (isAlert) {
      valStyle.fill = _ALERT_FILL;
      valStyle.font = { name: 'Arial', bold: true, color: { rgb: '9C0006' }, sz: 10 };
    }
    setCell(ws, row, 1, value, valStyle);
    row++;
  }

  // Borrower summary
  row++;
  writeSection(ws, 'As Borrower / Co-Borrower', row, 6);
  row++;
  const borrowKv = [
    ['Reporting Institutes', sb.reporting_institutes || 0],
    ['Living Contracts', sb.living_contracts || 0],
    ['Total Outstanding', sb.total_outstanding || 0],
    ['Total Overdue', sb.total_overdue || 0],
    ['Stay Order Contracts', sb.stay_order_contracts || 0],
  ];
  for (const [label, value] of borrowKv) {
    setCell(ws, row, 0, label, { font: _BOLD_FONT, border: _THIN_BORDER });
    setCell(ws, row, 1, value);
    styleCell(ws, row, 1, { isAmount: typeof value === 'number' && !Number.isInteger(value) });
    row++;
  }

  // Guarantor summary
  row++;
  writeSection(ws, 'As Guarantor', row, 6);
  row++;
  const guarKv = [
    ['Reporting Institutes', sg.reporting_institutes || 0],
    ['Living Contracts', sg.living_contracts || 0],
    ['Total Outstanding', sg.total_outstanding || 0],
    ['Total Overdue', sg.total_overdue || 0],
    ['Stay Order Contracts', sg.stay_order_contracts || 0],
  ];
  for (const [label, value] of guarKv) {
    setCell(ws, row, 0, label, { font: _BOLD_FONT, border: _THIN_BORDER });
    setCell(ws, row, 1, value);
    styleCell(ws, row, 1, { isAmount: typeof value === 'number' && !Number.isInteger(value) });
    row++;
  }

  // Warnings
  const warnings = report.extraction_warnings || [];
  if (warnings.length) {
    row++;
    writeSection(ws, 'Extraction Warnings', row, 6);
    row++;
    for (const w of warnings) {
      setCell(ws, row, 0, w, { font: _NORMAL_FONT, fill: _AMBER_FILL });
      row++;
    }
  }

  autoWidth(ws);
  XLSX.utils.book_append_sheet(wb, ws, 'Summary');
}

// ─────────────────────────── Sheet 2: Subject Info ───────────────

function writeSubjectSheet(wb, report) {
  const ws = initSheet();
  const subj = report.subject || {};
  const nid = report.nid_verification || {};
  const addr = report.addresses || {};

  writeTitle(ws, 'Subject Information', 0, 4);

  const fields = [
    ['CIB Subject Code', subj.cib_subject_code || ''],
    ['Type of Subject', subj.subject_type || ''],
    ['Name', subj.name || ''],
    ["Father's Name", subj.father_name || ''],
    ["Mother's Name", subj.mother_name || ''],
    ['Spouse Name', subj.spouse_name || ''],
    ['Date of Birth', subj.dob || ''],
    ['Gender', subj.gender || ''],
    ['NID (17-digit)', subj.nid_17 || ''],
    ['NID (10-digit)', subj.nid_10 || ''],
    ['TIN', subj.tin || ''],
    ['Telephone', subj.telephone || ''],
    ['District', subj.district || ''],
    ['Trade Name', subj.trade_name || ''],
    ['Registration No', subj.registration_no || ''],
    ['Registration Date', subj.registration_date || ''],
    ['Legal Form', subj.legal_form || ''],
    ['Sector Type', subj.sector_type || ''],
    ['Sector Code', subj.sector_code || ''],
    ['Reference Number', subj.reference_number || ''],
    ['', ''],
    ['NID Verified', nid.nid_verified ? 'Yes' : 'No'],
    ['Name from NID Server', nid.name_from_nid_server || ''],
    ['', ''],
    ['Present Address', addr.present || ''],
    ['Permanent Address', addr.permanent || ''],
    ['Office Address', addr.office || ''],
    ['Factory Address', addr.factory || ''],
  ];

  let row = 2;
  const verifiedFields = (subj.verified_fields || []).map(v => v.toLowerCase());

  for (const [label, value] of fields) {
    if (!label) { row++; continue; }
    setCell(ws, row, 0, label, { font: _BOLD_FONT, border: _THIN_BORDER });
    const valStyle = { font: _NORMAL_FONT, border: _THIN_BORDER, alignment: _LEFT_WRAP };
    if (verifiedFields.includes(label.toLowerCase().replace(/ /g, '_'))) {
      valStyle.fill = _GREEN_FILL;
    }
    setCell(ws, row, 1, value || '', valStyle);
    row++;
  }

  autoWidth(ws);
  XLSX.utils.book_append_sheet(wb, ws, 'Subject Info');
}

// ─────────────────────────── Sheet 3: Facility Matrix ────────────

function writeFacilityMatrixSheet(wb, report) {
  const ws = initSheet();
  writeTitle(ws, 'Summary of Funded Facilities', 0, 8);

  const sb = report.summary_borrower || {};
  const sg = report.summary_guarantor || {};

  let row = 2;
  writeSection(ws, 'As Borrower / Co-Borrower', row, 8);
  row++;

  const headers = ['Metric', 'Value'];
  for (let ci = 0; ci < headers.length; ci++) {
    setCell(ws, row, ci, headers[ci]);
  }
  styleHeaderRow(ws, row, headers.length);
  row++;

  const borrowerRows = [
    ['Reporting Institutes', sb.reporting_institutes || 0],
    ['Living Contracts', sb.living_contracts || 0],
    ['Total Outstanding (BDT)', sb.total_outstanding || 0],
    ['Total Overdue (BDT)', sb.total_overdue || 0],
    ['Stay Order Contracts', sb.stay_order_contracts || 0],
    ['Stay Order Outstanding (BDT)', sb.stay_order_outstanding || 0],
  ];
  for (const [label, value] of borrowerRows) {
    setCell(ws, row, 0, label, { font: _BOLD_FONT, border: _THIN_BORDER });
    setCell(ws, row, 1, value);
    styleCell(ws, row, 1, { isAmount: typeof value === 'number' && !Number.isInteger(value) });
    row++;
  }

  // Guarantor section
  row++;
  writeSection(ws, 'As Guarantor', row, 8);
  row++;

  for (let ci = 0; ci < headers.length; ci++) {
    setCell(ws, row, ci, headers[ci]);
  }
  styleHeaderRow(ws, row, headers.length);
  row++;

  const guarantorRows = [
    ['Reporting Institutes', sg.reporting_institutes || 0],
    ['Living Contracts', sg.living_contracts || 0],
    ['Total Outstanding (BDT)', sg.total_outstanding || 0],
    ['Total Overdue (BDT)', sg.total_overdue || 0],
    ['Stay Order Contracts', sg.stay_order_contracts || 0],
    ['Stay Order Outstanding (BDT)', sg.stay_order_outstanding || 0],
  ];
  for (const [label, value] of guarantorRows) {
    setCell(ws, row, 0, label, { font: _BOLD_FONT, border: _THIN_BORDER });
    setCell(ws, row, 1, value);
    styleCell(ws, row, 1, { isAmount: typeof value === 'number' && !Number.isInteger(value) });
    row++;
  }

  autoWidth(ws);
  XLSX.utils.book_append_sheet(wb, ws, 'Facility Matrix');
}

// ─────────────────────────── Sheet 4: Non-Funded ─────────────────

function writeNonFundedSheet(wb, report) {
  const ws = initSheet();
  writeTitle(ws, 'Summary of Non-Funded Facilities', 0, 10);

  const headers = [
    'Role', 'Type', 'Living #', 'Living Amt',
    'Terminated #', 'Terminated Amt',
    'Requested #', 'Requested Amt',
    'Stay Order #', 'Stay Order Amt',
  ];

  let row = 2;
  for (let ci = 0; ci < headers.length; ci++) {
    setCell(ws, row, ci, headers[ci]);
  }
  styleHeaderRow(ws, row, headers.length);
  row++;

  const amtCols = new Set([3, 5, 7, 9]); // 0-based

  for (const key of ['non_funded_borrower', 'non_funded_guarantor']) {
    for (const nf of (report[key] || [])) {
      const data = [
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
      ];
      for (let ci = 0; ci < data.length; ci++) {
        setCell(ws, row, ci, data[ci]);
        styleCell(ws, row, ci, { isAmount: amtCols.has(ci) });
      }
      row++;
    }
  }

  if (row === 3) {
    setCell(ws, row, 0, 'No non-funded facilities found.', { font: _NORMAL_FONT });
  }

  autoWidth(ws);
  XLSX.utils.book_append_sheet(wb, ws, 'Non-Funded');
}

// ─────────────────────────── Sheet 5: Contract Details ───────────

function writeContractsSheet(wb, report) {
  const ws = initSheet();
  writeTitle(ws, 'Contract Details', 0, 16);

  const headers = [
    'CIB Contract Code', 'Role', 'Phase', 'Category',
    'Facility Type', 'Start Date', 'End Date',
    'Sanction Limit', 'Outstanding', 'Overdue',
    'Installment Amt', 'Total Installments', 'Remaining',
    'Last Update', 'Classification Date', 'Lawsuit Date',
  ];

  let row = 2;
  for (let ci = 0; ci < headers.length; ci++) {
    setCell(ws, row, ci, headers[ci]);
  }
  styleHeaderRow(ws, row, headers.length);
  row++;

  const amtCols = new Set([7, 8, 9, 10]); // 0-based

  for (const c of (report.contracts || [])) {
    let latestStatus = '';
    const hist = c.monthly_history || [];
    if (hist.length) latestStatus = hist[0].status || '';

    const data = [
      c.cib_contract_code || '',
      c.role || '',
      c.phase || '',
      c.facility_category || '',
      c.facility_type || '',
      c.start_date || '',
      c.end_date || '',
      c.sanction_limit || 0,
      hist.length ? (hist[0].outstanding || 0) : 0,
      hist.length ? (hist[0].overdue || 0) : 0,
      c.installment_amount || 0,
      c.total_installments || 0,
      c.remaining_count || 0,
      c.last_update || '',
      c.classification_date || '',
      c.lawsuit_date || '',
    ];

    const isAlert = ADVERSE_CLASSIFICATIONS.includes(latestStatus);
    const isGreen = (c.phase || '').toLowerCase() === 'living' && !isAlert;

    for (let ci = 0; ci < data.length; ci++) {
      setCell(ws, row, ci, data[ci]);
      styleCell(ws, row, ci, {
        isAmount: amtCols.has(ci),
        isAlert,
        isGreen: isGreen && ci === 2,
      });
    }
    row++;
  }

  if (row === 3) {
    setCell(ws, row, 0, 'No contracts found.', { font: _NORMAL_FONT });
  }

  autoWidth(ws);
  XLSX.utils.book_append_sheet(wb, ws, 'Contract Details');
}

// ─────────────────────────── Sheet 6: Monthly History ────────────

function writeHistorySheet(wb, report) {
  const ws = initSheet();
  writeTitle(ws, 'Monthly History (All Contracts)', 0, 9);

  const headers = [
    'Contract Code', 'Role', 'Facility', 'Acct Date',
    'Outstanding', 'Overdue', 'NPI', 'Status', 'Default/WD',
  ];

  let row = 2;
  for (let ci = 0; ci < headers.length; ci++) {
    setCell(ws, row, ci, headers[ci]);
  }
  styleHeaderRow(ws, row, headers.length);
  row++;

  for (const c of (report.contracts || [])) {
    const code = c.cib_contract_code || '';
    const role = c.role || '';
    const fac = c.facility_type || '';

    for (const h of (c.monthly_history || [])) {
      const status = h.status || '';
      const isAlert = ADVERSE_CLASSIFICATIONS.includes(status);
      const data = [
        code, role, fac,
        h.accounting_date || '',
        h.outstanding || 0,
        h.overdue || 0,
        h.npi || '',
        status,
        h.default_wd || '',
      ];
      for (let ci = 0; ci < data.length; ci++) {
        setCell(ws, row, ci, data[ci]);
        styleCell(ws, row, ci, { isAmount: ci === 4 || ci === 5, isAlert });
      }
      row++;
    }
  }

  if (row === 3) {
    setCell(ws, row, 0, 'No monthly history found.', { font: _NORMAL_FONT });
  }

  autoWidth(ws);
  XLSX.utils.book_append_sheet(wb, ws, 'Monthly History');
}

// ─────────────────────────── Sheet 7: Linked Parties ─────────────

function writeLinkedPartiesSheet(wb, report) {
  const ws = initSheet();
  writeTitle(ws, 'Linked Parties', 0, 5);

  let row = 2;

  // Owners
  const owners = report.owners || [];
  if (owners.length) {
    writeSection(ws, 'Company Owners / Directors', row, 5);
    row++;
    const hdr = ['CIB Code', 'Name', 'Role', 'Stay Order'];
    for (let ci = 0; ci < hdr.length; ci++) setCell(ws, row, ci, hdr[ci]);
    styleHeaderRow(ws, row, hdr.length);
    row++;
    for (const ow of owners) {
      const vals = [
        ow.cib_subject_code || '', ow.name || '',
        ow.role || '', ow.stay_order || '',
      ];
      for (let ci = 0; ci < vals.length; ci++) {
        setCell(ws, row, ci, vals[ci], { font: _NORMAL_FONT, border: _THIN_BORDER });
      }
      row++;
    }
    row++;
  }

  // Proprietorships
  const props = report.proprietorships || [];
  if (props.length) {
    writeSection(ws, 'Linked Proprietorships', row, 5);
    row++;
    const hdr = ['CIB Code', 'Trade Name', 'Sector Type', 'Sector Code'];
    for (let ci = 0; ci < hdr.length; ci++) setCell(ws, row, ci, hdr[ci]);
    styleHeaderRow(ws, row, hdr.length);
    row++;
    for (const pr of props) {
      const vals = [
        pr.cib_subject_code || '', pr.trade_name || '',
        pr.sector_type || '', pr.sector_code || '',
      ];
      for (let ci = 0; ci < vals.length; ci++) {
        setCell(ws, row, ci, vals[ci], { font: _NORMAL_FONT, border: _THIN_BORDER });
      }
      row++;
    }
    row++;
  }

  // Linked subjects from contracts
  const allLinked = [];
  for (const c of (report.contracts || [])) {
    const code = c.cib_contract_code || '';
    for (const ls of (c.linked_subjects || [])) {
      allLinked.push([code, ls]);
    }
  }

  if (allLinked.length) {
    writeSection(ws, 'Subjects Linked to Contracts', row, 5);
    row++;
    const hdr = ['Contract Code', 'CIB Code', 'Role', 'Name'];
    for (let ci = 0; ci < hdr.length; ci++) setCell(ws, row, ci, hdr[ci]);
    styleHeaderRow(ws, row, hdr.length);
    row++;
    for (const [contractCode, ls] of allLinked) {
      const vals = [
        contractCode,
        ls.cib_subject_code || '',
        ls.role || '',
        ls.name || '',
      ];
      for (let ci = 0; ci < vals.length; ci++) {
        setCell(ws, row, ci, vals[ci], { font: _NORMAL_FONT, border: _THIN_BORDER });
      }
      row++;
    }
  }

  if (row === 2) {
    setCell(ws, row, 0, 'No linked parties found.', { font: _NORMAL_FONT });
  }

  autoWidth(ws);
  XLSX.utils.book_append_sheet(wb, ws, 'Linked Parties');
}

// ─────────────────────────── Sheet 8: Processing Info ────────────

function writeProcessingSheet(wb, report) {
  const ws = initSheet();
  writeTitle(ws, 'Processing & Extraction Metadata', 0, 4);

  const inq = report.inquiry || {};
  const matchStatus = report.match_status || {};

  const fields = [
    ['Source File', report.source_file || ''],
    ['Parse Timestamp', report.parse_timestamp || ''],
    ['Parser Version', report.parser_version || ''],
    ['', ''],
    ['Inquiry Date', inq.inquiry_date || ''],
    ['User ID', inq.user_id || ''],
    ['FI Code', inq.fi_code || ''],
    ['Branch Code', inq.branch_code || ''],
    ['FI Name', inq.fi_name || ''],
    ['', ''],
    ['Match Status', matchStatus.match_status || ''],
    ['Contract History', `${matchStatus.contract_history_months || ''} months`],
    ['Contract Phase', matchStatus.contract_phase || ''],
  ];

  let row = 2;
  for (const [label, value] of fields) {
    if (!label) { row++; continue; }
    setCell(ws, row, 0, label, { font: _BOLD_FONT, border: _THIN_BORDER });
    setCell(ws, row, 1, String(value), { font: _NORMAL_FONT, border: _THIN_BORDER });
    row++;
  }

  // Warnings
  const warnings = report.extraction_warnings || [];
  row++;
  writeSection(ws, `Extraction Warnings (${warnings.length})`, row, 4);
  row++;
  if (warnings.length) {
    for (const w of warnings) {
      setCell(ws, row, 0, w, { font: _NORMAL_FONT, fill: _AMBER_FILL });
      row++;
    }
  } else {
    setCell(ws, row, 0, 'No warnings \u2014 clean extraction.', {
      font: _NORMAL_FONT,
      fill: _GREEN_FILL,
    });
  }

  autoWidth(ws);
  XLSX.utils.book_append_sheet(wb, ws, 'Processing Info');
}

// ─────────────────────────── Single Report Export ────────────────

/**
 * Export one parsed CIB report to an 8-sheet Excel workbook.
 *
 * @param {Object} report - dict returned by parser (or reconstructed from DB)
 * @returns {Uint8Array} The xlsx binary data
 */
export function exportSingleReport(report) {
  const wb = XLSX.utils.book_new();

  writeSummarySheet(wb, report);
  writeSubjectSheet(wb, report);
  writeFacilityMatrixSheet(wb, report);
  writeNonFundedSheet(wb, report);
  writeContractsSheet(wb, report);
  writeHistorySheet(wb, report);
  writeLinkedPartiesSheet(wb, report);
  writeProcessingSheet(wb, report);

  return XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
}

// ─────────────────────────── Batch Export (from DB) ──────────────

/**
 * Export multiple subjects from the database into a single Excel workbook.
 * Triggers a browser download.
 *
 * @param {Array} allSubjects - array of subject summary objects from db
 * @param {Object} db - database adapter with get_subject_full(), get_all_subjects()
 * @param {string} [filename] - optional filename override
 */
export function exportMasterExcel(allSubjects, db, filename) {
  const wb = XLSX.utils.book_new();
  const ws = initSheet();

  writeTitle(ws, `CIB Master Export \u2014 ${APP_NAME} v${APP_VERSION}`, 0, 20);

  const headers = [
    'CIB Code', 'Type', 'Name', 'Trade Name', 'Father', 'NID-17',
    'Match Status', 'Inquiry Date',
    'B.Institutes', 'B.Living', 'B.Outstanding', 'B.Overdue',
    'G.Institutes', 'G.Living', 'G.Outstanding', 'G.Overdue',
    'Worst CL (B)', 'Worst CL (G)', 'Willful Default',
    'Source File',
  ];

  let row = 2;
  for (let ci = 0; ci < headers.length; ci++) {
    setCell(ws, row, ci, headers[ci]);
  }
  styleHeaderRow(ws, row, headers.length);
  row++;

  const amtCols = new Set([10, 11, 14, 15]); // 0-based

  for (const s of allSubjects) {
    const data = [
      s.cib_subject_code || '',
      s.subject_type || '',
      s.name || '',
      s.trade_name || '',
      s.father_name || '',
      s.nid_17 || '',
      s.match_status || '',
      s.inquiry_date || '',
      s.b_reporting_institutes || 0,
      s.b_living_contracts || 0,
      s.b_total_outstanding || 0,
      s.b_total_overdue || 0,
      s.g_reporting_institutes || 0,
      s.g_living_contracts || 0,
      s.g_total_outstanding || 0,
      s.g_total_overdue || 0,
      s.worst_class_borrower || 'STD',
      s.worst_class_guarantor || 'STD',
      s.has_willful_default ? 'Yes' : 'No',
      s.source_file || '',
    ];

    for (let ci = 0; ci < data.length; ci++) {
      setCell(ws, row, ci, data[ci]);
      const isAlert =
        (ci === 16 && ADVERSE_CLASSIFICATIONS.includes(data[ci])) ||
        (ci === 17 && ADVERSE_CLASSIFICATIONS.includes(data[ci])) ||
        (ci === 18 && data[ci] === 'Yes');
      styleCell(ws, row, ci, { isAmount: amtCols.has(ci), isAlert });
    }
    row++;
  }

  autoWidth(ws);

  // Timestamp footer
  row++;
  const now = new Date();
  const ts = now.toISOString().replace('T', ' ').substring(0, 19);
  setCell(ws, row, 0, `Generated: ${ts} | ${APP_NAME} v${APP_VERSION}`, {
    font: { name: 'Arial', italic: true, sz: 8, color: { rgb: '888888' } },
  });

  XLSX.utils.book_append_sheet(wb, ws, 'Master Export');

  const data = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const fname = filename || `CIB_Master_Export_${now.toISOString().slice(0, 10)}.xlsx`;
  downloadBlob(data, fname, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

  return data;
}

export { downloadBlob };
