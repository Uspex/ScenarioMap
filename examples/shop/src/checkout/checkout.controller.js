import { db } from '../db.js';
import { payments } from '../payments/payment.gateway.js';
import { queue } from '../queue.js';
import { mailer } from '../mailer.js';

const RESERVATION_MINUTES = 15;

export async function placeOrder(req, res) {
  const cart = await db.carts.findByCustomer(req.user.id);
  if (!cart || cart.items.length === 0) {
    return res.status(422).json({ error: 'cart_empty' });
  }

  const missing = await db.stock.findMissing(cart.items);
  if (missing.length > 0) {
    return res.status(409).json({ error: 'out_of_stock', items: missing });
  }

  let discount = 0;
  if (req.body.promoCode) {
    const promo = await db.promos.findActive(req.body.promoCode);
    if (!promo) {
      return res.status(400).json({ error: 'promo_invalid' });
    }
    discount = promo.percent;
  }

  const reservation = await db.stock.reserve(cart.items, RESERVATION_MINUTES);
  await queue.dispatch('releaseReservation', { reservationId: reservation.id }, { delayMinutes: RESERVATION_MINUTES });

  const order = await db.orders.create({
    customerId: req.user.id,
    items: cart.items,
    total: cart.total * (1 - discount / 100),
    status: 'pending_payment',
    reservationId: reservation.id,
  });

  const payment = await payments.charge({ orderId: order.id, amount: order.total, card: req.body.cardToken });

  if (payment.status === 'succeeded') {
    await markPaid(order);
    return res.status(201).json({ orderId: order.id, status: 'paid' });
  }
  if (payment.status === 'requires_action') {
    return res.status(202).json({ orderId: order.id, redirectUrl: payment.redirectUrl });
  }

  await db.orders.update(order.id, { status: 'cancelled', reason: payment.declineCode });
  await db.stock.release(reservation.id);
  return res.status(402).json({ error: 'payment_declined', code: payment.declineCode });
}

export async function markPaid(order) {
  await db.orders.update(order.id, { status: 'paid', paidAt: new Date() });
  await db.stock.commit(order.reservationId);
  await mailer.send('order-confirmation', { orderId: order.id });
}
