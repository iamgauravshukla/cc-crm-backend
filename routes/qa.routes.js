const express = require('express');
const router  = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const ctrl = require('../controllers/qa.controller');

router.use(authMiddleware);
// Chat QA is supervisor tooling — Admin only, end to end.
router.use((req, res, next) => {
  if (req.user?.role !== 'Admin') return res.status(403).json({ error: 'Access denied. Admin only.' });
  next();
});

router.get('/pages', ctrl.getPagesList);
router.get('/pages/:pageId/agents', ctrl.getPageAgents);
router.get('/pages/:pageId/workload', ctrl.getWorkload);
router.post('/runs', ctrl.startRun);
router.get('/runs', ctrl.listRuns);
router.get('/runs/:id', ctrl.getRun);
router.delete('/runs/:id', ctrl.deleteRun);
router.get('/conversations', ctrl.listConversations);
router.get('/conversations/:id', ctrl.getConversation);
router.get('/stats', ctrl.getStats);
router.get('/agents/:name/profile', ctrl.getAgentProfile);
router.get('/agents/:name/scorecard', ctrl.getAgentScorecard);

module.exports = router;
