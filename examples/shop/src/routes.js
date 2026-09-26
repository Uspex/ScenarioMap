// Демо-код интернет-магазина для примера сценарных карт. Не запускается — нужен только как «код проекта».
import { placeOrder } from './checkout/checkout.controller.js';
import { handlePaymentWebhook } from './payments/webhook.controller.js';
import { requestReturn, inspectReturn } from './returns/returns.controller.js';
import { getOrder } from './orders/orders.controller.js';

export function registerRoutes(app) {
  app.post('/api/checkout', placeOrder);
  app.post('/api/payments/webhook', handlePaymentWebhook);
  app.post('/api/orders/:id/returns', requestReturn);
  app.post('/api/returns/:id/inspect', inspectReturn);
  app.get('/api/orders/:id', getOrder);
}
