const { v4: uuidv4 } = require('uuid');
const sheetsService = require('../services/sheets.service');
const NodeCache = require('node-cache');
const Joi = require('joi');

// Cache with 5 minute TTL
const cache = new NodeCache({ stdTTL: 300 });

// Helper function to parse date strings in format "Jan 25 2026 5:30 PM"
function parseDateString(dateStr) {
  if (!dateStr) return null;
  
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
  return new Date(dateStr);
}

// Validation schema for booking creation
const bookingSchema = Joi.object({
  branch: Joi.string().required(),
  status: Joi.string().default('Scheduled'),
  firstName: Joi.string().required(),
  lastName: Joi.string().required(),
  age: Joi.number().integer().min(1).max(150).required(),
  phone: Joi.string().required(),
  socialMedia: Joi.string().allow('').optional(),
  email: Joi.string().email().required(),
  treatment: Joi.string().required(),
  area: Joi.string().allow('').optional(),
  freebie: Joi.string().allow('').optional(),
  date: Joi.string().required(),
  time: Joi.string().required(),
  paymentMode: Joi.string().valid('Cash', 'Debit', 'Credit').required(),
  totalPrice: Joi.number().min(0).required(),
  gender: Joi.string().valid('Male', 'Female').required(),
  companionFirstName: Joi.string().allow('').optional(),
  companionLastName: Joi.string().allow('').optional(),
  companionAge: Joi.alternatives().try(Joi.number(), Joi.string().allow('')).optional(),
  companionFreebie: Joi.string().allow('').optional(),
  companionTreatment: Joi.string().allow('').optional(),
  companionGender: Joi.string().valid('Male', 'Female', '').allow('').optional(),
  bookingDetails: Joi.string().allow('').optional(),
  adInteracted: Joi.string().allow('').optional(),
  agent: Joi.string().required()
});

class BookingController {
  async createBooking(req, res) {
    try {
      // Validate input
      const { error, value } = bookingSchema.validate(req.body);
      if (error) {
        return res.status(400).json({ error: error.details[0].message });
      }

      const bookingData = value;
      const userId = req.user.userId;

      // Generate booking ID and timestamp
      const bookingId = uuidv4();
      const timestamp = new Date().toISOString();

      // Format date to match "Jan 22 2026 6:35 PM" format
      const formatDateTime = (dateStr) => {
        const date = new Date(dateStr);
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const month = months[date.getMonth()];
        const day = date.getDate();
        const year = date.getFullYear();
        const hours = date.getHours();
        const minutes = date.getMinutes().toString().padStart(2, '0');
        const ampm = hours >= 12 ? 'PM' : 'AM';
        const displayHours = hours % 12 || 12;
        
        return `${month} ${day} ${year} ${displayHours}:${minutes} ${ampm}`;
      };
      
      const formattedDate = formatDateTime(bookingData.date);

      // Get client IP
      const customerIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

      // Check for promo hunter status BEFORE saving
      const promoHunterResult = await checkPromoHunter(
        bookingData.firstName,
        bookingData.lastName,
        bookingData.email,
        bookingData.phone,
        bookingData.companionFirstName,
        bookingData.companionLastName
      );

      // Update booking status if customer is a Promo Hunter
      let finalStatus = bookingData.status || 'Scheduled';
      if (promoHunterResult.status === 'Promo hunter') {
        finalStatus = 'Promo hunter';
      }

      // Prepare row matching Google Sheet columns (Intake sheet: 37 columns A-AK)
      const newRow = [
        timestamp,                              // A: Timestamp
        bookingData.branch,                     // B: Ad Interacted
        bookingData.branch,                     // C: Branch
        finalStatus,                            // D: Booking Status (updated if promo hunter)
        bookingData.firstName,                  // E: First Name
        bookingData.lastName,                   // F: Last Name
        bookingData.age,                        // G: Age
        bookingData.phone,                      // H: Phone
        bookingData.socialMedia || '',          // I: Facebook / Instagram Name
        bookingData.email || '',                // J: Email
        bookingData.treatment,                  // K: Promo/Treatment
        bookingData.area || '',                 // L: Area
        bookingData.freebie || '',              // M: Freebie
        formattedDate,                          // N: Date
        bookingData.paymentMode,                // O: Mode of payment
        bookingData.totalPrice,                 // P: Total Price
        bookingData.gender,                     // Q: Gender
        bookingData.companionFirstName || '',   // R: Companion First Name
        bookingData.companionLastName || '',    // S: Companion Last Name
        bookingData.companionAge || '',         // T: Companion Age
        bookingData.companionFreebie || '',     // U: Companion Freebie
        bookingData.companionTreatment || '',   // V: Companion Promo/Treatment
        bookingData.companionGender || '',      // W: Companion Gender
        bookingData.bookingDetails || '',       // X: Booking Details
        bookingData.agent,                      // Y: Agent
        (bookingData.email || '').toLowerCase(),        // Z: email_norm
        bookingData.phone.replace(/\D/g, ''),   // AA: phone_norm
        (bookingData.socialMedia || '').toLowerCase(), // AB: social_norm
        `${bookingData.firstName} ${bookingData.lastName}`.toLowerCase(), // AC: full_name_norm
        `${bookingData.companionFirstName || ''} ${bookingData.companionLastName || ''}`.trim().toLowerCase(), // AD: companion_full_name_norm
        promoHunterResult.status,               // AE: promo_hunter_status
        promoHunterResult.matchReason,          // AF: match_reason
        promoHunterResult.matchedSource,        // AG: matched_source
        promoHunterResult.matchedRow,           // AH: matched_row
        bookingId,                              // AI: record_id (UUID)
        'active',                               // AJ: record_status
        timestamp                               // AK: last_checked_at
      ];

      // Append to Intake sheet
      await sheetsService.appendRow('Intake', newRow);

      // Also append to DB Sheet (Master DB) for permanent storage
      // DB Sheet has 43 columns matching the actual Google Sheet structure
      const masterDbRow = [
        timestamp,                              // 0: Timestamp
        bookingData.branch,                     // 1: Branch
        bookingData.status || 'Scheduled',      // 2: Booking Status
        formattedDate,                          // 3: Date
        bookingData.firstName,                  // 4: First Name
        bookingData.lastName,                   // 5: Last Name
        bookingData.age,                        // 6: Age
        bookingData.gender,                     // 7: Gender
        bookingData.treatment,                  // 8: Promo/Treatment
        bookingData.area || '',                 // 9: Area
        bookingData.freebie || '',              // 10: Freebie
        bookingData.companionTreatment || '',   // 11: Companion Promo/Treatment
        bookingData.totalPrice,                 // 12: Total Price
        bookingData.paymentMode,                // 13: Mode of payment
        bookingData.phone,                      // 14: Phone
        bookingData.socialMedia || '',          // 15: Facebook / Instagram Name
        bookingData.email || '',                // 16: Email
        bookingData.agent,                      // 17: Agent
        bookingData.bookingDetails || '',       // 18: Booking Details
        bookingData.adInteracted || '',         // 19: Ad Interacted
        bookingData.companionFirstName || '',   // 20: Companion First Name
        bookingData.companionLastName || '',    // 21: Companion Last Name
        bookingData.companionAge || '',         // 22: Companion Age
        bookingData.companionGender || '',      // 23: Companion Gender
        bookingData.companionFreebie || '',     // 24: Companion Freebie
        bookingData.email.toLowerCase(),        // 25: email_norm
        bookingData.phone.replace(/\D/g, ''),   // 26: phone_norm
        (bookingData.socialMedia || '').toLowerCase(), // 27: social_norm
        `${bookingData.firstName} ${bookingData.lastName}`.toLowerCase(), // 28: full_name_norm
        `${bookingData.companionFirstName || ''} ${bookingData.companionLastName || ''}`.trim().toLowerCase(), // 29: companion_full_name_norm
        promoHunterResult.status,               // 30: promo_hunter_status
        promoHunterResult.matchReason,          // 31: match_reason
        promoHunterResult.matchedSource,        // 32: matched_source
        promoHunterResult.matchedRow,           // 33: matched_row
        bookingId,                              // 34: record_id
        'active',                               // 35: record_status
        timestamp,                              // 36: last_checked_at
        '',                                     // 37: legacy_full_name
        '',                                     // 38: exclude_from_dashboards
        timestamp,                              // 39: dash_booking_created_at
        formattedDate,                          // 40: dash_appointment_date
        bookingData.branch,                     // 41: dash_branch
        finalStatus                             // 42: dash_booking_status (updated if promo hunter)
      ];
      await sheetsService.appendRow('DB', masterDbRow);

      // Clear cache
      cache.del('old_bookings_all');

      res.status(201).json({
        message: 'Booking created successfully',
        booking: {
          bookingId,
          timestamp,
          ...bookingData,
          promoHunterStatus: promoHunterResult.status
        }
      });
    } catch (error) {
      console.error('Create booking error:', error);
      res.status(500).json({ error: 'Failed to create booking' });
    }
  }

  async getOldBookings(req, res) {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 50;
      const search = req.query.search || '';
      const branch = req.query.branch || '';
      const status = req.query.status || '';
      const sortOrder = req.query.sortOrder || 'newest'; // 'newest' or 'oldest'
      const dateRange = req.query.dateRange;
      const startDate = req.query.startDate;
      const endDate = req.query.endDate;
      
      // Try to get from cache
      let allBookings = cache.get('old_bookings_all');

      if (!allBookings) {
        // Read from Google Sheets
        const rows = await sheetsService.readSheet('DB');
        
        if (rows.length < 2) {
          return res.json({
            bookings: [],
            pagination: {
              page: 1,
              limit,
              total: 0,
              totalPages: 0
            }
          });
        }

        const headers = rows[0];
        
        // Parse rows into objects - CORRECTED COLUMN MAPPING for 43-column DB sheet
        allBookings = rows.slice(1).map((row, index) => {
          // Parse price - remove peso sign and any non-numeric characters except decimal point
          let price = row[12] || '0';
          if (typeof price === 'string') {
            price = price.replace(/[^0-9.]/g, '');
          }
          
          return {
            rowNumber: index + 2,
            timestamp: row[0] || '',
            branch: row[1] || '',
            status: row[2] || '',
            date: row[3] || '',
            firstName: row[4] || '',
            lastName: row[5] || '',
            age: row[6] || '',
            gender: row[7] || '',
            treatment: row[8] || '',
            area: row[9] || '',
            freebie: row[10] || '',
            companionTreatment: row[11] || '',
            totalPrice: parseFloat(price) || 0,
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
        });

        // Note: Sheet rows are in chronological order - row 2 is oldest, last row is newest
        // Cache for 5 minutes
        cache.set('old_bookings_all', allBookings);
      }

      // Filter by branch
      let filteredBookings = allBookings;
      if (branch && branch !== 'All') {
        filteredBookings = filteredBookings.filter(booking => 
          booking.branch === branch
        );
      }

      // Filter by status
      if (status && status !== 'All') {
        filteredBookings = filteredBookings.filter(booking => 
          booking.status === status
        );
      }

      // Filter by date range
      if (startDate && endDate) {
        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        
        filteredBookings = filteredBookings.filter(booking => {
          if (!booking.date) return false;
          try {
            const bookingDate = parseDateString(booking.date);
            if (bookingDate && !isNaN(bookingDate.getTime())) {
              return bookingDate >= start && bookingDate <= end;
            }
            return false;
          } catch {
            return false;
          }
        });
      } else if (dateRange && dateRange !== 'all') {
        const now = new Date();
        now.setHours(0, 0, 0, 0);
        let cutoffDate = new Date(now);
        
        switch(dateRange) {
          case 'today':
            // Already set to start of today
            break;
          case 'yesterday':
            cutoffDate.setDate(cutoffDate.getDate() - 1);
            break;
          case '7':
            cutoffDate.setDate(cutoffDate.getDate() - 7);
            break;
          case '30':
            cutoffDate.setDate(cutoffDate.getDate() - 30);
            break;
          case '90':
            cutoffDate.setDate(cutoffDate.getDate() - 90);
            break;
        }
        
        filteredBookings = filteredBookings.filter(booking => {
          if (!booking.date) return false;
          try {
            const bookingDate = parseDateString(booking.date);
            if (bookingDate && !isNaN(bookingDate.getTime())) {
              return bookingDate >= cutoffDate;
            }
            return false;
          } catch {
            return false;
          }
        });
      }

      // Filter by search query
      if (search) {
        const searchLower = search.toLowerCase();
        filteredBookings = filteredBookings.filter(booking => {
          return (
            booking.firstName.toLowerCase().includes(searchLower) ||
            booking.lastName.toLowerCase().includes(searchLower) ||
            booking.email.toLowerCase().includes(searchLower) ||
            booking.phone.includes(search) ||
            booking.agent.toLowerCase().includes(searchLower) ||
            booking.treatment.toLowerCase().includes(searchLower) ||
            booking.branch.toLowerCase().includes(searchLower)
          );
        });
      }

      // Sort bookings based on sortOrder
      // Sheet is in chronological order (oldest first), so:
      // - For 'newest': reverse the array (last row = most recent)
      // - For 'oldest': keep as is (first row after header = oldest)
      if (sortOrder === 'newest') {
        filteredBookings.reverse();
      }
      // If sortOrder is 'oldest', array is already in correct order

      // Calculate pagination
      const total = filteredBookings.length;
      const totalPages = Math.ceil(total / limit);
      const startIndex = (page - 1) * limit;
      const endIndex = startIndex + limit;

      // Get page data
      const paginatedBookings = filteredBookings.slice(startIndex, endIndex);

      res.json({
        bookings: paginatedBookings,
        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasNext: page < totalPages,
          hasPrev: page > 1
        }
      });
    } catch (error) {
      console.error('Get old bookings error:', error);
      res.status(500).json({ error: 'Failed to fetch bookings' });
    }
  }

  async getBookingById(req, res) {
    try {
      const { id } = req.params;

      // Try both sheets
      const newBookings = await sheetsService.readSheet('Intake');
      const oldBookings = await sheetsService.readSheet('DB');

      // Search in new bookings (has record_id in column AI - index 33)
      const newBookingRow = newBookings.slice(1).find(row => row[33] === id);
      
      // Search in old bookings (has record_id in column AI - index 33)
      const oldBookingRow = oldBookings.slice(1).find(row => row[33] === id);

      if (!newBookingRow && !oldBookingRow) {
        return res.status(404).json({ error: 'Booking not found' });
      }

      const bookingRow = newBookingRow || oldBookingRow;

      // Parse booking data matching DB/Intake sheet structure (37-43 columns)
      const booking = {
        recordId: bookingRow[33],      // AI: record_id
        timestamp: bookingRow[0],      // A: Timestamp
        branch: bookingRow[1],         // B: Branch
        status: bookingRow[2],         // C: Booking Status
        date: bookingRow[3],           // D: Date
        firstName: bookingRow[4],      // E: First Name
        lastName: bookingRow[5],       // F: Last Name
        age: bookingRow[6],            // G: Age
        gender: bookingRow[7],         // H: Gender
        treatment: bookingRow[8],      // I: Promo/Treatment
        area: bookingRow[9],           // J: Area
        freebie: bookingRow[10],       // K: Freebie
        companionTreatment: bookingRow[11], // L: Companion Promo/Treatment
        totalPrice: bookingRow[12],    // M: Total Price
        paymentMode: bookingRow[13],   // N: Mode of payment
        phone: bookingRow[14],         // O: Phone
        socialMedia: bookingRow[15],   // P: Facebook/Instagram
        email: bookingRow[16],         // Q: Email
        agent: bookingRow[17],         // R: Agent
        bookingDetails: bookingRow[18], // S: Booking Details
        adInteracted: bookingRow[19],  // T: Ad Interacted
        companionFirstName: bookingRow[20],  // U: Companion First Name
        companionLastName: bookingRow[21],   // V: Companion Last Name
        companionAge: bookingRow[22],        // W: Companion Age
        companionGender: bookingRow[23],     // X: Companion Gender
        companionPhone: bookingRow[24]       // Y: Companion Phone
      };

      return res.json({ booking });
    } catch (error) {
      console.error('Get booking error:', error);
      res.status(500).json({ error: 'Failed to fetch booking' });
    }
  }

  async updateBooking(req, res) {
    try {
      const { id: rowNumber } = req.params;
      const bookingData = req.body;

      console.log('Updating booking at row:', rowNumber);

      // Read DB sheet to find the row
      const dbRows = await sheetsService.readSheet('DB');
      
      if (!dbRows || dbRows.length < 2) {
        return res.status(404).json({ error: 'No bookings found' });
      }

      // Find the booking by rowNumber (row number is 1-indexed, including header)
      const dataRowIndex = parseInt(rowNumber) - 2; // Convert to 0-indexed data array (excluding header)
      
      if (dataRowIndex < 0 || dataRowIndex >= dbRows.length - 1) {
        return res.status(404).json({ error: 'Booking not found' });
      }

      // Get the existing row to preserve metadata
      const existingRow = dbRows[parseInt(rowNumber) - 1];
      
      // Prepare updated row for DB sheet (43 columns)
      const timestamp = new Date().toISOString();
      
      // Handle dateTime - if provided, use it; otherwise preserve existing
      const dateTimeValue = bookingData.dateTime || existingRow[3] || '';
      
      // Update normalized fields
      const emailNorm = (bookingData.email || '').toLowerCase();
      const phoneNorm = bookingData.phone.replace(/\D/g, '');
      const socialNorm = (bookingData.socialMedia || '').toLowerCase();
      const fullNameNorm = `${bookingData.firstName} ${bookingData.lastName}`.toLowerCase();
      const companionFullNameNorm = bookingData.companionFirstName && bookingData.companionLastName
        ? `${bookingData.companionFirstName} ${bookingData.companionLastName}`.toLowerCase()
        : '';
      
      const updatedDbRow = [
        timestamp,                              // 0: Timestamp (updated)
        bookingData.branch,                     // 1: Branch
        bookingData.status || 'Scheduled',      // 2: Booking Status
        dateTimeValue,                          // 3: Date (updated or preserved)
        bookingData.firstName,                  // 4: First Name
        bookingData.lastName,                   // 5: Last Name
        bookingData.age,                        // 6: Age
        bookingData.gender,                     // 7: Gender
        bookingData.treatment,                  // 8: Promo/Treatment
        bookingData.area || '',                 // 9: Area
        bookingData.freebie || '',              // 10: Freebie
        bookingData.companionTreatment || '',   // 11: Companion Promo/Treatment
        bookingData.totalPrice,                 // 12: Total Price
        bookingData.paymentMode,                // 13: Mode of payment
        bookingData.phone,                      // 14: Phone
        bookingData.socialMedia || '',          // 15: Facebook / Instagram Name
        bookingData.email || '',                // 16: Email
        bookingData.agent,                      // 17: Agent
        bookingData.bookingDetails || '',       // 18: Booking Details
        bookingData.adInteracted || '',         // 19: Ad Interacted
        bookingData.companionFirstName || '',   // 20: Companion First Name
        bookingData.companionLastName || '',    // 21: Companion Last Name
        bookingData.companionAge || '',         // 22: Companion Age
        bookingData.companionGender || '',      // 23: Companion Gender
        bookingData.companionFreebie || '',     // 24: Companion Freebie
        emailNorm,                              // 25: email_norm (updated)
        phoneNorm,                              // 26: phone_norm (updated)
        socialNorm,                             // 27: social_norm (updated)
        fullNameNorm,                           // 28: full_name_norm (updated)
        companionFullNameNorm,                  // 29: companion_full_name_norm (updated)
        existingRow[30] || '',                  // 30: promo_hunter_status (preserve)
        existingRow[31] || '',                  // 31: match_reason (preserve)
        existingRow[32] || '',                  // 32: matched_source (preserve)
        existingRow[33] || '',                  // 33: matched_row (preserve)
        existingRow[34] || '',                  // 34: record_id (preserve)
        existingRow[35] || 'active',            // 35: record_status (preserve)
        existingRow[36] || '',                  // 36: last_checked_at (preserve)
        existingRow[37] || '',                  // 37: legacy_full_name (preserve)
        existingRow[38] || '',                  // 38: exclude_from_dashboards (preserve)
        existingRow[39] || '',                  // 39: dash_booking_created_at (preserve)
        existingRow[40] || '',                  // 40: dash_appointment_date (preserve)
        bookingData.branch,                     // 41: dash_branch (update to match)
        bookingData.status || 'Scheduled'       // 42: dash_booking_status (update to match)
      ];

      // Update the row in DB sheet
      await sheetsService.updateRow('DB', parseInt(rowNumber), updatedDbRow);

      res.json({
        success: true,
        message: 'Booking updated successfully',
        data: bookingData
      });

    } catch (error) {
      console.error('Update booking error:', error);
      res.status(500).json({ error: 'Failed to update booking' });
    }
  }
}

// Helper function to check for promo hunter by matching name, email, phone, or companion name
async function checkPromoHunter(firstName, lastName, email, phone, companionFirstName, companionLastName) {
  try {
    const dbRows = await sheetsService.readSheet('DB');
    
    if (dbRows.length < 2) {
      return {
        status: 'Scheduled',
        matchReason: '',
        matchedSource: '',
        matchedRow: ''
      };
    }

    const fullName = `${firstName} ${lastName}`.toLowerCase().trim();
    const normalizedEmail = email.toLowerCase().trim();
    const normalizedPhone = phone.replace(/\D/g, ''); // Remove non-digits
    const companionFullName = companionFirstName && companionLastName 
      ? `${companionFirstName} ${companionLastName}`.toLowerCase().trim() 
      : '';

    // Check existing bookings (skip header row)
    const matches = [];
    const bookings = dbRows.slice(1);

    for (let i = 0; i < bookings.length; i++) {
      const row = bookings[i];
      const rowNumber = i + 2; // +2 because we skip header and array is 0-indexed
      
      const existingFirstName = (row[4] || '').toLowerCase().trim();
      const existingLastName = (row[5] || '').toLowerCase().trim();
      const existingEmail = (row[16] || '').toLowerCase().trim();
      const existingPhone = (row[14] || '').replace(/\D/g, '');
      const existingCompanionFirstName = (row[20] || '').toLowerCase().trim();
      const existingCompanionLastName = (row[21] || '').toLowerCase().trim();

      const existingFullName = `${existingFirstName} ${existingLastName}`.trim();
      const existingCompanionFullName = existingCompanionFirstName && existingCompanionLastName
        ? `${existingCompanionFirstName} ${existingCompanionLastName}`.trim()
        : '';

      let matchReason = '';
      let matchedAs = '';

      // Match by customer name
      if (existingFullName && fullName && existingFullName === fullName) {
        matchReason = 'Customer Name Match';
        matchedAs = 'customer';
      }
      // Match by email
      else if (normalizedEmail && existingEmail && existingEmail === normalizedEmail) {
        matchReason = 'Email Match';
        matchedAs = 'customer';
      }
      // Match by phone
      else if (normalizedPhone && existingPhone && existingPhone === normalizedPhone) {
        matchReason = 'Phone Match';
        matchedAs = 'customer';
      }
      // Match by companion name (current customer was a companion before)
      else if (companionFullName && existingCompanionFullName && existingCompanionFullName === companionFullName) {
        matchReason = 'Previously Companion';
        matchedAs = 'companion';
      }
      // Match if current companion matches previous customer
      else if (companionFullName && existingFullName && existingFullName === companionFullName) {
        matchReason = 'Companion Match (was customer)';
        matchedAs = 'companion';
      }

      if (matchReason) {
        matches.push({
          rowNumber,
          reason: matchReason,
          source: matchedAs,
          date: row[3] || '',
          branch: row[1] || ''
        });
      }
    }

    // Classify based on number of previous bookings
    let status = '';
    if (matches.length === 0) {
      status = 'Scheduled'; // New customer
    } else {
      status = 'Promo hunter'; // Has previous booking(s)
    }

    // Return detailed match information
    if (matches.length > 0) {
      const firstMatch = matches[0];
      const allReasons = matches.map(m => m.reason).join(', ');
      const allRows = matches.map(m => `Row ${m.rowNumber}`).join(', ');
      
      return {
        status,
        matchReason: allReasons,
        matchedSource: matches.map(m => `${m.source} (${m.branch})`).join(', '),
        matchedRow: allRows,
        matchCount: matches.length
      };
    }

    return {
      status,
      matchReason: '',
      matchedSource: '',
      matchedRow: '',
      matchCount: 0
    };
  } catch (error) {
    console.error('[Promo Hunter Check] Error:', error);
    return 'Unknown';
  }
}

module.exports = new BookingController();
