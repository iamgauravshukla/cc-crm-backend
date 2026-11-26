const express = require('express');
const router  = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const ctrl = require('../controllers/qa.controller');

router.use(authMiddleware);

// Agent self-service — any authenticated user, but strictly their OWN results
router.get('/my/overview', ctrl.getMyOverview);
router.get('/my/conversations/:id', ctrl.getMyConversation);

// Everything below is supervisor tooling — Admin only, end to end.
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
router.get('/ratings', ctrl.getRatings);
router.get('/agent-map', ctrl.getAgentMap);
router.put('/agent-map', ctrl.putAgentMap);
router.get('/settings/aci-weights', ctrl.getAciWeights);
router.put('/settings/aci-weights', ctrl.putAciWeights);

module.exports = router;
