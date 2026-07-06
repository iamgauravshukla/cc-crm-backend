'use strict';
const pool = require('../db/pool');

async function getAll(req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, filters, created_at FROM saved_views WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.userId]
    );
    res.json({ success: true, views: rows });
  } catch (err) {
    console.error('Get saved views error:', err);
    res.status(500).json({ error: 'Failed to fetch saved views' });
  }
}

async function create(req, res) {
  try {
    const { name, filters } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'View name is required' });
    if (!filters || typeof filters !== 'object') return res.status(400).json({ error: 'filters must be an object' });

    const { rows } = await pool.query(
      `INSERT INTO saved_views (user_id, name, filters)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, name) DO UPDATE SET filters = EXCLUDED.filters
       RETURNING id, name, filters, created_at`,
      [req.user.userId, name.trim(), JSON.stringify(filters)]
    );
    res.status(201).json({ success: true, view: rows[0] });
  } catch (err) {
    console.error('Create saved view error:', err);
    res.status(500).json({ error: 'Failed to save view' });
  }
}

async function remove(req, res) {
  try {
    const { id } = req.params;
    const { rowCount } = await pool.query(
      `DELETE FROM saved_views WHERE id = $1 AND user_id = $2`,
      [id, req.user.userId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Saved view not found' });
    res.json({ success: true, message: 'Saved view deleted' });
  } catch (err) {
    console.error('Delete saved view error:', err);
    res.status(500).json({ error: 'Failed to delete saved view' });
  }
}

module.exports = { getAll, create, remove };
