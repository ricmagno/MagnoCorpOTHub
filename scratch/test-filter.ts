import { DataFilteringService } from '../src/services/dataFiltering';
const service = new DataFilteringService();
const point = { tagName: 'Kagome_AU.BR_WQ001_PV', timestamp: new Date(), value: 367079, quality: 0 };
const filter = {"logicalOperator":"AND","conditions":[{"comparison":{"operator":"EQ","value":0}}]};
const result = service.evaluateCondition(point, filter);
console.log('Result of evaluateCondition:', result);
