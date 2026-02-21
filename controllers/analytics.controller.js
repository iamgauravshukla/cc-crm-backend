const sheetsService = require('../services/sheets.service');
const { parseDateString, parsePrice, mapRowToBooking } = require('../utils/dataParser');

/**
 * Get comprehensive analytics for a specific branch or all branches
 * Query params: 
 *  - branch (optional - defaults to "All")
 *  - range (optional - "today", "week", "month", "quarter", "year", defaults to "year")
 */
async function getAnalytics(req, res) {
  try {
    const branch = req.query.branch || 'All';
    const range = req.query.range || 'year';
    const startDate = req.query.startDate;
    const endDate = req.query.endDate;

    // Read only from DB sheet (old bookings)
    const dbRows = await sheetsService.readSheet('DB');

    if (dbRows.length < 2) {
      return res.json({
        success: true,
        data: {
          branch,
          range,
          overview: {
            totalBookings: 0,
            totalRevenue: '0',
            avgBookingValue: '0',
            uniqueCustomers: 0,
            repeatCustomerRate: 0,
            statusBreakdown: {}
          },
          branchPerformance: [],
          treatmentAnalysis: [],
          revenueAnalysis: { byPaymentMode: [], byPriceRange: [] },
          agentPerformance: [],
          demographicAnalysis: { byGender: [], byAgeGroup: [] },
          timeSeriesData: { byMonth: [] },
          marketingChannels: []
        }
      });
    }

    // Skip header row
    const allBookings = dbRows.slice(1);

    // Filter by branch if not "All"
    let filteredBookings = allBookings;
    if (branch !== 'All') {
      filteredBookings = allBookings.filter(row => row[1] === branch);
    }

    // Parse bookings with proper structure - CORRECTED COLUMN MAPPING for 44-column DB sheet
    let bookings = filteredBookings.map((row, idx) => {
      // Parse price - remove peso sign and any non-numeric characters except decimal point
      let price = row[12] || '0';
      if (typeof price === 'string') {
        price = price.replace(/[^0-9.]/g, '');
      }
      const parsedPrice = parseFloat(price) || 0;
      
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
        totalPrice: parsedPrice,
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

    const totalBeforeFilter = bookings.length;

    // Filter by date range
    bookings = filterByDateRange(bookings, range, startDate, endDate);
    
    console.log(`Analytics - Range: ${range}, StartDate: ${startDate}, EndDate: ${endDate}`);
    console.log(`Analytics - Bookings before filter: ${totalBeforeFilter}, after filter: ${bookings.length}`);

    // Calculate analytics
    // For branch performance, use all parsed bookings (not filtered by branch)
    const allParsedBookings = filteredBookings.map((row) => {
      let price = row[12] || '0';
      if (typeof price === 'string') {
        price = price.replace(/[^0-9.]/g, '');
      }
      const parsedPrice = parseFloat(price) || 0;
      
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
        totalPrice: parsedPrice,
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
    
    const analytics = {
      branch,
      range: startDate && endDate ? `${startDate} to ${endDate}` : range,
      overview: calculateOverview(bookings),
      branchPerformance: branch === 'All' ? calculateBranchPerformance(filterByDateRange(allParsedBookings, range, startDate, endDate)) : [],
      treatmentAnalysis: calculateTreatmentAnalysis(bookings),
      revenueAnalysis: calculateRevenueAnalysis(bookings),
      agentPerformance: calculateAgentPerformance(bookings),
      demographicAnalysis: calculateDemographicAnalysis(bookings),
      timeSeriesData: calculateTimeSeriesData(bookings, range, startDate, endDate),
      marketingChannels: calculateMarketingChannels(bookings)
    };

    res.json({
      success: true,
      data: analytics
    });

  } catch (error) {
    console.error('Analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
}

function filterByDateRange(bookings, range, startDate, endDate) {
  // Handle custom date range
  if (startDate && endDate) {
    const start = new Date(startDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    return bookings.filter(b => {
      if (!b.date) return false;
      
      try {
        const bookingDate = parseDateString(b.date);
        if (bookingDate && !isNaN(bookingDate.getTime())) {
          return bookingDate >= start && bookingDate <= end;
        }
      } catch (err) {
        return false;
      }
      return false;
    });
  }

  // If range is 'year', just return all bookings (don't filter by date)
  // This ensures we get data even if dates are in weird formats
  if (range === 'year') {
    return bookings;
  }

  const now = new Date();
  // Reset time to start of day for accurate comparisons
  now.setHours(0, 0, 0, 0);
  
  let cutoffDate = new Date(now);

  switch(range) {
    case 'today':
      // cutoffDate is already set to start of today
      break;
    case 'week':
      // Go back 7 days from today
      cutoffDate.setDate(cutoffDate.getDate() - 7);
      break;
    case 'month':
      // Go back 30 days from today
      cutoffDate.setDate(cutoffDate.getDate() - 30);
      break;
    case 'quarter':
      // Go back 90 days from today
      cutoffDate.setDate(cutoffDate.getDate() - 90);
      break;
    default:
      // For any unknown range, return all bookings
      return bookings;
  }

  let debugCount = 0;
  const filtered = bookings.filter(b => {
    if (!b.date) {
      // If no date, exclude it from filtered results
      return false;
    }
    
    try {
      const bookingDate = parseDateString(b.date);
      
      if (bookingDate && !isNaN(bookingDate.getTime())) {
        const isInRange = bookingDate >= cutoffDate;
        // Debug: Log first 3 comparisons
        if (debugCount < 3) {
          console.log(`Date comparison - Booking: ${b.date}, Parsed: ${bookingDate.toISOString()}, Cutoff: ${cutoffDate.toISOString()}, InRange: ${isInRange}`);
          debugCount++;
        }
        return isInRange;
      }
      
      // If we couldn't parse the date, exclude it
      return false;
    } catch (error) {
      // If error parsing, exclude it
      return false;
    }
  });

  console.log(`FilterByDateRange - Range: ${range}, Filtered: ${filtered.length} of ${bookings.length}`);
  return filtered;
}

function calculateOverview(bookings) {
    const totalBookings = bookings.length;
    const totalRevenue = bookings.reduce((sum, b) => sum + b.totalPrice, 0);
    const avgBookingValue = totalBookings > 0 ? totalRevenue / totalBookings : 0;
    
    const statusCounts = {};
    bookings.forEach(b => {
      statusCounts[b.status] = (statusCounts[b.status] || 0) + 1;
    });

    const uniqueCustomers = new Set(bookings.map(b => b.email.toLowerCase())).size;
    const repeatCustomerRate = totalBookings > 0 
      ? ((totalBookings - uniqueCustomers) / totalBookings * 100).toFixed(1)
      : 0;

    return {
      totalBookings,
      totalRevenue: totalRevenue.toFixed(2),
      avgBookingValue: avgBookingValue.toFixed(2),
      uniqueCustomers,
      repeatCustomerRate: parseFloat(repeatCustomerRate),
      statusBreakdown: statusCounts
    };
}

function calculateBranchPerformance(bookings) {
    const branches = {};
    
    bookings.forEach(booking => {
      const branch = booking.branch || 'Unknown';
      
      if (!branches[branch]) {
        branches[branch] = {
          name: branch,
          bookings: 0,
          revenue: 0
        };
      }
      
      branches[branch].bookings++;
      branches[branch].revenue += booking.totalPrice;
    });

    return Object.values(branches)
      .map(b => ({
        ...b,
        revenue: parseFloat(b.revenue.toFixed(2)),
        avgBookingValue: parseFloat((b.revenue / b.bookings).toFixed(2))
      }))
      .sort((a, b) => b.revenue - a.revenue);
}

function calculateTreatmentAnalysis(bookings) {
    const treatments = {};
    
    bookings.forEach(b => {
      const treatment = b.treatment || 'Unknown';
      
      if (!treatments[treatment]) {
        treatments[treatment] = {
          name: treatment,
          count: 0,
          revenue: 0
        };
      }
      
      treatments[treatment].count++;
      treatments[treatment].revenue += b.totalPrice;
    });

    return Object.values(treatments)
      .map(t => ({
        ...t,
        revenue: parseFloat(t.revenue.toFixed(2)),
        avgPrice: parseFloat((t.revenue / t.count).toFixed(2))
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15); // Top 15 treatments
}

function calculateRevenueAnalysis(bookings) {
    const byPaymentMode = {};
    
    bookings.forEach(b => {
      const mode = b.paymentMode || 'Unknown';
      byPaymentMode[mode] = (byPaymentMode[mode] || 0) + b.totalPrice;
    });

    const paymentModes = Object.entries(byPaymentMode).map(([mode, revenue]) => ({
      mode,
      revenue: parseFloat(revenue.toFixed(2))
    })).sort((a, b) => b.revenue - a.revenue);

    // Revenue by price range
    const priceRanges = {
      '0-1000': 0,
      '1001-2000': 0,
      '2001-3000': 0,
      '3001-5000': 0,
      '5000+': 0
    };

    bookings.forEach(b => {
      const price = b.totalPrice;
      if (price <= 1000) priceRanges['0-1000']++;
      else if (price <= 2000) priceRanges['1001-2000']++;
      else if (price <= 3000) priceRanges['2001-3000']++;
      else if (price <= 5000) priceRanges['3001-5000']++;
      else priceRanges['5000+']++;
    });

    return {
      byPaymentMode: paymentModes,
      byPriceRange: Object.entries(priceRanges).map(([range, count]) => ({
        range,
        count
      }))
    };
}

function calculateAgentPerformance(bookings) {
    const agents = {};
    
    bookings.forEach(b => {
      const agent = b.agent || 'Unknown';
      
      if (!agents[agent]) {
        agents[agent] = {
          name: agent,
          bookings: 0,
          revenue: 0
        };
      }
      
      agents[agent].bookings++;
      agents[agent].revenue += b.totalPrice;
    });

    return Object.values(agents)
      .map(a => ({
        ...a,
        revenue: parseFloat(a.revenue.toFixed(2)),
        avgBookingValue: parseFloat((a.revenue / a.bookings).toFixed(2))
      }))
      .sort((a, b) => b.revenue - a.revenue);
}

function calculateDemographicAnalysis(bookings) {
    const byGender = {};
    const byAgeGroup = {
      '18-25': 0,
      '26-35': 0,
      '36-45': 0,
      '46-55': 0,
      '56+': 0
    };

    bookings.forEach(b => {
      // Gender
      const gender = b.gender || 'Unknown';
      byGender[gender] = (byGender[gender] || 0) + 1;

      // Age group
      const age = b.age;
      if (age >= 18 && age <= 25) byAgeGroup['18-25']++;
      else if (age >= 26 && age <= 35) byAgeGroup['26-35']++;
      else if (age >= 36 && age <= 45) byAgeGroup['36-45']++;
      else if (age >= 46 && age <= 55) byAgeGroup['46-55']++;
      else if (age >= 56) byAgeGroup['56+']++;
    });

    return {
      byGender: Object.entries(byGender).map(([gender, count]) => ({
        gender,
        count
      })),
      byAgeGroup: Object.entries(byAgeGroup).map(([ageGroup, count]) => ({
        ageGroup,
        count
      }))
    };
}

function calculateTimeSeriesData(bookings, range, startDate, endDate) {
    if (bookings.length === 0) {
      return { byMonth: [] };
    }
    
    const monthNamesFull = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    
    // Determine grouping based on date range span
    let daySpan;
    let groupByDay = false;
    let groupByWeek = false;
    let groupByMonth = false;
    
    if (startDate && endDate) {
      // Custom date range - calculate span
      const start = new Date(startDate);
      const end = new Date(endDate);
      daySpan = Math.ceil((end - start) / (1000 * 60 * 60 * 24));
      
      if (daySpan <= 31) {
        groupByDay = true;
      } else if (daySpan <= 90) {
        groupByWeek = true;
      } else {
        groupByMonth = true;
      }
    } else {
      // Preset ranges
      switch(range) {
        case 'today':
        case 'week':
        case 'month':
          groupByDay = true;
          daySpan = range === 'today' ? 1 : range === 'week' ? 7 : 30;
          break;
        case 'quarter':
          groupByWeek = true;
          daySpan = 90;
          break;
        case 'year':
        default:
          groupByMonth = true;
          daySpan = 365;
          break;
      }
    }
    
    const timeSeriesData = {};
    
    bookings.forEach(b => {
      if (!b.date) return;
      
      try {
        const bookingDate = parseDateString(b.date);
        if (!bookingDate || isNaN(bookingDate.getTime())) return;
        
        let key;
        let label;
        
        if (groupByDay) {
          // Group by day: "Jan 28"
          const day = bookingDate.getDate();
          const month = monthNamesFull[bookingDate.getMonth()];
          const year = bookingDate.getFullYear();
          key = `${year}-${(bookingDate.getMonth() + 1).toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
          label = `${month} ${day}`;
        } else if (groupByWeek) {
          // Group by week: "Week of Jan 21"
          const weekStart = new Date(bookingDate);
          weekStart.setDate(bookingDate.getDate() - bookingDate.getDay()); // Start of week (Sunday)
          const month = monthNamesFull[weekStart.getMonth()];
          const day = weekStart.getDate();
          const year = weekStart.getFullYear();
          key = `${year}-${(weekStart.getMonth() + 1).toString().padStart(2, '0')}-W${Math.ceil(day / 7)}`;
          label = `Week of ${month} ${day}`;
        } else {
          // Group by month: "Jan 2026"
          const month = monthNamesFull[bookingDate.getMonth()];
          const year = bookingDate.getFullYear();
          key = `${year}-${(bookingDate.getMonth() + 1).toString().padStart(2, '0')}`;
          label = `${month} ${year}`;
        }
        
        if (!timeSeriesData[key]) {
          timeSeriesData[key] = { 
            key,
            label,
            count: 0, 
            revenue: 0,
            sortDate: bookingDate.getTime()
          };
        }
        
        timeSeriesData[key].count++;
        timeSeriesData[key].revenue += b.totalPrice;
      } catch (error) {
        // Skip invalid dates
      }
    });

    // Convert to array and sort by date
    const sortedData = Object.values(timeSeriesData)
      .sort((a, b) => a.sortDate - b.sortDate)
      .map(item => ({
        month: item.label, // Keep property name as "month" for backwards compatibility
        count: item.count,
        revenue: parseFloat(item.revenue.toFixed(2))
      }));

    return {
      byMonth: sortedData
    };
}

function calculateMarketingChannels(bookings) {
    const channels = {};
    
    bookings.forEach(b => {
      // Use socialMedia field (Instagram, Facebook, etc.) as marketing channel
      const channel = b.socialMedia || 'Unknown';
      
      if (!channels[channel]) {
        channels[channel] = {
          channel,
          bookings: 0,
          revenue: 0
        };
      }
      
      channels[channel].bookings++;
      channels[channel].revenue += b.totalPrice;
    });

    return Object.values(channels)
      .map(c => ({
        ...c,
        revenue: parseFloat(c.revenue.toFixed(2)),
        conversionValue: parseFloat((c.revenue / c.bookings).toFixed(2))
      }))
      .sort((a, b) => b.bookings - a.bookings);
}

/**
 * Get agent performance metrics
 * Query params:
 *  - days (optional - defaults to 30)
 */
async function getAgentPerformance(req, res) {
  try {
    const days = parseInt(req.query.days) || 30;
    const startDate = req.query.startDate;
    const endDate = req.query.endDate;
    
    // Read from DB sheet
    const dbRows = await sheetsService.readSheet('DB');
    
    if (dbRows.length < 2) {
      return res.json({
        success: true,
        data: {
          summary: {
            totalAgents: 0,
            totalBookings: 0,
            totalRevenue: 0,
            avgConversion: 0
          },
          agents: []
        }
      });
    }

    // Calculate date threshold or use custom dates
    let filterFunction;
    
    if (startDate && endDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      
      filterFunction = (dateStr) => {
        if (!dateStr) return false;
        try {
          const bookingDate = parseDateString(dateStr);
          return bookingDate && !isNaN(bookingDate.getTime()) && bookingDate >= start && bookingDate <= end;
        } catch {
          return false;
        }
      };
    } else {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days);
      
      filterFunction = (dateStr) => {
        if (!dateStr) return false;
        try {
          const bookingDate = parseDateString(dateStr);
          return bookingDate && !isNaN(bookingDate.getTime()) && bookingDate >= cutoffDate;
        } catch {
          return false;
        }
      };
    }

    // Parse bookings with date filter
    const recentBookings = dbRows.slice(1).filter(row => {
      return filterFunction(row[3]); // row[3] is the date column
    }).map(row => {
      // Parse price - remove peso sign and any non-numeric characters except decimal point
      let price = row[12] || '0';
      if (typeof price === 'string') {
        price = price.replace(/[^0-9.]/g, '');
      }
      const parsedPrice = parseFloat(price) || 0;
      
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
        totalPrice: parsedPrice,
        paymentMode: row[13] || '',
        phone: row[14] || '',
        socialMedia: row[15] || '',
        email: row[16] || '',
        agent: row[17] || '',
        bookingDetails: row[18] || '',
        adInteracted: row[19] || '',
        promoHunterStatus: row[30] || ''
      };
    });

    console.log(`\n========== AGENT PERFORMANCE DEBUG ==========`);
    console.log(`Date range: Last ${days} days`);
    console.log(`Total recent bookings: ${recentBookings.length}`);
    if (recentBookings.length > 0) {
      console.log('Sample booking:', {
        agent: recentBookings[0].agent,
        treatment: recentBookings[0].treatment,
        totalPrice: recentBookings[0].totalPrice,
        status: recentBookings[0].status,
        rawPrice: dbRows[1][12]
      });
      console.log('Agents found:', [...new Set(recentBookings.map(b => b.agent))]);
      console.log('Total revenue sum:', recentBookings.reduce((sum, b) => sum + b.totalPrice, 0));
    }
    console.log('=========================================\n');

    // Group by agent
    const agentStats = {};
    
    recentBookings.forEach(booking => {
      const agent = booking.agent || 'Unknown';
      
      if (!agentStats[agent]) {
        agentStats[agent] = {
          name: agent,
          bookings: 0,
          revenue: 0,
          converted: 0,
          scheduled: 0,
          cancelled: 0,
          promoHunters: 0,
          treatments: {},
          branches: {}
        };
      }
      
      const stats = agentStats[agent];
      stats.bookings++;
      stats.revenue += booking.totalPrice;
      
      // Track status
      const statusLower = booking.status.toLowerCase();
      if (statusLower.includes('bought') || statusLower.includes('completed')) {
        stats.converted++;
      } else if (statusLower === 'scheduled') {
        stats.scheduled++;
      } else if (statusLower === 'cancelled') {
        stats.cancelled++;
      }
      
      // Track promo hunters
      if (statusLower === 'promo hunter' || booking.promoHunterStatus) {
        stats.promoHunters++;
      }
      
      // Track treatments
      if (booking.treatment) {
        stats.treatments[booking.treatment] = (stats.treatments[booking.treatment] || 0) + 1;
      }
      
      // Track branches
      if (booking.branch) {
        stats.branches[booking.branch] = (stats.branches[booking.branch] || 0) + 1;
      }
    });

    // Calculate metrics for each agent
    const agents = Object.values(agentStats).map(agent => {
      const conversionRate = agent.bookings > 0 
        ? (agent.converted / agent.bookings * 100) 
        : 0;
      
      const avgBookingValue = agent.bookings > 0 
        ? agent.revenue / agent.bookings 
        : 0;
      
      // Get top treatment
      const topTreatment = Object.entries(agent.treatments)
        .sort((a, b) => b[1] - a[1])[0];
      
      // Get top branch
      const topBranch = Object.entries(agent.branches)
        .sort((a, b) => b[1] - a[1])[0];
      
      // Get treatment list
      const treatments = Object.entries(agent.treatments)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);
      
      return {
        name: agent.name,
        bookings: agent.bookings,
        revenue: parseFloat(agent.revenue.toFixed(2)),
        avgBookingValue: parseFloat(avgBookingValue.toFixed(2)),
        conversionRate: parseFloat(conversionRate.toFixed(2)),
        converted: agent.converted,
        scheduled: agent.scheduled,
        cancelled: agent.cancelled,
        promoHunters: agent.promoHunters,
        topTreatment: topTreatment ? topTreatment[0] : null,
        topBranch: topBranch ? topBranch[0] : null,
        treatments: treatments
      };
    }).sort((a, b) => b.revenue - a.revenue);

    // Calculate summary
    const summary = {
      totalAgents: agents.length,
      totalBookings: agents.reduce((sum, a) => sum + a.bookings, 0),
      totalRevenue: parseFloat(agents.reduce((sum, a) => sum + a.revenue, 0).toFixed(2)),
      avgConversion: agents.length > 0 
        ? parseFloat((agents.reduce((sum, a) => sum + a.conversionRate, 0) / agents.length).toFixed(2))
        : 0
    };

    // Build date range response
    let dateRangeResponse;
    if (startDate && endDate) {
      dateRangeResponse = {
        from: new Date(startDate).toISOString(),
        to: new Date(endDate).toISOString(),
        custom: true
      };
    } else {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days);
      dateRangeResponse = {
        from: cutoffDate.toISOString(),
        to: new Date().toISOString(),
        days
      };
    }

    res.json({
      success: true,
      data: {
        summary,
        agents,
        dateRange: dateRangeResponse
      }
    });

  } catch (error) {
    console.error('Error fetching agent performance:', error);
    res.status(500).json({ error: 'Failed to fetch agent performance data' });
  }
}

// Get Ad Performance Analytics
async function getAdPerformance(req, res) {
  try {
    const days = parseInt(req.query.days) || 30;
    const startDate = req.query.startDate;
    const endDate = req.query.endDate;
    const branch = req.query.branch;
    
    // Read from Master DB sheet
    const rows = await sheetsService.readSheet('DB');
    
    if (rows.length < 2) {
      return res.json({
        success: true,
        data: {
          summary: {
            totalAds: 0,
            totalBookings: 0,
            totalRevenue: 0,
            avgConversionRate: 0
          },
          ads: []
        }
      });
    }

    // Parse all bookings from DB sheet (44 columns)
    let allBookings = rows.slice(1).map((row) => {
      let price = row[12] || '0';
      if (typeof price === 'string') {
        price = price.replace(/[^0-9.]/g, '');
      }

      return {
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
    }).filter(booking => booking.adInteracted && booking.adInteracted.trim() !== '');

    // Filter by date range
    if (startDate && endDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      
      allBookings = allBookings.filter(booking => {
        if (!booking.date) return false;
        try {
          const bookingDate = parseDateString(booking.date);
          return bookingDate && !isNaN(bookingDate.getTime()) && bookingDate >= start && bookingDate <= end;
        } catch {
          return false;
        }
      });
    } else if (days) {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days);
      
      allBookings = allBookings.filter(booking => {
        if (!booking.date) return false;
        try {
          const bookingDate = parseDateString(booking.date);
          return bookingDate && !isNaN(bookingDate.getTime()) && bookingDate >= cutoffDate;
        } catch {
          return false;
        }
      });
    }

    // Filter by branch if specified
    if (branch && branch !== 'All') {
      allBookings = allBookings.filter(booking => booking.branch === branch);
    }

    console.log('Total bookings with ads:', allBookings.length);

    // Group by ad name
    const adMap = {};

    allBookings.forEach(booking => {
      const adName = booking.adInteracted.trim();
      
      if (!adMap[adName]) {
        adMap[adName] = {
          adName,
          totalBookings: 0,
          convertedBookings: 0,
          totalRevenue: 0,
          branches: {},
          treatments: {},
          bookings: []
        };
      }

      adMap[adName].totalBookings++;
      adMap[adName].bookings.push(booking);
      
      // Count conversions (statuses that indicate successful booking)
      const statusLower = (booking.status || '').toLowerCase();
      if (statusLower.includes('bought') || statusLower.includes('arrived')) {
        adMap[adName].convertedBookings++;
        adMap[adName].totalRevenue += booking.totalPrice;
      }

      // Track branches
      if (booking.branch) {
        adMap[adName].branches[booking.branch] = (adMap[adName].branches[booking.branch] || 0) + 1;
      }

      // Track treatments
      if (booking.treatment) {
        adMap[adName].treatments[booking.treatment] = (adMap[adName].treatments[booking.treatment] || 0) + 1;
      }
    });

    // Convert to array and calculate metrics
    const ads = Object.values(adMap).map(ad => {
      const conversionRate = ad.totalBookings > 0 
        ? (ad.convertedBookings / ad.totalBookings) * 100 
        : 0;

      const avgRevenuePerBooking = ad.convertedBookings > 0
        ? ad.totalRevenue / ad.convertedBookings
        : 0;

      // Find top branch
      const topBranch = Object.keys(ad.branches).length > 0
        ? Object.entries(ad.branches).sort((a, b) => b[1] - a[1])[0][0]
        : null;

      // Find top treatment
      const topTreatment = Object.keys(ad.treatments).length > 0
        ? Object.entries(ad.treatments).sort((a, b) => b[1] - a[1])[0][0]
        : null;

      return {
        adName: ad.adName,
        totalBookings: ad.totalBookings,
        convertedBookings: ad.convertedBookings,
        conversionRate: parseFloat(conversionRate.toFixed(2)),
        totalRevenue: parseFloat(ad.totalRevenue.toFixed(2)),
        avgRevenuePerBooking: parseFloat(avgRevenuePerBooking.toFixed(2)),
        topBranch,
        topTreatment
      };
    });

    console.log('Total unique ads:', ads.length);

    // Calculate summary
    const summary = {
      totalAds: ads.length,
      totalBookings: ads.reduce((sum, ad) => sum + ad.totalBookings, 0),
      totalRevenue: parseFloat(ads.reduce((sum, ad) => sum + ad.totalRevenue, 0).toFixed(2)),
      avgConversionRate: ads.length > 0
        ? parseFloat((ads.reduce((sum, ad) => sum + ad.conversionRate, 0) / ads.length).toFixed(2))
        : 0
    };

    res.json({
      success: true,
      data: {
        summary,
        ads
      }
    });

  } catch (error) {
    console.error('Error fetching ad performance:', error);
    res.status(500).json({ error: 'Failed to fetch ad performance data' });
  }
}

/**
 * Get comprehensive sales report
 * Query params:
 *  - startDate (optional): YYYY-MM-DD (requires endDate)
 *  - endDate (optional): YYYY-MM-DD (requires startDate)
 *  - timeRange (optional): "30days", "60days", "90days", "6months", "1year" (default: "6months")
 *  - branch (optional): specific branch name or "all" (default: "all")
 */
async function getSalesReport(req, res) {
  try {
    let timeRange = req.query.timeRange || '6months';
    const selectedBranch = req.query.branch || 'all';
    const startDateParam = req.query.startDate;
    const endDateParam = req.query.endDate;
    const dbRows = await sheetsService.readSheet('DB');

    if (dbRows.length < 2) {
      return res.json({
        success: true,
        data: {
          timeRange,
          branch: selectedBranch,
          arrivalRate: 0,
          totalArrivals: 0,
          totalBookings: 0,
          arrivalRateByBranch: [],
          rangeSales: { overall: 0, byBranch: [] },
          previousRangeSales: { overall: 0, byBranch: [] },
          rangeFirstHalfSales: { overall: 0, byBranch: [] },
          rangeSecondHalfSales: { overall: 0, byBranch: [] },
          dailySalesAndBookings: [],
          dailySales: { overall: 0, byBranch: [] },
          firstHalfSales: { overall: 0, byBranch: [] },
          secondHalfSales: { overall: 0, byBranch: [] },
          currentMonthSales: { overall: 0, byBranch: [] },
          lastMonthSales: { overall: 0, byBranch: [] },
          yearlySales: { overall: 0, monthlyBreakdown: [] },
          monthlySalesAndBookings: []
        }
      });
    }

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();

    // Calculate date range based on start/end dates or timeRange parameter
    let startDate;
    let endDate = now;

    if (startDateParam && endDateParam) {
      const parsedStart = new Date(startDateParam);
      const parsedEnd = new Date(endDateParam);
      if (!isNaN(parsedStart.getTime()) && !isNaN(parsedEnd.getTime())) {
        startDate = parsedStart;
        endDate = parsedEnd;
        startDate.setHours(0, 0, 0, 0);
        endDate.setHours(23, 59, 59, 999);
        timeRange = 'custom';
      }
    }

    if (!startDate) {
      switch (timeRange) {
        case '30days':
          startDate = new Date(now);
          startDate.setDate(startDate.getDate() - 30);
          break;
        case '60days':
          startDate = new Date(now);
          startDate.setDate(startDate.getDate() - 60);
          break;
        case 'thisMonth':
          startDate = new Date(now.getFullYear(), now.getMonth(), 1);
          break;
        case '90days':
          startDate = new Date(now.getTime() - (90 * 24 * 60 * 60 * 1000));
          break;
        case '6months':
          startDate = new Date(now);
          startDate.setMonth(startDate.getMonth() - 6);
          break;
        case '1year':
          startDate = new Date(now);
          startDate.setFullYear(startDate.getFullYear() - 1);
          break;
        default:
              startDate = new Date(now);
          startDate.setMonth(startDate.getMonth() - 6);
      }
    }

            startDate.setHours(0, 0, 0, 0);

            const rangeDurationMs = endDate.getTime() - startDate.getTime();
            const previousRangeEnd = new Date(startDate.getTime() - 1);
            const previousRangeStart = new Date(previousRangeEnd.getTime() - rangeDurationMs);
            const rangeMidpoint = new Date(startDate.getTime() + Math.floor(rangeDurationMs / 2));

    // Initialize accumulators
    let dailySales = { overall: 0, byBranch: {} };
    let firstHalfSales = { overall: 0, byBranch: {} };
    let secondHalfSales = { overall: 0, byBranch: {} };
    let rangeSales = { overall: 0, byBranch: {} };
    let previousRangeSales = { overall: 0, byBranch: {} };
    let currentMonthSales = { overall: 0, byBranch: {} };
    let lastMonthSales = { overall: 0, byBranch: {} };
    let yearlySales = { overall: 0, monthlyBreakdown: {} };
    let monthlySalesData = {}; // Months within range
    let dailySalesData = {}; // Days within range
    let totalArrivals = 0;
    let totalBookings = 0;
    let arrivalsByBranch = {};
    let bookingsByBranch = {};
    const arrivalStatuses = new Set([
      'Arrived not potential',
      'Arrived & bought',
      'Comeback & bought'
    ]);
    const formatDateKey = (date) => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };

    // Process each booking (skip header row)
    for (let i = 1; i < dbRows.length; i++) {
      const row = dbRows[i];
      
      const branch = row[1];
      const status = row[2];
      const dateStr = row[3]; // Date column
      const price = parsePrice(row[12]); // Total price column M (index 12)

      // Filter by branch if specified (not "all")
      if (selectedBranch !== 'all' && branch !== selectedBranch) continue;

      // Parse booking date
      const bookingDate = parseDateString(dateStr);
      if (!bookingDate || isNaN(bookingDate.getTime())) continue;

      if (bookingDate >= startDate && bookingDate <= endDate) {
        totalBookings += 1;
        bookingsByBranch[branch] = (bookingsByBranch[branch] || 0) + 1;
        if (arrivalStatuses.has(status)) {
          totalArrivals += 1;
          arrivalsByBranch[branch] = (arrivalsByBranch[branch] || 0) + 1;
        }
      }

      // Only count ACTUAL SALES: "Arrived & bought" or "Comeback & bought"
      if (status !== 'Arrived & bought' && status !== 'Comeback & bought') continue;

      // Range sales totals
      if (bookingDate >= startDate && bookingDate <= endDate) {
        rangeSales.overall += price;
        rangeSales.byBranch[branch] = (rangeSales.byBranch[branch] || 0) + price;
      }

      if (bookingDate >= previousRangeStart && bookingDate <= previousRangeEnd) {
        previousRangeSales.overall += price;
        previousRangeSales.byBranch[branch] = (previousRangeSales.byBranch[branch] || 0) + price;
      }

      // Filter by time range
      if (bookingDate < startDate || bookingDate > endDate) continue;

      const bookingYear = bookingDate.getFullYear();
      const bookingMonth = bookingDate.getMonth();
      const bookingDay = bookingDate.getDate();

      // Daily Sales (today)
      if (bookingDate >= today && bookingDate < new Date(today.getTime() + 86400000)) {
        dailySales.overall += price;
        dailySales.byBranch[branch] = (dailySales.byBranch[branch] || 0) + price;
      }

      // Range split (first half / second half)
      if (bookingDate <= rangeMidpoint) {
        firstHalfSales.overall += price;
        firstHalfSales.byBranch[branch] = (firstHalfSales.byBranch[branch] || 0) + price;
      } else {
        secondHalfSales.overall += price;
        secondHalfSales.byBranch[branch] = (secondHalfSales.byBranch[branch] || 0) + price;
      }

      // Last Month Sales
      const lastMonth = currentMonth === 0 ? 11 : currentMonth - 1;
      const lastMonthYear = currentMonth === 0 ? currentYear - 1 : currentYear;
      if (bookingYear === lastMonthYear && bookingMonth === lastMonth) {
        lastMonthSales.overall += price;
        lastMonthSales.byBranch[branch] = (lastMonthSales.byBranch[branch] || 0) + price;
      }

      // Yearly Sales (current year)
      if (bookingYear === currentYear) {
        yearlySales.overall += price;
        const monthKey = bookingMonth;
        if (!yearlySales.monthlyBreakdown[monthKey]) {
          yearlySales.monthlyBreakdown[monthKey] = { sales: 0, bookings: 0 };
        }
        yearlySales.monthlyBreakdown[monthKey].sales += price;
        yearlySales.monthlyBreakdown[monthKey].bookings += 1;
      }

      // Monthly Sales & Bookings (within time range)
      const monthYearKey = `${bookingYear}-${bookingMonth}`;
      if (!monthlySalesData[monthYearKey]) {
        monthlySalesData[monthYearKey] = { year: bookingYear, month: bookingMonth, sales: 0, bookings: 0 };
      }
      monthlySalesData[monthYearKey].sales += price;
      monthlySalesData[monthYearKey].bookings += 1;

      // Daily Sales & Bookings (within time range)
      const dayKey = formatDateKey(bookingDate);
      if (!dailySalesData[dayKey]) {
        dailySalesData[dayKey] = { date: dayKey, sales: 0, bookings: 0 };
      }
      dailySalesData[dayKey].sales += price;
      dailySalesData[dayKey].bookings += 1;
    }

    // Format byBranch data
    const formatBranchData = (branchObj) => {
      return Object.keys(branchObj).map(branch => ({
        branch,
        sales: Math.round(branchObj[branch] * 100) / 100
      })).sort((a, b) => b.sales - a.sales);
    };

    // Format monthly breakdown for yearly sales
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthlyBreakdownArray = [];
    for (let i = 0; i < 12; i++) {
      const data = yearlySales.monthlyBreakdown[i] || { sales: 0, bookings: 0 };
      monthlyBreakdownArray.push({
        month: monthNames[i],
        sales: Math.round(data.sales * 100) / 100,
        bookings: data.bookings
      });
    }

    // Format monthly data across selected range
    const monthlySalesArray = [];
    const rangeMonthStart = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
    const rangeMonthEnd = new Date(endDate.getFullYear(), endDate.getMonth(), 1);
    const cursor = new Date(rangeMonthStart);

    while (cursor <= rangeMonthEnd) {
      const targetYear = cursor.getFullYear();
      const targetMonth = cursor.getMonth();
      const key = `${targetYear}-${targetMonth}`;
      const data = monthlySalesData[key] || { sales: 0, bookings: 0 };

      monthlySalesArray.push({
        month: `${monthNames[targetMonth]} ${targetYear}`,
        sales: Math.round(data.sales * 100) / 100,
        bookings: data.bookings
      });

      cursor.setMonth(cursor.getMonth() + 1);
    }

    // Format daily data across selected range
    const dailySalesArray = [];
    const dayCursor = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
    const dayEnd = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
    while (dayCursor <= dayEnd) {
      const key = formatDateKey(dayCursor);
      const data = dailySalesData[key] || { date: key, sales: 0, bookings: 0 };
      dailySalesArray.push({
        date: data.date,
        sales: Math.round(data.sales * 100) / 100,
        bookings: data.bookings
      });
      dayCursor.setDate(dayCursor.getDate() + 1);
    }

    res.json({
      success: true,
      data: {
        timeRange,
        branch: selectedBranch,
        arrivalRate: totalBookings > 0 ? Math.round((totalArrivals / totalBookings) * 10000) / 100 : 0,
        totalArrivals,
        totalBookings,
        arrivalRateByBranch: Object.keys(bookingsByBranch).map((branch) => {
          const bookings = bookingsByBranch[branch] || 0;
          const arrivals = arrivalsByBranch[branch] || 0;
          return {
            branch,
            bookings,
            arrivals,
            arrivalRate: bookings > 0 ? Math.round((arrivals / bookings) * 10000) / 100 : 0
          };
        }).sort((a, b) => b.arrivalRate - a.arrivalRate),
        rangeSales: {
          overall: Math.round(rangeSales.overall * 100) / 100,
          byBranch: formatBranchData(rangeSales.byBranch)
        },
        previousRangeSales: {
          overall: Math.round(previousRangeSales.overall * 100) / 100,
          byBranch: formatBranchData(previousRangeSales.byBranch)
        },
        rangeFirstHalfSales: {
          overall: Math.round(firstHalfSales.overall * 100) / 100,
          byBranch: formatBranchData(firstHalfSales.byBranch)
        },
        rangeSecondHalfSales: {
          overall: Math.round(secondHalfSales.overall * 100) / 100,
          byBranch: formatBranchData(secondHalfSales.byBranch)
        },
        dailySalesAndBookings: dailySalesArray,
        dailySales: {
          overall: Math.round(dailySales.overall * 100) / 100,
          byBranch: formatBranchData(dailySales.byBranch)
        },
        currentMonthSales: {
          overall: Math.round(currentMonthSales.overall * 100) / 100,
          byBranch: formatBranchData(currentMonthSales.byBranch)
        },
        lastMonthSales: {
          overall: Math.round(lastMonthSales.overall * 100) / 100,
          byBranch: formatBranchData(lastMonthSales.byBranch)
        },
        yearlySales: {
          overall: Math.round(yearlySales.overall * 100) / 100,
          monthlyBreakdown: monthlyBreakdownArray
        },
        monthlySalesAndBookings: monthlySalesArray
      }
    });

  } catch (error) {
    console.error('Error fetching sales report:', error);
    res.status(500).json({ error: 'Failed to fetch sales report data' });
  }
}

module.exports = { getAnalytics, getAgentPerformance, getAdPerformance, getSalesReport };


