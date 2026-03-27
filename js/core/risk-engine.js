/**
 * CIB Analyzer — Risk Scoring Engine (ported from risk_engine.py)
 * 5-tier rule-based risk assessment:
 *   ADVERSE → HIGH RISK → MODERATE → NO HISTORY → LOW RISK
 */

import { CLASSIFICATION_ORDER, RISK_THRESHOLDS } from '../config.js';

/**
 * Compute overall risk rating for a subject.
 * @param {Object} subjectData - Full subject record
 * @param {Array} contracts - List of contract objects with monthly_history
 * @returns {[string, string[]]} [rating, factors]
 */
export function computeSubjectRisk(subjectData, contracts) {
    let factors = [];

    const allStatuses = [];
    const allNpi = [];
    const allOverdue = [];
    let hasWillfulDefault = false;
    let timesRescheduledTotal = 0;
    let livingContracts = 0;

    for (const c of contracts) {
        if ((c.phase || '').toLowerCase() === 'living') {
            livingContracts++;
        }
        timesRescheduledTotal += (c.times_rescheduled || 0);

        for (const h of (c.monthly_history || [])) {
            const status = h.status || '';
            if (status) allStatuses.push(status);
            allNpi.push(h.npi || 0);
            allOverdue.push(h.overdue || 0);
            const wd = h.default_wd || '';
            if (RISK_THRESHOLDS.willful_default_values.includes(wd)) {
                hasWillfulDefault = true;
            }
        }
    }

    // ── ADVERSE ──
    const adverseCls = RISK_THRESHOLDS.adverse_classifications;
    for (const s of allStatuses) {
        if (adverseCls.includes(s)) {
            factors.push(`Classification ${s} found in history`);
        }
    }
    if (hasWillfulDefault) {
        factors.push("Willful default flagged");
    }
    if (factors.length) return ["ADVERSE", factors];

    // ── HIGH RISK ──
    factors = [];
    const highCls = RISK_THRESHOLDS.high_classifications;
    for (const s of allStatuses) {
        if (highCls.includes(s)) {
            factors.push(`Classification ${s} found in history`);
        }
    }

    const maxNpi = allNpi.length ? Math.max(...allNpi) : 0;
    if (maxNpi >= RISK_THRESHOLDS.high_npi_min) {
        factors.push(`Max NPI = ${maxNpi} (threshold: ${RISK_THRESHOLDS.high_npi_min})`);
    }

    if (timesRescheduledTotal >= RISK_THRESHOLDS.high_rescheduled_min) {
        factors.push(`Rescheduled ${timesRescheduledTotal} times`);
    }

    if (factors.length) return ["HIGH RISK", factors];

    // ── MODERATE ──
    factors = [];
    const moderateCls = RISK_THRESHOLDS.moderate_classifications;
    for (const s of allStatuses) {
        if (moderateCls.includes(s)) {
            factors.push(`Classification ${s} found`);
        }
    }

    if (maxNpi >= RISK_THRESHOLDS.moderate_npi_min) {
        factors.push(`NPI = ${maxNpi}`);
    }

    const overdueMonths = allOverdue.filter(o => o > 0).length;
    if (overdueMonths >= RISK_THRESHOLDS.moderate_overdue_chronic_months) {
        factors.push(`Overdue in ${overdueMonths} months (chronic)`);
    }

    if (factors.length) return ["MODERATE", factors];

    // ── NO HISTORY ──
    if (livingContracts === 0 && contracts.length === 0) {
        return ["NO HISTORY", ["No credit contracts found"]];
    }

    // ── LOW RISK ──
    return ["LOW RISK", ["All contracts in good standing"]];
}

/**
 * Compute 10 per-contract risk columns from monthly history.
 */
export function computeContractRiskColumns(contract) {
    const history = contract.monthly_history || [];

    if (!history.length) {
        return {
            worst_ever_classification: "",
            max_overdue_amount: 0,
            max_npi: 0,
            ever_overdue: 0,
            months_in_overdue: 0,
            classification_trend: "",
            last_classification_date: "",
            on_time_payment_rate: 0,
            overdue_streak_max: 0,
            outstanding_trend: "",
            contract_risk: "",
        };
    }

    const sortedHist = [...history].sort((a, b) =>
        (a.accounting_date || '').localeCompare(b.accounting_date || '')
    );

    let worstCls = "STD";
    let maxOverdue = 0;
    let maxNpi = 0;
    let everOverdue = 0;
    let monthsOverdue = 0;
    let onTimeCount = 0;
    let overdueStreak = 0;
    let overdueStreakMax = 0;
    const statuses = [];
    const outstandings = [];

    for (const h of sortedHist) {
        const status = h.status || "STD";
        const overdue = h.overdue || 0;
        const npi = h.npi || 0;
        const outstanding = h.outstanding || 0;

        // Worst classification
        if (CLASSIFICATION_ORDER.includes(status) && CLASSIFICATION_ORDER.includes(worstCls)) {
            if (CLASSIFICATION_ORDER.indexOf(status) > CLASSIFICATION_ORDER.indexOf(worstCls)) {
                worstCls = status;
            }
        }

        // Overdue tracking
        if (overdue > 0) {
            everOverdue = 1;
            monthsOverdue++;
            overdueStreak++;
            if (overdue > maxOverdue) maxOverdue = overdue;
        } else {
            onTimeCount++;
            if (overdueStreak > overdueStreakMax) overdueStreakMax = overdueStreak;
            overdueStreak = 0;
        }

        if (npi > maxNpi) maxNpi = npi;
        statuses.push(status);
        outstandings.push(outstanding);
    }

    if (overdueStreak > overdueStreakMax) overdueStreakMax = overdueStreak;

    const totalMonths = sortedHist.length;
    const onTimeRate = totalMonths > 0 ? (onTimeCount / totalMonths * 100) : 0;

    // Classification trend
    let trend = "";
    if (statuses.length >= 6) {
        const clsIdx = s => CLASSIFICATION_ORDER.includes(s) ? CLASSIFICATION_ORDER.indexOf(s) : 0;
        const firstWorst = Math.max(...statuses.slice(0, 3).map(clsIdx));
        const lastWorst = Math.max(...statuses.slice(-3).map(clsIdx));
        if (lastWorst < firstWorst) trend = "improving";
        else if (lastWorst > firstWorst) trend = "deteriorating";
        else trend = "stable";
    } else if (statuses.length) {
        trend = "stable";
    }

    // Outstanding trend
    let outTrend = "";
    if (outstandings.length >= 3) {
        const firstAvg = outstandings.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
        const lastAvg = outstandings.slice(-3).reduce((a, b) => a + b, 0) / 3;
        if (lastAvg < firstAvg * 0.9) outTrend = "decreasing";
        else if (lastAvg > firstAvg * 1.1) outTrend = "increasing";
        else outTrend = "stable";
    }

    // Last classification date
    let lastClsDate = "";
    for (let i = sortedHist.length - 1; i >= 0; i--) {
        if (sortedHist[i].status && sortedHist[i].accounting_date) {
            lastClsDate = sortedHist[i].accounting_date;
            break;
        }
    }

    // Contract-level risk
    let contractRisk = "LOW";
    if (["DF", "BL", "BLW"].includes(worstCls)) contractRisk = "ADVERSE";
    else if (["SS"].includes(worstCls)) contractRisk = "HIGH";
    else if (["SMA"].includes(worstCls) || maxNpi >= 1) contractRisk = "MODERATE";

    return {
        worst_ever_classification: worstCls,
        max_overdue_amount: maxOverdue,
        max_npi: maxNpi,
        ever_overdue: everOverdue,
        months_in_overdue: monthsOverdue,
        classification_trend: trend,
        last_classification_date: lastClsDate,
        on_time_payment_rate: Math.round(onTimeRate * 10) / 10,
        overdue_streak_max: overdueStreakMax,
        outstanding_trend: outTrend,
        contract_risk: contractRisk,
    };
}

/**
 * Generate alert flags for a subject.
 */
export function computeAlertFlags(subjectData, contracts, relationshipData = null) {
    const flags = [];

    // RESCHEDULED_MULTIPLE
    for (const c of contracts) {
        const times = c.times_rescheduled || 0;
        if (times >= 2) {
            flags.push({
                flag_type: "RESCHEDULED_MULTIPLE",
                severity: "HIGH",
                details: `Rescheduled ${times} times`,
                related_contract: c.cib_contract_code || "",
            });
        }
    }

    // HIGH_NPI
    for (const c of contracts) {
        for (const h of (c.monthly_history || [])) {
            const npi = h.npi || 0;
            if (npi >= 6) {
                flags.push({
                    flag_type: "HIGH_NPI",
                    severity: "HIGH",
                    details: `NPI = ${npi} on date ${h.accounting_date || 'N/A'}`,
                    related_contract: c.cib_contract_code || "",
                });
                break;
            }
        }
    }

    // OVERDUE_CHRONIC
    for (const c of contracts) {
        const hist = c.monthly_history || [];
        const overdueMonths = hist.filter(h => (h.overdue || 0) > 0).length;
        if (overdueMonths >= 6) {
            flags.push({
                flag_type: "OVERDUE_CHRONIC",
                severity: "WARNING",
                details: `Overdue in ${overdueMonths} of ${hist.length} months`,
                related_contract: c.cib_contract_code || "",
            });
        }
    }

    // CLASSIFICATION_DETERIORATING
    for (const c of contracts) {
        const history = [...(c.monthly_history || [])].sort((a, b) =>
            (a.accounting_date || '').localeCompare(b.accounting_date || '')
        );
        if (history.length >= 6) {
            const clsIdx = s => CLASSIFICATION_ORDER.includes(s) ? CLASSIFICATION_ORDER.indexOf(s) : 0;
            const recent = history.slice(-3).map(h => h.status || 'STD');
            const earlier = history.slice(0, 3).map(h => h.status || 'STD');
            const recentWorst = Math.max(...recent.map(clsIdx));
            const earlierWorst = Math.max(...earlier.map(clsIdx));
            if (recentWorst > earlierWorst) {
                flags.push({
                    flag_type: "CLASSIFICATION_DETERIORATING",
                    severity: "WARNING",
                    details: "Classification worsened from recent history",
                    related_contract: c.cib_contract_code || "",
                });
            }
        }
    }

    // WILLFUL_DEFAULT_LINKED
    for (const c of contracts) {
        for (const h of (c.monthly_history || [])) {
            if (["Yes", "WD"].includes(h.default_wd)) {
                flags.push({
                    flag_type: "WILLFUL_DEFAULT_LINKED",
                    severity: "CRITICAL",
                    details: `Willful default on date ${h.accounting_date || 'N/A'}`,
                    related_contract: c.cib_contract_code || "",
                });
                break;
            }
        }
    }

    // Deduplicate by (flag_type, related_contract)
    const seen = new Set();
    const uniqueFlags = [];
    for (const f of flags) {
        const key = `${f.flag_type}|${f.related_contract}`;
        if (!seen.has(key)) {
            seen.add(key);
            uniqueFlags.push(f);
        }
    }

    return uniqueFlags;
}

/**
 * Run full risk assessment for a subject. Updates the database.
 * @param {Object} db - CIBDatabase instance
 * @param {string} cibCode - CIB subject code
 */
export function runRiskAssessment(db, cibCode) {
    const subjectData = db.getSubjectFull(cibCode);
    if (!subjectData) return;

    const contracts = subjectData.contracts || [];

    // Compute per-contract risk columns
    for (const c of contracts) {
        const riskCols = computeContractRiskColumns(c);
        db.updateContractRiskColumns(c.id, riskCols);
    }

    // Compute subject-level risk
    const [rating, factors] = computeSubjectRisk(subjectData, contracts);
    db.updateSubjectRisk(cibCode, rating, factors);

    // Compute alert flags
    const relationshipData = db.getRelationshipData(cibCode);
    const flags = computeAlertFlags(subjectData, contracts, relationshipData);
    db.storeAlertFlags(cibCode, flags);
}
