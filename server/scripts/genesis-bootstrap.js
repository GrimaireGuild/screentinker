'use strict';
const fs = require('fs');
const { db } = require('../db/database');
const { bootstrap } = require('../lib/genesis-bootstrap');
try {
  // Only read the initial secret on an empty database; Docker can remove it
  // after setup without making subsequent restarts fail.
  if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
    const password = process.env.GENESIS_ADMIN_PASSWORD_FILE
      ? fs.readFileSync(process.env.GENESIS_ADMIN_PASSWORD_FILE, 'utf8').trim()
      : process.env.GENESIS_ADMIN_PASSWORD;
    if (bootstrap(db, process.env.GENESIS_ADMIN_EMAIL, password)) console.log('Genesis Guild global admin created. Password change required on first login.');
  } else console.log('Genesis Guild account setup already complete.');
  db.close();
} catch (error) {
  console.error('Genesis Guild setup failed:', error.message);
  db.close();
  process.exitCode = 1;
}
