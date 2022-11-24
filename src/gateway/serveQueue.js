import pool from '../services/db.js';
import { createOne, deleteOne, readMany, readOne, updateOne } from '../helpers/crud.js'
import fetch from "../helpers/fetch.js";
import { date2Mysql, genInvoiceNumber, getBankInfo, getCardCategory, hasNull, parseOwnerName } from "../helpers/utils.js";
import { transporter } from '../services/mailer.js';
import { MAIL_USER } from '../config/index.config.js';

export default async function () {
    let payReqs;

    try {
        payReqs = await readMany(
            'payment_req',
            {
                'payment_req': ['cvv'],
                'payment': ['ref_number', 'date', 'num_installments'],
                'user': ['email', 'doc_number'],
                'payment_method': ['card_number', 'exp_year', 'exp_month', 'owner', 'card_type_id'],
                'payment_concept': ['amount']
            },
            [
                'JOIN payment ON payment_req.payment_id = payment.id',
                'LEFT JOIN bill ON payment.bill_id = bill.id',
                'LEFT JOIN user ON bill.user_id = user.id',
                'LEFT JOIN payment_method ON payment_req.payment_method_id = payment_method.id',
                'LEFT JOIN payment_concept ON bill.payment_concept_id = payment_concept.id'
            ],
            null,
            pool,
        );
    } catch (err) {
        console.log(err);
        return { status: 500, message: 'Error reading payment requests', error: err.message };
    }
    console.log(payReqs);

    payReqs = payReqs.filter(payReq => !hasNull(payReq));

    payReqs.forEach(servePaymentReq);

    return { status: 200, message: 'Processing payment requests' };
}

export async function servePaymentReq({ owner, email, doc_number, amount,
    card_type_id, card_number, exp_month, exp_year, cvv, num_installments, ref_number }) {

    // throw new Error('The service falls after saving the request and before sending it to the bank')

    const { bank, url } = getBankInfo(card_number);
    fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            'card_category_id': +getCardCategory(card_number),
            owner, email, doc_number, amount, card_type_id, card_number, 
            exp_month, exp_year, cvv, num_installments, ref_number,
        }),
    }).then(async ({ data: json }) => {
        // throw new Error('The service falls before receiving an answer from bank')
        console.log(ref_number, json);

        const { successful, effective_date: eff_date, amount, charge, fulfilled } = json.data;
        const effective_date = new Date(eff_date);

        let payment, paySettledId;
        const mailOrg = {
            from: `"Payuu" <${MAIL_USER}>`,
            to: MAIL_USER,
            subject: `Payment Completed (${ref_number})`,
            html: `
                <h2>Payment with Reference Number ${ref_number} Completed</h2>
                <p><b>Successful:</b> ${successful}</p>
                <p><b>Effective </b>Date: ${effective_date}</p>
                <p><b>Amount:</b> ${amount}</p>
                <p><b>Charge:</b> ${charge}</p>
                <p><b>Fulfilled:</b> ${fulfilled}</p>
            `
        };
        const mailClient = {
            from: `"Payuu" <${MAIL_USER}>`,
            to: ['alvaroforms@gmail.com', 'uwu.ossas.uwu@gmail.com'],
        };
        const errors = [];
        try {
            payment = await readOne(
                'payment',
                {
                    'payment': ['id', 'date', 'gateway_date', 'num_installments'],
                    'payment_concept': ['amount', 'payment_concept', 'code'],
                    'bill': ['id', 'ref_number'],
                    'campus': ['campus'],
                },
                [
                    'LEFT JOIN bill ON payment.bill_id = bill.id',
                    'LEFT JOIN payment_concept ON bill.payment_concept_id = payment_concept.id',
                    'LEFT JOIN user ON bill.user_id = user.id',
                    'LEFT JOIN campus ON user.campus_id = campus.id',
                ],
                { 'payment.ref_number': ref_number },
                pool
            );
        } catch (err) {
            if (err.message === 'Not found') console.log(`Payment with ref_number ${ref_number} not found`);
            else console.log(`Payment with ref_number ${ref_number} found (${payment.id}), but error: ${err.message}`);
            errors.push('<p><b>Payment:</b> Not found</p>');
        }

        // create payment_settled without payment_id, even if payment is not found
        try {
            paySettledId = (await createOne(
                'payment_settled',
                {
                    amount, charge,
                    fulfilled: fulfilled ? 1 : 0,
                    successful: successful ? 1 : 0,
                    payment_id: payment.id || null,
                    effective_date: date2Mysql(effective_date)
                },
                pool
            )).insertId;
            console.log(`Payment settled with ref_number ${ref_number} created`);
        } catch (err) {
            console.log(`Cannot create payment_settled with ref_number ${ref_number}`);
            console.log(err);
            errors.push('<p><b>Payment settled:</b> Not created</p>');
        }

        // delete payment_req
        if (payment) {
            try {
                await deleteOne('payment_req', { payment_id: payment.id }, pool);
            } catch (err) {
                console.log(`Cannot delete payment_req with ref_number ${ref_number}`);
                errors.push('<p><b>Payment request:</b> Not deleted</p>');
            }
        }

        // update bill in University DB
        if (successful) {
            if (payment) {
                try {
                    await updateOne(
                        'bill',
                        { completed: 1 },
                        { id: payment.bill_id },
                        pool
                    );
                } catch (err) {
                    console.log(`Cannot update bill with id ${payment.bill_id}`);
                    errors.push('<p><b>Payment concept person:</b> Not updated</p>');
                }
            }

            mailClient.subject = payment ?
                `Pago de ${payment.payment_concept} realizado` : 'Pago con número de referencia ${ref_number} realizado';

            mailClient.html = `
                <h2>Pago con Número de Referencia ${ref_number} Exitoso</h2>
                <h4>Pago aprobado por ${bank}</h4>
                <p><b>Referencia de pago:</b> ${ref_number}</p>
                ${payment ?
                    `
                    <p><b>Factura Nro:</b> ${payment.bill_ref_number}</p>
                    <p><b>Número de cuotas:</b> ${payment.num_installments}</p>
                    <p><b>Fecha de pago:</b> ${payment.date.toLocaleString()}</p>
                    <p><b>Fecha de pasarela de pago:</b> ${payment.gateway_date.toLocaleString()}</p>
                    ${payment.campus ? `<p><b>Sede:</b> ${payment.campus}</p>` : ''}
                    ${payment ?
                        `
                        <p><b>Concepto de pago:</b> ${payment.payment_concept}</p>
                        <p><b>Monto:</b> ${payment.amount}</p>
                        ` : ''
                    }
                    `
                    : ''
                }
                <p><b>Monto total:</b> ${amount}</p>
                <p><b>Fecha efectiva:</b> ${effective_date.toLocaleString()}</p>
            `;
        } else {
            mailClient.subject = `Pago fallido (${ref_number})`;
            mailClient.html = `
                <h2>Pago con Número de Referencia ${ref_number} Fallido</h2>
                <h4>Pago rechazado por ${bank}</h4>
                <p><b>Motivo</b>: ${json.reason}</p>
                <p><b>Fecha efectiva:</b> ${effective_date.toLocaleString()}</p>
                ${payment ? `<p><b>Factura Nro:</b> ${payment.bill_ref_number}</p>` : ''}
            `;
        }

        // send mail to client
        try {
            await transporter.sendMail(mailClient);
            console.log(`Mail sent to ${mailClient.to} (Payment completed)`);
        } catch (err) {
            console.log(`Cannot send mail to ${mailClient.to}`);
            errors.push('<p><b>Mail to client:</b> Not sent</p>');
        }

        // send mail to org
        if (errors.length) {
            mailOrg.html += `
                <br><hr>
                <h4>Internal Errors During Payment</h4>
                ${errors.join('')}
            `;
        }
        try {
            await transporter.sendMail(mailOrg);
            console.log(`Mail sent to ${mailOrg.to}`);
        } catch (err) {
            console.log(`Cannot send mail to ${mailOrg.to}`);
        }
    }).catch(err => {
        console.log('Payment request failed', err.message);
    });
}
