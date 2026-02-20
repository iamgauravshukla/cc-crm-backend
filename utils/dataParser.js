/**
 * Shared data parsing utilities to eliminate duplication across controllers
 */

/**
 * Parse date strings in multiple formats:
 * - M/D/YYYY format (e.g., "2/20/2026")
 * - "Jan 25 2026" format
 * - ISO format (2026-02-19)
 * - Standard date parsing fallback
 */
function parseDateString(dateStr) {
  if (!dateStr) return null;
  
  // Try M/D/YYYY format (e.g., "2/20/2026")
  const slashFormat = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashFormat) {
    const [_, month, day, year] = slashFormat;
    return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
  }
  
  // Try "Jan 25 2026" format
  const monthNames = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
  };
  
  const dateParts = dateStr.toLowerCase().split(' ');
  if (dateParts.length >= 3) {
    const monthStr = dateParts[0].toLowerCase();
    const day = parseInt(dateParts[1]);
    const year = parseInt(dateParts[2]);
    
    if (monthNames.hasOwnProperty(monthStr) && day && year) {
      return new Date(year, monthNames[monthStr], day);
    }
  }
  
  // Fallback: try standard parsing
  const fallback = new Date(dateStr);
  return isNaN(fallback.getTime()) ? null : fallback;
}

/**
 * Parse price value from sheet cells
 * Handles:
 * - Peso symbol (₱)
 * - Comma separators (1,000)
 * - Text values
 * Returns 0 for invalid/missing values
 */
function parsePrice(priceValue) {
  if (!priceValue) return 0;
  
  // Handle both string and numeric inputs
  const priceStr = String(priceValue);
  
  // Remove peso symbol and commas, keep only numbers and decimal point
  const cleaned = priceStr.replace('₱', '').replace(/,/g, '');
  const parsed = parseFloat(cleaned);
  
  return isNaN(parsed) ? 0 : parsed;
}

/**
 * Map sheet row to standardized booking object
 * Handles proper type conversion and data parsing
 * Supports both 44-column DB sheet and other formats
 */
function mapRowToBooking(row) {
  return {
    timestamp: row[0] || '',
    branch: row[1] || '',
    status: row[2] || '',
    date: row[3] || '',
    firstName: row[4] || '',
    lastName: row[5] || '',
    age: parseInt(row[6]) || 0,
    gender: row[7] || '',
    treatment: row[8] || '',
    area: row[9] || '',
    freebie: row[10] || '',
    companionTreatment: row[11] || '',
    totalPrice: parsePrice(row[12]),
    paymentMode: row[13] || '',
    phone: row[14] || '',
    socialMedia: row[15] || '',
    email: row[16] || '',
    agent: row[17] || '',
    bookingDetails: row[18] || '',
    adInteracted: row[19] || '',
    companionFirstName: row[20] || '',
    companionLastName: row[21] || '',
    companionAge: row[22] || '',
    companionGender: row[23] || '',
    companionFreebie: row[24] || ''
  };
}

/**
 * Get date range filter function
 * Returns a function that checks if a date falls within the specified range
 */
function getDateRangeFilter(startDate, endDate, days = null) {
  if (startDate && endDate) {
    const start = new Date(startDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    
    return (dateStr) => {
      if (!dateStr) return false;
      try {
        const bookingDate = parseDateString(dateStr);
        return bookingDate && !isNaN(bookingDate.getTime()) && 
               bookingDate >= start && bookingDate <= end;
      } catch {
        return false;
      }
    };
  }
  
  if (days) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    
    return (dateStr) => {
      if (!dateStr) return false;
      try {
        const bookingDate = parseDateString(dateStr);
        return bookingDate && !isNaN(bookingDate.getTime()) && bookingDate >= cutoffDate;
      } catch {
        return false;
      }
    };
  }
  
  return () => true; // No filter
}

module.exports = {
  parseDateString,
  parsePrice,
  mapRowToBooking,
  getDateRangeFilter
};
