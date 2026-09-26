import { db } from '../db.js';
import { payments } from '../payments/payment.gateway.js';
import { mailer } from '../mailer.js';

const RETURN_DAYS = 14;

export async function requestReturn(req, res) {
  const order = await db.orders.findById(req.params.id);
  if (order.status !== 'delivered') {
    return res.status(409).json({ error: 'not_delivered' });
  }

  const days = (Date.now() - order.deliveredAt.getTime()) / 86400000;
  if (days > RETURN_DAYS) {
    return res.status(422).json({ error: 'return_period_expired' });
  }

  const ret = await db.returns.create({ orderId: order.id, items: req.body.items, status: 'awaiting_parcel' });
  await mailer.send('return-label', { returnId: ret.id });
  return res.status(201).json({ returnId: ret.id });
}

export async function inspectReturn(req, res) {
  const ret = await db.returns.findById(req.params.id);
  const order = await db.orders.findById(ret.orderId);

  if (!req.body.intact) {
    await db.returns.update(ret.id, { status: 'rejected', reason: req.body.comment });
    await mailer.send('return-rejected', { returnId: ret.id });
    return res.status(200).json({ status: 'rejected' });
  }

  const refund = await payments.refund({ orderId: order.id, amount: order.total });
  if (refund.status !== 'succeeded') {
    await db.returns.update(ret.id, { status: 'manual_refund' });
    return res.status(200).json({ status: 'manual_refund' });
  }

  await db.returns.update(ret.id, { status: 'refunded', refundId: refund.id });
  await db.stock.restock(ret.items);
  return res.status(200).json({ status: 'refunded' });
}
