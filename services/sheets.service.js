const { google } = require('googleapis');

class SheetsService {
  constructor() {
    this.auth = null;
    this.sheets = null;
    this.spreadsheetId = process.env.GOOGLE_SHEET_ID;
    this.initialized = false;
    this._sheetNameCache = null; // { normalizedName -> actualTitle }
  }

  async initialize() {
    if (this.initialized) return;

    try {
      // Get private key - support both base64 encoded and raw format
      let privateKey;
      if (process.env.GOOGLE_PRIVATE_KEY_BASE64) {
        // Decode base64 encoded key (recommended for deployment)
        privateKey = Buffer.from(process.env.GOOGLE_PRIVATE_KEY_BASE64, 'base64').toString('utf-8');
      } else if (process.env.GOOGLE_PRIVATE_KEY) {
        // Use raw key with \n replacement
        privateKey = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
      } else {
        throw new Error('GOOGLE_PRIVATE_KEY or GOOGLE_PRIVATE_KEY_BASE64 is required');
      }

      // Initialize Google Auth using environment variables
      const credentials = {
        type: 'service_account',
        project_id: process.env.GOOGLE_PROJECT_ID,
        private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
        private_key: privateKey,
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        client_id: process.env.GOOGLE_CLIENT_ID,
        auth_uri: 'https://accounts.google.com/o/oauth2/auth',
        token_uri: 'https://oauth2.googleapis.com/token',
        auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
        client_x509_cert_url: process.env.GOOGLE_CLIENT_CERT_URL
      };

      this.auth = new google.auth.GoogleAuth({
        credentials: credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
      });

      this.sheets = google.sheets({ version: 'v4', auth: this.auth });
      this.initialized = true;
      this._sheetNameCache = null; // reset on re-init
      console.log('✅ Google Sheets API initialized');
    } catch (error) {
      console.error('❌ Failed to initialize Google Sheets API:', error.message);
      throw new Error('Google Sheets API initialization failed');
    }
  }

  // Resolves the actual tab title for a given name (case-insensitive).
  // Caches the full list so subsequent calls are free.
  async resolveSheetName(sheetName) {
    if (!this._sheetNameCache) {
      const response = await this.sheets.spreadsheets.get({
        spreadsheetId: this.spreadsheetId
      });
      this._sheetNameCache = {};
      for (const s of (response.data.sheets || [])) {
        this._sheetNameCache[s.properties.title.toLowerCase()] = s.properties.title;
      }
      console.log('📋 Available sheet tabs:', Object.values(this._sheetNameCache).join(', '));
    }
    const actual = this._sheetNameCache[sheetName.toLowerCase()];
    if (!actual) {
      const available = Object.values(this._sheetNameCache).join(', ');
      throw new Error(`Sheet "${sheetName}" not found. Available: ${available}`);
    }
    return actual;
  }

  async readSheet(sheetName, range = null) {
    await this.initialize();

    try {
      const actualName = await this.resolveSheetName(sheetName);

      // Default range based on sheet name
      let sheetRange = range;
      if (!sheetRange) {
        // Intake sheet has 37 columns (A-AK)
        if (sheetName.toLowerCase() === 'intake') {
          sheetRange = 'A:AK';
        }
        // DB sheet has 47 columns (A-AU) - includes companion_area (AU) at index 46
        else if (sheetName.toLowerCase() === 'db') {
          sheetRange = 'A:AU';
        }
        // Default for other sheets
        else {
          sheetRange = 'A:Z';
        }
      }

      console.log(`Reading ${actualName} sheet with range: ${sheetRange}`);
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: `${actualName}!${sheetRange}`
      });

      return response.data.values || [];
    } catch (error) {
      console.error(`Error reading sheet ${sheetName}:`, error.message);
      throw new Error(`Failed to read sheet: ${error.message}`);
    }
  }

  async appendRow(sheetName, values) {
    await this.initialize();

    try {
      const response = await this.sheets.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range: `${sheetName}!A:Z`,
        valueInputOption: 'USER_ENTERED',
        resource: { values: [values] }
      });

      return response.data;
    } catch (error) {
      console.error(`Error appending to sheet ${sheetName}:`, error.message);
      throw new Error(`Failed to append row: ${error.message}`);
    }
  }

  async updateRow(sheetName, rowIndex, values) {
    await this.initialize();

    try {
      // Determine range based on sheet name (same as readSheet)
      let sheetRange;
      if (sheetName === 'Intake') {
        sheetRange = `A${rowIndex}:AK${rowIndex}`;
      } else if (sheetName === 'DB') {
        sheetRange = `A${rowIndex}:AU${rowIndex}`; // extended to col AU (index 46) for companion_area
      } else {
        sheetRange = `A${rowIndex}:Z${rowIndex}`;
      }

      const response = await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: `${sheetName}!${sheetRange}`,
        valueInputOption: 'USER_ENTERED',
        resource: { values: [values] }
      });

      return response.data;
    } catch (error) {
      console.error(`Error updating sheet ${sheetName}:`, error.message);
      throw new Error(`Failed to update row: ${error.message}`);
    }
  }

  // Update a specific column range within a single row (e.g. "AS5:AT5")
  async updateCellRange(sheetName, range, values) {
    await this.initialize();
    try {
      const response = await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: `${sheetName}!${range}`,
        valueInputOption: 'USER_ENTERED',
        resource: { values: [values] }
      });
      return response.data;
    } catch (error) {
      console.error(`Error updating cell range ${sheetName}!${range}:`, error.message);
      throw new Error(`Failed to update cells: ${error.message}`);
    }
  }

  async batchUpdate(requests) {
    await this.initialize();

    try {
      const response = await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        resource: { requests }
      });

      return response.data;
    } catch (error) {
      console.error('Error in batch update:', error.message);
      throw new Error(`Failed to batch update: ${error.message}`);
    }
  }

  async getSheetId(sheetName) {
    await this.initialize();
    try {
      // resolveSheetName uses cached list and handles case-insensitive matching
      const actualName = await this.resolveSheetName(sheetName);
      // Re-use the cache to find sheetId
      const response = await this.sheets.spreadsheets.get({
        spreadsheetId: this.spreadsheetId
      });
      const sheet = (response.data.sheets || []).find(
        s => s.properties.title === actualName
      );
      if (!sheet) throw new Error(`Sheet ${sheetName} not found`);
      return sheet.properties.sheetId;
    } catch (error) {
      console.error(`Error getting sheet ID for ${sheetName}:`, error.message);
      throw new Error(`Failed to get sheet ID: ${error.message}`);
    }
  }

  async deleteRow(sheetName, rowIndex) {
    await this.initialize();

    try {
      const sheetId = await this.getSheetId(sheetName);

      // rowIndex is 1-based (row 1 is headers), Google Sheets API uses 0-based
      // So we need to delete from (rowIndex-1) to (rowIndex)
      const request = {
        deleteDimension: {
          range: {
            sheetId: sheetId,
            dimension: 'ROWS',
            startIndex: rowIndex - 1,
            endIndex: rowIndex
          }
        }
      };

      const response = await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        resource: { requests: [request] }
      });

      return response.data;
    } catch (error) {
      console.error(`Error deleting row ${rowIndex} from ${sheetName}:`, error.message);
      throw new Error(`Failed to delete row: ${error.message}`);
    }
  }
}

// Singleton instance
const sheetsService = new SheetsService();

module.exports = sheetsService;
