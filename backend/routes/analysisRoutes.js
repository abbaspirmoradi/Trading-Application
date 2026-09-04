import { Router } from 'express';
import {
  analyze, analyzeBatch, getChart, getAgentRegistry, getLogs, backtest, getMarketOverview,
} from '../controllers/analysisController.js';
import { dailyPicks } from '../controllers/advisorController.js';

const router = Router();

router.get('/agents', getAgentRegistry);
router.post('/analyze', analyze);
router.get('/analyze', analyze);
router.post('/analyze/batch', analyzeBatch);
router.get('/chart/:ticker', getChart);
router.get('/logs', getLogs);
router.post('/backtest', backtest);
router.get('/market/overview', getMarketOverview);
router.get('/picks', dailyPicks);
router.post('/picks', dailyPicks);

export default router;
