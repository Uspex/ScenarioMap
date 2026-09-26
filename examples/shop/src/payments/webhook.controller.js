import { db } from '../db.js';
import { payments } from './payment.gateway.js';
import { markPaid } from '../checkout/checkout.controller.js';

export async function handlePaymentWebhook(req, res) {
  if (!payments.verifySignature(req.rawBody, req.headers['x-signature'])) {
    return res.status(401).json({ error: 'bad_signature' });
  }

  const event = req.body;
  const order = await db.orders.findById(event.orderId);

  if (event.type === 'payment.succeeded') {
    await markPaid(order);
    return res.status(200).json({ ok: true });
  }

  await db.orders.update(order.id, { status: 'cancelled', reason: event.declineCode });
  await db.stock.release(order.reservationId);
  return res.status(200).json({ ok: true });
}
