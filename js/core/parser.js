/**
 * CIB Analyzer — PDF Parser Engine (JavaScript Port)
 * ===================================================
 * Extracts structured data from Bangladesh Bank CIB (Credit Information Bureau)
 * PDF reports. This is a faithful port of the Python parser.py.
 *
 * This module does NOT handle PDF text extraction — that is done by pdf-extract.js.
 * Instead, it receives raw text and parses it into structured data.
 *
 * The parser handles four subject types:
 *     1. Individual with NID verification (Matched found)
 *     2. Individual proprietor with CIB match (Matched found)
 *     3. Individual proprietor without CIB match (No Matched found)
 *     4. Company (Private Ltd, etc.)
 */

// =============================================================================
// CONSTANTS (from config.py)
// =============================================================================

const PARSER_VERSION = "2.0.0";

const CLASSIFICATION_ORDER = ["STD", "SMA", "SS", "DF", "BL", "BLW"];

const CLASSIFICATION_CATEGORIES = [
    "STD", "SMA", "SS (No)", "SS (Yes)", "DF", "BL", "BLW",
    "Terminated", "Requested", "Stay Order",
    "Willful Default (WD)", "Willful Default (Appeal)"
];

const FACILITY_TYPES = [
    "Installments", "Non-Installments", "Credit Cards",
    "Non-Listed securities", "Total"
];

// =============================================================================
// COMPILED REGEX PATTERNS
// =============================================================================
// Pre-compiled patterns for fields that are matched thousands of times
// across a batch of reports.

// Matches dates in DD/MM/YYYY format (e.g., "31/12/2025")
const RE_DATE = /\d{2}\/\d{2}\/\d{4}/;

// Matches CIB subject codes: one uppercase letter followed by 9+ digits
const RE_CIB_CODE = /^[A-Z]\d{9,}$/;

// Matches CIB contract codes (same pattern, found in contract headers)
const RE_CONTRACT_CODE = /[A-Z]\d{9,}/;

// Matches monetary amounts with optional commas (e.g., "1,187,429" or "0")
// Note: test against trimmed values — anchors require exact match
const RE_AMOUNT = /^[\d,]+$/;

// Matches the inquiry date format: "22-Jan-2026 10:28:07 AM"
const RE_INQUIRY_DATE = /\d{2}-\w{3}-\d{4}\s+[\d:]+\s*[AP]M/;

// Matches NID numbers (10 or 17 digits)
const RE_NID_17 = /(\d{17})/;
const RE_NID_10 = /(\d{10})/;

// Matches page number footers like "1/8", "3/4"
const RE_PAGE_NUMBER = /^\d+\/\d+$/;

// Matches classification status codes that appear in monthly history
const RE_STATUS = /^(STD|SMA|SS|DF|BL|BLW)$/;

// Default/Willful Default values in monthly history
const RE_DEFAULT_WD = /^(No|Yes|WD)$/;


// =============================================================================
// SECTION 1: TEXT CLEANING AND LINE SPLITTING
// =============================================================================

/**
 * Clean the extracted text and split into lines.
 *
 * Removes:
 *   - "CONFIDENTIAL" headers/footers (appear on every page)
 *   - Page number markers like "1/8", "3/4"
 *
 * @param {string} text - Raw extracted text string
 * @returns {string[]} List of cleaned text lines
 */
function cleanAndSplit(text) {
    const lines = text.split("\n");
    const cleaned = [];
    for (let i = 0; i < lines.length; i++) {
        // Normalize Unicode ligatures before any checks (pdf.js may emit fi/fl ligatures)
        let stripped = lines[i].trim()
            .replace(/\ufb01/g, 'fi')
            .replace(/\ufb02/g, 'fl');
        // Skip confidential headers that appear at top and bottom of every page
        if (stripped.toUpperCase().startsWith("CONFIDENTIAL")) {
            continue;
        }
        // Skip page number footers like "1/8"
        if (RE_PAGE_NUMBER.test(stripped)) {
            continue;
        }
        cleaned.push(stripped);
    }
    return cleaned;
}


/**
 * Get the first non-empty, non-label value from lines following a given index.
 *
 * In pymupdf extraction, PDF table cells often come out as separate lines:
 *     Line N:   "Father's name:"
 *     Line N+1: "NASIR UDDIN"
 *
 * This helper looks ahead up to 5 lines to find the actual value.
 * Skips empty lines and lines that end with ':' (which are labels, not values).
 *
 * @param {string[]} lines - List of text lines
 * @param {number} index - Starting index to look after
 * @returns {string} The first non-empty value found, or empty string
 */
function getValueAfter(lines, index) {
    for (let j = index + 1; j < Math.min(index + 5, lines.length); j++) {
        const val = lines[j].trim();
        if (val && !val.endsWith(':')) {
            return val;
        }
    }
    return '';
}


/**
 * Strip trailing inline fields from a value.
 * In real CIB PDFs, two-column layouts cause fields to merge on one line, e.g.:
 *   "HASAN FARUK Sector type: PRIVATE"
 * This strips everything from the first trailing field label onward.
 *
 * @param {string} val - The raw extracted value
 * @param {string[]} fieldLabels - Labels to search for (e.g., ['Sector type', 'Sector code'])
 * @returns {string} Cleaned value
 */
function stripTrailingField(val, fieldLabels) {
    if (!val) return val;
    for (const label of fieldLabels) {
        const idx = val.indexOf(label);
        if (idx > 0) {
            return val.substring(0, idx).trim();
        }
    }
    return val;
}


/**
 * Identify the start line index of each major section in the CIB report.
 *
 * This is the key optimization: instead of searching the entire text for
 * every field, we first identify where each section starts, then pass
 * only the relevant line range to each parser function.
 *
 * @param {string[]} lines - List of cleaned text lines
 * @returns {Object} Dictionary mapping section names to their starting line indices.
 *                    Returns -1 for sections not found.
 */
function findSectionBoundaries(lines) {
    const sections = {
        inquiry: -1,
        inquired: -1,
        nid_verification: -1,
        subject_info: -1,
        address_first: -1,
        owners_list: -1,
        proprietorship: -1,
        summary_borrower: -1,
        summary_1a: -1,
        summary_1b: -1,
        summary_guarantor: -1,
        summary_2a: -1,
        summary_2b: -1,
        external_debt: -1,
        installment_details: -1,
        non_installment_details: -1,
        notes: -1,
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes('Credit Information Report') && sections.inquiry === -1) {
            sections.inquiry = i;
        } else if (line.startsWith('INQUIRED') && sections.inquired === -1) {
            sections.inquired = i;
            // Handle merged line: "INQUIRED NID VERIFICATION RESULT"
            if (line.includes('NID VERIFICATION RESULT') && sections.nid_verification === -1) {
                sections.nid_verification = i;
            }
        } else if (line.includes('NID VERIFICATION RESULT') && sections.nid_verification === -1) {
            sections.nid_verification = i;
        } else if (line.includes('SUBJECT INFORMATION') && sections.subject_info === -1) {
            sections.subject_info = i;
        } else if (line === 'ADDRESS' && sections.address_first === -1) {
            sections.address_first = i;
        } else if (line.includes('OWNERS LIST') && sections.owners_list === -1) {
            sections.owners_list = i;
        } else if ((line.includes('LINKED PROPRIETORSHIP') || line.includes('PROPRIETORSHIP CONCERN')) && sections.proprietorship === -1) {
            sections.proprietorship = i;
        } else if (line.includes('1. SUMMARY OF FACILITY(S) AS BORROWER')) {
            sections.summary_borrower = i;
        } else if (line.includes('1.(A) SUMMARY OF THE FUNDED')) {
            sections.summary_1a = i;
        } else if (line.includes('1.(B) SUMMARY OF THE NON-FUNDED')) {
            sections.summary_1b = i;
        } else if (line.includes('2. SUMMARY OF FACILITY(S) AS GUARANTOR')) {
            sections.summary_guarantor = i;
        } else if (line.includes('2.(A) SUMMARY OF THE FUNDED')) {
            sections.summary_2a = i;
        } else if (line.includes('2.(B) SUMMARY OF THE NON-FUNDED')) {
            sections.summary_2b = i;
        } else if (line.includes('3. SUMMARY OF PRIVATE SECTOR')) {
            sections.external_debt = i;
        } else if (line.includes('DETAILS OF INSTALLMENT FACILITY') && sections.installment_details === -1) {
            sections.installment_details = i;
        } else if ((line.includes('DETAILS OF NONINSTALLMENT') || line.includes('DETAILS OF NON INSTALLMENT')) && sections.non_installment_details === -1) {
            sections.non_installment_details = i;
        } else if (line === 'NOTES:') {
            sections.notes = i;
        }
    }

    return sections;
}


// =============================================================================
// SECTION 2: INQUIRY HEADER PARSING
// =============================================================================

/**
 * Parse the inquiry header: who pulled this CIB report and when.
 *
 * @param {string[]} lines - All cleaned text lines
 * @param {Object} sections - Section boundary dictionary
 * @returns {Object} Dictionary with keys: inquiry_date, user_id, fi_code, branch_code, fi_name
 */
function parseInquiryHeader(lines, sections) {
    const data = {};

    const start = Math.max(0, sections.inquiry ?? 0);
    const end = Math.min(start + 40, lines.length);
    const headerLines = lines.slice(start, end);

    // Find the position of "Date of Inquiry"
    const labelNames = ['Date of Inquiry', 'User ID', 'FI Code', 'Branch Code', 'FI Name'];
    let labelStart = -1;
    let singleLineHeader = false;

    for (let i = 0; i < headerLines.length; i++) {
        if (headerLines[i] === 'Date of Inquiry') {
            labelStart = i;
            break;
        }
        // Handle single-line format: "Date of Inquiry User ID FI Code Branch Code FI Name"
        if (headerLines[i].includes('Date of Inquiry') && headerLines[i].includes('FI Code')) {
            labelStart = i;
            singleLineHeader = true;
            break;
        }
    }

    if (singleLineHeader && labelStart >= 0) {
        // Single-line header: labels on one line, values on next line(s)
        // Values line format: "16-Feb-2026 02:42:51 PM SXU215701 215 0101 I.D.L.C. ..."
        for (let vi = labelStart + 1; vi < Math.min(labelStart + 5, headerLines.length); vi++) {
            const valueLine = headerLines[vi];
            const dateMatch = RE_INQUIRY_DATE.exec(valueLine);
            if (dateMatch) {
                data.inquiry_date = dateMatch[0];
                // Remaining values follow after the date+time+AM/PM
                const afterDate = valueLine.substring(dateMatch.index + dateMatch[0].length).trim();
                const parts = afterDate.split(/\s+/);
                if (parts.length >= 1) data.user_id = parts[0];
                if (parts.length >= 2) data.fi_code = parts[1];
                if (parts.length >= 3) data.branch_code = parts[2];
                if (parts.length >= 4) data.fi_name = parts.slice(3).join(' ');
                break;
            }
        }
    } else if (labelStart >= 0) {
        // Multi-line format: each label on separate line, values on separate lines after
        let labelCount = 0;
        for (let j = labelStart; j < Math.min(labelStart + labelNames.length, headerLines.length); j++) {
            if (labelNames.includes(headerLines[j])) {
                labelCount++;
            } else {
                break;
            }
        }

        const valueStart = labelStart + labelCount;
        for (let offset = 0; offset < labelNames.length; offset++) {
            const label = labelNames[offset];
            if (offset < labelCount && valueStart + offset < headerLines.length) {
                const val = headerLines[valueStart + offset];
                if (label === 'Date of Inquiry') data.inquiry_date = val;
                else if (label === 'User ID') data.user_id = val;
                else if (label === 'FI Code') data.fi_code = val;
                else if (label === 'Branch Code') data.branch_code = val;
                else if (label === 'FI Name') data.fi_name = val;
            }
        }
    }

    // Fallback: if structured parsing didn't find the date, search for the pattern
    if (!data.inquiry_date) {
        for (let i = 0; i < headerLines.length; i++) {
            const m = RE_INQUIRY_DATE.exec(headerLines[i]);
            if (m) {
                data.inquiry_date = m[0];
                break;
            }
        }
    }

    return data;
}


// =============================================================================
// SECTION 3: MATCH STATUS AND CONTRACT HISTORY PERIOD
// =============================================================================

/**
 * Determine whether the CIB search found a match for the subject.
 *
 * @param {string[]} lines - All cleaned text lines
 * @param {Object} sections - Section boundary dictionary
 * @returns {Object} Dictionary with: match_status, contract_history_months, contract_phase
 */
function parseMatchStatus(lines, sections) {
    const data = {
        match_status: 'Unknown',
        contract_history_months: null,
        contract_phase: ''
    };

    const start = sections.inquired ?? 0;
    const end = sections.subject_info ?? lines.length;

    for (let i = start; i < Math.min(end, lines.length); i++) {
        const line = lines[i];

        if (line.includes('No Matched found')) {
            data.match_status = 'No Match';
        } else if (line.includes('Matched found') && !line.includes('No Matched')) {
            data.match_status = 'Matched';
        }

        // Contract History period: "Contract History:24 month" or "Contract History : 24 month"
        if (line.includes('Contract History')) {
            let m = line.match(/(\d+)\s*month/);
            if (m) {
                data.contract_history_months = parseInt(m[1], 10);
            } else {
                // Value might be on the next line
                const nextVal = getValueAfter(lines, i);
                m = nextVal.match(/(\d+)\s*month/);
                if (m) {
                    data.contract_history_months = parseInt(m[1], 10);
                }
            }
        }

        // Contract Phase: "Contract Phase:All Loans"
        if (line.includes('Contract Phase')) {
            let val = line.includes(':') ? line.split(':').pop().trim() : '';
            if (!val) {
                val = getValueAfter(lines, i);
            }
            data.contract_phase = val;
        }
    }

    return data;
}


// =============================================================================
// SECTION 4: NID VERIFICATION
// =============================================================================

/**
 * Parse NID Verification Result section.
 *
 * @param {string[]} lines - All cleaned text lines
 * @param {Object} sections - Section boundary dictionary
 * @returns {Object} Dictionary with: nid_verified (bool), name_from_nid_server
 */
function parseNidVerification(lines, sections) {
    const data = {
        nid_verified: false,
        name_from_nid_server: ''
    };

    const start = sections.nid_verification ?? -1;
    if (start === -1) {
        return data;
    }

    const end = sections.subject_info ?? lines.length;

    for (let i = start; i < Math.min(end, lines.length); i++) {
        const line = lines[i];

        if (line.includes('NID VERIFICATION RESULT')) {
            data.nid_verified = true;
        }

        // "Name: MST ROWSAN ARA" in the verification result block
        if (line.startsWith('Name:') && !line.includes('National ID')) {
            let val = line.replace('Name:', '').trim();
            if (!val) {
                val = getValueAfter(lines, i);
            }
            if (val) {
                data.name_from_nid_server = val;
            }
        }
    }

    return data;
}


// =============================================================================
// SECTION 5: SUBJECT INFORMATION
// =============================================================================

/**
 * Parse the SUBJECT INFORMATION section.
 *
 * @param {string[]} lines - All cleaned text lines
 * @param {Object} sections - Section boundary dictionary
 * @returns {Object} Dictionary with all subject fields and verification flags
 */
function parseSubjectInfo(lines, sections) {
    const data = {};

    const start = sections.subject_info ?? -1;
    if (start === -1) {
        return data;
    }

    // End at the first ADDRESS section after SUBJECT INFORMATION
    let end = lines.length;
    for (let i = start + 3; i < lines.length; i++) {
        if (lines[i] === 'ADDRESS') {
            end = i;
            break;
        }
    }

    const sectionLines = lines.slice(start, end);

    // ---------- Parse each field ----------
    for (let i = 0; i < sectionLines.length; i++) {
        const line = sectionLines[i];

        // CIB Subject Code (e.g., "C0000747379")
        // In real PDFs, often combined: "CIB subject code: Y0000586928 Type of subject: INDIVIDUAL"
        if (line.startsWith('CIB subject code:') || line === 'CIB subject code:') {
            let val = line.replace('CIB subject code:', '').trim();

            // Handle combined line with "Type of subject" on same line
            if (val.includes('Type of subject')) {
                const parts = val.split('Type of subject');
                val = parts[0].trim();
                // Also extract subject type from the same line
                let typeVal = parts[1] || '';
                typeVal = typeVal.replace(/^[:\s]+/, '').trim();
                if (typeVal) {
                    data.subject_type = typeVal.toUpperCase();
                }
            }

            if (!val) {
                val = getValueAfter(sectionLines, i);
            }
            // Clean: extract just the CIB code if extra text follows
            const codeMatch = val.match(/^([A-Z]\d+)/);
            if (codeMatch) {
                data.cib_subject_code = codeMatch[1];
            } else {
                data.cib_subject_code = val;
            }
        }

        // Type of Subject: "INDIVIDUAL" or "COMPANY" or "Individual"
        // Handles both "Type of subject: INDIVIDUAL" (with colon) and
        // "Type of subject Individual" (without colon, older PDFs)
        // Note: may already be set from the combined CIB subject code line above
        else if (line.startsWith('Type of subject') && !data.subject_type) {
            let val = '';
            if (line.includes(':')) {
                val = line.split(':').pop().trim();
            } else {
                // No colon: extract text after "Type of subject"
                val = line.replace(/^Type of subject\s*/i, '').trim();
            }
            if (!val) {
                val = getValueAfter(sectionLines, i);
            }
            data.subject_type = val.toUpperCase(); // Normalize to uppercase
        }

        // Name (for individuals)
        // Be careful to not match "Name from National ID Server" or "Trade Name"
        else if ((line === 'Name:' || line.startsWith('Name:')) &&
                 !line.includes('National ID') && !line.includes('Trade') && !line.includes('Owner')) {
            let val = line.replace('Name:', '').trim();
            if (!val) {
                val = getValueAfter(sectionLines, i);
            }
            // Strip "Reference number (Ref.):" and anything after it (inline on same line)
            if (val.includes('Reference number')) {
                val = val.split('Reference number')[0].trim();
            }
            // Check for "Verified" tag and extract it separately
            if (val.includes('Verified')) {
                data.name_verified = true;
                val = val.replace(/\s*Verified\s*/g, '').trim();
            } else {
                data.name_verified = false;
            }
            // Skip if this is the "Name from National ID Server" line
            if (val && !val.includes('Name from')) {
                data.name = val;
            }
        }

        // Trade Name (for companies and proprietorships)
        else if (line.includes('Trade Name:')) {
            let val = line.split('Trade Name:').pop().trim();
            if (!val) {
                val = getValueAfter(sectionLines, i);
            }
            if (val && val !== 'Trade Name:') {
                data.trade_name = val;
            }
        }

        // Title (for companies)
        else if (line.startsWith('Title:')) {
            let val = line.replace('Title:', '').trim();
            if (!val) {
                val = getValueAfter(sectionLines, i);
            }
            if (val) {
                data.title = val;
            }
        }

        // Father's name
        // In real PDFs, often merged: "Father's name: HASAN FARUK Sector type: PRIVATE"
        else if (line.startsWith("Father's name:") || line.startsWith("Father\u2019s name:")) {
            let val = line.split(':').slice(1).join(':').trim();
            if (!val) {
                val = getValueAfter(sectionLines, i);
            }
            // Strip trailing fields that share the same line
            val = stripTrailingField(val, ['Sector type', 'Sector code', 'Legal form', 'Registration']);
            data.father_name = val;
        }

        // Mother's name
        else if (line.startsWith("Mother's name:") || line.startsWith("Mother\u2019s name:")) {
            let val = line.split(':').slice(1).join(':').trim();
            if (!val) {
                val = getValueAfter(sectionLines, i);
            }
            val = stripTrailingField(val, ['Sector code', 'Sector type', 'above']);
            data.mother_name = val;
        }

        // Spouse Name
        else if (line.startsWith("Spouse Name:")) {
            let val = line.replace('Spouse Name:', '').trim();
            if (!val) {
                val = getValueAfter(sectionLines, i);
            }
            val = stripTrailingField(val, ['ID type', 'ID number', 'ID issue']);
            // Sometimes the next field label "ID type:" gets picked up
            if (val && val !== 'ID type:' && val !== '') {
                data.spouse_name = val;
            }
        }

        // Date of Birth — may have "Verified" tag
        else if (line.startsWith('Date of birth:')) {
            let m = RE_DATE.exec(line);
            if (m) {
                data.dob = m[0];
            } else {
                const nextVal = getValueAfter(sectionLines, i);
                m = RE_DATE.exec(nextVal);
                if (m) {
                    data.dob = m[0];
                }
            }
            data.dob_verified = line.includes('Verified') ||
                                (data.dob !== undefined && i + 1 < sectionLines.length && sectionLines[i + 1].includes('Verified'));
        }

        // Gender — often merged with "ID issue date:" on same line
        else if (line.startsWith('Gender')) {
            let val = '';
            if (line.includes('Gender:')) {
                val = line.split('Gender:')[1]?.trim() || '';
            } else if (line.includes(':')) {
                val = line.split(':').pop().trim();
            }
            if (!val) {
                val = getValueAfter(sectionLines, i);
            }
            val = stripTrailingField(val, ['ID issue', 'ID type', 'ID number']);
            if (val) {
                data.gender = val.toUpperCase();
            }
        }

        // District(Country)
        else if (line.startsWith('District(Country):')) {
            let val = line.replace('District(Country):', '').trim();
            if (!val) {
                val = getValueAfter(sectionLines, i);
            }
            if (val) {
                // Parse "JOYPURHAT(BD)" into district and country
                const m = val.match(/^(.+?)\((\w+)\)/);
                if (m) {
                    data.district = m[1].trim();
                    data.country = m[2].trim();
                } else {
                    data.district = val;
                    data.country = '';
                }
            }
        }

        // NID (17 Digit) — may have "Verified" tag
        else if (line.startsWith('NID (17 Digit):')) {
            let m = RE_NID_17.exec(line);
            if (m) {
                data.nid_17 = m[1];
            } else {
                const nextVal = getValueAfter(sectionLines, i);
                m = RE_NID_17.exec(nextVal);
                if (m) {
                    data.nid_17 = m[1];
                }
            }
            data.nid_17_verified = line.includes('Verified');
        }

        // NID (10 Digit) — may have "Verified" tag
        else if (line.startsWith('NID (10 Digit):')) {
            let m = RE_NID_10.exec(line);
            if (m) {
                data.nid_10 = m[1];
            } else {
                const nextVal = getValueAfter(sectionLines, i);
                m = RE_NID_10.exec(nextVal);
                if (m && m[1].length >= 10) {
                    data.nid_10 = m[1];
                }
            }
            data.nid_10_verified = line.includes('Verified');
        }

        // TIN (Tax Identification Number)
        else if (line.startsWith('TIN:')) {
            let val = line.replace('TIN:', '').trim();
            if (!val) {
                val = getValueAfter(sectionLines, i);
            }
            if (val && /^\d+/.test(val)) {
                data.tin = val;
            }
        }

        // Sector Type
        else if (line.startsWith('Sector type:')) {
            let val = line.replace('Sector type:', '').trim();
            if (!val) {
                val = getValueAfter(sectionLines, i);
            }
            data.sector_type = val;
        }

        // Sector Code (may include description in parentheses)
        else if (line.startsWith('Sector code:')) {
            let val = line.replace('Sector code:', '').trim();
            if (!val) {
                val = getValueAfter(sectionLines, i);
            }
            data.sector_code = val;
        }

        // Reference Number
        else if (line.startsWith('Reference number (Ref.):')) {
            let val = line.replace('Reference number (Ref.):', '').trim();
            if (!val) {
                val = getValueAfter(sectionLines, i);
            }
            data.reference_number = val;
        }

        // ID Type
        else if (line.startsWith('ID type:')) {
            let val = line.replace('ID type:', '').trim();
            if (!val) {
                val = getValueAfter(sectionLines, i);
            }
            if (val && val !== 'ID number:' && val !== '') {
                data.id_type = val;
            }
        }

        // ID Number
        else if (line.startsWith('ID number:')) {
            let val = line.replace('ID number:', '').trim();
            if (!val) {
                val = getValueAfter(sectionLines, i);
            }
            if (val && val !== 'ID issue date:' && val !== '') {
                data.id_number = val;
            }
        }

        // ID Issue Date
        else if (line.startsWith('ID issue date:')) {
            let val = line.replace('ID issue date:', '').trim();
            if (!val) {
                val = getValueAfter(sectionLines, i);
            }
            if (val) {
                const m = RE_DATE.exec(val);
                if (m) {
                    data.id_issue_date = m[0];
                }
            }
        }

        // Telephone
        else if (line.startsWith('Telephone') && !line.toLowerCase().includes('number')) {
            let val = line.includes(':') ? line.split(':').pop().trim() : '';
            if (!val) {
                val = getValueAfter(sectionLines, i);
            }
            if (val && /^[\d\-\+\s]+/.test(val)) {
                data.telephone = val;
            }
        }

        // Registration Number (companies only)
        else if (line.startsWith('Registration number:')) {
            let val = line.replace('Registration number:', '').trim();
            if (!val) {
                val = getValueAfter(sectionLines, i);
            }
            if (val) {
                data.registration_number = val;
            }
        }

        // Registration Date (companies only)
        else if (line.startsWith('Registration date:')) {
            let val = line.replace('Registration date:', '').trim();
            if (!val) {
                val = getValueAfter(sectionLines, i);
            }
            const m = RE_DATE.exec(val || '');
            if (m) {
                data.registration_date = m[0];
            }
        }

        // Legal Form (companies only, e.g., "Private Ltd. Co")
        else if (line.startsWith('Legal form:')) {
            let val = line.replace('Legal form:', '').trim();
            if (!val) {
                val = getValueAfter(sectionLines, i);
            }
            if (val) {
                data.legal_form = val;
            }
        }
    }

    // --- Secondary pass: extract inline fields from two-column layout ---
    // In real CIB PDFs, right-column fields like "Sector type: PRIVATE" appear
    // on the same line as left-column fields. Scan all lines for these.
    const fullText = sectionLines.join('\n');

    if (!data.sector_type) {
        const m = fullText.match(/Sector type:\s*([A-Z]+)/);
        if (m) data.sector_type = m[1];
    }

    if (!data.sector_code) {
        const m = fullText.match(/Sector code:\s*(\d+(?:\s*\([^)]*\))?)/);
        if (m) data.sector_code = m[1].trim();
    }

    if (!data.reference_number) {
        const m = fullText.match(/Reference number\s*\(Ref\.\):\s*(\d+\s*(?:\([^)]*\))?)/);
        if (m) data.reference_number = m[1].trim();
    }

    if (!data.tin) {
        const m = fullText.match(/TIN:\s*(\d+)/);
        if (m) data.tin = m[1];
    }

    if (!data.registration_number) {
        const m = fullText.match(/Registration number:\s*([A-Z0-9-]+)/);
        if (m) data.registration_number = m[1];
    }

    if (!data.registration_date) {
        const m = fullText.match(/Registration date:\s*(\d{2}\/\d{2}\/\d{4})/);
        if (m) data.registration_date = m[1];
    }

    if (!data.legal_form) {
        const m = fullText.match(/Legal form:\s*(.+?)(?:\n|$)/);
        if (m) data.legal_form = m[1].trim();
    }

    return data;
}


// =============================================================================
// SECTION 6: ADDRESS PARSING
// =============================================================================

/**
 * Parse all ADDRESS sections in the document.
 *
 * @param {string[]} lines - All cleaned text lines
 * @param {Object} sections - Section boundary dictionary
 * @returns {Object} Dictionary with address fields
 */
function parseAddresses(lines, sections) {
    const addresses = {
        permanent_address: '',
        present_address: '',
        business_address: '',
        factory_address: ''
    };

    // Map address types to dictionary keys
    const typeMap = {
        'Permanent': 'permanent_address',
        'Present': 'present_address',
        'Business': 'business_address',
        'Factory': 'factory_address',
        'Mailing': 'present_address'  // Treat mailing as present
    };

    const addrTypes = Object.keys(typeMap);

    // Find all ADDRESS blocks
    let i = 0;
    while (i < lines.length) {
        if (lines[i] === 'ADDRESS') {
            // Skip header lines (Address Type, Address, Postal code, etc.)
            let j = i + 1;
            while (j < lines.length && ['Address Type', 'Address', 'Postal code:', 'Postal code', 'District', 'Country', ''].includes(lines[j])) {
                j++;
            }

            // Read address entries until we hit a section boundary
            while (j < lines.length) {
                const line = lines[j];
                if (!line) {
                    j++;
                    continue;
                }

                // Check if we've hit a new section
                const sectionStarts = ['LINKED PROPRIETORSHIP', 'OWNERS LIST', '1. SUMMARY', 'SUBJECT INFORMATION', 'PROPRIETORSHIP CONCERN', 'CIB subject code:'];
                if (sectionStarts.some(x => line.startsWith(x))) {
                    break;
                }

                // Try to match an address type
                let matchedType = null;
                for (const atype of addrTypes) {
                    if (line.startsWith(atype)) {
                        matchedType = atype;
                        break;
                    }
                }

                if (matchedType) {
                    // Collect the address text and metadata
                    const addrText = line.substring(matchedType.length).trim();
                    const parts = addrText ? [addrText] : [];
                    let country = '';
                    let district = '';
                    let postal = '';

                    let k = j + 1;
                    while (k < lines.length) {
                        const nextLine = lines[k];
                        if (!nextLine) {
                            k++;
                            continue;
                        }
                        // Stop at next address type or section boundary
                        if (addrTypes.some(at => nextLine.startsWith(at))) {
                            break;
                        }
                        if (['LINKED', 'OWNERS', '1.', 'SUBJECT', 'CIB subject', 'ADDRESS', 'PROPRIETORSHIP'].some(x => nextLine.startsWith(x))) {
                            break;
                        }

                        // Country code (2 letters like "BD")
                        if (['BD', 'US', 'UK', 'IN', 'AE'].includes(nextLine)) {
                            country = nextLine;
                            k++;
                            break;
                        }
                        // Postal code (4 digits)
                        else if (/^\d{4}$/.test(nextLine) || nextLine === '0000') {
                            postal = nextLine;
                        }
                        // District name (capitalized word)
                        else if (/^[A-Z][A-Za-z]+$/.test(nextLine) && nextLine.length > 2) {
                            district = nextLine;
                        } else {
                            parts.push(nextLine);
                        }
                        k++;
                    }

                    // Build the full address string
                    let fullAddr = parts.filter(p => p).join(', ').replace(/^,\s*|,\s*$/g, '');
                    if (postal) {
                        fullAddr += `, ${postal}`;
                    }
                    if (district) {
                        fullAddr += `, ${district}`;
                    }
                    if (country) {
                        fullAddr += `, ${country}`;
                    }

                    // Store in the dictionary — concatenate if multiple of same type
                    const key = typeMap[matchedType];
                    if (addresses[key]) {
                        addresses[key] += ' | ' + fullAddr;
                    } else {
                        addresses[key] = fullAddr;
                    }

                    j = k;
                } else {
                    j++;
                }
            }
            i = j;
        } else {
            i++;
        }
    }

    return addresses;
}


// =============================================================================
// SECTION 7: OWNERS LIST (Companies)
// =============================================================================

/**
 * Parse the OWNERS LIST section for company subjects.
 *
 * @param {string[]} lines - All cleaned text lines
 * @param {Object} sections - Section boundary dictionary
 * @returns {Array} List of owner objects with: cib_subject_code, name, role, stay_order
 */
function parseOwnersList(lines, sections) {
    const owners = [];

    const start = sections.owners_list ?? -1;
    if (start === -1) {
        return owners;
    }

    // Skip header lines ("CIB subject code", "Name of the Owner/Company", etc.)
    let i = start + 1;
    while (i < lines.length && !lines[i].includes('Stay Order')) {
        i++;
    }
    i++; // Skip the "Stay Order" header line

    // Read until we hit the Summary section
    while (i < lines.length) {
        const line = lines[i];
        if (line.startsWith('1. SUMMARY') || line.startsWith('1.(A)')) {
            break;
        }
        if (!line) {
            i++;
            continue;
        }

        // CIB codes follow the pattern: one letter + 9+ digits
        if (RE_CIB_CODE.test(line)) {
            const code = line;
            const name = (i + 1 < lines.length) ? lines[i + 1] : '';
            const role = (i + 2 < lines.length) ? lines[i + 2] : '';

            if (name && role) {
                owners.push({
                    cib_subject_code: code,
                    name: name,
                    role: role,
                    stay_order: '' // Stay order column is usually empty
                });
            }
            i += 3;
        } else {
            i++;
        }
    }

    return owners;
}


// =============================================================================
// SECTION 8: LINKED PROPRIETORSHIPS
// =============================================================================

/**
 * Parse LINKED PROPRIETORSHIP(S) LIST section.
 *
 * @param {string[]} lines - All cleaned text lines
 * @param {Object} sections - Section boundary dictionary
 * @returns {Array} List of proprietorship objects
 */
function parseProprietorships(lines, sections) {
    const props = [];

    const start = sections.proprietorship ?? -1;
    if (start === -1) {
        return props;
    }

    // Find the end — usually the start of Summary section
    const end = sections.summary_borrower ?? lines.length;

    let prop = {};
    for (let i = start; i < end; i++) {
        const line = lines[i];

        if (line.startsWith('CIB subject code:') || (line === 'CIB subject' &&
                i + 1 < lines.length && lines[i + 1].startsWith('code:'))) {
            // If we have a previous prop, save it
            if (prop.cib_subject_code || prop.trade_name) {
                props.push(prop);
                prop = {};
            }

            let val = line.replace('CIB subject code:', '').trim();
            if (!val) {
                val = getValueAfter(lines, i);
            }
            const m = val.match(/^([A-Z]\d+)/);
            if (m) {
                prop.cib_subject_code = m[1];
            }
        }

        else if (line.startsWith('Reference number')) {
            let val = line.includes(':') ? line.split(':').slice(1).join(':').trim() : '';
            if (!val) {
                val = getValueAfter(lines, i);
            }
            prop.reference_number = val;
        }

        else if (line.startsWith('Trade Name:')) {
            let val = line.replace('Trade Name:', '').trim();
            if (!val) {
                val = getValueAfter(lines, i);
            }
            prop.trade_name = val;
        }

        else if (line.startsWith('Sector type:')) {
            let val = line.replace('Sector type:', '').trim();
            if (!val) {
                val = getValueAfter(lines, i);
            }
            prop.sector_type = val;
        }

        else if (line.startsWith('Sector code:')) {
            let val = line.replace('Sector code:', '').trim();
            if (!val) {
                val = getValueAfter(lines, i);
            }
            prop.sector_code = val;
        }
    }

    // Don't forget the last one
    if (prop.cib_subject_code || prop.trade_name) {
        props.push(prop);
    }

    return props;
}


// =============================================================================
// SECTION 9: SUMMARY STATS
// =============================================================================

/**
 * Parse the headline summary numbers for borrower or guarantor role.
 *
 * @param {string[]} lines - All cleaned text lines
 * @param {Object} sections - Section boundary dictionary
 * @param {string} role - 'borrower' or 'guarantor'
 * @returns {Object} Dictionary with summary statistics
 */
function parseSummaryStats(lines, sections, role) {
    const data = {};

    let start, end;
    if (role === 'borrower') {
        start = sections.summary_borrower ?? -1;
        end = sections.summary_1a ?? lines.length;
    } else {
        start = sections.summary_guarantor ?? -1;
        end = sections.summary_2a ?? lines.length;
    }

    if (start === -1) {
        return data;
    }

    // Parse the block between the section header and the classification matrix
    const block = lines.slice(start, end).join('\n');

    let m;

    m = block.match(/No of reporting Institutes:\s*\n?(\d+)/);
    if (m) {
        data.reporting_institutes = parseInt(m[1], 10);
    }

    m = block.match(/Total Overdue Amount:\s*\n?([\d,]+)/);
    if (m) {
        data.total_overdue = parseFloat(m[1].replace(/,/g, ''));
    }

    m = block.match(/No of Living Contracts:\s*\n?(\d+)/);
    if (m) {
        data.living_contracts = parseInt(m[1], 10);
    }

    m = block.match(/No of Stay order contracts:\s*\n?(\d+)/);
    if (m) {
        data.stay_order_contracts = parseInt(m[1], 10);
    }

    m = block.match(/Total Outstanding Amount:\s*\n?([\d,]+)/);
    if (m) {
        data.total_outstanding = parseFloat(m[1].replace(/,/g, ''));
    }

    // Stay order outstanding — may span multiple lines
    for (let i2 = start; i2 < Math.min(end, lines.length); i2++) {
        if (lines[i2].includes('Total Outstanding amount for Stay Order')) {
            for (let j2 = i2; j2 < Math.min(i2 + 5, lines.length); j2++) {
                const m2 = lines[j2].match(/^\s*([\d,]+)\s*$/);
                if (m2) {
                    data.stay_order_outstanding = parseFloat(m2[1].replace(/,/g, ''));
                    break;
                }
            }
        }
    }

    return data;
}


// =============================================================================
// SECTION 10: CLASSIFICATION MATRIX
// =============================================================================

/**
 * Parse sections 1(A) and 2(A): Funded Facility Classification Matrix.
 *
 * @param {string[]} lines - All cleaned text lines
 * @param {Object} sections - Section boundary dictionary
 * @param {string} role - 'borrower' or 'guarantor'
 * @returns {Array} List of classification matrix entries
 */
function parseClassificationMatrix(lines, sections, role) {
    const results = [];

    let start, end;
    if (role === 'borrower') {
        start = sections.summary_1a ?? -1;
        end = sections.summary_1b ?? (sections.summary_guarantor ?? lines.length);
    } else {
        start = sections.summary_2a ?? -1;
        end = sections.summary_2b ?? (sections.external_debt ?? lines.length);
    }

    if (start === -1) {
        return results;
    }

    // Detect facility types dynamically — older reports (2024) have 4 types, newer have 5
    // Scan the section header for "Non-Listed" to determine column count
    let activeFacilityTypes = FACILITY_TYPES; // default: 5 types
    let hasNonListed = false;
    for (let i = start; i < Math.min(start + 10, end, lines.length); i++) {
        if (lines[i].includes('Non-Listed')) {
            hasNonListed = true;
            break;
        }
    }
    if (!hasNonListed) {
        activeFacilityTypes = FACILITY_TYPES.filter(ft => ft !== 'Non-Listed securities');
    }

    const numCols = activeFacilityTypes.length; // 4 or 5 facility types
    const expectedNums = numCols * 2; // count + amount per facility type

    // The matrix is ROW-based: each row = classification name + inline numbers
    // e.g., "STD 2 5,858,463 0 0 0 0 2 5,858,463" (4 types × 2 = 8 numbers)
    // or "STD 1 1,187,429 0 0 0 0 0 0 1 1,187,429" (5 types × 2 = 10 numbers)
    // Special: "Willful Default" may split across lines with "(WD)" or "(Appeal)" on next line

    // Classification names to match (order matters — same as CLASSIFICATION_CATEGORIES)
    const classPatterns = [
        { name: 'STD', pattern: /^STD\s+/ },
        { name: 'SMA', pattern: /^SMA\s+/ },
        { name: 'SS (No)', pattern: /^SS\s*\(No\)\s+/ },
        { name: 'SS (Yes)', pattern: /^SS\s*\(Yes\)\s+/ },
        { name: 'DF', pattern: /^DF\s+/ },
        { name: 'BL', pattern: /^BL\s+/ },
        { name: 'BLW', pattern: /^BLW\s+/ },
        { name: 'Terminated', pattern: /^Terminated\s+/ },
        { name: 'Requested', pattern: /^Requested\s+/ },
        { name: 'Stay Order', pattern: /^Stay\s+Order\s+/ },
        { name: 'Willful Default (WD)', pattern: /^Willful\s+Default\s*(?:\(WD\))?\s+/ },
        { name: 'Willful Default (Appeal)', pattern: /^Willful\s+Default\s*(?:\(Appeal\))?\s+/ },
    ];

    // Track which classifications we've already seen (to distinguish the two "Willful Default" rows)
    const seen = new Set();

    for (let i = start; i < Math.min(end, lines.length); i++) {
        const line = lines[i].trim();

        for (const cp of classPatterns) {
            if (seen.has(cp.name)) continue;

            const m = cp.pattern.exec(line);
            if (!m) continue;

            // For "Willful Default" without (WD)/(Appeal) qualifier, need to check next line
            if (cp.name === 'Willful Default (WD)' && !line.includes('(WD)')) {
                // This is the first "Willful Default" row — check next line for "(WD)"
                const nextLine = (i + 1 < lines.length) ? lines[i + 1].trim() : '';
                if (nextLine !== '(WD)' && !nextLine.startsWith('(WD)')) {
                    // Might be "(WD)" on same line but we didn't match — skip
                    continue;
                }
            }
            if (cp.name === 'Willful Default (Appeal)' && !line.includes('(Appeal)')) {
                const nextLine = (i + 1 < lines.length) ? lines[i + 1].trim() : '';
                if (nextLine !== '(Appeal)' && !nextLine.startsWith('(Appeal)')) {
                    continue;
                }
            }

            // Extract numbers from the rest of the line after the classification name
            const afterName = line.substring(m[0].length);
            const numTokens = afterName.split(/\s+/).filter(t => t && /^[\d,]+$/.test(t));
            const nums = numTokens.map(t => parseFloat(t.replace(/,/g, '')));

            if (nums.length >= expectedNums) {
                seen.add(cp.name);
                // Map numbers to facility types: pairs of (count, amount)
                for (let fi = 0; fi < numCols; fi++) {
                    const count = Math.floor(nums[fi * 2]);
                    const amount = nums[fi * 2 + 1];
                    if (count > 0 || amount > 0) {
                        results.push({
                            role: role.toUpperCase(),
                            facility_type: activeFacilityTypes[fi],
                            classification: cp.name,
                            contract_count: count,
                            outstanding_amount: amount,
                        });
                    }
                }
                break;
            }
        }
    }

    return results;
}


// =============================================================================
// SECTION 10B: NON-FUNDED FACILITIES
// =============================================================================

/**
 * Parse sections 1(B) and 2(B): Non-Funded Facility summary.
 *
 * @param {string[]} lines - All cleaned text lines
 * @param {Object} sections - Section boundary dictionary
 * @param {string} role - 'borrower' or 'guarantor'
 * @returns {Array} List of non-funded facility entries
 */
function parseNonFunded(lines, sections, role) {
    const results = [];

    let start, end;
    if (role === 'borrower') {
        start = sections.summary_1b ?? -1;
        end = sections.summary_guarantor ?? lines.length;
    } else {
        start = sections.summary_2b ?? -1;
        end = sections.external_debt ?? (sections.installment_details ?? lines.length);
    }

    if (start === -1) {
        return results;
    }

    // Non-funded facility types to look for
    const nfTypes = {
        'Guarantee (GU)': 'GU',
        'Letter of credit (LC)': 'LC',
        'Other indirect facility (OF)': 'OF'
    };

    // Parse non-funded facility rows. Real PDFs produce inline rows like:
    // "Guarantee (GU) 0 0 0 0 0 0 0 0" — label + 8 numbers on one line
    for (let i = start; i < Math.min(end, lines.length); i++) {
        const line = lines[i];

        for (const [label, code] of Object.entries(nfTypes)) {
            if (line.includes(label) ||
                (code === 'GU' && line.includes('Guarantee') && !line.includes('Third Party')) ||
                (code === 'LC' && line.includes('Letter of credit')) ||
                (code === 'OF' && line.includes('Other indirect'))) {

                // First try: extract numbers from the SAME line (inline format)
                const tokens = line.split(/\s+/);
                const inlineNums = tokens.filter(t => RE_AMOUNT.test(t.trim())).map(t => parseFloat(t.replace(/,/g, '')));

                if (inlineNums.length >= 8) {
                    results.push({
                        facility_type: code,
                        role: role.toUpperCase(),
                        living_count: Math.floor(inlineNums[0]),
                        living_amount: inlineNums[1],
                        terminated_count: Math.floor(inlineNums[2]),
                        terminated_amount: inlineNums[3],
                        requested_count: Math.floor(inlineNums[4]),
                        requested_amount: inlineNums[5],
                        stay_order_count: Math.floor(inlineNums[6]),
                        stay_order_amount: inlineNums[7]
                    });
                    break;
                }

                // Fallback: collect numbers from subsequent lines
                const nums = [...inlineNums]; // start with any inline nums
                let j = i + 1;
                while (j < Math.min(i + 20, end, lines.length) && nums.length < 8) {
                    const val = lines[j].trim();
                    if (RE_AMOUNT.test(val) && !(val in nfTypes)) {
                        try {
                            nums.push(parseFloat(val.replace(/,/g, '')));
                        } catch (e) {
                            // skip
                        }
                    } else if (['Guarantee', 'Letter', 'Other indirect', 'Total'].some(x => val.startsWith(x))) {
                        break;
                    }
                    j++;
                }

                if (nums.length >= 8) {
                    results.push({
                        facility_type: code,
                        role: role.toUpperCase(),
                        living_count: Math.floor(nums[0]),
                        living_amount: nums[1],
                        terminated_count: Math.floor(nums[2]),
                        terminated_amount: nums[3],
                        requested_count: Math.floor(nums[4]),
                        requested_amount: nums[5],
                        stay_order_count: Math.floor(nums[6]),
                        stay_order_amount: nums[7]
                    });
                }
                break;
            }
        }
    }

    return results;
}


// =============================================================================
// SECTION 11: EXTERNAL DEBT
// =============================================================================

/**
 * Parse Section 3: Summary of Private Sector External Debt.
 *
 * @param {string[]} lines - All cleaned text lines
 * @param {Object} sections - Section boundary dictionary
 * @returns {Array} List of external debt entries
 */
function parseExternalDebt(lines, sections) {
    const results = [];

    const start = sections.external_debt ?? -1;
    if (start === -1) {
        return results;
    }

    // End at the next major section
    const end = sections.installment_details ?? (sections.non_installment_details ?? lines.length);

    // Look for any numeric data in this section
    for (let i = start + 1; i < Math.min(end, lines.length); i++) {
        const line = lines[i].trim();

        // Skip headers and empty lines
        if (!line || line.startsWith('3.') || line.includes('SUMMARY')) {
            continue;
        }

        // Look for debt type labels followed by amounts
        if (line.includes('External Debt') || line.includes('Foreign')) {
            const amountLine = getValueAfter(lines, i);
            if (amountLine) {
                const m = RE_AMOUNT.exec(amountLine);
                if (m) {
                    try {
                        const amount = parseFloat(m[0].replace(/,/g, ''));
                        if (amount > 0) {
                            results.push({
                                debt_type: line.trim(),
                                amount: amount,
                                currency: 'BDT',
                                details: '',
                            });
                        }
                    } catch (e) {
                        // skip
                    }
                }
            }
        }
    }

    return results;
}


// =============================================================================
// SECTION 12: CONTRACT PARSING
// =============================================================================

/**
 * Parse all contract detail blocks from the DETAILS sections.
 *
 * @param {string[]} lines - All cleaned text lines
 * @param {Object} sections - Section boundary dictionary
 * @returns {Array} List of contract objects
 */
function parseContracts(lines, sections) {
    const contracts = [];

    // Find the start of contract details — either installment or non-installment
    let detailStart = sections.installment_details ?? -1;
    if (detailStart === -1) {
        detailStart = sections.non_installment_details ?? -1;
    }
    if (detailStart === -1) {
        return contracts;
    }

    // End at NOTES section
    const detailEnd = sections.notes ?? lines.length;

    // Find all contract block starts within the details section
    const contractStarts = [];
    for (let i = detailStart; i < detailEnd; i++) {
        if (lines[i] === 'Ref' || (lines[i].startsWith('Ref') && (lines[i] + ' ' + (i + 1 < lines.length ? lines[i + 1] : '')).includes('FI code'))) {
            contractStarts.push(i);
        }
    }

    // Determine if each contract is installment or non-installment
    const nonInstStart = sections.non_installment_details ?? detailEnd;

    // Parse each contract block
    for (let idx = 0; idx < contractStarts.length; idx++) {
        const start = contractStarts[idx];
        const end = (idx + 1 < contractStarts.length) ? contractStarts[idx + 1] : detailEnd;

        const blockLines = lines.slice(start, end);
        const isInstallment = start < nonInstStart;

        const contract = parseSingleContract(blockLines, isInstallment);
        if (contract) {
            contracts.push(contract);
        }
    }

    return contracts;
}


/**
 * Parse a single contract block.
 *
 * @param {string[]} blockLines - Lines belonging to this contract block
 * @param {boolean} isInstallment - True if this is an installment facility
 * @returns {Object} Dictionary with all contract fields
 */
function parseSingleContract(blockLines, isInstallment) {
    const contract = {
        facility_category: isInstallment ? 'Installment' : 'Non-Installment'
    };

    // --- CIB Contract Code ---
    // The code may be on its own line OR embedded in the tabular data row:
    //   "1 (CIB Subject 215 0001 B0130024728 1277201574976347"
    // We search for a CIB code pattern anywhere in the first 15 lines.
    for (let idx = 0; idx < Math.min(15, blockLines.length); idx++) {
        const codeLine = blockLines[idx].trim();
        // Exact match (code is the entire line)
        if (RE_CIB_CODE.test(codeLine)) {
            contract.cib_contract_code = codeLine;
            break;
        }
        // CIB contract code embedded in a multi-value line (tabular row)
        const embeddedMatch = codeLine.match(/\b([A-Z]\d{9,})\b/);
        if (embeddedMatch && !codeLine.startsWith('CIB Subject') && !codeLine.includes('CIB Subject Code:')) {
            // Prefer the code that looks like a contract code (starts with B, C, D, etc.)
            // Skip subject codes (start with F) if another code is present
            const allCodes = [...codeLine.matchAll(/\b([A-Z]\d{9,})\b/g)].map(m => m[1]);
            const contractCode = allCodes.find(c => !c.startsWith('F')) || allCodes[0];
            if (contractCode) {
                contract.cib_contract_code = contractCode;
                break;
            }
        }
        // Handle masked contract codes (appear as "###", "# # #", etc.)
        if (/^[#\s]+$/.test(codeLine) && codeLine.includes('#')) {
            contract.cib_contract_code = '###';
            break;
        }
    }

    // --- CIB Subject Code (from reference) ---
    const blockText = blockLines.join('\n');
    const subjectCodeMatch = blockText.match(/CIB Subject\s*(?:\n)?Code:([A-Z]\d+)/);
    if (subjectCodeMatch) {
        contract.cib_subject_code = subjectCodeMatch[1].trim();
    }

    // --- Role, Phase, Facility (each may be on next line) ---
    for (let i = 0; i < blockLines.length; i++) {
        const line = blockLines[i];

        // Role: Borrower or Guarantor
        // In two-column layout: "Role: Borrower Date of Last Update: 10/09/2024 ..."
        if (line === 'Role:' || line.startsWith('Role:')) {
            let val = line.replace('Role:', '').trim();
            if (!val) {
                val = getValueAfter(blockLines, i);
            }
            // Strip trailing inline fields
            val = stripTrailingField(val, ['Date of Last', 'Contract History']);
            if (val) {
                contract.role = val;
            }
            // Also extract Date of Last Update from same line
            if (line.includes('Date of Last Update:')) {
                const m = RE_DATE.exec(line.split('Date of Last Update:')[1]);
                if (m) contract.last_update = m[0];
            }
        }

        // Phase: Living, Terminated, Terminated in advance, Requested
        // In two-column layout: "Phase: Living Date of Law suit: -"
        else if (line === 'Phase:' || line.startsWith('Phase:')) {
            let val = line.replace('Phase:', '').trim();
            if (!val) {
                val = getValueAfter(blockLines, i);
            }
            // Strip trailing inline fields
            val = stripTrailingField(val, ['Date of Law', 'Date of last', 'Monthly History']);
            // "Terminated in advance" spans two lines sometimes
            if (val && val.toLowerCase() === 'terminated in') {
                const nextVal = (i + 2 < blockLines.length) ? blockLines[i + 2].trim() : '';
                if (nextVal.toLowerCase() === 'advance' || nextVal.toLowerCase() === 'advance.') {
                    val = val + ' ' + nextVal;
                }
            }
            if (val && !val.startsWith('Date')) {
                contract.phase = val;
            }
        }

        // Facility type: Term Loan, Working Capital, Hire-Purchase, etc.
        // In two-column layout: "Facility: Hire-Purchase under Date of last payment:"
        else if (line === 'Facility:' || line.startsWith('Facility:')) {
            let val = line.replace('Facility:', '').trim();
            if (!val) {
                val = getValueAfter(blockLines, i);
            }
            // Strip trailing inline fields
            val = stripTrailingField(val, ['Date of last', 'Date of classification', 'Accounting', 'Monthly']);
            // May span multiple lines (e.g., "Hire-Purchase under" + "shirkatul Meelk")
            if (val) {
                let j = i + 1;
                while (j < Math.min(i + 4, blockLines.length)) {
                    const ns = blockLines[j].trim();
                    if (ns && ns === val) {
                        j++;
                        continue;
                    }
                    // Continue appending if line doesn't look like a metadata label or data
                    if (ns && !ns.startsWith('Date') && !ns.startsWith('Starting') &&
                        !ns.startsWith('Accounting') && !/^\d/.test(ns) && !ns.includes(':') &&
                        !ns.startsWith('Monthly') && !RE_DATE.test(ns)) {
                        val = val + ' ' + ns;
                        j++;
                    } else {
                        break;
                    }
                }
                contract.facility_type = val.trim();
            }
        }

        // Date of Last Update (standalone line)
        else if (line.startsWith('Date of Last Update:') && !contract.last_update) {
            let m = RE_DATE.exec(line);
            if (m) {
                contract.last_update = m[0];
            } else {
                const nextVal = getValueAfter(blockLines, i);
                m = RE_DATE.exec(nextVal);
                if (m) {
                    contract.last_update = m[0];
                }
            }
        }
    }

    // --- Numeric and date fields ---
    const fieldMappings = {
        'Starting date:': ['start_date', 'date'],
        'End date of contract:': ['end_date', 'date'],
        'Sanction Limit:': ['sanction_limit', 'float'],
        'Method of payment:': ['payment_method', 'str'],
        'Payments periodicity:': ['periodicity', 'str'],
        'Installment Amount:': ['installment_amount', 'float'],
        'Security Amount:': ['security_amount', 'float'],
        'Reorganized credit:': ['reorganized_credit', 'str'],
        'Security Type:': ['security_type', 'str'],
        'Date of last payment:': ['last_payment_date', 'date'],
        'Date of classification:': ['classification_date', 'date'],
        'Date of last rescheduling:': ['rescheduling_date', 'date'],
        'Subsidized credit Y/N:': ['subsidized_credit', 'str'],
    };

    for (let i = 0; i < blockLines.length; i++) {
        const line = blockLines[i];

        for (const [key, [field, ftype]] of Object.entries(fieldMappings)) {
            if (line.startsWith(key)) {
                let val = line.replace(key, '').trim();
                if (!val || val === '-') {
                    val = getValueAfter(blockLines, i);
                }
                if (val === '-' || !val) {
                    continue;
                }

                if (ftype === 'float') {
                    const m = val.match(/[\d,]+/);
                    if (m) {
                        contract[field] = parseFloat(m[0].replace(/,/g, ''));
                    }
                } else if (ftype === 'date') {
                    const m = RE_DATE.exec(val);
                    if (m) {
                        contract[field] = m[0];
                    }
                } else {
                    contract[field] = val;
                }
            }
        }

        // Special multi-line fields:

        // Total Disbursement Amount — multiple formats:
        // (1) Two lines: "Total Disbursement" then "Amount: 5,000,000"
        // (2) Inline: "Total Disbursement 5,000,000 Payments periodicity: Monthly"
        // (3) Split with interleave: "Total Disbursement" then "Amount: Installments ..."
        if (line.includes('Total Disbursement') && !contract.total_disbursement) {
            // Try inline: "Total Disbursement 5,000,000 ..."
            const inlineAmtMatch = line.match(/Total Disbursement\s+([\d,]+)/);
            if (inlineAmtMatch) {
                contract.total_disbursement = parseFloat(inlineAmtMatch[1].replace(/,/g, ''));
            } else {
                // Try next-line: "Amount: 5,000,000"
                const nextLine = (i + 1 < blockLines.length) ? blockLines[i + 1] : '';
                if (nextLine.startsWith('Amount:')) {
                    let val = nextLine.replace('Amount:', '').trim();
                    const m = val.match(/[\d,]+/);
                    if (m) {
                        contract.total_disbursement = parseFloat(m[0].replace(/,/g, ''));
                    }
                }
            }
        }

        // Total number of installments — formats:
        // (1) Two lines: "Total number of" then "installments: 60"
        // (2) Inline: "Total number of 60 Number of time(s) ..."
        if (line.startsWith('Total number of') && !contract.total_installments) {
            // Try inline: "Total number of 60 Number of ..."
            const inlineMatch = line.match(/Total number of\s+(\d+)/);
            if (inlineMatch) {
                contract.total_installments = parseInt(inlineMatch[1], 10);
            } else {
                const nextLine = (i + 1 < blockLines.length) ? blockLines[i + 1] : '';
                if (nextLine.includes('installments:')) {
                    let val = nextLine.replace('installments:', '').trim();
                    if (!val) {
                        val = getValueAfter(blockLines, i + 1);
                    }
                    const m = val.match(/(\d+)/);
                    if (m) {
                        contract.total_installments = parseInt(m[1], 10);
                    }
                }
            }
        }

        // Remaining installments — formats:
        // (1) "Remaining installments" then "Amount:" and "Number:" on next lines
        // (2) Inline: "Remaining 46 Reorganized credit: NO ..."
        if (line.startsWith('Remaining') && !contract.remaining_count) {
            // Try inline: "Remaining 46 Reorganized credit: NO"
            const inlineMatch = line.match(/Remaining\s+(\d+)\s+Reorganized/);
            if (inlineMatch) {
                contract.remaining_count = parseInt(inlineMatch[1], 10);
            } else if (line.startsWith('Remaining installments') && !line.includes('Amount') && !line.includes('Number')) {
                for (let k = i + 1; k < Math.min(i + 4, blockLines.length); k++) {
                    const ns = blockLines[k];
                    if (ns.startsWith('Amount:')) {
                        let val = ns.replace('Amount:', '').trim();
                        if (!val) {
                            val = getValueAfter(blockLines, k);
                        }
                        const m = val.match(/[\d,]+/);
                        if (m) {
                            contract.remaining_amount = parseFloat(m[0].replace(/,/g, ''));
                        }
                    } else if (ns.startsWith('Number:')) {
                        let val = ns.replace('Number:', '').trim();
                        if (!val) {
                            val = getValueAfter(blockLines, k);
                        }
                        const m = val.match(/(\d+)/);
                        if (m) {
                            contract.remaining_count = parseInt(m[1], 10);
                        }
                    }
                }
            }
        }

        // Third Party Guarantee Amount (split across lines)
        if (line === 'Third Party guarantee') {
            const nextLine = (i + 1 < blockLines.length) ? blockLines[i + 1] : '';
            if (nextLine.startsWith('Amount:')) {
                let val = nextLine.replace('Amount:', '').trim();
                if (!val) {
                    val = getValueAfter(blockLines, i + 1);
                }
                const m = val.match(/[\d,]+/);
                if (m) {
                    contract.third_party_guarantee = parseFloat(m[0].replace(/,/g, ''));
                }
            }
        }

        // Number of times rescheduled
        if (line.includes('Number of time(s)')) {
            const nextVal = getValueAfter(blockLines, i);
            if (nextVal && nextVal.startsWith('rescheduled')) {
                const val = nextVal.replace('rescheduled:', '').replace('rescheduled', '').trim();
                if (val) {
                    const m = val.match(/(\d+)/);
                    if (m) {
                        contract.times_rescheduled = parseInt(m[1], 10);
                    }
                }
            }
        }

        // Date of Law suit
        if (line.startsWith('Date of Law suit:')) {
            const val = line.replace('Date of Law suit:', '').trim();
            if (val && val !== '-') {
                const m = RE_DATE.exec(val);
                if (m) {
                    contract.lawsuit_date = m[0];
                }
            }
        }
    }

    // --- Monthly History ---
    contract.monthly_history = parseMonthlyHistory(blockLines, isInstallment);

    // --- Linked Subjects ---
    contract.linked_subjects = parseLinkedSubjects(blockLines);

    return contract;
}


// =============================================================================
// SECTION 13: MONTHLY HISTORY PARSING
// =============================================================================

/**
 * Parse the Monthly History table from a contract block.
 *
 * @param {string[]} blockLines - Lines belonging to this contract block
 * @param {boolean} isInstallment - True if installment facility
 * @returns {Array} List of monthly history entries
 */
function parseMonthlyHistory(blockLines, isInstallment) {
    const history = [];

    // Find "Monthly History" marker
    let mhStart = -1;
    for (let i = 0; i < blockLines.length; i++) {
        if (blockLines[i].includes('Monthly History')) {
            mhStart = i;
            break;
        }
    }

    if (mhStart === -1) {
        return history;
    }

    // Detect non-installment format by looking for "SancLmt" column header
    let isNonInst = !isInstallment;
    for (let idx = mhStart; idx < Math.min(mhStart + 20, blockLines.length); idx++) {
        if (blockLines[idx].includes('SancLmt')) {
            isNonInst = true;
            break;
        }
    }

    // Regex for orphan timestamps (e.g., "11:42:36 PM" on a line by itself)
    const RE_TIME_ONLY = /^\d{1,2}:\d{2}(:\d{2})?\s*[AP]M$/i;

    // Regex for inline monthly history row:
    // date amount amount amount/npi status default_wd
    // e.g., "31/08/2024 4,014,223 0 0 STD No"
    // e.g., "31/08/2024 5,000,000 4,014,223 0 STD No" (non-installment with sanction_limit)
    const RE_INLINE_ROW = /(\d{2}\/\d{2}\/\d{4})\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+(STD|SMA|SS|DF|BL|BLW)\s+(No|Yes|WD)/;

    // First pass: try to extract inline rows (common in real CIB PDFs where
    // contract metadata and monthly history are in two-column layout)
    for (let i = mhStart + 1; i < blockLines.length; i++) {
        const line = blockLines[i];

        // Stop at section boundaries
        if (line.startsWith('Contribution History') || line.startsWith('Other subjects linked')) {
            break;
        }

        const inlineMatch = RE_INLINE_ROW.exec(line);
        if (inlineMatch) {
            try {
                const date = inlineMatch[1];
                const v1 = parseFloat(inlineMatch[2].replace(/,/g, ''));
                const v2 = parseFloat(inlineMatch[3].replace(/,/g, ''));
                const v3 = parseFloat(inlineMatch[4].replace(/,/g, ''));
                const status = inlineMatch[5];
                const defaultWd = inlineMatch[6];

                if (isNonInst) {
                    history.push({
                        accounting_date: date,
                        sanction_limit: v1,
                        outstanding: v2,
                        overdue: v3,
                        npi: null,
                        status: status,
                        default_wd: defaultWd,
                        remarks_wd: ''
                    });
                } else {
                    history.push({
                        accounting_date: date,
                        outstanding: v1,
                        overdue: v2,
                        npi: Math.floor(v3),
                        sanction_limit: null,
                        status: status,
                        default_wd: defaultWd,
                        remarks_wd: ''
                    });
                }
            } catch (e) {
                // skip malformed row
            }
        }
    }

    // If inline parsing found rows, return them (this handles the interleaved two-column layout)
    if (history.length > 0) {
        return history;
    }

    // Fallback: one-value-per-line format (used in some PDFs or text extractions)
    const skipWords = new Set([
        'Accounting', 'Date', 'Outstanding', 'Overdue', 'NPI', 'Status',
        'Default', '&', 'Willful', 'Remarks', 'for', 'WD', 'SancLmt',
        'Outstand', 'Monthly History', 'Monthly', 'History',
        'Contract History (Credit History)'
    ]);

    const skipPrefixes = [
        'Phase:', 'Facility:', 'Date of Law', 'Date of last',
        'Date of classification', 'Starting date', 'End date',
        'CONFIDENTIAL', 'Sanction Limit', 'Total Disbursement',
        'Method of', 'Payments periodicity', 'Total number',
        'Installment Amount', 'Remaining', 'Security Amount',
        'Third Party', 'Reorganized', 'Security Type', 'Basis',
        'classification', 'judgment', 'Number of time',
        'rescheduled', 'Subsidized', 'Amount:'
    ];

    const skipValues = new Set([
        'Term Loan', 'Term', 'Loan', 'Living', 'Terminated',
        'Terminated in', 'advance', 'Cheque', 'Other', '-', 'NO', 'YES',
        'Working capital', 'financing', 'Hire-Purchase under',
        'shirkatul Meelk', 'Requested', '###'
    ]);

    const values = [];
    for (let i = mhStart + 1; i < blockLines.length; i++) {
        const line = blockLines[i];

        if (line.startsWith('Contribution History') || line.startsWith('Other subjects linked')) {
            break;
        }

        if (!line) continue;
        if (skipWords.has(line)) continue;
        if (line.split(/\s+/).every(w => skipWords.has(w))) continue;
        if (skipPrefixes.some(p => line.startsWith(p))) continue;
        if (RE_PAGE_NUMBER.test(line)) continue;
        if (skipValues.has(line)) continue;
        if (RE_TIME_ONLY.test(line)) continue;

        if (RE_DATE.test(line) || RE_AMOUNT.test(line.trim()) ||
                RE_STATUS.test(line) || RE_DEFAULT_WD.test(line)) {
            values.push(line);
        }
    }

    // Group values into rows of 6
    const rowSize = 6;
    let idx = 0;

    while (idx + rowSize - 1 < values.length) {
        if (RE_DATE.test(values[idx])) {
            try {
                if (isNonInst) {
                    history.push({
                        accounting_date: values[idx],
                        sanction_limit: parseFloat(values[idx + 1].replace(/,/g, '')),
                        outstanding: parseFloat(values[idx + 2].replace(/,/g, '')),
                        overdue: parseFloat(values[idx + 3].replace(/,/g, '')),
                        npi: null,
                        status: values[idx + 4],
                        default_wd: values[idx + 5],
                        remarks_wd: ''
                    });
                } else {
                    history.push({
                        accounting_date: values[idx],
                        outstanding: parseFloat(values[idx + 1].replace(/,/g, '')),
                        overdue: parseFloat(values[idx + 2].replace(/,/g, '')),
                        npi: parseInt(values[idx + 3], 10),
                        sanction_limit: null,
                        status: values[idx + 4],
                        default_wd: values[idx + 5],
                        remarks_wd: ''
                    });
                }
                idx += rowSize;
            } catch (e) {
                idx++;
            }
        } else {
            idx++;
        }
    }

    return history;
}


// =============================================================================
// SECTION 14: LINKED SUBJECTS
// =============================================================================

/**
 * Parse "Other subjects linked to the same contract" section.
 *
 * @param {string[]} blockLines - Lines belonging to this contract block
 * @returns {Array} List of linked subject objects
 */
function parseLinkedSubjects(blockLines) {
    const subjects = [];

    // Find the "Other subjects linked" marker
    let start = -1;
    for (let i = 0; i < blockLines.length; i++) {
        if (blockLines[i].includes('Other subjects linked to the same contract')) {
            start = i;
            break;
        }
    }

    if (start === -1) {
        return subjects;
    }

    // Skip header lines
    let i = start + 1;
    while (i < blockLines.length) {
        const line = blockLines[i];
        if (['CIB subject code', 'Role', 'Name', ''].includes(line)) {
            i++;
        } else {
            break;
        }
    }

    // Valid roles for linked subjects
    const validRoles = new Set(['Borrower', 'Guarantor', 'Co-Borrower']);

    // Read triples: code, role, name
    while (i < blockLines.length) {
        const line = blockLines[i];
        if (!line) {
            i++;
            continue;
        }

        // CIB code pattern: one letter + 9+ digits
        if (RE_CIB_CODE.test(line)) {
            const code = line;
            const role = (i + 1 < blockLines.length) ? blockLines[i + 1] : '';
            const name = (i + 2 < blockLines.length) ? blockLines[i + 2] : '';

            if (validRoles.has(role) && name) {
                subjects.push({
                    cib_subject_code: code,
                    role: role,
                    name: name
                });
                i += 3;
            } else {
                i++;
            }
        } else {
            // Hit non-CIB-code line — check if we should stop
            if (line.startsWith('Accounting') || line.startsWith('Ref') || RE_DATE.test(line)) {
                break;
            }
            i++;
        }
    }

    return subjects;
}


// =============================================================================
// SECTION 15: CIB SUBJECT CODES UNDER REFERENCE
// =============================================================================

/**
 * Extract CIB Subject Codes 1-5 that appear under the Reference Number
 * in the INQUIRED section.
 *
 * @param {string[]} lines - All cleaned text lines
 * @param {Object} sections - Section boundary dictionary
 * @returns {string[]} List of up to 5 CIB subject codes
 */
function parseCibSubjectCodesUnderRef(lines, sections) {
    const codes = [];

    const start = sections.inquired ?? 0;
    const end = sections.subject_info ?? lines.length;

    for (let i = start; i < Math.min(end, lines.length); i++) {
        const line = lines[i].trim();
        if (RE_CIB_CODE.test(line) && !codes.includes(line)) {
            codes.push(line);
            if (codes.length >= 5) {
                break;
            }
        }
    }

    return codes;
}


// =============================================================================
// SECTION 16: DERIVED METRICS
// =============================================================================

/**
 * Compute derived credit quality metrics from the extracted data.
 *
 * @param {Object} report - The complete parsed report dictionary
 * @returns {Object} Dictionary with derived metrics
 */
function computeDerivedMetrics(report) {
    const metrics = {
        worst_class_borrower: 'STD',
        worst_class_guarantor: 'STD',
        ever_overdue_borrower: false,
        max_overdue_borrower: 0.0,
        max_npi_borrower: 0,
        ever_overdue_guarantor: false,
        max_overdue_guarantor: 0.0,
        max_npi_guarantor: 0,
        has_willful_default: false,
    };

    const contracts = report.contracts || [];
    for (const contract of contracts) {
        const role = (contract.role || '').toLowerCase();
        const roleKey = role.includes('borrower') ? 'borrower' : 'guarantor';

        const monthlyHistory = contract.monthly_history || [];
        for (const hist of monthlyHistory) {
            const status = hist.status || 'STD';
            const overdue = hist.overdue || 0;
            const npi = hist.npi || 0;
            const defaultWd = hist.default_wd || 'No';

            // Update worst classification
            const currentWorst = metrics[`worst_class_${roleKey}`];
            if (CLASSIFICATION_ORDER.includes(status) && CLASSIFICATION_ORDER.includes(currentWorst)) {
                if (CLASSIFICATION_ORDER.indexOf(status) > CLASSIFICATION_ORDER.indexOf(currentWorst)) {
                    metrics[`worst_class_${roleKey}`] = status;
                }
            }

            // Update overdue metrics
            if (overdue > 0) {
                metrics[`ever_overdue_${roleKey}`] = true;
                if (overdue > metrics[`max_overdue_${roleKey}`]) {
                    metrics[`max_overdue_${roleKey}`] = overdue;
                }
            }

            // Update NPI
            if (npi > metrics[`max_npi_${roleKey}`]) {
                metrics[`max_npi_${roleKey}`] = npi;
            }

            // Willful default check
            if (defaultWd === 'Yes' || defaultWd === 'WD') {
                metrics.has_willful_default = true;
            }
        }
    }

    return metrics;
}


// =============================================================================
// SECTION 17: VALIDATION
// =============================================================================

/**
 * Check for potential extraction issues and return warnings.
 *
 * @param {Object} report - The complete parsed report dictionary
 * @returns {string[]} List of warning strings
 */
function validateExtraction(report) {
    const warnings = [];

    const subj = report.subject || {};

    // Every report should have a CIB Subject Code
    if (!subj.cib_subject_code) {
        warnings.push("Missing CIB Subject Code");
    }

    // Every report should have a subject type
    if (!subj.subject_type) {
        warnings.push("Missing Subject Type");
    }

    // Individuals should have a name
    if ((subj.subject_type || '').toUpperCase() === 'INDIVIDUAL' && !subj.name) {
        warnings.push("Missing Name for Individual subject");
    }

    // Companies should have a trade name
    if ((subj.subject_type || '').toUpperCase() === 'COMPANY' && !subj.trade_name) {
        warnings.push("Missing Trade Name for Company subject");
    }

    // Check contract count against summary
    const summaryB = report.summary_borrower || {};
    const summaryG = report.summary_guarantor || {};
    const expectedLiving = (summaryB.living_contracts || 0) + (summaryG.living_contracts || 0);

    const actualLiving = (report.contracts || []).filter(c => (c.phase || '').toLowerCase() === 'living').length;

    if (expectedLiving > 0 && actualLiving !== expectedLiving) {
        warnings.push(`Contract count mismatch: Summary says ${expectedLiving} living, found ${actualLiving}`);
    }

    // Check for contracts with no monthly history (may indicate parsing issue)
    for (const c of (report.contracts || [])) {
        if (!c.monthly_history || c.monthly_history.length === 0) {
            if ((c.phase || '').toLowerCase() !== 'requested') {
                const code = c.cib_contract_code || 'Unknown';
                warnings.push(`Contract ${code} has no monthly history`);
            }
        }
    }

    return warnings;
}


// =============================================================================
// SECTION 18: MASTER PARSE FUNCTION
// =============================================================================

/**
 * Parse a complete CIB report from pre-extracted text into structured data.
 *
 * 4-stage pipeline:
 *     Stage 1: Raw Text -> Cleaned Lines + Section Boundaries
 *     Stage 2: Lines -> Typed Fields (section parsers)
 *     Stage 3: Fields -> Validated Report (derived metrics + validation)
 *     Stage 4: Return complete report dict
 *
 * @param {string} text - Raw text already extracted from the PDF
 * @param {string} sourceFile - Original PDF filename
 * @param {string} fileHash - MD5 hash of the PDF file
 * @returns {Object} Dictionary containing all extracted and derived data
 */
function parseReport(text, sourceFile, fileHash) {
    // Stage 1: Raw Text -> Cleaned Lines + Section Boundaries
    const lines = cleanAndSplit(text);
    const sections = findSectionBoundaries(lines);

    // Stage 2: Lines -> Typed Fields (each section parser)
    const subject = parseSubjectInfo(lines, sections);

    // Extract CIB Subject Codes under reference number
    const refCodes = parseCibSubjectCodesUnderRef(lines, sections);
    for (let idx = 0; idx < Math.min(refCodes.length, 5); idx++) {
        subject[`cib_subject_code_${idx + 1}`] = refCodes[idx];
    }

    // Extract contract history period from match status
    const matchData = parseMatchStatus(lines, sections);
    if (matchData.contract_history_months) {
        subject.contract_history_period = `${matchData.contract_history_months} months`;
    }

    const report = {
        source_file: sourceFile || '',
        file_hash: fileHash || '',
        parse_timestamp: new Date().toISOString(),
        parser_version: PARSER_VERSION,
        inquiry: parseInquiryHeader(lines, sections),
        match_status: matchData,
        nid_verification: parseNidVerification(lines, sections),
        subject: subject,
        addresses: parseAddresses(lines, sections),
        owners: parseOwnersList(lines, sections),
        proprietorships: parseProprietorships(lines, sections),
        summary_borrower: parseSummaryStats(lines, sections, 'borrower'),
        summary_guarantor: parseSummaryStats(lines, sections, 'guarantor'),
        non_funded_borrower: parseNonFunded(lines, sections, 'borrower'),
        non_funded_guarantor: parseNonFunded(lines, sections, 'guarantor'),
        matrix_borrower: parseClassificationMatrix(lines, sections, 'borrower'),
        matrix_guarantor: parseClassificationMatrix(lines, sections, 'guarantor'),
        external_debt: parseExternalDebt(lines, sections),
        contracts: parseContracts(lines, sections),
    };

    // Stage 3: Derived Metrics + Validation
    report.metrics = computeDerivedMetrics(report);
    report.extraction_warnings = validateExtraction(report);

    // Stage 4: Return complete report
    return report;
}


// =============================================================================
// EXPORTS
// =============================================================================

export {
    // Constants
    PARSER_VERSION,
    CLASSIFICATION_ORDER,
    CLASSIFICATION_CATEGORIES,
    FACILITY_TYPES,

    // Regex patterns
    RE_DATE,
    RE_CIB_CODE,
    RE_CONTRACT_CODE,
    RE_AMOUNT,
    RE_INQUIRY_DATE,
    RE_NID_17,
    RE_NID_10,
    RE_PAGE_NUMBER,
    RE_STATUS,
    RE_DEFAULT_WD,

    // Core utilities
    cleanAndSplit,
    getValueAfter,
    findSectionBoundaries,

    // Section parsers
    parseInquiryHeader,
    parseMatchStatus,
    parseNidVerification,
    parseSubjectInfo,
    parseAddresses,
    parseOwnersList,
    parseProprietorships,
    parseSummaryStats as parseSummarySection,
    parseClassificationMatrix,
    parseNonFunded as parseNonFundedSummary,
    parseExternalDebt,
    parseContracts,
    parseSingleContract,
    parseMonthlyHistory,
    parseLinkedSubjects,
    parseCibSubjectCodesUnderRef,

    // Post-processing
    computeDerivedMetrics,
    validateExtraction,

    // Main entry point
    parseReport,
};
