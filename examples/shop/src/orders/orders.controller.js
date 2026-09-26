import { db } from '../db.js';

export async function getOrder(req, res) {
  const order = await db.orders.findById(req.params.id);
  if (!order || order.customerId !== req.user.id) {
    return res.status(404).json({ error: 'not_found' });
  }
  return res.status(200).json(order);
}
