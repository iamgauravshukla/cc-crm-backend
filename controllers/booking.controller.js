const { v4: uuidv4 } = require('uuid');
const sheetsService = require('../services/sheets.service');
const NodeCache = require('node-cache');
const Joi = require('joi');
const { parseDateString, parsePrice, mapRowToBooking } = require('../utils/dataParser');

// Cache with 5 minute TTL
const cache = new NodeCache({ stdTTL: 300 });

// Helper function to format current timestamp as "Feb 21 2026 10:53 AM"
const getCurrentTimestamp = () => {
  const now = new Date();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthName = months[now.getMonth()];
  const day = now.getDate();
  const year = now.getFullYear();
  const hours = now.getHours();
  const minutes = now.getMinutes().toString().padStart(2, '0');
  const displayHours = hours % 12 || 12;
  const ampm = hours >= 12 ? 'PM' : 'AM';
  
  return `${monthName} ${day} ${year} ${displayHours}:${minutes} ${ampm}`;
};

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
  companionArea: Joi.string().allow('').optional(),
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
      const timestamp = getCurrentTimestamp();

      // Format date and time to match "Feb 25 2026 12:00 AM" format
      const formatDateTime = (dateStr, timeStr) => {
        // dateStr is in format "YYYY-MM-DD" (from date input)
        // timeStr is in format "HH:MM" (from time input)
        const [year, month, day] = dateStr.split('-');
        const [hours, minutes] = timeStr ? timeStr.split(':') : ['00', '00'];
        
        const date = new Date(year, parseInt(month) - 1, day, hours, minutes);
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const monthName = months[date.getMonth()];
        const dayNum = date.getDate();
        const yearNum = date.getFullYear();
        const displayHours = parseInt(hours) % 12 || 12;
        const minutesStr = minutes.toString().padStart(2, '0');
        const ampm = parseInt(hours) >= 12 ? 'PM' : 'AM';
        
        return `${monthName} ${dayNum} ${yearNum} ${displayHours}:${minutesStr} ${ampm}`;
      };
      
      const formattedDate = formatDateTime(bookingData.date, bookingData.time);

      // Check for promo hunter status BEFORE saving
      const promoHunterResult = await checkPromoHunter(
        bookingData.firstName,
        bookingData.lastName,
        bookingData.email,
        bookingData.phone,
        bookingData.socialMedia,
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
      // DB Sheet has 44 columns matching the actual Google Sheet structure
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
        finalStatus,                            // 42: dash_booking_status (updated if promo hunter)
        '',                                     // 43: cancellation_time (empty for new bookings)
        '',                                     // 44: cancel_validation (FALSE by default)
        '',                                     // 45: underage_validation (FALSE by default)
        bookingData.companionArea || ''          // 46: companion_area
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
      const agent  = req.query.agent  || '';
      const gender = req.query.gender || '';
      const sortOrder = req.query.sortOrder || 'newest'; // 'newest' or 'oldest'
      
      // Booking Created Date filters (timestamp based)
      const createdDateRange = req.query.createdDateRange;
      const createdStartDate = req.query.createdStartDate;
      const createdEndDate = req.query.createdEndDate;
      
      // Appointment Date filters (scheduled date based)
      const appointmentDateRange = req.query.appointmentDateRange;
      const appointmentStartDate = req.query.appointmentStartDate;
      const appointmentEndDate = req.query.appointmentEndDate;
      
      // Always read fresh from Google Sheets (no caching)
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

      // Parse rows into objects
      const allBookings = rows.slice(1).map((row, index) => {
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
          companionFreebie: row[24] || '',
          companionArea: row[46] || '',
          promoHunterStatus: row[30] || '',
          // Exclusion validation flags (cols 44–45)
          cancelValidation:   (row[44] || '').toString().toUpperCase() === 'TRUE',
          underageValidation: (row[45] || '').toString().toUpperCase() === 'TRUE'
        };
      });

      // Pre-calculate all date boundaries once (outside the filter loop for performance)
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      
      // Helper function to safely parse dates with caching
      const parseDate = (dateStr, isTimestamp = false) => {
        if (!dateStr) return null;
        try {
          return parseDateString(dateStr);
        } catch {
          return null;
        }
      };
      
      // Pre-calculate created date filter boundaries
      let createdDateStart = null;
      let createdDateEnd = null;
      let applyCreatedFilter = false;
      
      if (createdStartDate && createdEndDate) {
        createdDateStart = new Date(createdStartDate);
        createdDateStart.setHours(0, 0, 0, 0);
        createdDateEnd = new Date(createdEndDate);
        createdDateEnd.setHours(23, 59, 59, 999);
        applyCreatedFilter = true;
      } else if (createdDateRange && createdDateRange !== 'all') {
        applyCreatedFilter = true;
        if (createdDateRange === 'today') {
          createdDateStart = today;
          createdDateEnd = tomorrow;
        } else if (createdDateRange === 'last7' || createdDateRange === 'last30' || createdDateRange === 'last90') {
          let days = createdDateRange === 'last7' ? 7 : createdDateRange === 'last30' ? 30 : 90;
          createdDateStart = new Date(today);
          createdDateStart.setDate(createdDateStart.getDate() - days);
          createdDateEnd = tomorrow;
        }
      }
      
      // Pre-calculate appointment date filter boundaries
      let appointmentDateStart = null;
      let appointmentDateEnd = null;
      let applyAppointmentFilter = false;
      
      if (appointmentStartDate && appointmentEndDate) {
        appointmentDateStart = new Date(appointmentStartDate);
        appointmentDateStart.setHours(0, 0, 0, 0);
        appointmentDateEnd = new Date(appointmentEndDate);
        appointmentDateEnd.setHours(23, 59, 59, 999);
        applyAppointmentFilter = true;
      } else if (appointmentDateRange && appointmentDateRange !== 'all') {
        applyAppointmentFilter = true;
        if (appointmentDateRange === 'today') {
          appointmentDateStart = today;
          appointmentDateEnd = tomorrow;
        } else if (appointmentDateRange === 'tomorrow') {
          appointmentDateStart = tomorrow;
          const dayAfterTomorrow = new Date(tomorrow);
          dayAfterTomorrow.setDate(dayAfterTomorrow.getDate() + 1);
          appointmentDateEnd = dayAfterTomorrow;
        } else if (appointmentDateRange === 'thisWeek') {
          appointmentDateStart = today;
          const endOfWeek = new Date(today);
          endOfWeek.setDate(endOfWeek.getDate() + (6 - today.getDay())); // Days until Sunday
          endOfWeek.setHours(23, 59, 59, 999);
          appointmentDateEnd = endOfWeek;
        }
      }
      
      const searchLower = search ? search.toLowerCase() : null;
      
      // Single-pass filtering for performance
      let filteredBookings = allBookings.filter(booking => {
        // Branch filter — supports single value, comma-separated multi-values, and NOT: prefix
        if (branch && branch !== 'All') {
          const isNot = branch.startsWith('NOT:');
          const raw = isNot ? branch.slice(4) : branch;
          const vals = raw.split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
          const matches = vals.includes((booking.branch || '').toLowerCase());
          if (isNot ? matches : !matches) return false;
        }
        
        // Status filter — supports single value, comma-separated multi-values, and NOT: prefix
        if (status && status !== 'All') {
          const isNot = status.startsWith('NOT:');
          const raw = isNot ? status.slice(4) : status;
          const vals = raw.split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
          const matches = vals.includes((booking.status || '').toLowerCase());
          if (isNot ? matches : !matches) return false;
        }

        // Agent filter — supports single or comma-separated multi-values (case-insensitive)
        if (agent && agent !== 'All') {
          const vals = agent.split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
          if (!vals.includes(booking.agent.toLowerCase())) return false;
        }

        // Gender filter (case-insensitive)
        if (gender && gender !== 'All' && booking.gender.toLowerCase() !== gender.toLowerCase()) return false;
        
        // Created date filter
        if (applyCreatedFilter) {
          const createdDate = parseDate(booking.timestamp, true);
          if (createdDate && !isNaN(createdDate.getTime())) {
            if (createdDate < createdDateStart || createdDate >= createdDateEnd) {
              return false;
            }
          }
        }
        
        // Appointment date filter
        if (applyAppointmentFilter) {
          const appointmentDate = parseDate(booking.date, false);
          if (appointmentDate && !isNaN(appointmentDate.getTime())) {
            if (appointmentDate < appointmentDateStart || appointmentDate >= appointmentDateEnd) {
              return false;
            }
          }
        }
        
        // Search filter
        if (searchLower) {
          const searchMatch = (
            booking.firstName.toLowerCase().includes(searchLower) ||
            booking.lastName.toLowerCase().includes(searchLower) ||
            booking.email.toLowerCase().includes(searchLower) ||
            booking.phone.includes(search) ||
            booking.agent.toLowerCase().includes(searchLower) ||
            booking.treatment.toLowerCase().includes(searchLower) ||
            booking.branch.toLowerCase().includes(searchLower)
          );
          if (!searchMatch) {
            return false;
          }
        }
        
        return true;
      });

      // Sort by appointment date (booking.date), not by sheet row order.
      // Row order reflects creation time, which has nothing to do with scheduled date.
      filteredBookings.sort((a, b) => {
        const da = parseDate(a.date);
        const db = parseDate(b.date);
        const ta = da && !isNaN(da.getTime()) ? da.getTime() : 0;
        const tb = db && !isNaN(db.getTime()) ? db.getTime() : 0;
        return sortOrder === 'newest' ? tb - ta : ta - tb;
      });

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

      // Parse booking data matching DB/Intake sheet structure (37-44 columns)
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
      const user = req.user; // Set by auth middleware

      console.log('========== UPDATE BOOKING START ==========');
      console.log('Updating booking at row number:', rowNumber);
      console.log('User:', user?.name, 'Role:', user?.role);
      console.log('Booking data:', JSON.stringify(bookingData, null, 2));

      // Read DB sheet to find the row
      const dbRows = await sheetsService.readSheet('DB');
      
      console.log('Total rows in DB sheet:', dbRows.length);
      console.log('Header row:', dbRows[0]);

      if (!dbRows || dbRows.length < 2) {
        console.error('No bookings found in DB sheet');
        return res.status(404).json({ error: 'No bookings found' });
      }

      // Convert rowNumber to 0-indexed position in dbRows array
      // rowNumber from frontend = Google Sheet row number (1-indexed)
      // dbRows[0] = header (Google Sheet row 1)
      // dbRows[1] = first data (Google Sheet row 2)
      // So dbRows index = rowNumber - 1
      const dbRowIndex = parseInt(rowNumber) - 1;
      
      console.log('Calculated dbRowIndex:', dbRowIndex);
      console.log('dbRows array length:', dbRows.length);

      if (dbRowIndex < 1 || dbRowIndex >= dbRows.length) {
        console.error(`Row index ${dbRowIndex} out of bounds. Array length: ${dbRows.length}`);
        return res.status(404).json({ 
          error: `Booking not found. Row ${rowNumber} does not exist in database (total rows: ${dbRows.length})`
        });
      }

      // Get the existing row
      const existingRow = dbRows[dbRowIndex];
      console.log('Existing row at index', dbRowIndex, ':', existingRow);

      // Role-based access control: Only block modifications to status or agent if values are changing
      if (user?.role !== 'Admin') {
        // Check if status is being changed to a different value
        if (bookingData.status !== undefined && bookingData.status !== existingRow[2]) {
          console.warn(`⚠️ Agent ${user?.name} attempted to modify booking status from "${existingRow[2]}" to "${bookingData.status}"`);
          return res.status(403).json({ 
            error: 'Agents cannot modify booking status',
            code: 'RESTRICTED_FIELDS'
          });
        }
        
        // Check if agent is being changed to a different value
        if (bookingData.agent !== undefined && bookingData.agent !== existingRow[17]) {
          console.warn(`⚠️ Agent ${user?.name} attempted to modify agent assignment from "${existingRow[17]}" to "${bookingData.agent}"`);
          return res.status(403).json({ 
            error: 'Agents cannot modify agent assignment',
            code: 'RESTRICTED_FIELDS'
          });
        }
      }

      // Log all existing columns
      console.log('========== EXISTING ROW COLUMNS ==========');
      const columnNames = [
        '0: Timestamp',
        '1: Branch',
        '2: Booking Status',
        '3: Date',
        '4: First Name',
        '5: Last Name',
        '6: Age',
        '7: Gender',
        '8: Treatment',
        '9: Area',
        '10: Freebie',
        '11: Companion Treatment',
        '12: Total Price',
        '13: Payment Mode',
        '14: Phone',
        '15: Social Media',
        '16: Email',
        '17: Agent',
        '18: Booking Details',
        '19: Ad Interacted',
        '20: Companion First Name',
        '21: Companion Last Name',
        '22: Companion Age',
        '23: Companion Gender',
        '24: Companion Freebie',
        '25: email_norm',
        '26: phone_norm',
        '27: social_norm',
        '28: full_name_norm',
        '29: companion_full_name_norm',
        '30: promo_hunter_status',
        '31: match_reason',
        '32: matched_source',
        '33: matched_row',
        '34: record_id',
        '35: record_status',
        '36: last_checked_at',
        '37: legacy_full_name',
        '38: exclude_from_dashboards',
        '39: dash_booking_created_at',
        '40: dash_appointment_date',
        '41: dash_branch',
        '42: dash_booking_status',
        '43: cancellation_time'
      ];

      existingRow.forEach((value, index) => {
        console.log(`${columnNames[index]}: ${value}`);
      });

      // Prepare updated row for DB sheet (44 columns total, indices 0-43)
      // NOTE: preserve the original creation timestamp (col 0) — do NOT overwrite it on edit
      const originalTimestamp = existingRow[0] || '';
      const nowTimestamp = getCurrentTimestamp(); // used only for cancellation_time
      
      // Handle dateTime - if provided, use it; otherwise preserve existing
      const dateTimeValue = bookingData.dateTime || existingRow[3] || '';
      
      // Update normalized fields with safety checks
      const emailNorm = (bookingData.email || '').toLowerCase();
      const phoneNorm = (bookingData.phone || '').replace(/\D/g, '');
      const socialNorm = (bookingData.socialMedia || '').toLowerCase();
      const fullNameNorm = `${bookingData.firstName || ''} ${bookingData.lastName || ''}`.toLowerCase().trim();
      const companionFullNameNorm = (bookingData.companionFirstName || '').trim() && (bookingData.companionLastName || '').trim()
        ? `${bookingData.companionFirstName} ${bookingData.companionLastName}`.toLowerCase().trim()
        : '';
      
      // Track cancellation time if status is being set to Cancelled
      let cancellationTime = existingRow[43] || ''; // preserve existing cancellation_time
      if (bookingData.status && bookingData.status.toLowerCase() === 'cancelled') {
        cancellationTime = nowTimestamp; // set cancellation time to now if cancelled
        console.log('Setting cancellation_time to:', cancellationTime);
      }
      
      const updatedDbRow = [
        originalTimestamp,                      // 0: Timestamp (PRESERVED — original creation time)
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
        bookingData.status || 'Scheduled',      // 42: dash_booking_status (update to match)
        cancellationTime,                        // 43: cancellation_time (track when cancelled)
        existingRow[44] || '',                  // 44: cancel_validation (preserve)
        existingRow[45] || '',                  // 45: underage_validation (preserve)
        bookingData.companionArea || ''          // 46: companion_area
      ];

      console.log('========== UPDATED ROW COLUMNS ==========');
      updatedDbRow.forEach((value, index) => {
        console.log(`${columnNames[index]}: ${value}`);
      });

      console.log('Updating row number:', parseInt(rowNumber));
      // Update the row in DB sheet
      await sheetsService.updateRow('DB', parseInt(rowNumber), updatedDbRow);

      // IMPORTANT: Clear the cache to reflect changes immediately
      cache.del('old_bookings_all');
      console.log('✅ Cache cleared - bookings will refresh immediately');

      console.log('========== UPDATE BOOKING SUCCESS ==========');
      res.json({
        success: true,
        message: 'Booking updated successfully',
        data: bookingData,
        rowNumber: parseInt(rowNumber),
        cancellationTime: cancellationTime
      });


    } catch (error) {
      console.error('========== UPDATE BOOKING ERROR ==========');
      console.error('Error message:', error.message);
      console.error('Error stack:', error.stack);
      console.error('Full error:', error);
      res.status(500).json({ 
        error: 'Failed to update booking',
        details: error.message,
        rowNumber: req.params.id
      });
    }
  }

  // PATCH /bookings/:rowNumber/validation
  // Updates only cancel_validation (col 44) and underage_validation (col 45) in the DB sheet.
  // Admin-only — agents cannot toggle these flags.
  async updateValidation(req, res) {
    try {
      const { rowNumber } = req.params;
      const { cancelValidation, underageValidation } = req.body;

      if (req.user?.role !== 'Admin') {
        return res.status(403).json({ error: 'Only admins can set validation flags' });
      }

      const row = parseInt(rowNumber, 10);
      if (!row || row < 2) {
        return res.status(400).json({ error: 'Invalid row number' });
      }

      // Write only AS (col 44) and AT (col 45) for the given row.
      // Store "TRUE"/"FALSE" strings for easy sheet readability.
      const cancelVal   = cancelValidation   ? 'TRUE' : 'FALSE';
      const underageVal = underageValidation ? 'TRUE' : 'FALSE';

      await sheetsService.updateCellRange('DB', `AS${row}:AT${row}`, [cancelVal, underageVal]);

      // Clear booking cache so OldBookings reflects the change immediately
      cache.del('old_bookings_all');

      return res.json({
        success: true,
        rowNumber: row,
        cancelValidation:   cancelValidation,
        underageValidation: underageValidation
      });
    } catch (error) {
      console.error('updateValidation error:', error.message);
      res.status(500).json({ error: 'Failed to update validation flags' });
    }
  }

  // Get daily reports with 6 sections
  // NOTE: This endpoint automatically updates based on TODAY's date
  // Each request calculates dates fresh, so tomorrow it will show different data
  // No caching is used to ensure always showing current day's information
  async getDailyReports(req, res) {
    try {
      const dbRows = await sheetsService.readSheet('DB');
      console.log(`📊 getDailyReports - Total DB rows: ${dbRows.length}`);
      
      if (dbRows.length < 2) {
        console.log('⚠️ No data in DB sheet');
        return res.json({
          success: true,
          date: new Date().toISOString().split('T')[0],
          reports: {
            otsBookings: { total: 0, revenue: 0, count: 0, byBranch: {} },
            overallBookings: { total: 0, revenue: 0, count: 0, byBranch: {} },
            bookedTomorrow: { byBranch: {} },
            bookedNext7Days: { byBranch: {} },
            cancellations: { total: 0, revenue: 0, count: 0, byBranch: {} },
            overallBookingsTomorrow: { total: 0, revenue: 0, count: 0 }
          }
        });
      }
      
      // Calculate dates FRESH on each request to ensure daily updates
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const dayAfterTomorrow = new Date(tomorrow);
      dayAfterTomorrow.setDate(dayAfterTomorrow.getDate() + 1);
      const nextSevenDaysEnd = new Date(today);
      nextSevenDaysEnd.setDate(nextSevenDaysEnd.getDate() + 7);

      console.log(`📅 Today: ${today.toDateString()}, Tomorrow: ${tomorrow.toDateString()}, DayAfterTomorrow: ${dayAfterTomorrow.toDateString()}`);


      // Helper to extract date-only from timestamp string (e.g. "May 5 2026 10:30 AM")
      // Uses parseDateString which correctly handles all custom timestamp formats
      const getDateFromTimestamp = (timestampStr) => {
        if (!timestampStr) return null;
        try {
          const parsed = parseDateString(timestampStr);
          if (!parsed || isNaN(parsed.getTime())) return null;
          return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), 0, 0, 0, 0);
        } catch (e) {
          return null;
        }
      };

      // Helper to parse date from DB formatted date string
      const parseBookingDate = (dateStr) => {
        if (!dateStr) return null;
        const parsed = parseDateString(dateStr);
        if (!parsed) return null;
        const d = new Date(parsed);
        d.setHours(0, 0, 0, 0);
        return d;
      };

      // Helper to check if date falls in range
      const isToday = (date) => date && date.getTime() === today.getTime();
      const isTomorrow = (date) => date && date.getTime() === tomorrow.getTime();
      const isNext7Days = (date) => date && date > today && date <= nextSevenDaysEnd;
      const isInNext7Days = (date) => date && date >= dayAfterTomorrow && date <= nextSevenDaysEnd;

      // row[43] = cancellation_time: set by updateBooking when status changed to Cancelled
      // Covers: cancelled via CRM today (any creation date) OR created+cancelled today without CRM
      const isCancelledToday = (cancellationTimeStr) => {
        if (!cancellationTimeStr) return false;
        const cancelledDate = getDateFromTimestamp(cancellationTimeStr);
        return cancelledDate && isToday(cancelledDate);
      };

      // Branches list
      const branches = ['STA LUCIA', 'FELIZ', 'ESTANCIA', 'Spa', 'Clinic', 'Lab', 
                       'Dermatology', 'Wellness', 'Med Spa', 'Aesthetic', 'Hydro', 
                       'Hair Care', 'Anti-Aging', 'Mother Care', 'Other', 
                       'AI SKIN', 'CENTRIS', 'DNA MANILA', 'GENEVA', 'GLORIETTA', 'HERA',
                       'LIONESSE', 'LUMIA', 'PARIS', 'SM NORTH', 'VENICE'];

      // Initialize report objects
      const reports = {
        otsBookings: { total: 0, revenue: 0, count: 0, byBranch: {} },
        overallBookings: { total: 0, revenue: 0, count: 0, byBranch: {} },
        bookedTomorrow: { byBranch: {} },
        bookedNext7Days: { byBranch: {} },
        cancellations: { total: 0, revenue: 0, count: 0, byBranch: {} },
        overallBookingsTomorrow: { total: 0, revenue: 0, count: 0 },
        arrivalsToday: { count: 0, byBranch: {}, byStatus: { 'Arrived & bought': 0, 'Arrived not potential': 0 } }
      };

      // Initialize branch-level data
      branches.forEach(branch => {
        reports.otsBookings.byBranch[branch] = { count: 0, revenue: 0 };
        reports.overallBookings.byBranch[branch] = { count: 0, revenue: 0 };
        reports.bookedTomorrow.byBranch[branch] = { count: 0, revenue: 0 };
        reports.bookedNext7Days.byBranch[branch] = { count: 0, revenue: 0 };
        reports.cancellations.byBranch[branch] = { count: 0, revenue: 0 };
        reports.arrivalsToday.byBranch[branch] = { count: 0 };
      });

      // Process each booking row
      // VALIDATION LOGIC:
      // 1. OTS: Created TODAY + Scheduled TODAY + NOT cancelled
      // 2. OVERALL: Created TODAY + Scheduled (Next7Days \ {TODAY}) + NOT cancelled
      // 3. Tomorrow: Created TODAY + Scheduled TOMORROW + NOT cancelled
      // 4. Next7Days: Scheduled (Next7Days incl TODAY) + NOT cancelled (ignores when created)
      // 5. Cancellations: cancelled via CRM today OR created+cancelled today (no CRM update)
      // 6. TomorrowSummary: Scheduled TOMORROW + NOT cancelled (ignores when created)
      // 7. ArrivalsToday: Booking date = TODAY + status is "Arrived & bought" or "Arrived not potential"
      
      let processedCount = 0;
      console.log(`🔄 Processing ${dbRows.length - 1} booking rows...`);
      
      for (let i = 1; i < dbRows.length; i++) {
        const row = dbRows[i];
        const timestamp = row[0];
        const branch = row[1];
        const status = (row[2] || '').toLowerCase();
        const bookingDateStr = row[3];
        const firstName = row[4];
        const lastName = row[5];
        const price = parsePrice(row[12]);
        const cancellationTime = row[43];

        // Parse booking date from formatted date column
        const bookingDate = parseBookingDate(bookingDateStr);
        if (!bookingDate) {
          console.log(`⚠️ Row ${i}: Could not parse booking date: "${bookingDateStr}"`);
          continue;
        }

        // Extract created date from timestamp (ISO format)
        const createdDate = getDateFromTimestamp(timestamp);
        const createdToday = createdDate && createdDate.getTime() === today.getTime();
        
        // Log first 3 rows and last 12 rows (our demo bookings start at row ~30231)
        if (i <= 3 || i >= dbRows.length - 12) {
          console.log(`📝 Row ${i}: ${firstName} ${lastName} | Created: ${createdDate?.toDateString()} (${createdToday ? '✓TODAY' : ''}) | Booking: ${bookingDate.toDateString()} | Status: ${status} | Branch: ${branch}`);
        }
        
        processedCount++;

        // Section 1: OTS Bookings (Created today + Scheduled for today, all statuses)
        if (createdToday && isToday(bookingDate)) {
          reports.otsBookings.count++;
          reports.otsBookings.revenue += price;
          reports.otsBookings.total++;
          if (reports.otsBookings.byBranch[branch]) {
            reports.otsBookings.byBranch[branch].count++;
            reports.otsBookings.byBranch[branch].revenue += price;
          }
        }

        // Section 2: OVERALL Bookings (Created today + Scheduled tomorrow→+7 days, all statuses)
        if (createdToday && isNext7Days(bookingDate)) {
          reports.overallBookings.count++;
          reports.overallBookings.revenue += price;
          reports.overallBookings.total++;
          if (reports.overallBookings.byBranch[branch]) {
            reports.overallBookings.byBranch[branch].count++;
            reports.overallBookings.byBranch[branch].revenue += price;
          }
        }

        // Section 3: Booked Tomorrow per Branch (Created today, scheduled tomorrow, Scheduled status only)
        if (createdToday && isTomorrow(bookingDate) && status === 'scheduled') {
          if (reports.bookedTomorrow.byBranch[branch]) {
            reports.bookedTomorrow.byBranch[branch].count++;
            reports.bookedTomorrow.byBranch[branch].revenue += price;
          }
        }

        // Section 4: Booked Next 7 Days per Branch (Created today, day-after-tomorrow→+7, Scheduled only)
        if (createdToday && isInNext7Days(bookingDate) && status === 'scheduled') {
          if (reports.bookedNext7Days.byBranch[branch]) {
            reports.bookedNext7Days.byBranch[branch].count++;
            reports.bookedNext7Days.byBranch[branch].revenue += price;
          }
        }

        // Section 5: Cancellations per Branch
        // Counts: cancelled via CRM today (cancellationTime = today) OR created+cancelled today
        if (status.includes('cancel') && (isCancelledToday(cancellationTime) || (!cancellationTime && createdToday))) {
          reports.cancellations.count++;
          reports.cancellations.revenue += price;
          reports.cancellations.total++;
          if (reports.cancellations.byBranch[branch]) {
            reports.cancellations.byBranch[branch].count++;
            reports.cancellations.byBranch[branch].revenue += price;
          }
        }

        // Section 6: Overall Bookings Tomorrow (Scheduled tomorrow, any creation date, Scheduled status only)
        if (isTomorrow(bookingDate) && status === 'scheduled') {
          reports.overallBookingsTomorrow.count++;
          reports.overallBookingsTomorrow.revenue += price;
          reports.overallBookingsTomorrow.total++;
        }

        // Section 7: Arrivals Today (Booking date = today, status is arrived)
        // Also exclude underage_validation rows (col 45) from arrival count
        const underageValidation = (row[45] || '').toString().toUpperCase() === 'TRUE';
        const normalizedStatus = (row[2] || '').toLowerCase().replace(/\s+/g, ' ').trim();
        if (isToday(bookingDate) && !underageValidation &&
            (normalizedStatus === 'arrived & bought' || normalizedStatus === 'arrived not potential')) {
          reports.arrivalsToday.count++;
          if (reports.arrivalsToday.byBranch[branch]) {
            reports.arrivalsToday.byBranch[branch].count++;
          }
          // Track by exact status label for breakdown
          const statusLabel = row[2] || '';
          if (reports.arrivalsToday.byStatus[statusLabel] !== undefined) {
            reports.arrivalsToday.byStatus[statusLabel]++;
          } else {
            reports.arrivalsToday.byStatus[statusLabel] = 1;
          }
        }

      } // end for loop

      console.log(`✅ Processed ${processedCount} bookings`);
      console.log(`📊 Reports Summary:`);
      console.log(`   OTS: ${reports.otsBookings.count}, Revenue: ₱${reports.otsBookings.revenue}`);
      console.log(`   OVERALL: ${reports.overallBookings.count}, Revenue: ₱${reports.overallBookings.revenue}`);
      console.log(`   Tomorrow: ${Object.values(reports.bookedTomorrow.byBranch).reduce((sum, b) => sum + b.count, 0)} bookings`);
      console.log(`   Next7Days: ${Object.values(reports.bookedNext7Days.byBranch).reduce((sum, b) => sum + b.count, 0)} bookings`);
      console.log(`   Cancellations: ${reports.cancellations.count}, Revenue: ₱${reports.cancellations.revenue}`);
      console.log(`   Tomorrow Summary: ${reports.overallBookingsTomorrow.count}, Revenue: ₱${reports.overallBookingsTomorrow.revenue}`);
      console.log(`   Arrivals Today: ${reports.arrivalsToday.count}`);

      res.json({
        success: true,
        date: today.toISOString().split('T')[0],
        reports
      });

    } catch (error) {
      console.error('Get daily reports error:', error);
      res.status(500).json({ error: 'Failed to fetch daily reports' });
    }
  }

  // Get OTS detailed bookings (Created today + Scheduled today)
  async getOTSBookings(req, res) {
    try {
      const dbRows = await sheetsService.readSheet('DB');
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const getDateFromTimestamp = (timestampStr) => {
        if (!timestampStr) return null;
        const parsed = parseDateString(timestampStr);
        if (!parsed || isNaN(parsed.getTime())) return null;
        return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), 0, 0, 0, 0);
      };

      const parseBookingDate = (dateStr) => {
        if (!dateStr) return null;
        const parsed = parseDateString(dateStr);
        if (!parsed) return null;
        const d = new Date(parsed);
        d.setHours(0, 0, 0, 0);
        return d;
      };

      const isToday = (date) => date && date.getTime() === today.getTime();

      const bookings = [];
      for (let i = 1; i < dbRows.length; i++) {
        const row = dbRows[i];
        const timestamp = row[0];
        const bookingDateStr = row[3];
        const status = (row[2] || '').toLowerCase();

        const bookingDate = parseBookingDate(bookingDateStr);
        const createdDate = getDateFromTimestamp(timestamp);
        const createdToday = createdDate && createdDate.getTime() === today.getTime();

        if (createdToday && isToday(bookingDate)) {
          bookings.push({
            firstName: row[4] || '',
            lastName: row[5] || '',
            branch: row[1] || '',
            date: row[3] || '',
            treatment: row[8] || '',
            totalPrice: row[12] || 0,
            status: row[2] || '',
            phone: row[14] || '',
            email: row[16] || '',
            agent: row[17] || ''
          });
        }
      }

      res.json({ success: true, bookings });
    } catch (error) {
      console.error('Get OTS bookings error:', error);
      res.status(500).json({ error: 'Failed to fetch OTS bookings' });
    }
  }

  // Get Overall detailed bookings (Created today + Scheduled next 7 days)
  async getOverallBookings(req, res) {
    try {
      const dbRows = await sheetsService.readSheet('DB');
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const nextSevenDaysEnd = new Date(today);
      nextSevenDaysEnd.setDate(nextSevenDaysEnd.getDate() + 7);

      const getDateFromTimestamp = (timestampStr) => {
        if (!timestampStr) return null;
        const parsed = parseDateString(timestampStr);
        if (!parsed || isNaN(parsed.getTime())) return null;
        return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), 0, 0, 0, 0);
      };

      const parseBookingDate = (dateStr) => {
        if (!dateStr) return null;
        const parsed = parseDateString(dateStr);
        if (!parsed) return null;
        const d = new Date(parsed);
        d.setHours(0, 0, 0, 0);
        return d;
      };

      const isNext7Days = (date) => date && date > today && date <= nextSevenDaysEnd;

      const bookings = [];
      for (let i = 1; i < dbRows.length; i++) {
        const row = dbRows[i];
        const timestamp = row[0];
        const bookingDateStr = row[3];
        const status = (row[2] || '').toLowerCase();

        const bookingDate = parseBookingDate(bookingDateStr);
        const createdDate = getDateFromTimestamp(timestamp);
        const createdToday = createdDate && createdDate.getTime() === today.getTime();

        if (createdToday && isNext7Days(bookingDate)) {
          bookings.push({
            firstName: row[4] || '',
            lastName: row[5] || '',
            branch: row[1] || '',
            date: row[3] || '',
            treatment: row[8] || '',
            totalPrice: row[12] || 0,
            status: row[2] || '',
            phone: row[14] || '',
            email: row[16] || '',
            agent: row[17] || ''
          });
        }
      }

      res.json({ success: true, bookings });
    } catch (error) {
      console.error('Get overall bookings error:', error);
      res.status(500).json({ error: 'Failed to fetch overall bookings' });
    }
  }

  // Get Tomorrow detailed bookings (Created today + Scheduled tomorrow)
  async getTomorrowBookings(req, res) {
    try {
      const dbRows = await sheetsService.readSheet('DB');
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      const getDateFromTimestamp = (timestampStr) => {
        if (!timestampStr) return null;
        const parsed = parseDateString(timestampStr);
        if (!parsed || isNaN(parsed.getTime())) return null;
        return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), 0, 0, 0, 0);
      };

      const parseBookingDate = (dateStr) => {
        if (!dateStr) return null;
        const parsed = parseDateString(dateStr);
        if (!parsed) return null;
        const d = new Date(parsed);
        d.setHours(0, 0, 0, 0);
        return d;
      };

      const isTomorrow = (date) => date && date.getTime() === tomorrow.getTime();

      const bookings = [];
      for (let i = 1; i < dbRows.length; i++) {
        const row = dbRows[i];
        const timestamp = row[0];
        const bookingDateStr = row[3];
        const status = (row[2] || '').toLowerCase();

        const bookingDate = parseBookingDate(bookingDateStr);
        const createdDate = getDateFromTimestamp(timestamp);
        const createdToday = createdDate && createdDate.getTime() === today.getTime();

        if (createdToday && isTomorrow(bookingDate) && status === 'scheduled') {
          bookings.push({
            firstName: row[4] || '',
            lastName: row[5] || '',
            branch: row[1] || '',
            date: row[3] || '',
            treatment: row[8] || '',
            totalPrice: row[12] || 0,
            status: row[2] || '',
            phone: row[14] || '',
            email: row[16] || '',
            agent: row[17] || ''
          });
        }
      }

      res.json({ success: true, bookings });
    } catch (error) {
      console.error('Get tomorrow bookings error:', error);
      res.status(500).json({ error: 'Failed to fetch tomorrow bookings' });
    }
  }

  // Get Next 7 Days detailed bookings
  async getNext7DaysBookings(req, res) {
    try {
      const dbRows = await sheetsService.readSheet('DB');
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const nextSevenDaysEnd = new Date(today);
      nextSevenDaysEnd.setDate(nextSevenDaysEnd.getDate() + 7);

      const parseBookingDate = (dateStr) => {
        if (!dateStr) return null;
        const parsed = parseDateString(dateStr);
        if (!parsed) return null;
        const d = new Date(parsed);
        d.setHours(0, 0, 0, 0);
        return d;
      };

      const dayAfterTomorrow = new Date(tomorrow);
      dayAfterTomorrow.setDate(dayAfterTomorrow.getDate() + 1);

      const getDateFromTimestamp = (timestampStr) => {
        if (!timestampStr) return null;
        const parsed = parseDateString(timestampStr);
        if (!parsed || isNaN(parsed.getTime())) return null;
        return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), 0, 0, 0, 0);
      };

      const isInNext7Days = (date) => date && date >= dayAfterTomorrow && date <= nextSevenDaysEnd;

      const bookings = [];
      for (let i = 1; i < dbRows.length; i++) {
        const row = dbRows[i];
        const timestamp = row[0];
        const bookingDateStr = row[3];
        const status = (row[2] || '').toLowerCase();

        const bookingDate = parseBookingDate(bookingDateStr);
        const createdDate = getDateFromTimestamp(timestamp);
        const createdToday = createdDate && createdDate.getTime() === today.getTime();

        if (createdToday && isInNext7Days(bookingDate) && status === 'scheduled') {
          bookings.push({
            firstName: row[4] || '',
            lastName: row[5] || '',
            branch: row[1] || '',
            date: row[3] || '',
            treatment: row[8] || '',
            totalPrice: row[12] || 0,
            status: row[2] || '',
            phone: row[14] || '',
            email: row[16] || '',
            agent: row[17] || ''
          });
        }
      }

      res.json({ success: true, bookings });
    } catch (error) {
      console.error('Get next 7 days bookings error:', error);
      res.status(500).json({ error: 'Failed to fetch next 7 days bookings' });
    }
  }

  // Get Cancellations detailed bookings (Created today + status is Cancelled)
  async getCancellations(req, res) {
    try {
      const dbRows = await sheetsService.readSheet('DB');
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const getDateFromTimestamp = (timestampStr) => {
        if (!timestampStr) return null;
        const parsed = parseDateString(timestampStr);
        if (!parsed || isNaN(parsed.getTime())) return null;
        return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), 0, 0, 0, 0);
      };

      const bookings = [];
      for (let i = 1; i < dbRows.length; i++) {
        const row = dbRows[i];
        const timestamp = row[0];
        const status = (row[2] || '').toLowerCase();
        const cancellationTime = row[43];

        const createdDate = getDateFromTimestamp(timestamp);
        const createdToday = createdDate && createdDate.getTime() === today.getTime();
        const isCancelledToday = (ts) => {
          if (!ts) return false;
          const d = getDateFromTimestamp(ts);
          return d && d.getTime() === today.getTime();
        };

        if (status.includes('cancel') && (isCancelledToday(cancellationTime) || (!cancellationTime && createdToday))) {
          bookings.push({
            firstName: row[4] || '',
            lastName: row[5] || '',
            branch: row[1] || '',
            date: row[3] || '',
            treatment: row[8] || '',
            totalPrice: row[12] || 0,
            status: row[2] || '',
            phone: row[14] || '',
            email: row[16] || '',
            agent: row[17] || ''
          });
        }
      }

      res.json({ success: true, bookings });
    } catch (error) {
      console.error('Get cancellations error:', error);
      res.status(500).json({ error: 'Failed to fetch cancellations' });
    }
  }

  // Get Arrivals Today detailed bookings (Booking date = today + arrived status)
  async getArrivalsToday(req, res) {
    try {
      const dbRows = await sheetsService.readSheet('DB');
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const parseBookingDate = (dateStr) => {
        if (!dateStr) return null;
        const parsed = parseDateString(dateStr);
        if (!parsed) return null;
        const d = new Date(parsed);
        d.setHours(0, 0, 0, 0);
        return d;
      };

      const isToday = (date) => date && date.getTime() === today.getTime();

      const arrivalStatuses = new Set(['arrived & bought', 'arrived not potential']);

      const bookings = [];
      for (let i = 1; i < dbRows.length; i++) {
        const row = dbRows[i];
        const bookingDateStr = row[3];
        const rawStatus = row[2] || '';
        const normalizedStatus = rawStatus.toLowerCase().replace(/\s+/g, ' ').trim();

        const bookingDate = parseBookingDate(bookingDateStr);

        const underageValidation = (row[45] || '').toString().toUpperCase() === 'TRUE';
        if (isToday(bookingDate) && arrivalStatuses.has(normalizedStatus) && !underageValidation) {
          bookings.push({
            firstName: row[4] || '',
            lastName: row[5] || '',
            branch: row[1] || '',
            date: row[3] || '',
            treatment: row[8] || '',
            totalPrice: row[12] || 0,
            status: rawStatus,
            phone: row[14] || '',
            email: row[16] || '',
            agent: row[17] || ''
          });
        }
      }

      res.json({ success: true, bookings });
    } catch (error) {
      console.error('Get arrivals today error:', error);
      res.status(500).json({ error: 'Failed to fetch arrivals today' });
    }
  }

  // Get Tomorrow Summary detailed bookings (Scheduled tomorrow, any creation date)
  async getTomorrowSummary(req, res) {
    try {
      const dbRows = await sheetsService.readSheet('DB');
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      // getTomorrowSummary doesn't filter by creation date, so no getDateFromTimestamp needed

      const parseBookingDate = (dateStr) => {
        if (!dateStr) return null;
        const parsed = parseDateString(dateStr);
        if (!parsed) return null;
        const d = new Date(parsed);
        d.setHours(0, 0, 0, 0);
        return d;
      };

      const isTomorrow = (date) => date && date.getTime() === tomorrow.getTime();

      const bookings = [];
      for (let i = 1; i < dbRows.length; i++) {
        const row = dbRows[i];
        const bookingDateStr = row[3];
        const status = (row[2] || '').toLowerCase();

        const bookingDate = parseBookingDate(bookingDateStr);

        if (isTomorrow(bookingDate) && status === 'scheduled') {
          bookings.push({
            firstName: row[4] || '',
            lastName: row[5] || '',
            branch: row[1] || '',
            date: row[3] || '',
            treatment: row[8] || '',
            totalPrice: row[12] || 0,
            status: row[2] || '',
            phone: row[14] || '',
            email: row[16] || '',
            agent: row[17] || ''
          });
        }
      }

      res.json({ success: true, bookings });
    } catch (error) {
      console.error('Get tomorrow summary error:', error);
      res.status(500).json({ error: 'Failed to fetch tomorrow summary' });
    }
  }

  // GET /bookings/cc-report
  // All-in-one payload for the CC Booking Report dashboard.
  // Sections:
  //   totalSchedulesToday    – byBranch count/revenue + ots/additional split
  //   totalArrivalsToday     – byBranch count + otsArrivals/additionalArrivals split
  // DELETE /bookings/:rowNumber — Admin only.
  // Deletes a booking row from the DB sheet and the matching row from the Intake sheet
  // (matched by the bookingId UUID stored at DB col 34 / Intake col AI index 34).
  async deleteBooking(req, res) {
    try {
      if (req.user?.role !== 'Admin') {
        return res.status(403).json({ error: 'Only admins can delete bookings' });
      }

      const rowNumber = parseInt(req.params.rowNumber, 10);
      if (!rowNumber || rowNumber < 2) {
        return res.status(400).json({ error: 'Invalid row number' });
      }

      // Read the DB sheet to get the bookingId (record_id at col index 34)
      const dbRows = await sheetsService.readSheet('DB');
      const targetRow = dbRows[rowNumber - 1]; // rowNumber is 1-based, array is 0-based
      if (!targetRow) {
        return res.status(404).json({ error: 'Booking row not found' });
      }
      const bookingId = targetRow[34] || '';

      // Delete from DB sheet
      await sheetsService.deleteRow('DB', rowNumber);

      // Delete matching row from Intake sheet (record_id at col index 34 = column AI)
      if (bookingId) {
        const intakeRows = await sheetsService.readSheet('Intake');
        const intakeRowIdx = intakeRows.findIndex((r, i) => i > 0 && (r[34] || '') === bookingId);
        if (intakeRowIdx !== -1) {
          await sheetsService.deleteRow('Intake', intakeRowIdx + 1);
          console.log(`✅ Deleted Intake row ${intakeRowIdx + 1} for bookingId ${bookingId}`);
        } else {
          console.log(`ℹ️ No matching Intake row found for bookingId ${bookingId}`);
        }
      }

      return res.json({ success: true, message: 'Booking deleted successfully', rowNumber });
    } catch (error) {
      console.error('deleteBooking error:', error.message);
      res.status(500).json({ error: 'Failed to delete booking', details: error.message });
    }
  }

  //   totalSchedulesTomorrow – byBranch count + otsTomorrow/additionalTomorrow split
  //   paymentModesTomorrow   – { Cash, Debit, Credit } counts for tomorrow's schedule
  //   totalSchedulesNext7    – byBranch count + otsNext7/additionalNext7 split
  //   totalOTS               – byBranch OTS count (today+tomorrow+next7) + grand total
  async getCCReport(req, res) {
    try {
      const dbRows = await sheetsService.readSheet('DB');
      if (dbRows.length < 2) {
        return res.json({ success: true, data: {} });
      }

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
      const next7End  = new Date(today); next7End.setDate(today.getDate() + 7);

      const parseDate = (str) => {
        if (!str) return null;
        const p = parseDateString(str);
        if (!p || isNaN(p.getTime())) return null;
        const d = new Date(p); d.setHours(0,0,0,0); return d;
      };

      const isDay  = (d, ref) => d && d.getTime() === ref.getTime();
      const inNext7 = (d) => d && d > today && d <= next7End;
      const inNext7Inc = (d) => d && d >= today && d <= next7End;

      // branch → { count, revenue }
      const makeBranchMap = () => ({});
      const inc = (map, branch, revenue = 0) => {
        if (!map[branch]) map[branch] = { count: 0, revenue: 0 };
        map[branch].count++;
        map[branch].revenue += revenue;
      };

      const totalSchedulesToday    = { ots: 0, additional: 0, byBranch: makeBranchMap(), otsRevenue: 0, additionalRevenue: 0 };
      const totalArrivalsToday     = { otsArrivals: 0, additionalArrivals: 0, byBranch: makeBranchMap() };
      const totalSchedulesTomorrow = { otsTomorrow: 0, additionalTomorrow: 0, byBranch: makeBranchMap() };
      const paymentModesTomorrow   = { Cash: 0, Debit: 0, Credit: 0 };
      const totalSchedulesNext7    = { otsNext7: 0, additionalNext7: 0, byBranch: makeBranchMap() };
      const totalOTSByBranch       = makeBranchMap(); // OTS = created today
      const arrivalsStatusMap      = {};

      for (let i = 1; i < dbRows.length; i++) {
        const row = dbRows[i];
        const cancelValidation = (row[44] || '').toString().toUpperCase() === 'TRUE';
        if (cancelValidation) continue;

        const branch      = row[1] || 'Unknown';
        const rawStatus   = row[2] || '';
        const statusLower = rawStatus.toLowerCase().replace(/\s+/g, ' ').trim();
        const bookingDate = parseDate(row[3]);
        const createdDate = parseDate(row[0]);
        const price       = parseFloat((row[12] || '0').toString().replace(/[^0-9.]/g, '')) || 0;
        const payMode     = (row[13] || '').trim();

        if (!bookingDate) continue;

        const createdToday = createdDate && isDay(createdDate, today);
        const cancelled    = statusLower.includes('cancel');
        const isArrived    = statusLower === 'arrived & bought' || statusLower === 'arrived not potential';
        const underageVal  = (row[45] || '').toString().toUpperCase() === 'TRUE';

        // ── Section 1: Total Schedules Today ──────────────────────────
        if (!cancelled && isDay(bookingDate, today)) {
          inc(totalSchedulesToday.byBranch, branch, price);
          if (createdToday) {
            totalSchedulesToday.ots++;
            totalSchedulesToday.otsRevenue += price;
            inc(totalOTSByBranch, branch);
          } else {
            totalSchedulesToday.additional++;
            totalSchedulesToday.additionalRevenue += price;
          }
        }

        // ── Section 2: Total Arrivals Today ───────────────────────────
        if (!underageVal && isArrived && isDay(bookingDate, today)) {
          inc(totalArrivalsToday.byBranch, branch);
          if (!arrivalsStatusMap[rawStatus]) arrivalsStatusMap[rawStatus] = 0;
          arrivalsStatusMap[rawStatus]++;
          if (createdToday) totalArrivalsToday.otsArrivals++;
          else              totalArrivalsToday.additionalArrivals++;
        }

        // ── Section 3: Total Schedules Tomorrow ───────────────────────
        if (!cancelled && isDay(bookingDate, tomorrow)) {
          inc(totalSchedulesTomorrow.byBranch, branch, price);
          // Payment modes for tomorrow
          const modeKey = payMode.toLowerCase().includes('cash') ? 'Cash'
                        : payMode.toLowerCase().includes('debit') ? 'Debit'
                        : payMode.toLowerCase().includes('credit') ? 'Credit' : null;
          if (modeKey) paymentModesTomorrow[modeKey]++;

          if (createdToday) totalSchedulesTomorrow.otsTomorrow++;
          else              totalSchedulesTomorrow.additionalTomorrow++;

          // OTS = created today (for OTS grand total section)
          if (createdToday) inc(totalOTSByBranch, branch);
        }

        // ── Section 4: Total Schedules Next 7 Days ────────────────────
        if (!cancelled && inNext7(bookingDate)) {
          inc(totalSchedulesNext7.byBranch, branch, price);
          if (createdToday) {
            totalSchedulesNext7.otsNext7++;
            inc(totalOTSByBranch, branch);
          } else {
            totalSchedulesNext7.additionalNext7++;
          }
        }
      }

      // Derived totals
      const totalToday    = Object.values(totalSchedulesToday.byBranch).reduce((s, b) => s + b.count, 0);
      const totalTomorrow = Object.values(totalSchedulesTomorrow.byBranch).reduce((s, b) => s + b.count, 0);
      const totalArrivals = Object.values(totalArrivalsToday.byBranch).reduce((s, b) => s + b.count, 0);
      const totalNext7    = Object.values(totalSchedulesNext7.byBranch).reduce((s, b) => s + b.count, 0);
      const totalOTS      = Object.values(totalOTSByBranch).reduce((s, b) => s + b.count, 0);

      return res.json({
        success: true,
        generatedAt: new Date().toISOString(),
        data: {
          totalSchedulesToday:    { ...totalSchedulesToday,    total: totalToday },
          totalArrivalsToday:     { ...totalArrivalsToday,     total: totalArrivals, byStatus: arrivalsStatusMap },
          totalSchedulesTomorrow: { ...totalSchedulesTomorrow, total: totalTomorrow },
          paymentModesTomorrow,
          totalSchedulesNext7:    { ...totalSchedulesNext7,    total: totalNext7 },
          totalOTS:               { byBranch: totalOTSByBranch, total: totalOTS },
        }
      });
    } catch (error) {
      console.error('getCCReport error:', error.message);
      res.status(500).json({ error: 'Failed to generate CC report' });
    }
  }

  // GET /bookings/cc-report/drilldown?section=<section>
  // Returns detailed bookings for a CC Report section (filtered by branch or payMode on the client).
  // Sections: schedules-today | arrivals | schedules-tomorrow | payment-tomorrow | next7days | ots
  async getCCReportDrilldown(req, res) {
    try {
      const { section } = req.query;
      const validSections = ['schedules-today', 'arrivals', 'schedules-tomorrow', 'payment-tomorrow', 'next7days', 'ots'];
      if (!validSections.includes(section)) {
        return res.status(400).json({ error: 'Invalid section. Must be one of: ' + validSections.join(', ') });
      }

      const dbRows = await sheetsService.readSheet('DB');
      if (dbRows.length < 2) return res.json({ success: true, bookings: [] });

      const today = new Date(); today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
      const next7End  = new Date(today); next7End.setDate(today.getDate() + 7);

      const parseDate = (str) => {
        if (!str) return null;
        const p = parseDateString(str);
        if (!p || isNaN(p.getTime())) return null;
        const d = new Date(p); d.setHours(0, 0, 0, 0); return d;
      };

      const isDay   = (d, ref) => d && d.getTime() === ref.getTime();
      const inNext7 = (d) => d && d > today && d <= next7End;

      const bookings = [];
      for (let i = 1; i < dbRows.length; i++) {
        const row = dbRows[i];
        const cancelValidation = (row[44] || '').toString().toUpperCase() === 'TRUE';
        if (cancelValidation) continue;

        const branch      = row[1] || 'Unknown';
        const rawStatus   = row[2] || '';
        const statusLower = rawStatus.toLowerCase().replace(/\s+/g, ' ').trim();
        const bookingDate = parseDate(row[3]);
        const createdDate = parseDate(row[0]);
        const payMode     = (row[13] || '').trim();

        if (!bookingDate) continue;

        const createdToday = createdDate && isDay(createdDate, today);
        const cancelled    = statusLower.includes('cancel');
        const isArrived    = statusLower === 'arrived & bought' || statusLower === 'arrived not potential';
        const underageVal  = (row[45] || '').toString().toUpperCase() === 'TRUE';

        let include = false;
        if (section === 'schedules-today'    && !cancelled && isDay(bookingDate, today))    include = true;
        else if (section === 'arrivals'      && !underageVal && isArrived && isDay(bookingDate, today)) include = true;
        else if (section === 'schedules-tomorrow' && !cancelled && isDay(bookingDate, tomorrow)) include = true;
        else if (section === 'payment-tomorrow'   && !cancelled && isDay(bookingDate, tomorrow)) include = true;
        else if (section === 'next7days'     && !cancelled && inNext7(bookingDate))         include = true;
        else if (section === 'ots'           && !cancelled && createdToday &&
                 (isDay(bookingDate, today) || isDay(bookingDate, tomorrow) || inNext7(bookingDate))) include = true;

        if (include) {
          bookings.push({
            firstName:   row[4]  || '',
            lastName:    row[5]  || '',
            branch,
            date:        row[3]  || '',
            treatment:   row[8]  || '',
            totalPrice:  row[12] || 0,
            status:      rawStatus,
            phone:       row[14] || '',
            email:       row[16] || '',
            agent:       row[17] || '',
            paymentMode: payMode,
          });
        }
      }

      res.json({ success: true, bookings });
    } catch (error) {
      console.error('getCCReportDrilldown error:', error.message);
      res.status(500).json({ error: 'Failed to fetch drill-down bookings' });
    }
  }
}

// Helper function to check for promo hunter by matching name, email, phone, social media, or companion name
async function checkPromoHunter(firstName, lastName, email, phone, socialMedia, companionFirstName, companionLastName) {
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
    const normalizedEmail = (email || '').toLowerCase().trim();
    const normalizedPhone = (phone || '').replace(/\D/g, '').trim(); // Remove non-digits
    const normalizedSocialMedia = (socialMedia || '').toLowerCase().trim();
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
      const existingPhone = (row[14] || '').replace(/\D/g, '').trim();
      const existingSocialMedia = (row[15] || '').toLowerCase().trim();
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
      // Match by social media (Facebook / Instagram Name)
      else if (normalizedSocialMedia && existingSocialMedia && existingSocialMedia === normalizedSocialMedia) {
        matchReason = 'Social Media Match';
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

    // Return detailed match information from FIRST match only (most recent booking)
    if (matches.length > 0) {
      const firstMatch = matches[0];
      
      return {
        status,
        matchReason: firstMatch.reason,
        matchedSource: `${firstMatch.source} (${firstMatch.branch})`,
        matchedRow: `Row ${firstMatch.rowNumber}`,
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
