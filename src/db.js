import Dexie from 'dexie';

export const db = new Dexie('EquiCheckDB');

db.version(1).stores({
  properties: '++id, address, dscr, created' 
});