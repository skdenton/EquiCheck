import Dexie from 'dexie';

export const db = new Dexie('EZFeasibilityDB');

db.version(1).stores({
  properties: '++id, address, dscr, created'
});