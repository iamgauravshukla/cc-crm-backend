'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const pool = require('../db/pool');

const CONFIG = {
  branch: [
    'AI SKIN','CENTRIS','DNA MANILA','ESTANCIA','FELIZ',
    'GENEVA','GLORIETTA','HERA','LIONESSE','LUMIA',
    'PARIS','SM NORTH','STA LUCIA','VENICE'
  ],
  booking_status: [
    'Pencil booking','Scheduled','At the shop','Nearby','On the way',
    'Will be late','Cancelled','Arrived on treatment',
    'Arrived & bought','Arrived not potential',
    'Comeback','Comeback & bought','Refund',
    'Old client','Promo hunter','No Data'
  ],
  treatment: [
    'HAIR RENEWAL','HAIR REGROWTH','HAIR REMOVAL','SCALP DANDRUFF',
    'SCALP PSORIASIS','EXOSOMES','ADVANCED HAIRLOSS SOLUTION','EXCIMER RX LASER',
    'EYEBAG','7D HIFU','12D HIFU','HYDRA','CRYO','CO2','CARBON','PICO',
    'ANTI MELASMA','ACNE CLEANSE','ACNE BRIGHTENING','ORGANIC BOTOX',
    'COLLAGEN FACIAL','THERMAGE','EMS','10D LASER','SKIN LIGHTENING',
    'EXILIS','SAUNAPOD','SOFWAVE','RF','WARTS REMOVAL'
  ],
  agent: [
    'NICOLE','SYRA','DHEZA','GERALDINE','ANJELA','RAIZA','NALYN',
    'DONA','TRISHA','IRIS','JOY','MAE','JULS','YAN','SUTRA',
    'GLADEZ','LEIH','MARY','ROSE','CAMIL','SHAINA'
  ]
};

async function run() {
  const client = await pool.connect();
  try {
    // Create table if needed
    await client.query(`
      CREATE TABLE IF NOT EXISTS config_options (
        id          SERIAL      PRIMARY KEY,
        category    VARCHAR(50) NOT NULL,
        value       TEXT        NOT NULL,
        sort_order  INT         NOT NULL DEFAULT 0,
        is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_config_category_value UNIQUE (category, value)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_config_category_active
        ON config_options(category) WHERE is_active = TRUE
    `);

    let total = 0;
    for (const [category, values] of Object.entries(CONFIG)) {
      for (let i = 0; i < values.length; i++) {
        await client.query(`
          INSERT INTO config_options (category, value, sort_order, is_active)
          VALUES ($1, $2, $3, TRUE)
          ON CONFLICT (category, value) DO UPDATE
            SET sort_order = EXCLUDED.sort_order, is_active = TRUE
        `, [category, values[i], i + 1]);
        total++;
      }
    }
    console.log(`Done: ${total} config options seeded`);

    const { rows } = await client.query(
      'SELECT category, COUNT(*) AS cnt FROM config_options WHERE is_active=TRUE GROUP BY category ORDER BY category'
    );
    rows.forEach(r => console.log(`  ${r.category}: ${r.cnt}`));
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
