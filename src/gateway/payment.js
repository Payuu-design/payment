import { Router } from 'express';
import pool from '../services/db.js';
import { createOne, readOne, updateOne } from '../helpers/crud.js'
import hashValue from '../helpers/hashValue.js';
import {
    date2Mysql,
    genReferenceNumber,
    getBankInfo,
    validateCardNumber,
    validateCvv,
    validateDate,
    validateExpMonth,
    validateExpYear,
    validateNumInstallments
} from '../helpers/utils.js';
import { servePaymentReq } from './serveQueue.js';
import { transporter } from '../services/mailer.js';
import { MAIL_USER } from '../config/index.config.js';
import { CARD_TYPE_DEBIT } from '../config/constants.js';

const router = new Router();

router.post('/', async (req, res) => {
    
    // check required fields
    const { user_id, date, num_installments, bill_id, cvv, payment_method_id } = req.body;
    
    if(!user_id || !bill_id || !payment_method_id || !validateNumInstallments(num_installments)
        || !validateCvv(cvv) || !validateDate(date)) {
        console.log('Invalid fields');
        return res.status(400).json({ message: 'Bad request' });
    }

    // validate card id
    let user;
    try {
        user = await readOne(
            'user',
            { 'user': ['email', 'doc_number'] },
            [],
            { id: user_id },
            pool
        )
    } catch(err) {
        console.log(err);
        if(err.message === 'Not found') {
            return res.status(400).json({ message: 'User not found' });
        }
        return res.status(500).json({ message: 'Internal server error' });
    }

    // validate card id
    let payMeth;
    try {
        payMeth = await readOne(
            'payment_method',
            { 'payment_method': ['card_number', 'exp_year', 'exp_month', 'owner', 'card_type_id'] },
            [],
            { id: payment_method_id, user_id },
            pool
        )
    } catch(err) {
        console.log(err);
        if(err.message === 'Not found') {
            return res.status(400).json({ message: 'Invalid payment method' });
        }
        return res.status(500).json({ message: 'Internal server error' });
    }
    // if(!validateExpYear(payMeth.exp_year) || !validateExpMonth(payMeth.exp_month) 
    //     || !validateCardNumber(payMeth.card_number)) {
        
    //     return res.status(400).json({ message: 'Invalid payment method' });
    // }
    if(payMeth.card_type_id === CARD_TYPE_DEBIT && num_installments > 1) {
        return res.status(400).json({ message: 'Debit cards do not support installments' });
    }

    // validate bill_id
    let bill;
    try {
        bill = await readOne(
            'bill',
            { 'bill': ['payment_concept_id', 'pay_before', 'completed'] },
            [],
            { id: bill_id, user_id },
            pool
        )
    } catch(err) {
        console.log(err);
        if(err.message === 'Not found') {
            return res.status(400).json({ message: 'Invalid bill' });
        }
        return res.status(500).json({ message: 'Internal server error' });
    }
    if(bill.completed) {
        return res.status(400).json({ message: 'Bill already paid' });
    }
    if(new Date(bill.pay_before) < new Date()) {
        return res.status(400).json({ message: 'Bill expired' });
    }

    // validate bill_id
    let payConcept;
    try {
        payConcept = await readOne(
            'payment_concept',
            { 'payment_concept': ['payment_concept', 'amount', 'code'] },
            [],
            { id: bill.payment_concept_id },
            pool
        )
    } catch(err) {
        console.log(err);
        if(err.message === 'Not found') {
            return res.status(400).json({ message: 'Invalid payment concept' });
        }
        return res.status(500).json({ message: 'Internal server error' });
    }
    
    // create payment
    const refNumber = genReferenceNumber();
    const _ = hashValue(cvv);
    try {
        const paymentId = (await createOne(
            'payment',
            {
                gateway_date: date2Mysql(new Date()),
                date: date2Mysql(new Date(date)),
                ref_number: refNumber,
                bill_id, num_installments,
            },
            pool
        )).insertId;
        await createOne(
            'payment_req',
            {
                cvv: _,
                payment_id: paymentId,
                payment_method_id,
            },
            pool
        );
    } catch(err) {
        console.log(err);
        return res.status(500).json({ message: 'Error when creating payment' });
    }

    res.status(201).json({ message: 'Payment created', ref_number: refNumber });

    servePaymentReq({
        owner: payMeth.owner,
        email: user.email,
        doc_number: user.doc_number,
        amount: payConcept.amount,
        card_number: payMeth.card_number,
        card_type_id: payMeth.card_type_id,
        exp_month: payMeth.exp_month,
        exp_year: payMeth.exp_year,
        ref_number: refNumber,
        num_installments,
        cvv: _
    }).then(() => {
        console.log('Payment request served');
    }).catch(() => {
        // console.log('Payment request couldn\'t be served');
    });

    const { bank } = getBankInfo(payMeth.card_number);
    const mailClient = {
        from: `"Payuu" <${MAIL_USER}>`,
        to: 'uwu.ossas.uwu@gmail.com',
        subject: 'Pago en Proceso',
        html: `
            <h2>Solicitud de Pago Recibida</h2>
            <p>Tu pago fue recibido por Payuu y está siendo procesado por ${bank}.</p>
            <p>Recibirás un correo de confirmación del pago en un plazo máximo de cinco (5) días hábiles.</p>
            <p><b>Número de referencia:</b> ${refNumber}</p>
        `
    };
    try {
        await transporter.sendMail(mailClient);
        console.log(`Mail sent to ${mailClient.to}`);
    } catch(err) {
        console.log(`Cannot send mail to ${mailClient.to}`);
    }
});

export default router;
