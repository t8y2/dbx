db = db.getSiblingDB('dbx');
db.dbx_smoke.createIndex({ note: 1 });
db.dbx_smoke.insertOne({ _id: 1, note: 'DBX smoke 中文 🚀', nullableValue: null, createdAt: new Date() });
