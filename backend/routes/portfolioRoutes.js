import { Router } from 'express';
import {
  fetchPortfolio, updatePortfolio, createPosition, deletePosition, stressTest,
} from '../controllers/portfolioController.js';
import { patchPosition } from '../controllers/portfolioController.js';
import { reviewPortfolio } from '../controllers/advisorController.js';

const router = Router();

router.get('/', fetchPortfolio);
router.patch('/', updatePortfolio);
router.post('/positions', createPosition);
router.patch('/positions/:id', patchPosition);
router.delete('/positions/:id', deletePosition);
router.get('/stress-test', stressTest);
router.get('/review', reviewPortfolio);
router.post('/review', reviewPortfolio);

export default router;
