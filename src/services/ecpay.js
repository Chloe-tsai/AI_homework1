// ECPay AIO (全方位金流) helpers — CMV-SHA256 protocol.
// Spec: https://developers.ecpay.com.tw/2862.md (產生訂單), https://developers.ecpay.com.tw/2858.md (介接注意事項)
// CheckMacValue implementation follows .claude/skills/ecpay/guides/13-checkmacvalue.md (Node.js section).
const crypto = require('crypto');
const db = require('../database');

// Public ECPay staging credentials, used only when env vars are missing
const TEST_MERCHANT_ID = '3002607';
const TEST_HASH_KEY = 'pwFHCqoQZGmho4w6';
const TEST_HASH_IV = 'EkRm7iFT261dpevs';

function getConfig() {
  const isProduction = process.env.ECPAY_ENV === 'production';
  const host = isProduction ? 'https://payment.ecpay.com.tw' : 'https://payment-stage.ecpay.com.tw';
  return {
    merchantId: process.env.ECPAY_MERCHANT_ID || TEST_MERCHANT_ID,
    hashKey: process.env.ECPAY_HASH_KEY || TEST_HASH_KEY,
    hashIv: process.env.ECPAY_HASH_IV || TEST_HASH_IV,
    isProduction,
    checkoutUrl: `${host}/Cashier/AioCheckOut/V5`,
    queryUrl: `${host}/Cashier/QueryTradeInfo/V5`,
    paymentInfoQueryUrl: `${host}/Cashier/QueryPaymentInfo`,
    baseUrl: (process.env.BASE_URL || 'http://localhost:3001').replace(/\/+$/, ''),
    atmExpireDays: clampInt(process.env.ECPAY_ATM_EXPIRE_DAYS, 1, 60, 3)
  };
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Credit and WebATM are real-time (OrderResultURL + QueryTradeInfo); ATM is asynchronous (number first, payment later)
const PAYMENT_METHODS = ['Credit', 'ATM', 'WebATM'];

// urlencode -> lowercase -> restore .NET characters (must match PHP SDK UrlService::ecpayUrlEncode)
function ecpayUrlEncode(source) {
  let encoded = encodeURIComponent(source).replace(/%20/g, '+').replace(/~/g, '%7e').replace(/'/g, '%27');
  encoded = encoded.toLowerCase();
  const replacements = {
    '%2d': '-', '%5f': '_', '%2e': '.', '%21': '!',
    '%2a': '*', '%28': '(', '%29': ')'
  };
  for (const [from, to] of Object.entries(replacements)) {
    encoded = encoded.split(from).join(to);
  }
  return encoded;
}

function generateCheckMacValue(params, hashKey, hashIv, method = 'sha256') {
  const filtered = Object.fromEntries(
    Object.entries(params).filter(([k]) => k !== 'CheckMacValue')
  );
  const sorted = Object.keys(filtered)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const paramStr = sorted.map(k => `${k}=${filtered[k]}`).join('&');
  const raw = `HashKey=${hashKey}&${paramStr}&HashIV=${hashIv}`;
  const encoded = ecpayUrlEncode(raw);
  return crypto.createHash(method).update(encoded, 'utf8').digest('hex').toUpperCase();
}

// Timing-safe comparison of the received CheckMacValue
function verifyCheckMacValue(params, hashKey, hashIv, method = 'sha256') {
  if (!params || typeof params.CheckMacValue !== 'string') return false;
  const calculated = generateCheckMacValue(params, hashKey, hashIv, method);
  const a = Buffer.from(params.CheckMacValue.toUpperCase());
  const b = Buffer.from(calculated);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function verifyWithConfig(params) {
  const { hashKey, hashIv } = getConfig();
  return verifyCheckMacValue(params, hashKey, hashIv);
}

// MerchantTradeDate must be Taiwan time (UTC+8) regardless of server timezone
function formatTaipeiDate(date = new Date()) {
  const t = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}/${pad(t.getUTCMonth() + 1)}/${pad(t.getUTCDate())} ` +
    `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`;
}

// FL + yyMMddHHmmss (Taipei) + 6 random alphanumerics = 20 chars, alphanumeric only
function generateMerchantTradeNo(date = new Date()) {
  const stamp = formatTaipeiDate(date).replace(/[^0-9]/g, '').slice(2);
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(6);
  let suffix = '';
  for (const b of bytes) suffix += chars[b % chars.length];
  return `FL${stamp}${suffix}`;
}

// Strip HTML tags, control chars and characters ECPay rejects; '#' separates items
function sanitizeText(text) {
  return String(text)
    .replace(/<[^>]*>/g, '')
    .replace(/[\x00-\x1F\x7F]/g, '')
    .replace(/[#&<>|;`'"]/g, '')
    .trim();
}

function buildItemName(items) {
  const name = items
    .map(i => `${sanitizeText(i.product_name)} x ${i.quantity}`)
    .join('#');
  // Keep under 200 chars so ECPay never truncates (truncation breaks CheckMacValue)
  return Array.from(name).slice(0, 200).join('') || '花漾生活商品';
}

// method: 'Credit' | 'ATM' | 'WebATM'. Spec: https://developers.ecpay.com.tw/2862.md,
// ATM: https://developers.ecpay.com.tw/2872.md, WebATM (desktop only, card reader): https://developers.ecpay.com.tw/11031.md
function buildCheckoutParams(order, items, merchantTradeNo, method = 'Credit') {
  const config = getConfig();
  const params = {
    MerchantID: config.merchantId,
    MerchantTradeNo: merchantTradeNo,
    MerchantTradeDate: formatTaipeiDate(),
    PaymentType: 'aio',
    TotalAmount: String(order.total_amount),
    TradeDesc: '花漾生活訂單',
    ItemName: buildItemName(items),
    ReturnURL: `${config.baseUrl}/api/ecpay/notify`,
    ChoosePayment: method,
    EncryptType: '1',
    NeedExtraPaidInfo: 'N',
    CustomField1: order.id
  };
  if (method === 'ATM') {
    // ATM is asynchronous: account info first (PaymentInfoURL / ClientRedirectURL), payment later (ReturnURL).
    // OrderResultURL is not supported for ATM.
    params.ExpireDate = String(config.atmExpireDays);
    params.PaymentInfoURL = `${config.baseUrl}/api/ecpay/payment-info`;
    params.ClientRedirectURL = `${config.baseUrl}/ecpay/payment-info-result`;
  } else {
    params.OrderResultURL = `${config.baseUrl}/ecpay/result`;
  }
  params.CheckMacValue = generateCheckMacValue(params, config.hashKey, config.hashIv);
  return { actionUrl: config.checkoutUrl, params };
}

// Signed MerchantTradeNo lookup used by QueryTradeInfo and QueryPaymentInfo (TimeStamp valid for 3 minutes)
async function postSignedQuery(url, merchantTradeNo, label) {
  const config = getConfig();
  const params = {
    MerchantID: config.merchantId,
    MerchantTradeNo: merchantTradeNo,
    TimeStamp: String(Math.floor(Date.now() / 1000))
  };
  params.CheckMacValue = generateCheckMacValue(params, config.hashKey, config.hashIv);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString()
  });
  if (!res.ok) {
    throw new Error(`ECPay ${label} HTTP ${res.status}`);
  }
  const text = await res.text();
  const result = Object.fromEntries(new URLSearchParams(text));
  if (!verifyCheckMacValue(result, config.hashKey, config.hashIv)) {
    throw new Error(`ECPay ${label} CheckMacValue mismatch`);
  }
  if (result.MerchantTradeNo !== merchantTradeNo || result.MerchantID !== config.merchantId) {
    throw new Error(`ECPay ${label} returned a different trade`);
  }
  return result;
}

// Ask ECPay for the trade status (works from localhost)
function queryTradeInfo(merchantTradeNo) {
  return postSignedQuery(getConfig().queryUrl, merchantTradeNo, 'QueryTradeInfo');
}

// Ask ECPay for ATM account info (https://developers.ecpay.com.tw/5615.md); not returned once paid
function queryPaymentInfo(merchantTradeNo) {
  return postSignedQuery(getConfig().paymentInfoQueryUrl, merchantTradeNo, 'QueryPaymentInfo');
}

// Shared by ReturnURL, OrderResultURL and QueryTradeInfo; idempotent per MerchantTradeNo
const applyPaymentResult = db.transaction((result) => {
  const payment = db.prepare('SELECT * FROM payments WHERE merchant_trade_no = ?')
    .get(String(result.merchantTradeNo || ''));
  if (!payment) return { status: 'not_found', payment: null };

  if (payment.status === 'paid') {
    return { status: 'paid', payment };
  }

  const succeeded = String(result.rtnCode) === '1' && Number(result.tradeAmt) === payment.amount;

  if (succeeded) {
    db.prepare(
      `UPDATE payments
       SET status = 'paid', trade_no = ?, payment_type = ?, rtn_code = ?, rtn_msg = ?,
           paid_at = ?, simulate_paid = ?
       WHERE id = ?`
    ).run(
      result.tradeNo || null, result.paymentType || null, String(result.rtnCode),
      result.rtnMsg || null, result.paymentDate || null,
      result.simulatePaid === undefined ? null : Number(result.simulatePaid) || 0,
      payment.id
    );
    db.prepare("UPDATE orders SET status = 'paid' WHERE id = ? AND status = 'pending'").run(payment.order_id);
  } else {
    // Card declined / amount mismatch: keep the order pending so the user can retry
    const msg = String(result.rtnCode) === '1' ? '付款金額與訂單不符' : (result.rtnMsg || null);
    db.prepare(
      `UPDATE payments SET status = 'failed', trade_no = ?, rtn_code = ?, rtn_msg = ? WHERE id = ?`
    ).run(result.tradeNo || null, result.rtnCode === undefined ? null : String(result.rtnCode), msg, payment.id);
  }

  const updated = db.prepare('SELECT * FROM payments WHERE id = ?').get(payment.id);
  return { status: updated.status, payment: updated };
});

// Server-side confirmation: the only path that can mark a payment paid.
// Callbacks are treated as a hint; ECPay's QueryTradeInfo is the source of truth.
// Returns { status: 'paid' | 'failed' | 'unpaid' | 'not_found', payment, tradeStatus }
// and throws when ECPay cannot be reached or its reply fails CheckMacValue.
async function confirmPayment(merchantTradeNo) {
  const payment = db.prepare('SELECT * FROM payments WHERE merchant_trade_no = ?')
    .get(String(merchantTradeNo || ''));
  if (!payment) return { status: 'not_found', payment: null };
  if (payment.status === 'paid') return { status: 'paid', payment };

  // Throws on network error, bad CheckMacValue or a reply for a different trade
  const result = await queryTradeInfo(payment.merchant_trade_no);

  // TradeStatus: 1 = paid, 0 = not paid yet (bank may still be confirming), 10200095 = not established
  if (result.TradeStatus !== '1') {
    return { status: 'unpaid', payment, tradeStatus: result.TradeStatus };
  }

  const applied = applyPaymentResult({
    merchantTradeNo: result.MerchantTradeNo,
    rtnCode: '1',
    rtnMsg: 'QueryTradeInfo TradeStatus=1',
    tradeNo: result.TradeNo,
    tradeAmt: result.TradeAmt,
    paymentType: result.PaymentType,
    paymentDate: result.PaymentDate
  });
  return { ...applied, tradeStatus: result.TradeStatus };
}

// ATM number-taken notice (RtnCode=2) from PaymentInfoURL, ClientRedirectURL, ReturnURL or QueryPaymentInfo.
// Only fills a pending ATM payment; repeated notices write the same values (idempotent).
// Returns the updated payment row, or null when there is no matching pending ATM payment.
const saveAtmInfo = db.transaction(({ merchantTradeNo, tradeNo, bankCode, vAccount, expireDate }) => {
  const payment = db.prepare('SELECT * FROM payments WHERE merchant_trade_no = ?')
    .get(String(merchantTradeNo || ''));
  if (!payment || payment.payment_method !== 'ATM' || payment.status !== 'pending' || !vAccount) {
    return payment || null;
  }
  db.prepare(
    `UPDATE payments
     SET bank_code = ?, v_account = ?, expire_date = ?, trade_no = COALESCE(?, trade_no), rtn_code = '2'
     WHERE id = ?`
  ).run(bankCode || null, String(vAccount), expireDate || null, tradeNo || null, payment.id);
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(payment.id);
});

// ExpireDate is yyyy/MM/dd (deadline 23:59:59 Taiwan time that day); tolerate a full timestamp too
function isAtmExpired(payment, now = new Date()) {
  if (!payment || !payment.expire_date) return false;
  const value = String(payment.expire_date).trim();
  const deadline = value.length > 10 ? value : `${value.slice(0, 10)} 23:59:59`;
  return formatTaipeiDate(now) > deadline;
}

// An ATM account the shopper may still transfer to; blocks starting another payment for the order
function isAtmActive(payment, now = new Date()) {
  return Boolean(payment) &&
    payment.payment_method === 'ATM' &&
    payment.status === 'pending' &&
    Boolean(payment.v_account) &&
    !isAtmExpired(payment, now);
}

function getLatestPayment(orderId) {
  return db.prepare(
    'SELECT * FROM payments WHERE order_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1'
  ).get(orderId) || null;
}

// Public view of the latest payment for order detail responses (snake_case)
function summarizePayment(payment) {
  if (!payment) return null;
  return {
    payment_method: payment.payment_method,
    status: payment.status,
    bank_code: payment.bank_code,
    v_account: payment.v_account,
    expire_date: payment.expire_date,
    is_expired: payment.payment_method === 'ATM' ? isAtmExpired(payment) : false
  };
}

// Simulated payments (ECPay back-office 模擬付款, SimulatePaid=1) never change ECPay's own trade status,
// so QueryTradeInfo cannot confirm them. Accept them outside production only, for testing.
function acceptsSimulatedPayment() {
  return !getConfig().isProduction;
}

// Map an AIO callback body (ReturnURL / OrderResultURL) to applyPaymentResult input
function fromCallbackBody(body) {
  return {
    merchantTradeNo: body.MerchantTradeNo,
    rtnCode: body.RtnCode,
    rtnMsg: body.RtnMsg,
    tradeNo: body.TradeNo,
    tradeAmt: body.TradeAmt,
    paymentType: body.PaymentType,
    paymentDate: body.PaymentDate,
    simulatePaid: body.SimulatePaid
  };
}

module.exports = {
  getConfig,
  ecpayUrlEncode,
  generateCheckMacValue,
  verifyCheckMacValue,
  verifyWithConfig,
  formatTaipeiDate,
  generateMerchantTradeNo,
  buildCheckoutParams,
  queryTradeInfo,
  queryPaymentInfo,
  applyPaymentResult,
  confirmPayment,
  saveAtmInfo,
  isAtmExpired,
  isAtmActive,
  getLatestPayment,
  summarizePayment,
  acceptsSimulatedPayment,
  fromCallbackBody,
  PAYMENT_METHODS
};
