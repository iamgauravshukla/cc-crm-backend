'use strict';
const pool = require('../db/pool');

class ConfigController {

  // GET /api/config — all active options grouped by category
  async getAll(req, res) {
    try {
      const { rows } = await pool.query(`
        SELECT id, category, value, sort_order
        FROM config_options
        WHERE is_active = TRUE
        ORDER BY category, sort_order, value
      `);

      const config = {};
      for (const r of rows) {
        if (!config[r.category]) config[r.category] = [];
        config[r.category].push({ id: r.id, value: r.value, sortOrder: r.sort_order });
      }

      res.json({ success: true, config });
    } catch (err) {
      console.error('Config getAll error:', err);
      res.status(500).json({ error: 'Failed to fetch configuration' });
    }
  }

  // POST /api/config — add option (Admin only)
  async addOption(req, res) {
    try {
      if (req.user?.role !== 'Admin') return res.status(403).json({ error: 'Admin only' });

      const { category, value } = req.body;
      if (!category || !value || !value.trim()) {
        return res.status(400).json({ error: 'category and value are required' });
      }

      const { rows: maxRows } = await pool.query(
        'SELECT COALESCE(MAX(sort_order), 0) AS mx FROM config_options WHERE category = $1',
        [category]
      );
      const nextOrder = parseInt(maxRows[0].mx) + 1;

      const { rows } = await pool.query(`
        INSERT INTO config_options (category, value, sort_order, is_active)
        VALUES ($1, $2, $3, TRUE)
        ON CONFLICT (category, value)
          DO UPDATE SET is_active = TRUE, sort_order = EXCLUDED.sort_order
        RETURNING id, category, value, sort_order
      `, [category, value.trim(), nextOrder]);

      res.status(201).json({ success: true, option: rows[0] });
    } catch (err) {
      console.error('Config addOption error:', err);
      res.status(500).json({ error: 'Failed to add option' });
    }
  }

  // PUT /api/config/:id — update value (Admin only)
  async updateOption(req, res) {
    try {
      if (req.user?.role !== 'Admin') return res.status(403).json({ error: 'Admin only' });

      const { id } = req.params;
      const { value } = req.body;
      if (!value || !value.trim()) return res.status(400).json({ error: 'value is required' });

      const { rows } = await pool.query(`
        UPDATE config_options SET value = $1
        WHERE id = $2 AND is_active = TRUE
        RETURNING id, category, value, sort_order
      `, [value.trim(), id]);

      if (!rows.length) return res.status(404).json({ error: 'Option not found' });

      res.json({ success: true, option: rows[0] });
    } catch (err) {
      if (err.code === '23505') return res.status(400).json({ error: 'This value already exists in this category' });
      console.error('Config updateOption error:', err);
      res.status(500).json({ error: 'Failed to update option' });
    }
  }

  // DELETE /api/config/:id — soft delete (Admin only)
  async deleteOption(req, res) {
    try {
      if (req.user?.role !== 'Admin') return res.status(403).json({ error: 'Admin only' });

      const { id } = req.params;
      const { rowCount } = await pool.query(
        'UPDATE config_options SET is_active = FALSE WHERE id = $1 AND is_active = TRUE',
        [id]
      );

      if (!rowCount) return res.status(404).json({ error: 'Option not found' });

      res.json({ success: true });
    } catch (err) {
      console.error('Config deleteOption error:', err);
      res.status(500).json({ error: 'Failed to delete option' });
    }
  }

  // POST /api/config/reorder — bulk reorder within a category (Admin only)
  async reorder(req, res) {
    try {
      if (req.user?.role !== 'Admin') return res.status(403).json({ error: 'Admin only' });

      const { category, orderedIds } = req.body;
      if (!category || !Array.isArray(orderedIds) || !orderedIds.length) {
        return res.status(400).json({ error: 'category and orderedIds[] are required' });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (let i = 0; i < orderedIds.length; i++) {
          await client.query(
            'UPDATE config_options SET sort_order = $1 WHERE id = $2 AND category = $3',
            [i + 1, orderedIds[i], category]
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      res.json({ success: true });
    } catch (err) {
      console.error('Config reorder error:', err);
      res.status(500).json({ error: 'Failed to reorder options' });
    }
  }
}

module.exports = new ConfigController();
