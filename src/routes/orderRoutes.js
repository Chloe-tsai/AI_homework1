const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../database');
const authMiddleware = require('../middleware/authMiddleware');
const ecpayService = require('../services/ecpayService');

const router = express.Router();

router.use(authMiddleware);

function generateOrderNo() {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const random = uuidv4().slice(0, 5).toUpperCase();
  return `ORD-${dateStr}-${random}`;
}

function getPaymentSummary(payment) {
  if (!payment) return null;
  return {
    id: payment.id,
    provider: payment.provider,
    merchant_trade_no: payment.merchant_trade_no,
    amount: payment.amount,
    status: payment.status,
    provider_trade_no: payment.provider_trade_no,
    payment_type: payment.payment_type,
    paid_at: payment.paid_at,
    last_queried_at: payment.last_queried_at,
    query_count: payment.query_count,
    created_at: payment.created_at,
    updated_at: payment.updated_at
  };
}

function getQueryIntervalSeconds() {
  const value = Number.parseInt(process.env.ECPAY_QUERY_MIN_INTERVAL_SECONDS, 10);
  return Number.isInteger(value) && value >= 0 ? value : 600;
}

/**
 * @openapi
 * /api/orders:
 *   post:
 *     summary: 從購物車建立訂單
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [recipientName, recipientEmail, recipientAddress]
 *             properties:
 *               recipientName:
 *                 type: string
 *               recipientEmail:
 *                 type: string
 *                 format: email
 *               recipientAddress:
 *                 type: string
 *     responses:
 *       201:
 *         description: 訂單建立成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     order_no:
 *                       type: string
 *                     total_amount:
 *                       type: integer
 *                     status:
 *                       type: string
 *                     items:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           product_name:
 *                             type: string
 *                           product_price:
 *                             type: integer
 *                           quantity:
 *                             type: integer
 *                     created_at:
 *                       type: string
 *                 error:
 *                   type: string
 *                   nullable: true
 *                 message:
 *                   type: string
 *       400:
 *         description: 購物車為空或庫存不足或收件資訊缺失
 */
router.post('/', (req, res) => {
  const { recipientName, recipientEmail, recipientAddress } = req.body;
  const userId = req.user.userId;

  if (!recipientName || !recipientEmail || !recipientAddress) {
    return res.status(400).json({
      data: null,
      error: 'VALIDATION_ERROR',
      message: '收件人姓名、Email 和地址為必填欄位'
    });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(recipientEmail)) {
    return res.status(400).json({
      data: null,
      error: 'VALIDATION_ERROR',
      message: 'Email 格式不正確'
    });
  }

  // Get cart items with product info
  const cartItems = db.prepare(
    `SELECT ci.id, ci.product_id, ci.quantity,
            p.name as product_name, p.price as product_price, p.stock as product_stock
     FROM cart_items ci
     JOIN products p ON ci.product_id = p.id
     WHERE ci.user_id = ?`
  ).all(userId);

  if (cartItems.length === 0) {
    return res.status(400).json({
      data: null,
      error: 'CART_EMPTY',
      message: '購物車為空'
    });
  }

  // Check stock
  const insufficientItems = cartItems.filter(item => item.quantity > item.product_stock);
  if (insufficientItems.length > 0) {
    const names = insufficientItems.map(i => i.product_name).join(', ');
    return res.status(400).json({
      data: null,
      error: 'STOCK_INSUFFICIENT',
      message: `以下商品庫存不足：${names}`
    });
  }

  // Calculate total
  const totalAmount = cartItems.reduce(
    (sum, item) => sum + item.product_price * item.quantity, 0
  );

  const orderId = uuidv4();
  const orderNo = generateOrderNo();

  // Transaction: create order, order items, deduct stock, clear cart
  const createOrder = db.transaction(() => {
    db.prepare(
      `INSERT INTO orders (id, order_no, user_id, recipient_name, recipient_email, recipient_address, total_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(orderId, orderNo, userId, recipientName, recipientEmail, recipientAddress, totalAmount);

    const insertItem = db.prepare(
      `INSERT INTO order_items (id, order_id, product_id, product_name, product_price, quantity)
       VALUES (?, ?, ?, ?, ?, ?)`
    );

    const updateStock = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?');

    for (const item of cartItems) {
      insertItem.run(uuidv4(), orderId, item.product_id, item.product_name, item.product_price, item.quantity);
      updateStock.run(item.quantity, item.product_id);
    }

    db.prepare('DELETE FROM cart_items WHERE user_id = ?').run(userId);
  });

  createOrder();

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  const orderItems = db.prepare(
    'SELECT product_name, product_price, quantity FROM order_items WHERE order_id = ?'
  ).all(orderId);

  res.status(201).json({
    data: {
      id: order.id,
      order_no: order.order_no,
      total_amount: order.total_amount,
      status: order.status,
      items: orderItems,
      created_at: order.created_at
    },
    error: null,
    message: '訂單建立成功'
  });
});

/**
 * @openapi
 * /api/orders:
 *   get:
 *     summary: 自己的訂單列表
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: 成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: object
 *                   properties:
 *                     orders:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: string
 *                           order_no:
 *                             type: string
 *                           total_amount:
 *                             type: integer
 *                           status:
 *                             type: string
 *                           created_at:
 *                             type: string
 *                 error:
 *                   type: string
 *                   nullable: true
 *                 message:
 *                   type: string
 */
router.get('/', (req, res) => {
  const orders = db.prepare(
    'SELECT id, order_no, total_amount, status, created_at FROM orders WHERE user_id = ? ORDER BY created_at DESC'
  ).all(req.user.userId);

  res.json({
    data: { orders },
    error: null,
    message: '成功'
  });
});

/**
 * @openapi
 * /api/orders/{id}:
 *   get:
 *     summary: 訂單詳情
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: 成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     order_no:
 *                       type: string
 *                     recipient_name:
 *                       type: string
 *                     recipient_email:
 *                       type: string
 *                     recipient_address:
 *                       type: string
 *                     total_amount:
 *                       type: integer
 *                     status:
 *                       type: string
 *                     created_at:
 *                       type: string
 *                     items:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: string
 *                           product_id:
 *                             type: string
 *                           product_name:
 *                             type: string
 *                           product_price:
 *                             type: integer
 *                           quantity:
 *                             type: integer
 *                 error:
 *                   type: string
 *                   nullable: true
 *                 message:
 *                   type: string
 *       404:
 *         description: 訂單不存在
 */
router.get('/:id', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(req.params.id, req.user.userId);

  if (!order) {
    return res.status(404).json({ data: null, error: 'NOT_FOUND', message: '訂單不存在' });
  }

  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
  const payment = db.prepare('SELECT * FROM payments WHERE order_id = ?').get(order.id);

  res.json({
    data: { ...order, items, payment: getPaymentSummary(payment) },
    error: null,
    message: '成功'
  });
});

/**
 * @openapi
 * /api/orders/{id}/payments/ecpay:
 *   post:
 *     summary: 建立 ECPay AIO 信用卡付款表單
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: 回傳 ECPay form action 與已簽章欄位
 *       400:
 *         description: 訂單不是 pending
 *       404:
 *         description: 訂單不存在
 *       503:
 *         description: ECPay 尚未設定
 */
router.post('/:id/payments/ecpay', (req, res) => {
  const order = db.prepare(
    'SELECT * FROM orders WHERE id = ? AND user_id = ?'
  ).get(req.params.id, req.user.userId);

  if (!order) {
    return res.status(404).json({ data: null, error: 'NOT_FOUND', message: '訂單不存在' });
  }
  if (order.status !== 'pending') {
    return res.status(400).json({
      data: null,
      error: 'INVALID_STATUS',
      message: '只有 pending 訂單可以建立付款'
    });
  }

  let payment = db.prepare('SELECT * FROM payments WHERE order_id = ?').get(order.id);
  if (!payment) {
    const paymentId = uuidv4();
    const merchantTradeNo = ecpayService.generateMerchantTradeNo();
    const merchantTradeDate = ecpayService.getMerchantTradeDate();
    db.prepare(
      `INSERT INTO payments
       (id, order_id, provider, merchant_trade_no, merchant_trade_date, amount)
       VALUES (?, ?, 'ecpay', ?, ?, ?)`
    ).run(paymentId, order.id, merchantTradeNo, merchantTradeDate, order.total_amount);
    payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  }

  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);

  try {
    const checkout = ecpayService.buildCheckoutForm({
      order,
      payment,
      items,
      baseUrl: process.env.BASE_URL
    });
    return res.json({
      data: {
        payment: getPaymentSummary(payment),
        checkout
      },
      error: null,
      message: 'ECPay 付款資料已建立'
    });
  } catch (error) {
    if (error instanceof ecpayService.EcpayServiceError) {
      return res.status(error.statusCode).json({
        data: null,
        error: error.code,
        message: error.message
      });
    }
    throw error;
  }
});

/**
 * @openapi
 * /api/orders/{id}/payments/ecpay/verify:
 *   post:
 *     summary: 主動查詢並驗證 ECPay 付款結果
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: 已取得並驗證 ECPay 交易狀態
 *       404:
 *         description: 訂單不存在
 *       409:
 *         description: 尚未建立 ECPay 付款
 *       429:
 *         description: 查詢過於頻繁
 *       502:
 *         description: ECPay 無法連線或回應驗證失敗
 */
router.post('/:id/payments/ecpay/verify', async (req, res) => {
  const order = db.prepare(
    'SELECT * FROM orders WHERE id = ? AND user_id = ?'
  ).get(req.params.id, req.user.userId);

  if (!order) {
    return res.status(404).json({ data: null, error: 'NOT_FOUND', message: '訂單不存在' });
  }

  let payment = db.prepare('SELECT * FROM payments WHERE order_id = ?').get(order.id);
  if (!payment) {
    return res.status(409).json({
      data: null,
      error: 'PAYMENT_NOT_INITIALIZED',
      message: '尚未建立 ECPay 付款'
    });
  }

  if (order.status === 'paid' && payment.status === 'paid') {
    return res.json({
      data: { order, payment: getPaymentSummary(payment), provider_status: '1' },
      error: null,
      message: '此訂單已確認付款'
    });
  }
  if (order.status !== 'pending') {
    return res.status(400).json({
      data: null,
      error: 'INVALID_STATUS',
      message: '此訂單目前無法查詢付款'
    });
  }

  const interval = getQueryIntervalSeconds();
  const reservation = db.prepare(
    `UPDATE payments
     SET last_queried_at = datetime('now'), query_count = query_count + 1,
         updated_at = datetime('now')
     WHERE id = ?
       AND (last_queried_at IS NULL OR last_queried_at <= datetime('now', ?))`
  ).run(payment.id, `-${interval} seconds`);

  if (reservation.changes === 0) {
    return res.status(429).json({
      data: null,
      error: 'PAYMENT_QUERY_TOO_FREQUENT',
      message: `請至少間隔 ${interval} 秒再查詢付款結果`
    });
  }

  try {
    const result = await ecpayService.queryTradeInfo(payment.merchant_trade_no);

    if (Number(result.TradeAmt) !== payment.amount) {
      return res.status(502).json({
        data: null,
        error: 'ECPAY_RESPONSE_MISMATCH',
        message: 'ECPay 查詢金額與本地訂單不符'
      });
    }

    const providerStatus = String(result.TradeStatus || '');
    const paymentStatus = providerStatus === '1'
      ? 'paid'
      : (providerStatus === '10200095' ? 'failed' : 'pending');

    const applyVerifiedResult = db.transaction(() => {
      db.prepare(
        `UPDATE payments
         SET status = ?, provider_trade_no = ?, payment_type = ?, paid_at = ?,
             updated_at = datetime('now')
         WHERE id = ?`
      ).run(
        paymentStatus,
        result.TradeNo || null,
        result.PaymentType || null,
        paymentStatus === 'paid' ? (result.PaymentDate || null) : null,
        payment.id
      );

      if (paymentStatus === 'paid' || paymentStatus === 'failed') {
        db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(paymentStatus, order.id);
      }
    });
    applyVerifiedResult();

    const updatedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
    payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(payment.id);

    return res.json({
      data: {
        order: updatedOrder,
        payment: getPaymentSummary(payment),
        provider_status: providerStatus
      },
      error: null,
      message: paymentStatus === 'paid'
        ? 'ECPay 已確認付款成功'
        : (paymentStatus === 'failed' ? 'ECPay 已確認交易失敗' : 'ECPay 尚未確認付款')
    });
  } catch (error) {
    if (error instanceof ecpayService.EcpayServiceError) {
      return res.status(error.statusCode).json({
        data: null,
        error: error.code,
        message: error.message
      });
    }
    return res.status(500).json({
      data: null,
      error: 'INTERNAL_ERROR',
      message: '查詢付款結果時發生錯誤'
    });
  }
});

module.exports = router;
