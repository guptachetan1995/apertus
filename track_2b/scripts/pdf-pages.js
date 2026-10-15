'use strict';

// Counts the pages of a PDF written by Chrome (Skia): every page is an uncompressed
// "/Type /Page" object, and the page tree's root carries the total in "/Count". If the page
// objects cannot be seen, the largest /Count is the root's. Anything else is an error rather
// than a guess, because this number gates the 6-page limit.
function countPdfPages(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString('latin1') : String(buffer);
  if (!text.startsWith('%PDF-')) throw new Error('not a PDF file');
  const pageObjects = (text.match(/\/Type\s*\/Page(?![A-Za-z])/g) || []).length;
  if (pageObjects > 0) return pageObjects;
  const counts = [...text.matchAll(/\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)|\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages/g)].map((m) => Number(m[1] || m[2]));
  if (counts.length > 0) return Math.max(...counts);
  throw new Error('could not read the page count from the PDF');
}

module.exports = { countPdfPages };
