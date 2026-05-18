import express from 'express';
const app = express();
app.get('/health', (req, res) => res.send('OK'));
app.listen(5001, () => console.log('Minimal server listening on 5001'));
