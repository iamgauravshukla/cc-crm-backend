const sheetsService = require('../services/sheets.service');

/**
 * Get dashboard overview data
 * - Today's bookings from Intake sheet
 * - Yesterday vs Today comparison (revenue, bookings)
 */
async function getDashboardOverview(req, res) {
  try {
    // Read from Intake sheet (today's bookings)
    const intakeRows = await sheetsService.readSheet('Intake');
    
    if (intakeRows.length < 2) {
      return res.json({
        success: true,
        data: {
          todayBookings: [],
          comparison: {
            today: { bookings: 0, revenue: 0 },
            yesterday: { bookings: 0, revenue: 0 }
          }
        }
      });
    }

    // Parse all bookings
    const allBookings = intakeRows.slice(1).map((row, idx) => {
      // Parse price - remove peso sign and any non-numeric characters except decimal point
      let price = row[15] || '0';
      if (typeof price === 'string') {
        price = price.replace(/[^0-9.]/g, '');
      }
      const parsedPrice = parseFloat(price) || 0;
      
      return {
        recordId: row[34] || '',
        timestamp: row[0] || '',
        adInteracted: row[1] || '',
        branch: row[2] || '',
        status: row[3] || '',
        firstName: row[4] || '',
        lastName: row[5] || '',
        age: parseInt(row[6]) || 0,
        phone: row[7] || '',
        socialMedia: row[8] || '',
        email: row[9] || '',
        treatment: row[10] || '',
        area: row[11] || '',
        freebie: row[12] || '',
        date: row[13] || '',
        paymentMode: row[14] || '',
        totalPrice: parsedPrice,
        gender: row[16] || '',
        companionFirstName: row[17] || '',
        companionLastName: row[18] || '',
        companionAge: row[19] || '',
        companionFreebie: row[20] || '',
        companionTreatment: row[21] || '',
        companionGender: row[22] || '',
        companionPhone: row[25] || '',
        bookingDetails: row[23] || '',
        agent: row[24] || '',
        promoHunterStatus: row[30] || '',
        matchReason: row[31] || '',
        matchedSource: row[32] || '',
        matchedRow: row[33] || ''
      };
    });

    // Get today's date (start of day)
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Get yesterday's date
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    // Get tomorrow's date (end of today)
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Filter bookings for today and yesterday based on timestamp
    const todayBookings = [];
    const yesterdayBookings = [];

    allBookings.forEach(booking => {
      if (!booking.timestamp) return;

      try {
        // Parse timestamp - could be "01/26/2026 10:30:45" or similar
        const timestampDate = parseTimestamp(booking.timestamp);
        
        if (timestampDate) {
          if (timestampDate >= today && timestampDate < tomorrow) {
            todayBookings.push(booking);
          } else if (timestampDate >= yesterday && timestampDate < today) {
            yesterdayBookings.push(booking);
          }
        }
      } catch (error) {
        // Skip invalid timestamps
      }
    });

    // Calculate totals
    const todayStats = {
      bookings: todayBookings.length,
      revenue: todayBookings.reduce((sum, b) => sum + b.totalPrice, 0)
    };

    const yesterdayStats = {
      bookings: yesterdayBookings.length,
      revenue: yesterdayBookings.reduce((sum, b) => sum + b.totalPrice, 0)
    };

    // Calculate KPI metrics
    const avgBookingValue = todayStats.bookings > 0 ? todayStats.revenue / todayStats.bookings : 0;
    const yesterdayAvgValue = yesterdayStats.bookings > 0 ? yesterdayStats.revenue / yesterdayStats.bookings : 0;
    
    const completedToday = todayBookings.filter(b => b.status?.toLowerCase().includes('completed') || b.status?.toLowerCase().includes('bought')).length;
    const conversionRate = todayStats.bookings > 0 ? (completedToday / todayStats.bookings * 100) : 0;

    // Calculate percentage changes
    const bookingsChange = yesterdayStats.bookings > 0 
      ? ((todayStats.bookings - yesterdayStats.bookings) / yesterdayStats.bookings * 100) 
      : (todayStats.bookings > 0 ? 100 : 0);
    
    const revenueChange = yesterdayStats.revenue > 0 
      ? ((todayStats.revenue - yesterdayStats.revenue) / yesterdayStats.revenue * 100) 
      : (todayStats.revenue > 0 ? 100 : 0);

    // Top Performers Today
    const branchStats = {};
    const agentStats = {};
    const treatmentStats = {};

    todayBookings.forEach(b => {
      // Branch performance
      if (!branchStats[b.branch]) {
        branchStats[b.branch] = { name: b.branch, bookings: 0, revenue: 0 };
      }
      branchStats[b.branch].bookings++;
      branchStats[b.branch].revenue += b.totalPrice;

      // Agent performance
      if (b.agent) {
        if (!agentStats[b.agent]) {
          agentStats[b.agent] = { name: b.agent, bookings: 0, revenue: 0 };
        }
        agentStats[b.agent].bookings++;
        agentStats[b.agent].revenue += b.totalPrice;
      }

      // Treatment popularity
      if (b.treatment) {
        if (!treatmentStats[b.treatment]) {
          treatmentStats[b.treatment] = { name: b.treatment, count: 0 };
        }
        treatmentStats[b.treatment].count++;
      }
    });

    const topBranches = Object.values(branchStats)
      .sort((a, b) => b.bookings - a.bookings)
      .slice(0, 3)
      .map(b => ({ ...b, revenue: parseFloat(b.revenue.toFixed(2)) }));

    const topAgents = Object.values(agentStats)
      .sort((a, b) => b.bookings - a.bookings)
      .slice(0, 3)
      .map(a => ({ ...a, revenue: parseFloat(a.revenue.toFixed(2)) }));

    const topTreatments = Object.values(treatmentStats)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // Alerts & Notifications
    const highValueThreshold = 50000; // ₱50,000
    const highValueBookings = todayBookings.filter(b => b.totalPrice >= highValueThreshold);
    const cancelledBookings = todayBookings.filter(b => b.status?.toLowerCase().includes('cancelled') || b.status?.toLowerCase().includes('refund'));
    const newCustomers = todayBookings.filter(b => b.status?.toLowerCase().includes('new'));

    const alerts = {
      highValue: highValueBookings.map(b => ({
        customer: `${b.firstName} ${b.lastName}`,
        amount: parseFloat(b.totalPrice.toFixed(2)),
        treatment: b.treatment,
        branch: b.branch
      })),
      cancelled: cancelledBookings.map(b => ({
        customer: `${b.firstName} ${b.lastName}`,
        treatment: b.treatment,
        branch: b.branch,
        reason: b.bookingDetails
      })),
      promoHunters: todayBookings.filter(b => b.status?.toLowerCase().includes('promo hunter')).length,
      newCustomers: newCustomers.length
    };

    // Prevent caching to ensure fresh data on each request
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');

    res.json({
      success: true,
      data: {
        todayBookings: todayBookings.map(b => ({
          timestamp: b.timestamp,
          branch: b.branch,
          customer: `${b.firstName} ${b.lastName}`,
          age: b.age,
          gender: b.gender,
          phone: b.phone,
          email: b.email,
          socialMedia: b.socialMedia,
          treatment: b.treatment,
          area: b.area,
          freebie: b.freebie,
          date: b.date,
          paymentMode: b.paymentMode,
          price: b.totalPrice,
          agent: b.agent,
          bookingDetails: b.bookingDetails,
          companionName: b.companionFirstName && b.companionLastName ? `${b.companionFirstName} ${b.companionLastName}` : '',
          companionPhone: b.companionPhone || '',
          companionAge: b.companionAge || '',
          companionGender: b.companionGender || '',
          companionFreebie: b.companionFreebie || '',
          companionTreatment: b.companionTreatment || '',
          status: b.status,
          promoHunterStatus: b.promoHunterStatus,
          matchReason: b.matchReason,
          matchedSource: b.matchedSource,
          matchedRow: b.matchedRow
        })),
        kpis: {
          bookings: {
            today: todayStats.bookings,
            yesterday: yesterdayStats.bookings,
            change: parseFloat(bookingsChange.toFixed(1)),
            trend: bookingsChange >= 0 ? 'up' : 'down'
          },
          revenue: {
            today: parseFloat(todayStats.revenue.toFixed(2)),
            yesterday: parseFloat(yesterdayStats.revenue.toFixed(2)),
            change: parseFloat(revenueChange.toFixed(1)),
            trend: revenueChange >= 0 ? 'up' : 'down'
          },
          avgBookingValue: {
            today: parseFloat(avgBookingValue.toFixed(2)),
            yesterday: parseFloat(yesterdayAvgValue.toFixed(2))
          },
          conversionRate: parseFloat(conversionRate.toFixed(1))
        },
        topPerformers: {
          branches: topBranches,
          agents: topAgents,
          treatments: topTreatments
        },
        alerts,
        comparison: {
          today: {
            bookings: todayStats.bookings,
            revenue: parseFloat(todayStats.revenue.toFixed(2))
          },
          yesterday: {
            bookings: yesterdayStats.bookings,
            revenue: parseFloat(yesterdayStats.revenue.toFixed(2))
          }
        }
      }
    });

  } catch (error) {
    console.error('Error fetching dashboard data:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
}

function parseTimestamp(timestamp) {
  if (!timestamp) return null;

  try {
    // Handle ISO format first (2026-01-27T15:18:14.595Z)
    if (timestamp.includes('T') || timestamp.match(/^\d{4}-\d{2}-\d{2}/)) {
      const date = new Date(timestamp);
      return date && !isNaN(date.getTime()) ? date : null;
    }

    // Handle new format: "Feb 25 2026 3:59 AM"
    const monthNamePattern = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{4})\s+(\d{1,2}):(\d{2})\s+(AM|PM)$/;
    const monthMatch = timestamp.match(monthNamePattern);
    
    if (monthMatch) {
      const monthMap = {
        'Jan': 0, 'Feb': 1, 'Mar': 2, 'Apr': 3, 'May': 4, 'Jun': 5,
        'Jul': 6, 'Aug': 7, 'Sep': 8, 'Oct': 9, 'Nov': 10, 'Dec': 11
      };
      
      const month = monthMap[monthMatch[1]];
      const day = parseInt(monthMatch[2]);
      const year = parseInt(monthMatch[3]);
      let hours = parseInt(monthMatch[4]);
      const minutes = parseInt(monthMatch[5]);
      const ampm = monthMatch[6];
      
      // Convert to 24-hour format
      if (ampm === 'PM' && hours !== 12) {
        hours += 12;
      } else if (ampm === 'AM' && hours === 12) {
        hours = 0;
      }
      
      const date = new Date(year, month, day, hours, minutes);
      return date && !isNaN(date.getTime()) ? date : null;
    }

    // Handle various timestamp formats
    // "1/26/2026 10:30:45", "01/26/2026 10:30:45", "2026-01-26 10:30:45"
    
    let dateStr = timestamp;
    let timeStr = '';

    // Split date and time if present
    if (timestamp.includes(' ')) {
      [dateStr, timeStr] = timestamp.split(' ');
    }

    let date;

    if (dateStr.includes('/')) {
      // Format: MM/DD/YYYY or M/D/YYYY
      const parts = dateStr.split('/');
      if (parts.length === 3) {
        const month = parseInt(parts[0]) - 1;
        const day = parseInt(parts[1]);
        const year = parseInt(parts[2]);
        date = new Date(year, month, day);
      }
    } else if (dateStr.includes('-')) {
      // Format: YYYY-MM-DD
      date = new Date(dateStr);
    }

    // Add time if present
    if (date && timeStr) {
      const timeParts = timeStr.split(':');
      if (timeParts.length >= 2) {
        date.setHours(parseInt(timeParts[0]) || 0);
        date.setMinutes(parseInt(timeParts[1]) || 0);
        if (timeParts.length >= 3) {
          date.setSeconds(parseInt(timeParts[2]) || 0);
        }
      }
    }

    return date && !isNaN(date.getTime()) ? date : null;
  } catch (error) {
    return null;
  }
}

/**
 * Get booking trend data for last N days
 */
async function getBookingTrend(req, res) {
  try {
    const days = parseInt(req.query.days) || 20;

    // Read from DB Sheet (master bookings)
    const dbRows = await sheetsService.readSheet('DB');
    
    if (dbRows.length < 2) {
      return res.json({
        success: true,
        data: { dates: [], bookings: [] }
      });
    }


    const headers = dbRows[0];
    const mostRecentRow = dbRows[dbRows.length - 1]; // Last row = most recent
    
    for (let i = 0; i < Math.min(headers.length, mostRecentRow.length); i++) {
      const header = headers[i] || `Column ${i}`;
      const value = mostRecentRow[i] || '';
      console.log(`[${i.toString().padStart(2, '0')}] ${header.padEnd(30)} | "${value}"`);
    }


    // Parse all bookings - using Date column (appointment date)
    const allBookings = dbRows.slice(1).map((row, idx) => {
      const appointmentDate = row[3] || ''; // Date column at index 3
      return {
        date: appointmentDate
      };
    });
    
    console.log(`Total bookings in DB: ${allBookings.length}`);

    // Calculate date range
    const endDate = new Date();
    endDate.setHours(23, 59, 59, 999);
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - (days - 1));
    startDate.setHours(0, 0, 0, 0);

    // Create date buckets
    const dateBuckets = {};
    const dateLabels = [];
    
    for (let i = 0; i < days; i++) {
      const date = new Date(startDate);
      date.setDate(date.getDate() + i);
      const dateKey = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`;
      const dateLabel = `${date.getDate()} ${date.toLocaleString('default', { month: 'short' })}`;
      dateBuckets[dateKey] = 0;
      dateLabels.push(dateLabel);
    }

    // Count bookings per day
    let matchedCount = 0;
    allBookings.forEach(booking => {
      if (!booking.date) return;
      
      try {
        // Parse the date string (format: YYYY-MM-DD or MM/DD/YYYY)
        const bookingDate = parseDate(booking.date);
        if (bookingDate) {
          // Normalize the booking date to match bucket key format
          const normalizedDate = new Date(bookingDate);
          normalizedDate.setHours(0, 0, 0, 0);
          
          if (normalizedDate >= startDate && normalizedDate <= endDate) {
            const dateKey = `${normalizedDate.getFullYear()}-${(normalizedDate.getMonth() + 1).toString().padStart(2, '0')}-${normalizedDate.getDate().toString().padStart(2, '0')}`;
            if (dateBuckets.hasOwnProperty(dateKey)) {
              dateBuckets[dateKey]++;
              matchedCount++;
            }
          }
        }
      } catch (error) {
        // Skip invalid dates
      }
    });

    const bookingCounts = Object.values(dateBuckets);

    // Prevent caching to ensure fresh data on each request
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');

    res.json({
      success: true,
      data: {
        dates: dateLabels,
        bookings: bookingCounts
      }
    });

  } catch (error) {
    console.error('❌ Error fetching trend:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch booking trend'
    });
  }
}

function parseDate(dateStr) {
  if (!dateStr) return null;
  
  try {
    // Handle "Jan 25 2026  5:30 PM" format (most common in DB)
    if (dateStr.includes(' ')) {
      // Split by multiple spaces and filter empty strings
      const parts = dateStr.trim().split(/\s+/);
      if (parts.length >= 3) {
        const monthStr = parts[0]; // "Jan"
        const day = parseInt(parts[1]); // "25"
        const year = parseInt(parts[2]); // "2026"
        
        // Convert month name to number
        const months = {
          'jan': 0, 'feb': 1, 'mar': 2, 'apr': 3, 'may': 4, 'jun': 5,
          'jul': 6, 'aug': 7, 'sep': 8, 'oct': 9, 'nov': 10, 'dec': 11,
          'january': 0, 'february': 1, 'march': 2, 'april': 3, 'june': 5,
          'july': 6, 'august': 7, 'september': 8, 'october': 9, 'november': 10, 'december': 11
        };
        
        const month = months[monthStr.toLowerCase()];
        
        if (month !== undefined && !isNaN(day) && !isNaN(year)) {
          return new Date(year, month, day);
        }
      }
    }
    
    // Handle MM/DD/YYYY format
    if (dateStr.includes('/')) {
      const parts = dateStr.split('/');
      if (parts.length === 3) {
        const month = parseInt(parts[0]) - 1;
        const day = parseInt(parts[1]);
        const year = parseInt(parts[2]);
        return new Date(year, month, day);
      }
    }
    
    // Handle YYYY-MM-DD format
    if (dateStr.includes('-')) {
      const parts = dateStr.split('-');
      if (parts.length === 3) {
        const year = parseInt(parts[0]);
        const month = parseInt(parts[1]) - 1;
        const day = parseInt(parts[2]);
        return new Date(year, month, day);
      }
    }
    
    return null;
  } catch (error) {
    return null;
  }
}

module.exports = { getDashboardOverview, getBookingTrend };
