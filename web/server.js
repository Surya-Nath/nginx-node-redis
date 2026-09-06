const os = require('os');
const express = require('express');
const redis = require('redis');

const app = express();
const client = redis.createClient({
  host: process.env.REDIS_HOST || 'redis',
  port: 6379,
  retry_strategy: () => 1000
});

client.on('error', (err) => console.error('redis error:', err.message));

app.get('/', (req, res) => {
  client.get('numVisits', (err, val) => {
    if (err) {
      console.error(err);
      return res.status(503).send('redis down');
    }
    let n = parseInt(val, 10);
    if (isNaN(n)) n = 0;
    n += 1;
    client.set('numVisits', String(n));
    res.send(os.hostname() + ': Number of visits is: ' + n);
  });
});

app.listen(5000, '0.0.0.0', () => {
  console.log('listening on 5000 host=' + os.hostname());
});
