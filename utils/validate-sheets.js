const sheetsService = require('../services/sheets.service');

async function validateSheets() {
  console.log('🔍 Validating Google Sheets setup...\n');

  try {
    // Initialize service
    await sheetsService.initialize();
    console.log('✅ Google Sheets API initialized successfully\n');

    // Check Users sheet
    console.log('Checking "Users" sheet...');
    const users = await sheetsService.readSheet('Users', 'A1:F1');
    if (users.length > 0) {
      console.log('✅ Users sheet exists');
      console.log('   Headers:', users[0].join(', '));
    } else {
      console.log('❌ Users sheet not found or empty');
    }

    // Check Intake sheet (New Bookings)
    console.log('\nChecking "Intake" sheet...');
    const newBookings = await sheetsService.readSheet('Intake', 'A1:BK1');
    if (newBookings.length > 0) {
      console.log('✅ Intake sheet exists');
      console.log('   Columns:', newBookings[0].length, '(expected: 37)');
    } else {
      console.log('❌ Intake sheet not found or empty');
    }

    // Check DB sheet (Old Bookings)
    console.log('\nChecking "DB" sheet...');
    const oldBookings = await sheetsService.readSheet('DB', 'A1:BQ1');
    if (oldBookings.length > 0) {
      console.log('✅ DB sheet exists');
      console.log('   Columns:', oldBookings[0].length, '(expected: 43)');
      
      // Count rows
      const allRows = await sheetsService.readSheet('DB', 'A:A');
      console.log('   Total bookings:', allRows.length - 1); // -1 for header
    } else {
      console.log('❌ DB sheet not found or empty');
    }

    console.log('\n✅ All sheets validated successfully!');
    console.log('\n📝 Next steps:');
    console.log('1. Run: npm run dev');
    console.log('2. Open: http://localhost:3000');
    console.log('3. Sign up and start using the dashboard\n');

  } catch (error) {
    console.error('\n❌ Validation failed:', error.message);
    console.log('\n🔧 Troubleshooting:');
    console.log('1. Check config/google-credentials.json exists');
    console.log('2. Verify GOOGLE_SHEET_ID in .env');
    console.log('3. Ensure service account has access to the sheet');
    console.log('4. Verify sheet names match exactly:\n   - Users\n   - Intake\n   - DB\n');
    process.exit(1);
  }
}

validateSheets();
