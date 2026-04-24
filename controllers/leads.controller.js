const sheetsService = require('../services/sheets.service');

// Sheet names for leads
const CALL_LEADS_SHEET = 'CallLeads';
const BOOKING_LEADS_SHEET = 'BookingLeads';

// CallLeads columns:    Timestamp | Wellness Center | Full Name | Email | Phone | Treatment | Message | Status
// BookingLeads columns: Timestamp | Wellness Center | Full Name | Email | Phone | Treatment | Age | Schedule | Payment Method | Status

const VALID_TYPES = ['call', 'booking'];

const getCurrentTimestamp = () => {
  const now = new Date();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = now.getDate();
  const month = months[now.getMonth()];
  const year = now.getFullYear();
  const hours = now.getHours();
  const minutes = now.getMinutes().toString().padStart(2, '0');
  const displayHours = hours % 12 || 12;
  const ampm = hours >= 12 ? 'PM' : 'AM';
  return `${month} ${day} ${year} ${displayHours}:${minutes} ${ampm}`;
};

/**
 * POST /api/leads?type=call&center=<CENTER_NAME>
 * POST /api/leads?type=booking&center=<CENTER_NAME>
 * Public endpoint — called from wellness center website
 *
 * type=call    body: { fullname, email, phone, treatment, message }
 * type=booking body: { fullname, email, phone, treatment, age, schedule, payment_method }
 */
async function submitLead(req, res) {
  try {
    const type = (req.query.type || '').trim().toLowerCase();
    const center = (req.query.center || '').trim();

    if (!type || !VALID_TYPES.includes(type)) {
      return res.status(400).json({
        error: `Query param ?type= is required. Valid values: ${VALID_TYPES.join(', ')}`
      });
    }
    if (!center) {
      return res.status(400).json({ error: 'Query param ?center= is required' });
    }

    if (type === 'call') {
      return submitCallLead(req, res, center);
    }
    return submitBookingLead(req, res, center);
  } catch (error) {
    console.error('Submit lead error:', error);
    return res.status(500).json({ error: 'Failed to submit lead' });
  }
}

/**
 * Internal handler for consultancy call lead submission
 */
async function submitCallLead(req, res, center) {
  try {
    const { fullname, email, phone, treatment, message } = req.body;

    if (!fullname || !email || !phone || !treatment) {
      return res.status(400).json({ error: 'fullname, email, phone, and treatment are required' });
    }

    const timestamp = getCurrentTimestamp();

    const row = [
      timestamp,               // 0: Timestamp
      center,                  // 1: Wellness Center
      fullname.trim(),         // 2: Full Name
      email.trim().toLowerCase(), // 3: Email
      `'${phone.trim()}`,      // 4: Phone (apostrophe prevents Sheets treating + as formula)
      treatment.trim(),        // 5: Treatment
      (message || '').trim(),  // 6: Message
      'New'                    // 7: Status
    ];

    await sheetsService.appendRow(CALL_LEADS_SHEET, row);

    console.log(`✅ Call lead submitted — Center: ${center}, Name: ${fullname}`);
    return res.status(201).json({ success: true, message: 'Lead submitted successfully' });
  } catch (error) {
    console.error('Submit call lead error:', error);
    return res.status(500).json({ error: 'Failed to submit lead' });
  }
}

/**
 * Internal handler for direct booking lead submission
 */
async function submitBookingLead(req, res, center) {
  try {
    const { fullname, email, phone, treatment, age, schedule, payment_method } = req.body;

    if (!fullname || !email || !phone || !treatment || !schedule) {
      return res.status(400).json({ error: 'fullname, email, phone, treatment, and schedule are required' });
    }

    const timestamp = getCurrentTimestamp();

    const row = [
      timestamp,                            // 0: Timestamp
      center,                               // 1: Wellness Center
      fullname.trim(),                      // 2: Full Name
      email.trim().toLowerCase(),           // 3: Email
      `'${phone.trim()}`,                   // 4: Phone (apostrophe prevents Sheets treating + as formula)
      treatment.trim(),                     // 5: Treatment
      (age || '').toString().trim(),        // 6: Age
      (schedule || '').trim(),              // 7: Schedule
      (payment_method || '').trim(),        // 8: Payment Method
      'New'                                 // 9: Status
    ];

    await sheetsService.appendRow(BOOKING_LEADS_SHEET, row);

    console.log(`✅ Booking lead submitted — Center: ${center}, Name: ${fullname}`);
    return res.status(201).json({ success: true, message: 'Lead submitted successfully' });
  } catch (error) {
    console.error('Submit booking lead error:', error);
    return res.status(500).json({ error: 'Failed to submit lead' });
  }
}

/**
 * GET /api/leads/call?center=ALL&search=&sort=latest
 * Protected — CRM users only
 */
async function getCallLeads(req, res) {
  try {
    const { center = 'ALL', search = '', sort = 'latest' } = req.query;

    const rows = await sheetsService.readSheet(CALL_LEADS_SHEET);

    if (rows.length < 2) {
      return res.json({ success: true, data: [] });
    }

    let leads = rows.slice(1).map((row, idx) => ({
      rowIndex: idx + 2,
      timestamp: row[0] || '',
      center: row[1] || '',
      fullname: row[2] || '',
      email: row[3] || '',
      phone: row[4] || '',
      treatment: row[5] || '',
      message: row[6] || '',
      status: row[7] || 'New',
      feedback: row[8] || '',
    }));

    // Filter by center
    if (center && center.toUpperCase() !== 'ALL') {
      leads = leads.filter(l => l.center.toLowerCase() === center.toLowerCase());
    }

    // Search filter
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      leads = leads.filter(l =>
        l.fullname.toLowerCase().includes(q) ||
        l.email.toLowerCase().includes(q) ||
        l.phone.includes(q) ||
        l.treatment.toLowerCase().includes(q) ||
        l.message.toLowerCase().includes(q)
      );
    }

    // Sort — newest first by default (sheet rows are chronological)
    if (sort === 'oldest') {
      // already in ascending order from sheet
    } else {
      leads = leads.reverse();
    }

    return res.json({ success: true, data: leads });
  } catch (error) {
    console.error('Get call leads error:', error);
    return res.status(500).json({ error: 'Failed to fetch leads' });
  }
}

/**
 * GET /api/leads/booking?center=ALL&search=&sort=latest
 * Protected — CRM users only
 */
async function getBookingLeads(req, res) {
  try {
    const { center = 'ALL', search = '', sort = 'latest' } = req.query;

    const rows = await sheetsService.readSheet(BOOKING_LEADS_SHEET);

    if (rows.length < 2) {
      return res.json({ success: true, data: [] });
    }

    let leads = rows.slice(1).map((row, idx) => ({
      rowIndex: idx + 2,
      timestamp: row[0] || '',
      center: row[1] || '',
      fullname: row[2] || '',
      email: row[3] || '',
      phone: row[4] || '',
      treatment: row[5] || '',
      age: row[6] || '',
      schedule: row[7] || '',
      paymentMethod: row[8] || '',
      status: row[9] || 'New',
      feedback: row[10] || '',
    }));

    // Filter by center
    if (center && center.toUpperCase() !== 'ALL') {
      leads = leads.filter(l => l.center.toLowerCase() === center.toLowerCase());
    }

    // Search filter
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      leads = leads.filter(l =>
        l.fullname.toLowerCase().includes(q) ||
        l.email.toLowerCase().includes(q) ||
        l.phone.includes(q) ||
        l.treatment.toLowerCase().includes(q)
      );
    }

    // Sort
    if (sort === 'oldest') {
      // already ascending
    } else {
      leads = leads.reverse();
    }

    return res.json({ success: true, data: leads });
  } catch (error) {
    console.error('Get booking leads error:', error);
    return res.status(500).json({ error: 'Failed to fetch leads' });
  }
}

/**
 * GET /api/leads/centers
 * Returns distinct wellness center names from both lead sheets
 * Protected — CRM users only
 */
async function getCenters(req, res) {
  try {
    const [callRows, bookingRows] = await Promise.all([
      sheetsService.readSheet(CALL_LEADS_SHEET),
      sheetsService.readSheet(BOOKING_LEADS_SHEET),
    ]);

    const centersSet = new Set();

    callRows.slice(1).forEach(row => { if (row[1]) centersSet.add(row[1]); });
    bookingRows.slice(1).forEach(row => { if (row[1]) centersSet.add(row[1]); });

    const centers = ['ALL', ...Array.from(centersSet).sort()];
    return res.json({ success: true, data: centers });
  } catch (error) {
    console.error('Get centers error:', error);
    return res.status(500).json({ error: 'Failed to fetch centers' });
  }
}

/**
 * PATCH /api/leads/:type/:rowIndex
 * Updates status and/or feedback for a lead row.
 * Protected — CRM users only.
 * type: 'call' | 'booking'
 */
async function updateLead(req, res) {
  try {
    const { type, rowIndex } = req.params;
    const { status, feedback } = req.body;
    const row = parseInt(rowIndex, 10);

    if (!['call', 'booking'].includes(type)) {
      return res.status(400).json({ error: 'Invalid type. Must be call or booking.' });
    }
    if (!row || isNaN(row) || row < 2) {
      return res.status(400).json({ error: 'Invalid rowIndex.' });
    }

    const sheetName = type === 'call' ? CALL_LEADS_SHEET : BOOKING_LEADS_SHEET;
    // CallLeads:    status=col7, feedback=col8
    // BookingLeads: status=col9, feedback=col10
    const statusIdx   = type === 'call' ? 7 : 9;
    const feedbackIdx = type === 'call' ? 8 : 10;

    // Read the current row so we don't wipe existing columns
    const rows = await sheetsService.readSheet(sheetName);
    const existingRow = rows[row - 1] ? [...rows[row - 1]] : [];

    // Extend array if shorter than needed
    while (existingRow.length <= feedbackIdx) existingRow.push('');

    if (status !== undefined)  existingRow[statusIdx]   = status;
    if (feedback !== undefined) existingRow[feedbackIdx] = feedback;

    await sheetsService.updateRow(sheetName, row, existingRow);

    return res.json({ success: true, message: 'Lead updated successfully' });
  } catch (error) {
    console.error('Update lead error:', error);
    return res.status(500).json({ error: 'Failed to update lead' });
  }
}

module.exports = { submitLead, getCallLeads, getBookingLeads, getCenters, updateLead };
