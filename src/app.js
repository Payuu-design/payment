import express from 'express';
import morgan from 'morgan';
import payment from './gateway/payment.js';
import pool from './services/db.js';
import serveQueue from './gateway/serveQueue.js';
import apiGateway from './api-gateway/apiGateway.js';

const app = express();

app.set('json spaces', 2);
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((_, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, x-auth-token');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
    next();
});

app.get('/', (_, res) => res.status(200).json({
    message: 'Welcome to the Payuu Payment Gateway',
}));
app.get('/ping', async (_, res) => {
    try {
        res.status(200).json({ message: (await pool.query('SELECT "Pong!" AS result'))[0][0].result });
    } catch (err) {
        console.log(err);
        res.status(500).json({ message: 'Cannot connect to DB' });
    }
});
app.use('/pay', payment);
app.post('/api-gateway', async (_, res) => {
    const { status, message, error } = await apiGateway();
    res.status(status).json({ message, error });
});
app.post('/serve-queue', async (_, res) => {
    const { status, message, error } = await serveQueue();
    res.status(status).json({ message, error });
});
app.use((_, res) => res.status(404).json({ message: 'Not Found' }));

export default app;
