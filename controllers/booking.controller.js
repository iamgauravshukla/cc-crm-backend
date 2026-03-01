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

      // Get client IP
      const customerIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

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
        ''                                      // 43: cancellation_time (empty for new bookings)
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
      
      // Booking Created Date filters (timestamp based)
      const createdDateRange = req.query.createdDateRange;
      const createdStartDate = req.query.createdStartDate;
      const createdEndDate = req.query.createdEndDate;
      
      // Appointment Date filters (scheduled date based)
      const appointmentDateRange = req.query.appointmentDateRange;
      const appointmentStartDate = req.query.appointmentStartDate;
      const appointmentEndDate = req.query.appointmentEndDate;
      
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
        
        // Parse rows into objects - CORRECTED COLUMN MAPPING for 44-column DB sheet
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
        // Branch filter
        if (branch && branch !== 'All' && booking.branch !== branch) {
          return false;
        }
        
        // Status filter
        if (status && status !== 'All' && booking.status !== status) {
          return false;
        }
        
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
            if (appointmentDate < appointmentDateStart || appointmentDate > appointmentDateEnd) {
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
      const timestamp = getCurrentTimestamp();
      
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
        cancellationTime = timestamp; // set cancellation time to now if cancelled
        console.log('Setting cancellation_time to:', cancellationTime);
      }
      
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
        bookingData.status || 'Scheduled',      // 42: dash_booking_status (update to match)
        cancellationTime                        // 43: cancellation_time (track when cancelled)
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
      const nextSevenDaysEnd = new Date(today);
      nextSevenDaysEnd.setDate(nextSevenDaysEnd.getDate() + 7);

      console.log(`📅 Today: ${today.toDateString()}, Tomorrow: ${tomorrow.toDateString()}`);


      // Helper to extract date from ISO timestamp
      const getDateFromTimestamp = (isoString) => {
        if (!isoString) return null;
        try {
          const date = new Date(isoString);
          if (isNaN(date.getTime())) return null;
          // Extract just the date part in local timezone
          const year = date.getFullYear();
          const month = date.getMonth();
          const day = date.getDate();
          const localDateOnly = new Date(year, month, day, 0, 0, 0, 0);
          return localDateOnly;
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
      const isInNext7Days = (date) => date && date >= today && date <= nextSevenDaysEnd;
      
      // Helper to check if cancellation happened today
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
        overallBookingsTomorrow: { total: 0, revenue: 0, count: 0 }
      };

      // Initialize branch-level data
      branches.forEach(branch => {
        reports.otsBookings.byBranch[branch] = { count: 0, revenue: 0 };
        reports.overallBookings.byBranch[branch] = { count: 0, revenue: 0 };
        reports.bookedTomorrow.byBranch[branch] = { count: 0, revenue: 0 };
        reports.bookedNext7Days.byBranch[branch] = { count: 0, revenue: 0 };
        reports.cancellations.byBranch[branch] = { count: 0, revenue: 0 };
      });

      // Process each booking row
      // VALIDATION LOGIC:
      // 1. OTS: Created TODAY + Scheduled TODAY + NOT cancelled
      // 2. OVERALL: Created TODAY + Scheduled (Next7Days \ {TODAY}) + NOT cancelled
      // 3. Tomorrow: Created TODAY + Scheduled TOMORROW + NOT cancelled
      // 4. Next7Days: Scheduled (Next7Days incl TODAY) + NOT cancelled (ignores when created)
      // 5. Cancellations: Created TODAY + Cancelled + Cancelled TODAY
      // 6. TomorrowSummary: Scheduled TOMORROW + NOT cancelled (ignores when created)
      
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

        // Section 1: OTS Bookings (Created today + Scheduled for today)
        if (createdToday && isToday(bookingDate) && !status.includes('cancel')) {
          reports.otsBookings.count++;
          reports.otsBookings.revenue += price;
          reports.otsBookings.total++;
          if (reports.otsBookings.byBranch[branch]) {
            reports.otsBookings.byBranch[branch].count++;
            reports.otsBookings.byBranch[branch].revenue += price;
          }
        }

        // Section 2: OVERALL Bookings (Created today + Scheduled for next 7 days, not today)
        if (createdToday && isNext7Days(bookingDate) && !status.includes('cancel')) {
          reports.overallBookings.count++;
          reports.overallBookings.revenue += price;
          reports.overallBookings.total++;
          if (reports.overallBookings.byBranch[branch]) {
            reports.overallBookings.byBranch[branch].count++;
            reports.overallBookings.byBranch[branch].revenue += price;
          }
        }

        // Section 3: Booked Tomorrow per Branch (Created today, scheduled for tomorrow)
        if (createdToday && isTomorrow(bookingDate) && !status.includes('cancel')) {
          if (reports.bookedTomorrow.byBranch[branch]) {
            reports.bookedTomorrow.byBranch[branch].count++;
            reports.bookedTomorrow.byBranch[branch].revenue += price;
          }
        }

        // Section 4: Booked Next 7 Days per Branch (Any bookings next 7 days)
        if (isInNext7Days(bookingDate) && !status.includes('cancel')) {
          if (reports.bookedNext7Days.byBranch[branch]) {
            reports.bookedNext7Days.byBranch[branch].count++;
            reports.bookedNext7Days.byBranch[branch].revenue += price;
          }
        }

        // Section 5: Cancellations per Branch (Created today + Cancelled today)
        if (createdToday && status.includes('cancel') && isCancelledToday(cancellationTime)) {
          reports.cancellations.count++;
          reports.cancellations.revenue += price;
          reports.cancellations.total++;
          if (reports.cancellations.byBranch[branch]) {
            reports.cancellations.byBranch[branch].count++;
            reports.cancellations.byBranch[branch].revenue += price;
          }
        }

        // Section 6: Overall Bookings Tomorrow (Scheduled for tomorrow, anytime)
        if (isTomorrow(bookingDate) && !status.includes('cancel')) {
          reports.overallBookingsTomorrow.count++;
          reports.overallBookingsTomorrow.revenue += price;
          reports.overallBookingsTomorrow.total++;
        }
      }

      console.log(`✅ Processed ${processedCount} bookings`);
      console.log(`📊 Reports Summary:`);
      console.log(`   OTS: ${reports.otsBookings.count}, Revenue: ₱${reports.otsBookings.revenue}`);
      console.log(`   OVERALL: ${reports.overallBookings.count}, Revenue: ₱${reports.overallBookings.revenue}`);
      console.log(`   Tomorrow: ${Object.values(reports.bookedTomorrow.byBranch).reduce((sum, b) => sum + b.count, 0)} bookings`);
      console.log(`   Next7Days: ${Object.values(reports.bookedNext7Days.byBranch).reduce((sum, b) => sum + b.count, 0)} bookings`);
      console.log(`   Cancellations: ${reports.cancellations.count}, Revenue: ₱${reports.cancellations.revenue}`);
      console.log(`   Tomorrow Summary: ${reports.overallBookingsTomorrow.count}, Revenue: ₱${reports.overallBookingsTomorrow.revenue}`);

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

      const getDateFromTimestamp = (isoString) => {
        if (!isoString) return null;
        const date = new Date(isoString);
        if (isNaN(date.getTime())) return null;
        const year = date.getFullYear();
        const month = date.getMonth();
        const day = date.getDate();
        return new Date(year, month, day, 0, 0, 0, 0);
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

        if (createdToday && isToday(bookingDate) && !status.includes('cancel')) {
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

      const getDateFromTimestamp = (isoString) => {
        if (!isoString) return null;
        const date = new Date(isoString);
        if (isNaN(date.getTime())) return null;
        const year = date.getFullYear();
        const month = date.getMonth();
        const day = date.getDate();
        return new Date(year, month, day, 0, 0, 0, 0);
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

        if (createdToday && isNext7Days(bookingDate) && !status.includes('cancel')) {
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

      const getDateFromTimestamp = (isoString) => {
        if (!isoString) return null;
        const date = new Date(isoString);
        if (isNaN(date.getTime())) return null;
        const year = date.getFullYear();
        const month = date.getMonth();
        const day = date.getDate();
        return new Date(year, month, day, 0, 0, 0, 0);
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

        if (createdToday && isTomorrow(bookingDate) && !status.includes('cancel')) {
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
      const nextSevenDaysEnd = new Date(today);
      nextSevenDaysEnd.setDate(nextSevenDaysEnd.getDate() + 7);

      const getDateFromTimestamp = (isoString) => {
        if (!isoString) return null;
        const date = new Date(isoString);
        if (isNaN(date.getTime())) return null;
        const year = date.getFullYear();
        const month = date.getMonth();
        const day = date.getDate();
        return new Date(year, month, day, 0, 0, 0, 0);
      };

      const parseBookingDate = (dateStr) => {
        if (!dateStr) return null;
        const parsed = parseDateString(dateStr);
        if (!parsed) return null;
        const d = new Date(parsed);
        d.setHours(0, 0, 0, 0);
        return d;
      };

      const isInNext7Days = (date) => date && date >= today && date <= nextSevenDaysEnd;

      const bookings = [];
      for (let i = 1; i < dbRows.length; i++) {
        const row = dbRows[i];
        const bookingDateStr = row[3];
        const status = (row[2] || '').toLowerCase();

        const bookingDate = parseBookingDate(bookingDateStr);

        if (isInNext7Days(bookingDate) && !status.includes('cancel')) {
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

  // Get Cancellations detailed bookings (Created today + Cancelled today)
  async getCancellations(req, res) {
    try {
      const dbRows = await sheetsService.readSheet('DB');
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const getDateFromTimestamp = (isoString) => {
        if (!isoString) return null;
        const date = new Date(isoString);
        if (isNaN(date.getTime())) return null;
        const year = date.getFullYear();
        const month = date.getMonth();
        const day = date.getDate();
        return new Date(year, month, day, 0, 0, 0, 0);
      };

      const isCancelledToday = (cancellationTimeStr) => {
        if (!cancellationTimeStr) return false;
        const cancelledDate = getDateFromTimestamp(cancellationTimeStr);
        return cancelledDate && cancelledDate.getTime() === today.getTime();
      };

      const bookings = [];
      for (let i = 1; i < dbRows.length; i++) {
        const row = dbRows[i];
        const timestamp = row[0];
        const status = (row[2] || '').toLowerCase();
        const cancellationTime = row[43];

        const createdDate = getDateFromTimestamp(timestamp);
        const createdToday = createdDate && createdDate.getTime() === today.getTime();

        if (createdToday && status.includes('cancel') && isCancelledToday(cancellationTime)) {
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

  // Get Tomorrow Summary detailed bookings (Scheduled tomorrow, any creation date)
  async getTomorrowSummary(req, res) {
    try {
      const dbRows = await sheetsService.readSheet('DB');
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      const getDateFromTimestamp = (isoString) => {
        if (!isoString) return null;
        const date = new Date(isoString);
        if (isNaN(date.getTime())) return null;
        const year = date.getFullYear();
        const month = date.getMonth();
        const day = date.getDate();
        return new Date(year, month, day, 0, 0, 0, 0);
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
        const bookingDateStr = row[3];
        const status = (row[2] || '').toLowerCase();

        const bookingDate = parseBookingDate(bookingDateStr);

        if (isTomorrow(bookingDate) && !status.includes('cancel')) {
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
