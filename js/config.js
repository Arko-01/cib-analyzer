/**
 * CIB Analyzer — Configuration (ported from config.py)
 */

export const APP_NAME = "CIB Analyzer";
export const APP_VERSION = "2.0.0";
export const PARSER_VERSION = "2.0.0";
export const SCHEMA_VERSION = 1;

// File processing
export const MAX_PDF_SIZE_BYTES = 10 * 1024 * 1024;
export const CIB_IDENTIFIER_TEXT = "Credit Information Report";

// Search
export const SEARCH_DEBOUNCE_MS = 200;
export const MAX_SEARCH_RESULTS = 50;

// Classification
export const CLASSIFICATION_ORDER = ["STD", "SMA", "SS", "DF", "BL", "BLW"];

export const CLASSIFICATION_CATEGORIES = [
    "STD", "SMA", "SS (No)", "SS (Yes)", "DF", "BL", "BLW",
    "Terminated", "Requested", "Stay Order",
    "Willful Default (WD)", "Willful Default (Appeal)"
];

export const FACILITY_TYPES = [
    "Installments", "Non-Installments", "Credit Cards",
    "Non-Listed securities", "Total"
];

export const NON_FUNDED_TYPES = [
    "Guarantee (GU)", "Letter of credit (LC)",
    "Other indirect facility (OF)"
];

// Risk scoring
export const RISK_TIERS = ["ADVERSE", "HIGH RISK", "MODERATE", "NO HISTORY", "LOW RISK"];

export const RISK_THRESHOLDS = {
    adverse_classifications: ["DF", "BL", "BLW"],
    willful_default_values: ["Yes", "WD"],
    high_classifications: ["SS"],
    high_npi_min: 6,
    moderate_overdue_chronic_months: 6,
    high_rescheduled_min: 2,
    moderate_classifications: ["SMA"],
    moderate_npi_min: 1,
};

export const ALERT_FLAGS = [
    "GUARANTOR_FOR_DEFAULTER",
    "RESCHEDULED_MULTIPLE",
    "HIGH_NPI",
    "OVERDUE_CHRONIC",
    "WILLFUL_DEFAULT_LINKED",
    "CLASSIFICATION_DETERIORATING",
];

export const ADVERSE_CLASSIFICATIONS = ["SMA", "SS", "DF", "BL", "BLW"];
export const WILLFUL_DEFAULT_VALUES = ["Yes", "WD"];

// Excel formatting
export const AMOUNT_FORMAT = '#,##0.00';
export const DATE_FORMAT = 'DD/MM/YYYY';
export const HEADER_BG_COLOR = "203864";
export const HEADER_FONT_COLOR = "FFFFFF";
export const TITLE_BG_COLOR = "203864";
export const TITLE_FONT_COLOR = "FFFFFF";
export const SECTION_BG_COLOR = "F5F5ED";
export const ALERT_BG_COLOR = "FFE0E0";
export const GREEN_BG_COLOR = "E2EFDA";
export const AMBER_BG_COLOR = "FFF2CC";

// Timeline / classification colors
export const TIMELINE_COLORS = {
    STD: "#96C458",
    SMA: "#F5A623",
    SS: "#DD4749",
    DF: "#DD4749",
    BL: "#DD4749",
    BLW: "#DD4749",
    WD: "#4E1412",
    NO_DATA: "#D0D0D0",
};

// Risk badge colors
export const RISK_COLORS = {
    "LOW RISK": "#96C458",
    "NO HISTORY": "#AAAAAA",
    "MODERATE": "#F5A623",
    "HIGH RISK": "#DD4749",
    "ADVERSE": "#4E1412",
};

// DSCR thresholds and colors
export const DSCR_THRESHOLDS = {
    green: 1.5,
    yellow: 1.25,
    amber: 1.0,
};

export const DSCR_COLORS = {
    green: "#96C458",
    yellow: "#F5D623",
    amber: "#F5A623",
    red: "#DD4749",
};

// Guarantor exposure thresholds
export const GUARANTOR_EXPOSURE = {
    medium_pct: 0.25,
    high_pct: 0.50,
};

// Taka symbol
export const TAKA_SYMBOL = "\u09F3";

// DB filename
export const DB_FILENAME = "cib_master.db";
