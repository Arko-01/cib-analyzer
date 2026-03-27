/**
 * CIB Analyzer — PDF Text Extraction (replaces pymupdf/fitz)
 * Uses pdf.js to extract text from CIB PDF reports.
 *
 * Key challenge: pdf.js returns positioned text items, not line-by-line text.
 * We must reconstruct lines by grouping items by Y-coordinate and sorting by X.
 */

/* global pdfjsLib */

/**
 * Extract all text from a PDF ArrayBuffer, returning line-by-line text
 * matching pymupdf's page.get_text() output as closely as possible.
 *
 * @param {ArrayBuffer} arrayBuffer - Raw PDF file data
 * @returns {Promise<string>} Full text with newlines
 */
export async function extractText(arrayBuffer) {
    const pdf = await pdfjsLib.getDocument({
        data: arrayBuffer,
        // pdf.js ignores permission flags by default (same as pymupdf)
    }).promise;

    let fullText = '';

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const content = await page.getTextContent();

        // Reconstruct lines from positioned text items
        const pageText = reconstructLines(content.items, page.view);
        fullText += pageText + '\n';
    }

    return fullText;
}

/**
 * Reconstruct line-by-line text from pdf.js text items.
 *
 * pymupdf's get_text() groups text by lines (same Y baseline) and
 * orders left-to-right. We replicate this by:
 * 1. Grouping items with similar Y positions (within tolerance)
 * 2. Sorting each group by X position
 * 3. Joining with spaces where gaps exist
 *
 * @param {Array} items - pdf.js text content items
 * @param {Array} viewport - Page viewport [x0, y0, x1, y1]
 * @returns {string} Reconstructed text
 */
function reconstructLines(items, viewport) {
    if (!items.length) return '';

    // Each item has: str, transform[4]=x, transform[5]=y, width, height
    // Note: PDF Y-axis is bottom-up, but pdf.js transform already accounts for this
    // in getTextContent — items come in reading order per page.

    // However, CIB PDFs have table layouts where items from different cells
    // share similar Y positions. We need to group by Y and sort by X.

    const LINE_Y_TOLERANCE = 3; // pixels — items within this Y range = same line

    // Extract position info
    const positioned = items.map(item => ({
        text: item.str,
        x: item.transform[4],
        y: item.transform[5],
        width: item.width || 0,
        height: item.height || 0,
    }));

    // Sort by Y descending (top of page first), then X ascending
    positioned.sort((a, b) => {
        if (Math.abs(a.y - b.y) > LINE_Y_TOLERANCE) {
            return b.y - a.y; // Higher Y = earlier in document (top-down)
        }
        return a.x - b.x; // Same line: left to right
    });

    // Group into lines by Y proximity
    const lines = [];
    let currentLine = [positioned[0]];

    for (let i = 1; i < positioned.length; i++) {
        const item = positioned[i];
        const prevItem = currentLine[currentLine.length - 1];

        if (Math.abs(item.y - prevItem.y) <= LINE_Y_TOLERANCE) {
            // Same line — but re-sort by X to handle out-of-order items
            currentLine.push(item);
        } else {
            // New line
            lines.push(currentLine);
            currentLine = [item];
        }
    }
    lines.push(currentLine);

    // Build text from lines
    const textLines = lines.map(lineItems => {
        // Sort items in this line by X position
        lineItems.sort((a, b) => a.x - b.x);

        // Join items, inserting spaces for gaps
        let lineText = '';
        for (let i = 0; i < lineItems.length; i++) {
            const item = lineItems[i];
            if (i > 0) {
                const prevItem = lineItems[i - 1];
                const gap = item.x - (prevItem.x + prevItem.width);
                // If there's a significant gap, add a space
                if (gap > 2) {
                    lineText += ' ';
                }
            }
            lineText += item.text;
        }
        return lineText;
    });

    return textLines.join('\n');
}

/**
 * Compute SHA-256 hash of a file ArrayBuffer.
 * Replaces Python's hashlib.sha256.
 *
 * @param {ArrayBuffer} arrayBuffer
 * @returns {Promise<string>} Hex-encoded hash
 */
export async function computeFileHash(arrayBuffer) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
