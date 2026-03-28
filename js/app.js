/* =============================================================================
   CIB Analyzer v2.0.0 — Client-Side SPA (ES Module)
   Main orchestrator: replaces the old Flask-based app.js with direct
   calls to client-side sql.js database and processing modules.
   ============================================================================= */

// ── Module Imports ──
import CIBDatabase from './db/database.js';
import { extractText, computeFileHash } from './core/pdf-extract.js';
import { parseReport } from './core/parser.js';
import { runRiskAssessment } from './core/risk-engine.js';
import { exportMasterExcel } from './exports/excel-export.js';
import { exportIndividualReport } from './exports/individual-report.js';
import { exportCreditMemo } from './exports/credit-memo.js';
import { exportCSV } from './exports/csv-export.js';
import {
    DSCR_THRESHOLDS, TAKA_SYMBOL, MAX_PDF_SIZE_BYTES,
    CIB_IDENTIFIER_TEXT, SEARCH_DEBOUNCE_MS, DSCR_COLORS,
    TIMELINE_COLORS,
} from './config.js';


// ── Module-level globals ──
let db = null;


// =============================================================================
// UTILITIES
// =============================================================================
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];
const TAKA = TAKA_SYMBOL;

function formatTaka(amount) {
    const n = parseFloat(amount) || 0;
    return TAKA + ' ' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatTakaShort(amount) {
    const n = parseFloat(amount) || 0;
    if (n >= 1e7) return TAKA + ' ' + (n / 1e7).toFixed(1) + ' Cr';
    if (n >= 1e5) return TAKA + ' ' + (n / 1e5).toFixed(1) + ' L';
    if (n >= 1e3) return TAKA + ' ' + (n / 1e3).toFixed(1) + ' K';
    return TAKA + ' ' + n.toFixed(0);
}

function riskBadgeHTML(rating) {
    if (!rating) return '';
    const cls = {
        'LOW RISK': 'risk-low', 'NO HISTORY': 'risk-no-history',
        'MODERATE': 'risk-moderate', 'HIGH RISK': 'risk-high', 'ADVERSE': 'risk-adverse',
    }[rating] || 'risk-no-history';
    return `<span class="risk-badge ${cls}">${rating}</span>`;
}

function clsBadgeHTML(cls) {
    if (!cls) return '';
    return `<span class="cls-badge cls-${cls}">${cls}</span>`;
}

function matchBadgeHTML(matched) {
    return matched
        ? '<span class="match-badge match-yes">Matched</span>'
        : '<span class="match-badge match-no">Not Matched</span>';
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
}

function toast(msg, type = 'info') {
    const container = $('#toastContainer');
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => el.remove(), 4000);
}


// ── Tab Switching ──
function initTabs(container) {
    if (!container) return;
    const buttons = $$('.tab-btn', container);
    const contents = $$('.tab-content', container);
    buttons.forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.dataset.tab;
            buttons.forEach(b => b.classList.toggle('active', b === btn));
            contents.forEach(c => c.classList.toggle('active', c.id === target || c.dataset.tab === target));
        });
    });
}


// ── Theme Toggle ──
function initTheme() {
    const saved = localStorage.getItem('cib-theme');
    if (saved) {
        // User has an explicit preference
        document.documentElement.setAttribute('data-theme', saved);
    } else {
        // No saved preference — respect system dark mode via CSS media query
        // Remove the hardcoded data-theme so the @media (prefers-color-scheme: dark) rule applies
        document.documentElement.removeAttribute('data-theme');
    }

    const btn = $('#themeToggle');
    if (btn) {
        btn.addEventListener('click', () => {
            const current = document.documentElement.getAttribute('data-theme');
            // If no explicit theme, detect current system theme
            const effectiveTheme = current || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
            const next = effectiveTheme === 'dark' ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', next);
            localStorage.setItem('cib-theme', next);
        });
    }
}


// ── DB Info ──
async function loadDbInfo() {
    const el = $('#dbInfo');
    if (!el) return;
    try {
        const count = db.getSubjectCount();
        el.textContent = `${count} subjects | Browser DB`;
    } catch {
        el.textContent = 'No database';
    }
}


// =============================================================================
// HASH-BASED SPA ROUTER
// =============================================================================
const ROUTES = ['process', 'search', 'export', 'deal', 'log'];
let currentPage = null;

function initRouter() {
    window.addEventListener('hashchange', onRouteChange);
    onRouteChange();
}

function onRouteChange() {
    const hash = window.location.hash || '#/process';
    const page = hash.replace('#/', '') || 'process';
    showPage(ROUTES.includes(page) ? page : 'process');
}

function showPage(page) {
    if (page === currentPage) return;
    currentPage = page;

    // Toggle page containers
    for (const r of ROUTES) {
        const el = $(`#page-${r}`);
        if (el) {
            el.classList.toggle('active', r === page);
            el.style.display = r === page ? 'block' : 'none';
        }
    }

    // Update nav active states
    $$('.nav-link').forEach(link => {
        link.classList.toggle('active', link.dataset.page === page);
    });

    // Call page refresh/init
    switch (page) {
        case 'process': break; // static, already initialised
        case 'search':  refreshSearchPage(); break;
        case 'export':  refreshExportPage(); break;
        case 'deal':    break; // event-driven
        case 'log':     refreshLogPage(); break;
    }
}


// =============================================================================
// PROCESS PAGE
// =============================================================================
function initProcessPage() {
    const dropZone = $('#dropZone');
    const fileInput = $('#fileInput');
    const fileList = $('#fileList');
    const fileCount = $('#fileCount');
    const processBtn = $('#processBtn');
    const cancelBtn = $('#cancelBtn');
    const progressContainer = $('#progressContainer');
    const progressFill = $('#progressFill');
    const progressText = $('#progressText');
    const processLog = $('#processLog');

    let selectedFiles = [];  // File objects held in memory
    let cancelRequested = false;

    // Drag & drop
    if (dropZone) {
        ['dragenter', 'dragover'].forEach(evt => {
            dropZone.addEventListener(evt, e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
        });
        ['dragleave', 'drop'].forEach(evt => {
            dropZone.addEventListener(evt, e => { e.preventDefault(); dropZone.classList.remove('drag-over'); });
        });
        dropZone.addEventListener('drop', e => {
            const files = [...e.dataTransfer.files].filter(f => f.name.toLowerCase().endsWith('.pdf'));
            if (files.length) addFiles(files);
            else toast('No PDF files found in drop', 'error');
        });
    }

    if (fileInput) {
        fileInput.addEventListener('change', () => {
            const files = [...fileInput.files].filter(f => f.name.toLowerCase().endsWith('.pdf'));
            if (files.length) addFiles(files);
            fileInput.value = '';
        });
    }

    function addFiles(files) {
        // Deduplicate by name
        const existingNames = new Set(selectedFiles.map(f => f.name));
        let added = 0;
        for (const f of files) {
            if (!existingNames.has(f.name)) {
                selectedFiles.push(f);
                existingNames.add(f.name);
                added++;
            }
        }
        if (added < files.length) {
            toast(`${files.length - added} duplicate file(s) skipped`, 'info');
        }
        renderFileList();
    }

    function renderFileList() {
        if (!fileList) return;
        fileList.innerHTML = selectedFiles.map((f, i) => `
            <div class="file-item" data-idx="${i}">
                <input type="checkbox" checked class="file-check">
                <span class="file-name">${escapeHtml(f.name)}</span>
                <span class="file-size text-muted text-sm">${(f.size / 1024).toFixed(0)} KB</span>
                <span class="file-status" id="fstatus-${i}">Pending</span>
                <button class="file-remove" data-idx="${i}">&times;</button>
            </div>
        `).join('');

        fileList.querySelectorAll('.file-remove').forEach(btn => {
            btn.addEventListener('click', () => {
                selectedFiles.splice(parseInt(btn.dataset.idx), 1);
                renderFileList();
            });
        });

        if (fileCount) fileCount.textContent = `${selectedFiles.length} file(s) selected`;
        if (processBtn) processBtn.disabled = selectedFiles.length === 0;
    }

    // Start processing
    if (processBtn) {
        processBtn.addEventListener('click', async () => {
            const checked = $$('.file-check', fileList)
                .map((cb, i) => cb.checked ? selectedFiles[i] : null)
                .filter(Boolean);
            if (!checked.length) { toast('No files selected', 'error'); return; }

            processBtn.disabled = true;
            cancelBtn.style.display = '';
            cancelBtn.disabled = false;
            cancelRequested = false;
            progressContainer.classList.add('active');
            processLog.innerHTML = '';
            progressFill.style.width = '0%';

            const total = checked.length;
            let successCount = 0;
            let replacedCount = 0;
            let failedCount = 0;

            // Create batch
            let batchId;
            try {
                batchId = await db.createBatch();
            } catch (e) {
                toast('Failed to create batch: ' + e.message, 'error');
                processBtn.disabled = false;
                return;
            }

            for (let i = 0; i < total; i++) {
                if (cancelRequested) {
                    processLog.innerHTML += '<div class="log-err">Processing cancelled by user.</div>';
                    break;
                }

                const file = checked[i];
                const startTime = performance.now();
                const pct = ((i + 1) / total * 100).toFixed(0);
                progressFill.style.width = pct + '%';
                progressText.textContent = `Processing ${i + 1} of ${total}: ${file.name}`;

                const statusEl = $(`#fstatus-${selectedFiles.indexOf(file)}`);

                try {
                    // Read file
                    const arrayBuffer = await file.arrayBuffer();
                    if (cancelRequested) break;

                    // Size check
                    if (arrayBuffer.byteLength > MAX_PDF_SIZE_BYTES) {
                        throw new Error(`File exceeds maximum size (${(MAX_PDF_SIZE_BYTES / 1024 / 1024).toFixed(0)} MB)`);
                    }

                    // Compute hash
                    const fileHash = await computeFileHash(arrayBuffer);
                    if (cancelRequested) break;

                    // Check if hash already exists
                    const existingCode = db.getSubjectByFileHash(fileHash);
                    let replaced = false;
                    if (existingCode) {
                        // File already processed — replace the existing subject
                        await db.deleteSubject(existingCode);
                        replaced = true;
                    }

                    // Yield to UI so cancel clicks can register
                    await new Promise(r => setTimeout(r, 0));
                    if (cancelRequested) break;

                    // Extract text
                    const text = await extractText(arrayBuffer);

                    // Validate CIB report
                    if (!text.includes(CIB_IDENTIFIER_TEXT)) {
                        throw new Error('Not a valid CIB report (identifier text not found)');
                    }

                    // Parse
                    const report = parseReport(text, file.name, fileHash);

                    // Store
                    await db.storeReport(report);

                    // Risk assessment
                    const cibCode = report.subject?.cib_subject_code;
                    if (cibCode) {
                        runRiskAssessment(db, cibCode);
                    }

                    const duration = ((performance.now() - startTime) / 1000).toFixed(1);
                    const statusLabel = replaced ? 'REPLACED' : 'OK';

                    if (statusEl) {
                        statusEl.textContent = replaced ? 'Replaced' : 'Done';
                        statusEl.className = `file-status ${replaced ? 'text-warning' : 'text-success'}`;
                    }

                    processLog.innerHTML += `<div class="log-ok">[${i + 1}/${total}] ${statusLabel}: ${escapeHtml(file.name)} (${duration}s)</div>`;

                    if (replaced) replacedCount++;
                    else successCount++;

                    // Log to processing log (non-critical — don't let this fail the whole file)
                    try {
                        await db.logProcessing({
                            batchId,
                            sourceFile: file.name,
                            fileHash,
                            cibCode: cibCode || '',
                            name: report.subject?.name || report.subject?.trade_name || '',
                            status: replaced ? 'REPLACED' : 'SUCCESS',
                            duration: parseFloat(duration),
                            contracts: (report.contracts || []).length,
                            replacement: replaced,
                        });
                    } catch (_logErr) {
                        console.warn('Failed to log processing entry:', _logErr);
                    }

                } catch (err) {
                    failedCount++;
                    const duration = ((performance.now() - startTime) / 1000).toFixed(1);

                    if (statusEl) {
                        statusEl.textContent = 'Error';
                        statusEl.className = 'file-status text-danger';
                    }

                    console.error(`FAIL: ${file.name}`, err);
                    processLog.innerHTML += `<div class="log-err">[${i + 1}/${total}] FAIL: ${escapeHtml(file.name)} — ${escapeHtml(err.message)} (${duration}s)</div>`;

                    try {
                        await db.logProcessing({
                            batchId,
                            sourceFile: file.name,
                            status: 'FAILED',
                            duration: parseFloat(duration),
                            message: err.message,
                        });
                    } catch (_logErr) {
                        console.warn('Failed to log processing entry:', _logErr);
                    }
                }

                processLog.scrollTop = processLog.scrollHeight;
            }

            // Finish batch
            const adverseCount = db.getAdverseCount();
            try {
                await db.finishBatch(batchId, total, successCount, replacedCount, failedCount, adverseCount);
            } catch { /* ignore */ }

            progressFill.style.width = '100%';
            progressText.textContent = `Complete: ${successCount} new, ${replacedCount} replaced, ${failedCount} failed`;
            processLog.innerHTML += `<div class="log-info">Batch complete. ${adverseCount} adverse subjects in database.</div>`;

            processBtn.disabled = false;
            cancelBtn.disabled = true;
            cancelBtn.style.display = 'none';
            selectedFiles = [];
            renderFileList();
            await loadDbInfo();
        });
    }

    if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
            cancelRequested = true;
            cancelBtn.disabled = true;
            cancelBtn.textContent = 'Cancelling...';
        });
    }
}


// =============================================================================
// SEARCH PAGE
// =============================================================================
let searchDebounceTimer = null;
let searchSelectedCode = null;

function initSearchPage() {
    const searchInput = $('#searchInput');

    if (searchInput) {
        searchInput.addEventListener('input', () => {
            clearTimeout(searchDebounceTimer);
            searchDebounceTimer = setTimeout(() => loadSubjects(searchInput.value.trim()), SEARCH_DEBOUNCE_MS);
        });
    }
}

function refreshSearchPage() {
    const searchInput = $('#searchInput');
    loadSubjects(searchInput ? searchInput.value.trim() : '');
}

function loadSubjects(query) {
    const resultsList = $('#resultsList');
    const resultsHeader = $('#resultsHeader');
    if (!resultsList) return;

    try {
        let results;
        if (query.length >= 2) {
            results = db.searchSubjects(query);
            resultsHeader.textContent = `${results.length} RESULTS`;
        } else {
            results = db.getAllSubjects();
            resultsHeader.textContent = `ALL SUBJECTS (${results.length})`;
        }
        renderSearchResults(results, resultsList);
    } catch (err) {
        resultsList.innerHTML = `<div class="p-3 text-muted text-center">Error: ${escapeHtml(err.message)}</div>`;
    }
}

function renderSearchResults(results, resultsList) {
    resultsList.innerHTML = results.length === 0
        ? `<div class="empty-state">
               <div class="empty-state-icon">&#128269;</div>
               <div class="empty-state-title">No subjects found</div>
               <div class="empty-state-text">Process CIB PDF reports to populate the database, or adjust your search query.</div>
           </div>`
        : results.map(r => {
            const code = r.cib_subject_code || '';
            const name = r.name || r.trade_name || 'Unknown';
            const risk = r.risk_rating || '';
            const parts = [code, r.subject_type, r.inquiry_date ? `Report: ${r.inquiry_date}` : ''].filter(Boolean);
            const sel = code === searchSelectedCode ? 'selected' : '';
            return `
                <div class="result-card ${sel}" data-code="${escapeHtml(code)}">
                    <div class="result-name">${escapeHtml(name)}</div>
                    <div class="result-sub">${escapeHtml(parts.join(' \u00b7 '))}</div>
                    <div class="result-meta">${riskBadgeHTML(risk)}</div>
                </div>`;
        }).join('');

    resultsList.querySelectorAll('.result-card').forEach(card => {
        card.addEventListener('click', () => {
            searchSelectedCode = card.dataset.code;
            $$('.result-card', resultsList).forEach(c => c.classList.toggle('selected', c === card));
            loadSubjectDetail(searchSelectedCode);
        });
    });
}

function loadSubjectDetail(code) {
    const detailArea = $('#detailArea');
    detailArea.innerHTML = '<div class="detail-placeholder"><span class="spinner"></span></div>';

    try {
        const data = db.getSubjectFull(code);
        if (!data) {
            detailArea.innerHTML = '<div class="detail-placeholder">Subject not found</div>';
            return;
        }
        renderSubjectDetail(data, detailArea);
    } catch (err) {
        detailArea.innerHTML = `<div class="detail-placeholder">Error: ${escapeHtml(err.message)}</div>`;
    }
}

function renderSubjectDetail(data, detailArea) {
    const name = data.name || data.trade_name || 'Unknown';
    const code = data.cib_subject_code || '';
    const risk = data.risk_rating || '';
    const contracts = data.contracts || [];
    const summaries = data.summary_snapshots || [];
    const relationships = data.relationships || [];
    const alerts = data.alert_flags || [];
    const matchStatus = data.match_status || '';
    const matched = matchStatus.toLowerCase().includes('matched') && !matchStatus.toLowerCase().includes('no match');

    detailArea.innerHTML = `
        <div class="subject-header">
            <div>
                <div class="subject-name">${escapeHtml(name)}</div>
                <div class="subject-subtitle">${escapeHtml(code)} &middot; ${escapeHtml(data.subject_type || '')}</div>
            </div>
            ${riskBadgeHTML(risk)}
        </div>
        <div class="tab-nav" id="detailTabs">
            <button class="tab-btn active" data-tab="tab-profile">Profile</button>
            <button class="tab-btn" data-tab="tab-facilities">Facilities</button>
            <button class="tab-btn" data-tab="tab-relationships">Relationships</button>
            <button class="tab-btn" data-tab="tab-history">History</button>
        </div>
        <div class="tab-content active" data-tab="tab-profile" id="tab-profile">
            ${renderProfile(data, contracts, summaries, alerts, matched)}
        </div>
        <div class="tab-content" data-tab="tab-facilities" id="tab-facilities">
            ${renderFacilities(contracts, data.inquiries || [])}
        </div>
        <div class="tab-content" data-tab="tab-relationships" id="tab-relationships">
            ${renderRelationships(relationships)}
        </div>
        <div class="tab-content" data-tab="tab-history" id="tab-history">
            ${renderHistory(contracts)}
        </div>
    `;
    initTabs(detailArea);
}

// ── Profile ──
function renderProfile(data, contracts, summaries, alerts, matched) {
    let html = '';

    // Role cards
    if (summaries.length) {
        html += '<div class="role-cards">';
        for (const s of summaries) {
            const role = s.role || '';
            const outstanding = s.bb_total_outstanding || 0;
            const overdue = s.bb_total_overdue || 0;
            const living = s.bb_living_contracts || 0;
            const terminated = s.bb_terminated_count || 0;
            html += `
                <div class="role-card">
                    <div class="flex justify-between items-center">
                        <span class="role-title">As ${escapeHtml(role)}</span>
                        <span class="role-amount">${formatTaka(outstanding)}</span>
                    </div>
                    <div class="role-detail">Total outstanding</div>
                    <div class="role-detail">${living} Living &middot; ${terminated} Terminated</div>
                    <div class="role-detail ${overdue > 0 ? 'text-danger' : ''}">Overdue: ${formatTaka(overdue)}</div>
                </div>`;
        }
        html += '</div>';
    }

    // Alert Summary
    html += renderAlertSummary(contracts, alerts, matched);

    // Personal Details
    html += '<div class="section-header mt-3">Personal Details</div>';
    const noMatchFields = ['Spouse Name', 'Present Address', 'Permanent Address', 'Office Address', 'Factory Address'];
    const fields = [
        ['CIB Subject Code', data.cib_subject_code],
        ['Subject Type', data.subject_type],
        ['Name', data.name],
        ["Father's Name", data.father_name],
        ["Mother's Name", data.mother_name],
        ['Spouse Name', data.spouse_name],
        ['Date of Birth', data.dob],
        ['Gender', data.gender],
        ['NID (17)', data.nid_17],
        ['NID (10)', data.nid_10],
        ['TIN', data.tin],
        ['District', data.district],
    ].filter(([, v]) => v);

    html += '<div class="detail-grid p-3">';
    for (const [label, value] of fields) {
        html += `<div class="detail-label">${escapeHtml(label)}</div>
                 <div class="detail-value">${escapeHtml(String(value))}</div>
                 <div>${!noMatchFields.includes(label) ? matchBadgeHTML(matched) : ''}</div>`;
    }
    html += '</div>';

    // Addresses
    const addresses = [
        ['Present Address', data.present_address],
        ['Permanent Address', data.permanent_address],
        ['Office Address', data.office_address],
        ['Factory Address', data.factory_address],
    ].filter(([, v]) => v);

    if (addresses.length) {
        html += '<div class="section-header mt-3">Addresses</div><div class="p-3">';
        for (const [label, value] of addresses) {
            html += `<div class="mb-2"><span class="text-muted text-sm">${escapeHtml(label)}:</span><br>${escapeHtml(String(value))}</div>`;
        }
        html += '</div>';
    }

    return html;
}

function renderAlertSummary(contracts, alerts) {
    const borrower = contracts.filter(c => (c.role || '').toLowerCase() === 'borrower');
    const guarantor = contracts.filter(c => (c.role || '').toLowerCase() === 'guarantor');

    function worstClass(list) {
        const order = { STD: 0, SMA: 1, SS: 2, DF: 3, BL: 4, BLW: 5, WD: 6 };
        let worst = 'STD';
        for (const c of list) {
            const cls = c.worst_ever_classification || 'STD';
            if ((order[cls] || 0) > (order[worst] || 0)) worst = cls;
        }
        return worst;
    }
    function maxVal(list, key) {
        return Math.max(0, ...list.map(c => parseFloat(c[key]) || 0));
    }
    function everOverdue(list) {
        return list.some(c => parseFloat(c.max_overdue_amount || 0) > 0);
    }

    const metrics = [
        ['Worst Classification (Borrower)', worstClass(borrower)],
        ['Worst Classification (Guarantor)', worstClass(guarantor)],
        ['Ever Overdue \u2014 Borrower', everOverdue(borrower) ? 'Yes' : 'No'],
        ['Max Overdue (Borrower)', formatTaka(maxVal(borrower, 'max_overdue_amount'))],
        ['Max NPI (Borrower)', String(maxVal(borrower, 'max_npi'))],
        ['Ever Overdue \u2014 Guarantor', everOverdue(guarantor) ? 'Yes' : 'No'],
        ['Max Overdue (Guarantor)', formatTaka(maxVal(guarantor, 'max_overdue_amount'))],
        ['Max NPI (Guarantor)', String(maxVal(guarantor, 'max_npi'))],
        ['Rescheduled Count', String(contracts.filter(c => parseInt(c.times_rescheduled || 0) > 0).length)],
        ['Total Exposure (Borrower)', formatTaka(borrower.reduce((s, c) => s + (parseFloat(c.remaining_amount) || 0), 0))],
        ['Total Exposure (Guarantor)', formatTaka(guarantor.reduce((s, c) => s + (parseFloat(c.remaining_amount) || 0), 0))],
    ];

    let html = '<div class="section-header mt-3">Alert Summary</div><div class="alert-metrics">';
    for (const [label, value] of metrics) {
        let cls = '';
        if (['DF', 'BL', 'BLW', 'WD', 'Yes'].includes(value)) cls = 'text-danger text-bold';
        else if (['SS', 'SMA'].includes(value)) cls = 'text-warning text-bold';
        html += `<div class="metric-label">${escapeHtml(label)}</div><div class="metric-value ${cls}">${escapeHtml(value)}</div>`;
    }
    html += '</div>';

    // Alert flags — consolidate duplicates with count
    if (alerts.length) {
        const flagCounts = {};
        const flagSeverity = {};
        for (const a of alerts) {
            const ft = a.flag_type;
            flagCounts[ft] = (flagCounts[ft] || 0) + 1;
            if (a.severity === 'HIGH' || a.severity === 'CRITICAL') flagSeverity[ft] = 'badge-danger';
            else if (!flagSeverity[ft]) flagSeverity[ft] = 'badge-warning';
        }
        html += '<div class="alert-flags">';
        for (const [ft, count] of Object.entries(flagCounts)) {
            const sev = flagSeverity[ft] || 'badge-warning';
            const label = count > 1 ? `${ft} (${count})` : ft;
            html += `<span class="badge ${sev}">${escapeHtml(label)}</span>`;
        }
        html += '</div>';
    }

    return html;
}

// ── Facilities ──
function renderFacilities(contracts, inquiries = []) {
    if (!contracts.length) return '<div class="p-4 text-muted">No contracts found</div>';

    // Build FI code → name map from inquiries
    const fiNameMap = {};
    for (const inq of inquiries) {
        if (inq.inquiry_fi_code && inq.inquiry_fi_name) {
            fiNameMap[inq.inquiry_fi_code] = inq.inquiry_fi_name;
        }
    }

    const living = contracts.filter(c => (c.phase || '').toLowerCase() === 'living');
    const terminated = contracts.filter(c => (c.phase || '').toLowerCase() !== 'living');

    let html = `<div class="p-3 text-bold">${contracts.length} facilities (${living.length} living &middot; ${terminated.length} terminated)</div>`;

    // Sort
    const clsOrder = { WD: 0, BLW: 1, BL: 2, DF: 3, SS: 4, SMA: 5, STD: 6 };
    const sorted = [...contracts].sort((a, b) => {
        const aLiving = (a.phase || '').toLowerCase() === 'living' ? 0 : 1;
        const bLiving = (b.phase || '').toLowerCase() === 'living' ? 0 : 1;
        if (aLiving !== bLiving) return aLiving - bLiving;
        const aRole = (a.role || '').toLowerCase() === 'borrower' ? 0 : 1;
        const bRole = (b.role || '').toLowerCase() === 'borrower' ? 0 : 1;
        if (aRole !== bRole) return aRole - bRole;
        return (clsOrder[a.worst_ever_classification] ?? 6) - (clsOrder[b.worst_ever_classification] ?? 6);
    });

    for (const c of sorted) {
        const isLiving = (c.phase || '').toLowerCase() === 'living';
        const bandCls = isLiving ? 'living' : 'terminated';
        const phaseLabel = isLiving ? 'Living' : 'Terminated';

        // Build facility label: "Bank Name · CIB Code · Facility Type" or "CIB Code · Facility Type"
        const fiName = c.fi_code ? (fiNameMap[c.fi_code] || `FI-${c.fi_code}`) : '';
        const cibCode = c.cib_contract_code || '';
        const facilityType = c.facility_type || '';
        const labelParts = [fiName, cibCode, facilityType].filter(Boolean);
        const facilityLabel = labelParts.join(' &middot; ');

        html += `<div class="facility-card">
            <div class="facility-band ${bandCls}">
                <span class="badge ${isLiving ? 'badge-success' : 'badge-muted'}">${phaseLabel}</span>
                <strong>${facilityLabel}</strong>
                <span>${escapeHtml(c.role || '')}</span>
                <span class="band-amount">${formatTaka(c.remaining_amount || 0)}</span>
            </div>
            <div class="facility-details">
                <div><span class="fd-label">Sanction Limit:</span> <span class="fd-value">${formatTaka(c.sanction_limit || 0)}</span></div>
                <div><span class="fd-label">Start Date:</span> <span class="fd-value">${escapeHtml(c.start_date || '-')}</span></div>
                <div><span class="fd-label">End Date:</span> <span class="fd-value">${escapeHtml(c.end_date || '-')}</span></div>
                <div><span class="fd-label">EMI:</span> <span class="fd-value">${formatTaka(c.installment_amount || 0)}</span></div>
                <div><span class="fd-label">Classification:</span> <span class="fd-value">${clsBadgeHTML(c.worst_ever_classification)}</span></div>
                <div><span class="fd-label">Max NPI:</span> <span class="fd-value">${c.max_npi ?? '-'}</span></div>
                <div><span class="fd-label">Rescheduled:</span> <span class="fd-value">${c.times_rescheduled || '0'} times</span></div>
                <div><span class="fd-label">Payment:</span> <span class="fd-value">${escapeHtml(c.payment_method || '-')}</span></div>
            </div>
            <div class="timeline">${renderTimeline(c.monthly_history || [])}</div>
        </div>`;
    }
    return html;
}

function renderTimeline(history) {
    if (!history.length) return '<span class="text-muted text-xs">No history data</span>';
    const sorted = [...history].sort((a, b) => (a.accounting_date || '').localeCompare(b.accounting_date || ''));
    return sorted.map(h => {
        const cls = h.status || h.classification || '';
        const color = TIMELINE_COLORS[cls] || TIMELINE_COLORS.NO_DATA;
        const overdue = parseFloat(h.overdue) || 0;
        const tip = `${h.accounting_date || ''} | ${cls || 'N/A'} | Overdue: ${formatTaka(overdue)}`;
        return `<div class="timeline-block" style="--tl-bg:${color}" title="${escapeHtml(tip)}">
            <div class="timeline-tooltip">${escapeHtml(tip)}</div>
        </div>`;
    }).join('');
}

// ── Relationships ──
function renderRelationships(relationships) {
    if (!relationships.length) return '<div class="p-4 text-muted">No connected parties found</div>';

    let html = '<div class="p-3">';
    for (const r of relationships) {
        const name = r.name || r.related_name || r.cib_subject_code || r.related_subject_code || 'Unknown';
        const code = r.cib_subject_code || r.related_subject_code || '';
        const role = r.role || r.relationship_type || '';
        const cls = r.worst_classification || '';

        html += `<div class="rel-card">
            <div class="rel-card-body">
                <div class="rel-name">${escapeHtml(name)}</div>
                <div class="rel-meta">${escapeHtml(code)} &middot; ${escapeHtml(role)}</div>
            </div>
            ${clsBadgeHTML(cls)}
        </div>`;
    }
    html += '</div>';
    return html;
}

// ── History ──
function renderHistory(contracts) {
    if (!contracts.length) return '<div class="p-4 text-muted">No history data</div>';

    let html = '';
    for (const c of contracts) {
        const history = c.monthly_history || [];
        if (!history.length) continue;

        const isLiving = (c.phase || '').toLowerCase() === 'living';
        const bandColor = isLiving ? '#96C458' : '#AAAAAA';
        html += `<div class="facility-section-header" style="--band-color:${bandColor}">
            ${escapeHtml(c.cib_contract_code || '')} &mdash; ${escapeHtml(c.facility_type || '')} (${escapeHtml(c.role || '')})
        </div>`;

        html += '<div class="table-wrapper"><table class="data-table"><thead><tr>';
        html += '<th>Month</th><th>Classification</th><th class="text-right">Outstanding</th>';
        html += '<th class="text-right">Overdue</th><th>NPI</th><th>WD</th></tr></thead><tbody>';

        const parseDate = (d) => { const p = (d || '').split('/'); return p.length === 3 ? `${p[2]}${p[1]}${p[0]}` : d || ''; };
        const sorted = [...history].sort((a, b) => parseDate(b.accounting_date).localeCompare(parseDate(a.accounting_date)));
        for (const h of sorted) {
            const cls = h.status || '';
            const overdue = parseFloat(h.overdue) || 0;
            const rowCls = ['WD', 'BLW', 'BL', 'DF'].includes(cls) ? 'history-severe'
                : overdue > 0 ? 'history-overdue' : '';
            html += `<tr class="${rowCls}">
                <td>${escapeHtml(h.accounting_date || '')}</td>
                <td>${clsBadgeHTML(cls)}</td>
                <td class="text-right">${formatTaka(h.outstanding || 0)}</td>
                <td class="text-right">${overdue > 0 ? formatTaka(overdue) : '-'}</td>
                <td>${h.npi ?? '-'}</td>
                <td>${escapeHtml(h.default_wd || '')}</td>
            </tr>`;
        }
        html += '</tbody></table></div>';
    }
    return html || '<div class="p-4 text-muted">No history data</div>';
}


// =============================================================================
// EXPORT PAGE
// =============================================================================
function initExportPage() {
    const page = $('.export-page');
    if (!page) return;

    const typeCards = $$('.export-type-card', page);
    const panels = $$('.export-panel', page);

    typeCards.forEach(card => {
        card.addEventListener('click', () => {
            typeCards.forEach(c => c.classList.toggle('selected', c === card));
            panels.forEach(p => p.classList.toggle('active', p.dataset.type === card.dataset.type));
        });
    });

    // Master export
    $('#exportMasterBtn')?.addEventListener('click', async () => {
        try {
            const allSubjects = db.getAllSubjects();
            if (!allSubjects.length) { toast('No subjects in database', 'error'); return; }
            toast('Generating Master Excel...', 'info');
            exportMasterExcel(allSubjects, db, 'CIB_Master_Report.xlsx');
            toast('Master Excel exported!', 'success');
        } catch (err) {
            toast('Export failed: ' + err.message, 'error');
        }
    });

    // Database download
    $('#exportDbBtn')?.addEventListener('click', () => {
        try {
            const data = db.exportDatabase();
            const blob = new Blob([data], { type: 'application/x-sqlite3' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            a.download = `cib_master_${timestamp}.db`;
            a.click();
            URL.revokeObjectURL(url);
            toast('Database downloaded!', 'success');
        } catch (err) {
            toast('Download failed: ' + err.message, 'error');
        }
    });

    // Database import
    const importInput = $('#importDbInput');
    $('#importDbBtn')?.addEventListener('click', () => importInput?.click());

    importInput?.addEventListener('change', async () => {
        const file = importInput.files[0];
        if (!file) return;
        try {
            const arrayBuffer = await file.arrayBuffer();
            const uint8Array = new Uint8Array(arrayBuffer);
            await db.importDatabase(uint8Array);
            toast('Database imported successfully! Reloading...', 'success');
            await loadDbInfo();
            refreshExportPage();
        } catch (err) {
            toast('Import failed: ' + err.message, 'error');
        }
        importInput.value = '';
    });

    // CSV export
    $('#exportCsvBtn')?.addEventListener('click', async () => {
        try {
            const allSubjects = db.getAllSubjects();
            if (!allSubjects.length) { toast('No subjects in database', 'error'); return; }
            toast('Generating CSV files...', 'info');
            await exportCSV(allSubjects, db, 'CIB_CSV_Export.zip');
            toast('CSV files exported!', 'success');
        } catch (err) {
            toast('CSV export failed: ' + err.message, 'error');
        }
    });

    // Clear all data
    $('#clearDbBtn')?.addEventListener('click', async () => {
        if (!confirm('Are you sure you want to delete ALL data? This cannot be undone.')) return;
        try {
            await db.deleteDatabase();
            // Re-initialise empty DB
            const sqlPromise = initSqlJs({ locateFile: file => 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/' + file });
            await db.init(sqlPromise);
            toast('All data cleared', 'success');
            await loadDbInfo();
        } catch (err) {
            toast('Clear failed: ' + err.message, 'error');
        }
    });

    // Individual export
    let indCode = '';
    const indSearchInput = $('#indSearchInput');
    const indResults = $('#indResults');

    indSearchInput?.addEventListener('input', () => {
        clearTimeout(indSearchInput._t);
        indSearchInput._t = setTimeout(() => {
            const q = indSearchInput.value.trim();
            if (q.length < 2) { indResults.innerHTML = ''; return; }
            try {
                const results = db.searchSubjects(q);
                indResults.innerHTML = results.slice(0, 10).map(r => {
                    const name = r.name || r.trade_name || '';
                    return `<div class="result-card" data-code="${r.cib_subject_code}">
                        <span class="text-bold">${escapeHtml(name)}</span>
                        <span class="text-muted text-sm"> \u2014 ${r.cib_subject_code}</span>
                    </div>`;
                }).join('');
                indResults.querySelectorAll('.result-card').forEach(c => {
                    c.addEventListener('click', () => {
                        indCode = c.dataset.code;
                        indSearchInput.value = c.querySelector('.text-bold').textContent;
                        indResults.innerHTML = '';
                    });
                });
            } catch { /* ignore */ }
        }, SEARCH_DEBOUNCE_MS);
    });

    $('#exportIndBtn')?.addEventListener('click', async () => {
        if (!indCode) { toast('Select a subject first', 'error'); return; }
        try {
            const data = db.getSubjectFull(indCode);
            if (!data) { toast('Subject not found', 'error'); return; }
            toast('Generating individual report...', 'info');
            exportIndividualReport(data, db, `CIB_Report_${indCode}.xlsx`);
            toast('Individual report exported!', 'success');
        } catch (err) {
            toast('Export failed: ' + err.message, 'error');
        }
    });

    // Credit memo export
    let memoCode = '';
    const memoSearchInput = $('#memoSearchInput');
    const memoResults = $('#memoResults');

    memoSearchInput?.addEventListener('input', () => {
        clearTimeout(memoSearchInput._t);
        memoSearchInput._t = setTimeout(() => {
            const q = memoSearchInput.value.trim();
            if (q.length < 2) { memoResults.innerHTML = ''; return; }
            try {
                const results = db.searchSubjects(q);
                memoResults.innerHTML = results.slice(0, 10).map(r => {
                    const name = r.name || r.trade_name || '';
                    return `<div class="result-card" data-code="${r.cib_subject_code}">
                        <span class="text-bold">${escapeHtml(name)}</span>
                        <span class="text-muted text-sm"> \u2014 ${r.cib_subject_code}</span>
                    </div>`;
                }).join('');
                memoResults.querySelectorAll('.result-card').forEach(c => {
                    c.addEventListener('click', () => {
                        memoCode = c.dataset.code;
                        memoSearchInput.value = c.querySelector('.text-bold').textContent;
                        memoResults.innerHTML = '';
                    });
                });
            } catch { /* ignore */ }
        }, SEARCH_DEBOUNCE_MS);
    });

    $('#exportMemoBtn')?.addEventListener('click', async () => {
        if (!memoCode) { toast('Select a subject first', 'error'); return; }
        try {
            const data = db.getSubjectFull(memoCode);
            if (!data) { toast('Subject not found', 'error'); return; }
            toast('Generating credit memo...', 'info');
            exportCreditMemo(data, db, `Credit_Memo_${memoCode}.xlsx`);
            toast('Credit memo exported!', 'success');
        } catch (err) {
            toast('Export failed: ' + err.message, 'error');
        }
    });
}

function refreshExportPage() {
    // Load stats for the master panel
    try {
        const count = db.getSubjectCount();
        const adverseCount = db.getAdverseCount();
        const el = $('#masterSubjects');
        if (el) el.textContent = count;
        const advEl = $('#masterAdverse');
        if (advEl) advEl.textContent = adverseCount;
    } catch { /* ignore */ }
}


// =============================================================================
// DEAL ASSESSMENT PAGE
// =============================================================================
function initDealPage() {
    const dealSearch = $('#dealSearchInput');
    const dealResults = $('#dealResults');
    const dealApplicant = $('#dealApplicant');
    let selectedApplicant = null;

    dealSearch?.addEventListener('input', () => {
        clearTimeout(dealSearch._t);
        dealSearch._t = setTimeout(() => {
            const q = dealSearch.value.trim();
            if (q.length < 2) { dealResults.innerHTML = ''; return; }
            try {
                const results = db.searchSubjects(q);
                dealResults.innerHTML = results.slice(0, 8).map(r => {
                    const name = r.name || r.trade_name || '';
                    return `<div class="result-card" data-code="${r.cib_subject_code}">
                        <span class="text-bold">${escapeHtml(name)}</span>
                        <span class="text-muted text-sm"> \u2014 ${r.cib_subject_code}</span>
                        ${riskBadgeHTML(r.risk_rating)}
                    </div>`;
                }).join('');
                dealResults.querySelectorAll('.result-card').forEach(c => {
                    c.addEventListener('click', () => {
                        const code = c.dataset.code;
                        dealSearch.value = c.querySelector('.text-bold').textContent;
                        dealResults.innerHTML = '';
                        const data = db.getSubjectFull(code);
                        if (data) {
                            selectedApplicant = data;
                            renderApplicantInfo(data);
                        }
                    });
                });
            } catch { /* ignore */ }
        }, SEARCH_DEBOUNCE_MS);
    });

    function renderApplicantInfo(data) {
        if (!dealApplicant) return;
        const contracts = data.contracts || [];
        const totalEMI = contracts
            .filter(c => (c.role || '').toLowerCase() === 'borrower' && (c.phase || '').toLowerCase() === 'living')
            .reduce((s, c) => s + (parseFloat(c.installment_amount) || 0), 0);

        dealApplicant.innerHTML = `
            <div class="card p-3 mb-3">
                <div class="flex justify-between items-center mb-2">
                    <strong>${escapeHtml(data.name || data.trade_name || '')}</strong>
                    ${riskBadgeHTML(data.risk_rating)}
                </div>
                <div class="text-sm text-muted">${escapeHtml(data.cib_subject_code || '')} &middot; ${contracts.length} facilities</div>
                <div class="mt-2 text-sm">Existing EMI from CIB: <strong>${formatTaka(totalEMI)}</strong></div>
            </div>`;

        // Auto-fill existing EMI
        const emiField = $('#existingEmi');
        if (emiField) emiField.value = totalEMI.toFixed(0);

        // Connected parties
        renderConnectedParties(data);
    }

    function renderConnectedParties(data) {
        const container = $('#connectedParties');
        if (!container) return;
        const rels = data.relationships || [];
        if (!rels.length) { container.innerHTML = '<span class="text-muted">No connected parties</span>'; return; }

        container.innerHTML = '<div class="connected-parties">' + rels.map(r => {
            const name = r.related_name || r.related_subject_code || 'Unknown';
            return `<div class="card p-3">
                <div class="text-bold">${escapeHtml(name)}</div>
                <div class="text-sm text-muted">${escapeHtml(r.related_subject_code || '')} &middot; ${escapeHtml(r.relationship_type || '')}</div>
                <div class="mt-2">${clsBadgeHTML(r.worst_classification)}</div>
            </div>`;
        }).join('') + '</div>';
    }

    // Scenario tabs
    const scenTabs = $$('.scenario-tab');
    const scenPanels = $$('.scenario-panel');
    scenTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            scenTabs.forEach(t => t.classList.toggle('active', t === tab));
            scenPanels.forEach(p => p.classList.toggle('active', p.dataset.scenario === tab.dataset.scenario));
        });
    });

    // Calculate DSCR (local calculation, no API call)
    $('#calculateDscrBtn')?.addEventListener('click', () => {
        const income = parseFloat($('#monthlyIncome')?.value) || 0;
        const existingEmi = parseFloat($('#existingEmi')?.value) || 0;
        const additional = parseFloat($('#additionalObligations')?.value) || 0;

        const scenarios = [];
        for (let i = 1; i <= 3; i++) {
            const sanction = parseFloat($(`#sanction${i}`)?.value) || 0;
            const tenure = parseInt($(`#tenure${i}`)?.value) || 0;
            const rate = parseFloat($(`#rate${i}`)?.value) || 0;
            const moratorium = parseInt($(`#moratorium${i}`)?.value) || 0;
            if (sanction > 0 || tenure > 0) {
                scenarios.push({ sanction, tenure, rate, moratorium });
            }
        }

        if (!income) { toast('Enter monthly income', 'error'); return; }
        if (!scenarios.length) { toast('Enter at least one scenario', 'error'); return; }

        const results = calculateDSCR(income, existingEmi, additional, scenarios);
        renderDscrResults(results, income);
    });

    function renderDscrResults(results, income) {
        const container = $('#dscrResults');
        if (!container || !results || !results.length) return;

        const best = results.reduce((max, r) => r.dscr > max.dscr ? r : max, results[0]);

        container.innerHTML = '<div class="section-header">DSCR Results</div><div class="dscr-results">' + results.map((r, i) => {
            const isBest = results.length > 1 && r === best;
            const color = DSCR_COLORS[r.color] || '#AAAAAA';
            return `<div class="dscr-card ${isBest ? 'best' : ''}" data-color="${r.color}">
                <div class="text-sm text-muted mb-2">Scenario ${i + 1}</div>
                <div class="dscr-value" style="--dscr-color:${color}">${r.dscr_display}</div>
                <div class="dscr-label">Debt Service Coverage Ratio</div>
                <div class="dscr-emi">EMI: ${formatTaka(r.emi)}</div>
                <div class="text-xs text-muted mt-2">${formatTaka(r.sanction)} @ ${r.rate}% for ${r.tenure}m</div>
                <div class="text-xs text-muted">Total obligations: ${formatTaka(r.total_obligations)}</div>
                ${isBest ? '<div class="badge badge-success mt-2">Best Option</div>' : ''}
            </div>`;
        }).join('') + '</div>';
    }
}

/**
 * Calculate DSCR locally (ported from web_app.py deal/calculate endpoint).
 * Uses standard amortization EMI formula.
 */
function calculateDSCR(monthlyIncome, existingEmi, additionalObligations, scenarios) {
    const results = [];
    for (const sc of scenarios) {
        const { sanction, tenure, rate, moratorium } = sc;
        let emi = 0;

        if (sanction > 0 && tenure > 0) {
            const effectiveTenure = Math.max(tenure - (moratorium || 0), 1);
            if (rate > 0) {
                // Standard amortization: EMI = P * r * (1+r)^n / ((1+r)^n - 1)
                const monthlyRate = rate / 100 / 12;
                const factor = Math.pow(1 + monthlyRate, effectiveTenure);
                emi = sanction * monthlyRate * factor / (factor - 1);
            } else {
                // Zero interest: simple division
                emi = sanction / effectiveTenure;
            }
        }

        const totalObligations = existingEmi + additionalObligations + emi;
        let dscr = 0;
        if (totalObligations > 0) {
            dscr = monthlyIncome / totalObligations;
        }

        let color;
        if (dscr >= DSCR_THRESHOLDS.green) color = 'green';
        else if (dscr >= DSCR_THRESHOLDS.yellow) color = 'yellow';
        else if (dscr >= DSCR_THRESHOLDS.amber) color = 'amber';
        else color = 'red';

        results.push({
            sanction,
            tenure,
            rate,
            moratorium: moratorium || 0,
            emi: Math.round(emi),
            total_obligations: Math.round(totalObligations),
            dscr: parseFloat(dscr.toFixed(2)),
            dscr_display: totalObligations > 0 ? dscr.toFixed(2) + 'x' : 'N/A',
            color,
        });
    }
    return results;
}


// =============================================================================
// LOG PAGE
// =============================================================================
let logData = [];

function initLogPage() {
    const statusFilter = $('#logStatusFilter');
    const dateFilter = $('#logDateFilter');
    const searchInput = $('#logSearchInput');
    const refreshBtn = $('#logRefreshBtn');

    [statusFilter, dateFilter].forEach(el => el?.addEventListener('change', refreshLogPage));
    searchInput?.addEventListener('input', () => {
        clearTimeout(searchInput._t);
        searchInput._t = setTimeout(refreshLogPage, 300);
    });
    refreshBtn?.addEventListener('click', refreshLogPage);
}

function refreshLogPage() {
    const tableBody = $('#logTableBody');
    const summaryEl = $('#logSummary');
    const statusFilter = $('#logStatusFilter');
    const dateFilter = $('#logDateFilter');
    const searchInput = $('#logSearchInput');
    if (!tableBody) return;

    try {
        let entries = db.getProcessingLog();

        // Apply client-side filters
        const statusVal = statusFilter?.value || 'All';
        if (statusVal !== 'All') {
            const statusMap = {
                'Success': 'SUCCESS',
                'Error': 'FAILED',
                'Duplicate': 'DUPLICATE',
                'Skipped': 'SKIPPED',
            };
            const mapped = statusMap[statusVal] || statusVal.toUpperCase();
            entries = entries.filter(e => e.status === mapped);
        }

        const dateVal = dateFilter?.value || 'All Time';
        if (dateVal !== 'All Time') {
            const now = new Date();
            let cutoff;
            if (dateVal === 'Today') {
                cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            } else if (dateVal === 'Last 7 Days') {
                cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            } else if (dateVal === 'Last 30 Days') {
                cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
            }
            if (cutoff) {
                entries = entries.filter(e => {
                    const d = new Date(e.processed_at);
                    return d >= cutoff;
                });
            }
        }

        const searchQ = (searchInput?.value || '').trim().toLowerCase();
        if (searchQ) {
            entries = entries.filter(e => {
                const hay = [e.source_file, e.subject_name, e.cib_subject_code].join(' ').toLowerCase();
                return hay.includes(searchQ);
            });
        }

        renderLog(entries, tableBody, summaryEl);
    } catch (err) {
        tableBody.innerHTML = `<tr><td colspan="7" class="text-center text-danger p-4">Error: ${escapeHtml(err.message)}</td></tr>`;
    }
}

function renderLog(entries, tableBody, summaryEl) {
    const successCount = entries.filter(e => e.status === 'SUCCESS').length;
    const failCount = entries.filter(e => e.status === 'FAILED').length;

    tableBody.innerHTML = entries.length === 0
        ? `<tr><td colspan="7">
               <div class="empty-state">
                   <div class="empty-state-icon">&#128203;</div>
                   <div class="empty-state-title">No processing logs yet</div>
                   <div class="empty-state-text">Process CIB PDF reports to see activity here.</div>
               </div>
           </td></tr>`
        : entries.map(e => {
            const statusCls = e.status === 'SUCCESS' ? 'status-ok' : e.status === 'FAILED' ? 'status-fail' : '';
            const statusLabel = e.status === 'SUCCESS' ? 'OK' : e.status === 'FAILED' ? 'FAIL' : (e.status || '');
            return `<tr>
                <td>${escapeHtml((e.processed_at || '').slice(0, 19))}</td>
                <td><span class="${statusCls}">${statusLabel}</span></td>
                <td class="log-filename">${escapeHtml(e.source_file || '')}</td>
                <td>${escapeHtml(e.subject_name || '')}</td>
                <td class="mono">${escapeHtml(e.cib_subject_code || '')}</td>
                <td class="text-right">${(e.duration_seconds || 0).toFixed(1)}s</td>
                <td class="text-center">${e.contracts_count ?? ''}</td>
            </tr>`;
        }).join('');

    if (summaryEl) {
        summaryEl.textContent = `${entries.length} entries  \u00b7  ${successCount} success  \u00b7  ${failCount} failed`;
    }
}


// =============================================================================
// INITIALISATION
// =============================================================================
async function boot() {
    const appLoading = $('#appLoading');

    try {
        // 1. Initialise sql.js WASM
        const sqlPromise = initSqlJs({
            locateFile: file => 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/' + file,
        });

        // 2. Configure pdf.js worker (wait for it to be available)
        while (!window.pdfjsLib) await new Promise(r => setTimeout(r, 50));
        pdfjsLib.GlobalWorkerOptions.workerSrc =
            'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.mjs';

        // 3. Create and init database
        db = new CIBDatabase();
        await db.init(sqlPromise);

        // 4. Hide loading, show app
        if (appLoading) appLoading.style.display = 'none';

        // 5. Init theme + DB info
        initTheme();
        await loadDbInfo();

        // 6. Init all page controllers (event bindings)
        initProcessPage();
        initSearchPage();
        initExportPage();
        initDealPage();
        initLogPage();

        // 7. Start router (shows first page)
        initRouter();

    } catch (err) {
        console.error('Boot failed:', err);
        if (appLoading) {
            appLoading.innerHTML = `
                <div class="text-danger text-center p-4">
                    <h3>Failed to initialise CIB Analyzer</h3>
                    <p>${escapeHtml(err.message)}</p>
                    <button class="btn btn-primary mt-2" onclick="location.reload()">Retry</button>
                </div>`;
        }
    }
}

boot();
