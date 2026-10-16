const express = require('express');
const db = require('../database');
const ecpay = require('../services/ecpay');

// ECPay callbacks. These are called by ECPay (server-to-server) or by the
// browser coming back from the ECPay payment page, so they use no JWT;
// authenticity is checked with CheckMacValue instead.
const router = express.Router();

// Express 4 does not catch rejected promises; forward them to errorHandler
const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ATM virtual account issued (not paid yet) — this is NOT a failure (https://developers.ecpay.com.tw/2881.md)
const RTN_ATM_NUMBER_TAKEN = '2';

function ack(res, text = '1|OK') {
  return res.status(200).type('text/plain').send(text);
}

function atmInfoFromBody(body) {
  return {
    merchantTradeNo: body.MerchantTradeNo,
    tradeNo: body.TradeNo,
    bankCode: body.BankCode,
    vAccount: body.vAccount,
    expireDate: body.ExpireDate
  };
}

function findPayment(merchantTradeNo) {
  return db.prepare('SELECT * FROM payments WHERE merchant_trade_no = ?').get(String(merchantTradeNo || ''));
}

/**
 * @openapi
 * /api/ecpay/notify:
 *   post:
 *     summary: 綠界付款結果通知（ReturnURL，Server-to-Server）
 *     description: 綠界以 Form POST 通知付款結果，依綠界規格回應純文字（此端點不使用統一 JSON 格式）。RtnCode=1 時以 QueryTradeInfo 確認後才標記已付款；非正式環境另接受後台模擬付款（SimulatePaid=1）。RtnCode=2（ATM 取號）視為取號通知、不是失敗。需 BASE_URL 可公開存取（port 80/443）才會收到。
 *     tags: [ECPay]
 *     requestBody:
 *       required: true
 *       content:
 *         application/x-www-form-urlencoded:
 *           schema:
 *             type: object
 *             properties:
 *               MerchantTradeNo:
 *                 type: string
 *               RtnCode:
 *                 type: string
 *               TradeAmt:
 *                 type: string
 *               CheckMacValue:
 *                 type: string
 *     responses:
 *       200:
 *         description: 純文字 `1|OK`；`0|CheckMacValue Error`、`0|Not Paid Yet`、`0|QueryTradeInfo Error` 會讓綠界重送
 *         content:
 *           text/plain:
 *             schema:
 *               type: string
 */
router.post('/api/ecpay/notify', asyncHandler(async (req, res) => {
  const body = req.body || {};
  if (!ecpay.verifyWithConfig(body)) {
    console.error('ECPay notify: CheckMacValue mismatch for', body.MerchantTradeNo);
    return ack(res, '0|CheckMacValue Error');
  }

  const rtnCode = String(body.RtnCode);

  if (rtnCode === RTN_ATM_NUMBER_TAKEN) {
    // Defensive: an ATM number-taken notice reaching ReturnURL must not be recorded as a failure
    ecpay.saveAtmInfo(atmInfoFromBody(body));
    return ack(res);
  }

  if (rtnCode !== '1') {
    // Payment failed: record it (order stays pending), nothing to confirm
    const result = ecpay.applyPaymentResult(ecpay.fromCallbackBody(body));
    if (result.status === 'not_found') {
      console.error('ECPay notify: unknown MerchantTradeNo', body.MerchantTradeNo);
    }
    return ack(res);
  }

  if (String(body.SimulatePaid) === '1') {
    // Back-office simulation: QueryTradeInfo never reports it as paid, so it can only be accepted from the notice
    if (ecpay.acceptsSimulatedPayment()) {
      const result = ecpay.applyPaymentResult(ecpay.fromCallbackBody(body));
      if (result.status === 'not_found') {
        console.error('ECPay notify: unknown MerchantTradeNo', body.MerchantTradeNo);
      }
    } else {
      console.error('ECPay notify: ignored SimulatePaid=1 notice in production', body.MerchantTradeNo);
    }
    return ack(res);
  }

  // Success notice: confirm with QueryTradeInfo before marking the order paid
  let confirmed;
  try {
    confirmed = await ecpay.confirmPayment(body.MerchantTradeNo);
  } catch (err) {
    // Not acknowledging makes ECPay resend later (up to 4 times)
    console.error('ECPay notify: QueryTradeInfo failed for', body.MerchantTradeNo, err.message);
    return ack(res, '0|QueryTradeInfo Error');
  }

  if (confirmed.status === 'not_found') {
    console.error('ECPay notify: unknown MerchantTradeNo', body.MerchantTradeNo);
  } else if (confirmed.status === 'unpaid') {
    console.error('ECPay notify: QueryTradeInfo not paid yet', body.MerchantTradeNo, confirmed.tradeStatus);
    return ack(res, '0|Not Paid Yet');
  }

  ack(res);
}));

/**
 * @openapi
 * /api/ecpay/payment-info:
 *   post:
 *     summary: 綠界 ATM 取號結果通知（PaymentInfoURL，Server-to-Server）
 *     description: 消費者在綠界選擇 ATM 並取號後，綠界以 Form POST 送出 BankCode、vAccount、ExpireDate。RtnCode=2 為取號成功（不是錯誤），寫入付款紀錄；其他 RtnCode 記錄為取號失敗（訂單維持 pending）。依綠界規格回純文字 `1|OK`。需 BASE_URL 可公開存取才會收到。
 *     tags: [ECPay]
 *     requestBody:
 *       required: true
 *       content:
 *         application/x-www-form-urlencoded:
 *           schema:
 *             type: object
 *             properties:
 *               MerchantTradeNo:
 *                 type: string
 *               RtnCode:
 *                 type: string
 *               BankCode:
 *                 type: string
 *               vAccount:
 *                 type: string
 *               ExpireDate:
 *                 type: string
 *               CheckMacValue:
 *                 type: string
 *     responses:
 *       200:
 *         description: 純文字 `1|OK`（CheckMacValue 驗證失敗時為 `0|CheckMacValue Error`）
 *         content:
 *           text/plain:
 *             schema:
 *               type: string
 */
router.post('/api/ecpay/payment-info', (req, res) => {
  const body = req.body || {};
  if (!ecpay.verifyWithConfig(body)) {
    console.error('ECPay payment-info: CheckMacValue mismatch for', body.MerchantTradeNo);
    return ack(res, '0|CheckMacValue Error');
  }

  if (!findPayment(body.MerchantTradeNo)) {
    console.error('ECPay payment-info: unknown MerchantTradeNo', body.MerchantTradeNo);
    return ack(res);
  }

  if (String(body.RtnCode) === RTN_ATM_NUMBER_TAKEN) {
    ecpay.saveAtmInfo(atmInfoFromBody(body));
  } else {
    ecpay.applyPaymentResult(ecpay.fromCallbackBody(body));
  }
  ack(res);
});

/**
 * @openapi
 * /ecpay/payment-info-result:
 *   post:
 *     summary: 綠界 ATM 取號後導回（ClientRedirectURL，瀏覽器 Form POST）
 *     description: 取號完成後綠界讓瀏覽器帶著繳費資訊回到本站（localhost 也可用）。驗證 CheckMacValue，RtnCode=2 時寫入繳費資訊並 302 至 `/orders/{id}?payment=atm`；取號失敗至 `?payment=failed`；簽章錯誤或查無付款至 `/orders?payment=failed`。
 *     tags: [ECPay]
 *     requestBody:
 *       required: true
 *       content:
 *         application/x-www-form-urlencoded:
 *           schema:
 *             type: object
 *     responses:
 *       302:
 *         description: 導向訂單詳情頁
 */
router.post('/ecpay/payment-info-result', (req, res) => {
  const body = req.body || {};
  if (!ecpay.verifyWithConfig(body)) {
    console.error('ECPay payment-info-result: CheckMacValue mismatch for', body.MerchantTradeNo);
    return res.redirect('/orders?payment=failed');
  }

  const payment = findPayment(body.MerchantTradeNo);
  if (!payment) {
    return res.redirect('/orders?payment=failed');
  }
  // Use the order id from our own payment record, not the posted CustomField1
  const orderUrl = `/orders/${encodeURIComponent(payment.order_id)}`;

  if (String(body.RtnCode) === RTN_ATM_NUMBER_TAKEN) {
    ecpay.saveAtmInfo(atmInfoFromBody(body));
    return res.redirect(`${orderUrl}?payment=atm`);
  }

  ecpay.applyPaymentResult(ecpay.fromCallbackBody(body));
  res.redirect(`${orderUrl}?payment=failed`);
});

/**
 * @openapi
 * /ecpay/result:
 *   post:
 *     summary: 綠界付款完成導回（OrderResultURL，瀏覽器 Form POST）
 *     description: 消費者付款後由瀏覽器帶回結果。驗證 CheckMacValue 並更新訂單後，302 導向 `/orders/{id}?payment=success|failed`。
 *     tags: [ECPay]
 *     requestBody:
 *       required: true
 *       content:
 *         application/x-www-form-urlencoded:
 *           schema:
 *             type: object
 *     responses:
 *       302:
 *         description: 導向訂單詳情頁
 */
router.post('/ecpay/result', asyncHandler(async (req, res) => {
  const body = req.body || {};
  if (!ecpay.verifyWithConfig(body)) {
    console.error('ECPay result: CheckMacValue mismatch for', body.MerchantTradeNo);
    return res.redirect('/orders?payment=failed');
  }

  const payment = db.prepare('SELECT * FROM payments WHERE merchant_trade_no = ?')
    .get(String(body.MerchantTradeNo || ''));
  if (!payment) {
    return res.redirect('/orders?payment=failed');
  }
  // Use the order id from our own payment record, not the posted CustomField1
  const orderUrl = `/orders/${encodeURIComponent(payment.order_id)}`;

  if (String(body.RtnCode) !== '1') {
    ecpay.applyPaymentResult(ecpay.fromCallbackBody(body));
    return res.redirect(`${orderUrl}?payment=failed`);
  }

  // Success redirect: confirm with QueryTradeInfo before marking the order paid
  let outcome;
  try {
    const confirmed = await ecpay.confirmPayment(payment.merchant_trade_no);
    outcome = confirmed.status === 'paid' ? 'success'
      : confirmed.status === 'failed' ? 'failed'
      : 'pending';
  } catch (err) {
    console.error('ECPay result: QueryTradeInfo failed for', payment.merchant_trade_no, err.message);
    // The order page retries the query on load
    outcome = 'pending';
  }

  res.redirect(`${orderUrl}?payment=${outcome}`);
}));

module.exports = router;
