const crypto = require('crypto');

const STAGE_BASE_URL = 'https://payment-stage.ecpay.com.tw';
const PRODUCTION_BASE_URL = 'https://payment.ecpay.com.tw';
const DEFAULT_STAGE_RETURN_URL = 'https://example.com/ecpay/notify';
const DEFAULT_TIMEOUT_MS = 10000;
const FORBIDDEN_TEXT_PATTERN = /(?:<[^>]*>|\b(?:echo|curl|wget|python|cmd|ping|telnet|chmod|chown|nmap|netcat|nc|rm|lsof|gcc|g\+\+)\b|[`|;])/i;

class EcpayServiceError extends Error {
  constructor(code, message, statusCode = 502) {
    super(message);
    this.name = 'EcpayServiceError';
    this.code = code;
    this.statusCode = statusCode;
    this.isOperational = true;
  }
}

function parseBoolean(value, defaultValue = false) {
  if (value === undefined) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function getConfig() {
  const merchantId = process.env.ECPAY_MERCHANT_ID;
  const hashKey = process.env.ECPAY_HASH_KEY;
  const hashIv = process.env.ECPAY_HASH_IV;
  const environment = String(process.env.ECPAY_ENV || 'staging').toLowerCase();
  const isStage = ['stage', 'staging', 'test'].includes(environment);
  const isProduction = ['prod', 'production'].includes(environment);

  if (!merchantId || !hashKey || !hashIv) {
    throw new EcpayServiceError(
      'ECPAY_NOT_CONFIGURED',
      'ECPay 尚未完成設定',
      503
    );
  }
  if (!isStage && !isProduction) {
    throw new EcpayServiceError(
      'ECPAY_CONFIG_INVALID',
      'ECPAY_ENV 必須為 staging 或 production',
      500
    );
  }

  const returnUrl = process.env.ECPAY_RETURN_URL || (isStage ? DEFAULT_STAGE_RETURN_URL : '');
  if (!returnUrl) {
    throw new EcpayServiceError(
      'ECPAY_CONFIG_INVALID',
      '正式環境必須設定 ECPAY_RETURN_URL',
      500
    );
  }

  const timeoutValue = Number.parseInt(process.env.ECPAY_QUERY_TIMEOUT_MS, 10);

  return {
    merchantId,
    hashKey,
    hashIv,
    environment: isStage ? 'staging' : 'production',
    baseUrl: isStage ? STAGE_BASE_URL : PRODUCTION_BASE_URL,
    returnUrl,
    simulatePaid: isStage && parseBoolean(process.env.ECPAY_SIMULATE_PAID, false),
    queryTimeoutMs: Number.isInteger(timeoutValue) && timeoutValue > 0
      ? timeoutValue
      : DEFAULT_TIMEOUT_MS
  };
}

/**
 * ECPay CMV URL encoding for AIO APIs.
 * Source: https://developers.ecpay.com.tw/2902/ (verified 2026-10-15)
 */
function ecpayUrlEncode(source) {
  let encoded = encodeURIComponent(source)
    .replace(/%20/g, '+')
    .replace(/~/g, '%7e')
    .replace(/'/g, '%27')
    .toLowerCase();

  const replacements = {
    '%2d': '-',
    '%5f': '_',
    '%2e': '.',
    '%21': '!',
    '%2a': '*',
    '%28': '(',
    '%29': ')'
  };

  for (const [escaped, character] of Object.entries(replacements)) {
    encoded = encoded.split(escaped).join(character);
  }
  return encoded;
}

function generateCheckMacValue(params, hashKey, hashIv) {
  const keys = Object.keys(params)
    .filter(key => key !== 'CheckMacValue' && params[key] !== undefined && params[key] !== null)
    .sort((left, right) => {
      const a = left.toLowerCase();
      const b = right.toLowerCase();
      if (a < b) return -1;
      if (a > b) return 1;
      return 0;
    });

  const parameterString = keys.map(key => `${key}=${params[key]}`).join('&');
  const raw = `HashKey=${hashKey}&${parameterString}&HashIV=${hashIv}`;
  return crypto
    .createHash('sha256')
    .update(ecpayUrlEncode(raw), 'utf8')
    .digest('hex')
    .toUpperCase();
}

function verifyCheckMacValue(params, hashKey, hashIv) {
  const received = String(params.CheckMacValue || '').toUpperCase();
  const expected = generateCheckMacValue(params, hashKey, hashIv);
  const receivedBuffer = Buffer.from(received, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');

  if (receivedBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

function getMerchantTradeDate(date = new Date()) {
  return date.toLocaleString('sv-SE', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).replace(/-/g, '/');
}

function generateMerchantTradeNo(now = Date.now()) {
  const timestamp = String(now).slice(-13).padStart(13, '0');
  const random = crypto.randomBytes(3).toString('hex').slice(0, 5).toUpperCase();
  return `FL${timestamp}${random}`;
}

function sanitizeText(value, fallback, maxLength) {
  const normalized = String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized || FORBIDDEN_TEXT_PATTERN.test(normalized)) return fallback;
  return Array.from(normalized).slice(0, maxLength).join('');
}

/**
 * Builds the fields that the browser must POST to AioCheckOut/V5.
 * Source: https://developers.ecpay.com.tw/2862/ (verified 2026-10-15)
 */
function buildCheckoutForm({ order, payment, items, baseUrl }) {
  const config = getConfig();
  const itemName = sanitizeText(
    items.map(item => item.product_name).join('#'),
    'Flower products',
    200
  );
  const localBaseUrl = String(baseUrl || process.env.BASE_URL || 'http://localhost:3001')
    .replace(/\/$/, '');

  const params = {
    MerchantID: config.merchantId,
    MerchantTradeNo: payment.merchant_trade_no,
    MerchantTradeDate: payment.merchant_trade_date,
    PaymentType: 'aio',
    TotalAmount: String(order.total_amount),
    TradeDesc: 'FlowerLifeOrder',
    ItemName: itemName,
    ReturnURL: config.returnUrl,
    ChoosePayment: 'Credit',
    EncryptType: '1',
    ClientBackURL: `${localBaseUrl}/orders/${encodeURIComponent(order.id)}?payment=return`,
    NeedExtraPaidInfo: 'N'
  };

  if (config.simulatePaid) params.SimulatePaid = '1';
  params.CheckMacValue = generateCheckMacValue(params, config.hashKey, config.hashIv);

  return {
    action: `${config.baseUrl}/Cashier/AioCheckOut/V5`,
    method: 'POST',
    fields: params
  };
}

function parseQueryResponse(body) {
  const params = new URLSearchParams(body);
  return Object.fromEntries(params.entries());
}

/**
 * Queries QueryTradeInfo/V5 and verifies the signed response.
 * Source: https://developers.ecpay.com.tw/2890/ (verified 2026-10-15)
 */
async function queryTradeInfo(merchantTradeNo, options = {}) {
  const config = getConfig();
  const requestParams = {
    MerchantID: config.merchantId,
    MerchantTradeNo: merchantTradeNo,
    TimeStamp: String(Math.floor(Date.now() / 1000))
  };
  requestParams.CheckMacValue = generateCheckMacValue(
    requestParams,
    config.hashKey,
    config.hashIv
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.queryTimeoutMs);
  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') {
    clearTimeout(timeout);
    throw new EcpayServiceError(
      'ECPAY_RUNTIME_UNSUPPORTED',
      '目前 Node.js 版本不支援 ECPay 查詢所需的 fetch',
      500
    );
  }

  let response;
  try {
    response = await fetchImpl(`${config.baseUrl}/Cashier/QueryTradeInfo/V5`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(requestParams).toString(),
      signal: controller.signal
    });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new EcpayServiceError('ECPAY_TIMEOUT', 'ECPay 查詢逾時', 504);
    }
    throw new EcpayServiceError('ECPAY_UNAVAILABLE', '無法連線至 ECPay', 502);
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 403) {
    throw new EcpayServiceError(
      'ECPAY_RATE_LIMITED',
      'ECPay 暫時限制查詢頻率，請稍後再試',
      429
    );
  }
  if (!response.ok) {
    throw new EcpayServiceError(
      'ECPAY_UNAVAILABLE',
      `ECPay 查詢失敗（HTTP ${response.status}）`,
      502
    );
  }

  const body = await response.text();
  const result = parseQueryResponse(body);
  if (!result.CheckMacValue || !verifyCheckMacValue(result, config.hashKey, config.hashIv)) {
    throw new EcpayServiceError(
      'ECPAY_RESPONSE_INVALID',
      'ECPay 查詢結果簽章驗證失敗',
      502
    );
  }
  if (result.MerchantID !== config.merchantId || result.MerchantTradeNo !== merchantTradeNo) {
    throw new EcpayServiceError(
      'ECPAY_RESPONSE_MISMATCH',
      'ECPay 查詢結果與本地交易不符',
      502
    );
  }

  return result;
}

module.exports = {
  EcpayServiceError,
  buildCheckoutForm,
  ecpayUrlEncode,
  generateCheckMacValue,
  generateMerchantTradeNo,
  getConfig,
  getMerchantTradeDate,
  parseQueryResponse,
  queryTradeInfo,
  sanitizeText,
  verifyCheckMacValue
};
