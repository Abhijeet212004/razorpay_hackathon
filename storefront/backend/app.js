const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const fileUpload = require('express-fileupload');
const errorMiddleware = require('./middlewares/error');

const app = express();

// config
if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config({ path: 'backend/config/config.env' });
}

app.use(express.json());
app.use(cookieParser());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(fileUpload());

const user = require('./routes/userRoute');
const product = require('./routes/productRoute');
const order = require('./routes/orderRoute');
const payment = require('./routes/paymentRoute');
const agent = require('./routes/agentRoute');
const fulfil = require('./routes/fulfilRoute');
const address = require('./routes/addressRoute');

app.use('/api/v1', user);
app.use('/api/v1', product);
app.use('/api/v1', order);
app.use('/api/v1', payment);

// guard.mount(app, "/agent") — the merchant's own routes above are untouched.
app.use('/api/v1', agent);
app.use('/api/v1', address);

// Internal only: the kernel records an agent's order here. Not routed publicly.
app.use('/internal', fulfil);

// error middleware
app.use(errorMiddleware);

module.exports = app;