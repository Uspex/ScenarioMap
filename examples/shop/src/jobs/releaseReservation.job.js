import { db } from '../db.js';

export async function releaseReservation({ reservationId }) {
  const order = await db.orders.findByReservation(reservationId);
  if (order.status !== 'pending_payment') {
    return { released: false };
  }

  await db.stock.release(reservationId);
  return { released: true };
}
