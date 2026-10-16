const { app, request, registerUser } = require('./setup');
const ecpay = require('../src/services/ecpay');

const HASH_KEY = 'pwFHCqoQZGmho4w6';
const HASH_IV = 'EkRm7iFT261dpevs';

// Official vectors from the ECPay skill (test-vectors/checkmacvalue.json)
const VECTORS = [
  {
    params: {
      MerchantID: '3002607', MerchantTradeNo: 'Test1234567890', MerchantTradeDate: '2025/01/01 12:00:00',
      PaymentType: 'aio', TotalAmount: '100', TradeDesc: '測試', ItemName: '測試商品',
      ReturnURL: 'https://example.com/notify', ChoosePayment: 'ALL', EncryptType: '1'
    },
    expected: '291CBA324D31FB5A4BBBFDF2CFE5D32598524753AFD4959C3BF590C5B2F57FB2'
  },
  {
    params: { MerchantID: '3002607', ItemName: "Tom's Shop", TotalAmount: '100' },
    expected: 'CF0A3D4901D99459D8641516EC57210700E8A5C9AB26B1D021301E9CB93EF78D'
  },
  {
    params: { MerchantID: '3002607', ItemName: 'My Test Product', TotalAmount: '300' },
    expected: '7712A5E6EDC3B57086063C88568084C66CE882A21D40E74DE5ACA3B478C6F316'
  }
];

// Build a callback body signed the same way ECPay would
function signedCallback(fields) {
  const body = {
    MerchantID: ecpay.getConfig().merchantId,
    RtnCode: '1',
    RtnMsg: '交易成功',
    TradeNo: '2510151200000001',
    PaymentDate: '2026/10/15 12:00:00',
    PaymentType: 'Credit_CreditCard',
    PaymentTypeChargeFee: '0',
    TradeDate: '2026/10/15 11:59:00',
    SimulatePaid: '0',
    ...fields
  };
  const { hashKey, hashIv } = ecpay.getConfig();
  body.CheckMacValue = ecpay.generateCheckMacValue(body, hashKey, hashIv);
  return body;
}

// Mock ECPay's QueryTradeInfo reply (signed like the real one); a fresh Response per call
function mockQueryTradeInfo(fields) {
  const { hashKey, hashIv, merchantId } = ecpay.getConfig();
  const reply = {
    MerchantID: merchantId,
    TradeNo: '2510151200000002',
    PaymentDate: '2026/10/15 12:00:00',
    PaymentType: 'Credit_CreditCard',
    ...fields
  };
  reply.CheckMacValue = ecpay.generateCheckMacValue(reply, hashKey, hashIv);
  return vi.spyOn(global, 'fetch').mockImplementation(async () =>
    new Response(new URLSearchParams(reply).toString(), { status: 200 })
  );
}

async function createOrder(token) {
  const prodRes = await request(app).get('/api/products?limit=100');
  const product = prodRes.body.data.products.find((p) => p.stock > 0);

  await request(app)
    .post('/api/cart')
    .set('Authorization', `Bearer ${token}`)
    .send({ productId: product.id, quantity: 1 });

  const orderRes = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${token}`)
    .send({ recipientName: '綠界測試', recipientEmail: 'ecpay@example.com', recipientAddress: '台北市付款路 1 號' });

  return orderRes.body.data;
}

async function startPayment(token, orderId) {
  return request(app)
    .post(`/api/orders/${orderId}/ecpay`)
    .set('Authorization', `Bearer ${token}`);
}

async function getOrder(token, orderId) {
  const res = await request(app)
    .get(`/api/orders/${orderId}`)
    .set('Authorization', `Bearer ${token}`);
  return res.body.data;
}

describe('ECPay CheckMacValue', () => {
  it('should match the official SHA256 test vectors', () => {
    for (const v of VECTORS) {
      expect(ecpay.generateCheckMacValue(v.params, HASH_KEY, HASH_IV)).toBe(v.expected);
    }
  });

  it('should verify and reject tampered params', () => {
    const params = { ...VECTORS[0].params, CheckMacValue: VECTORS[0].expected };
    expect(ecpay.verifyCheckMacValue(params, HASH_KEY, HASH_IV)).toBe(true);
    expect(ecpay.verifyCheckMacValue({ ...params, TotalAmount: '1' }, HASH_KEY, HASH_IV)).toBe(false);
    expect(ecpay.verifyCheckMacValue({ ...params, CheckMacValue: 'abc' }, HASH_KEY, HASH_IV)).toBe(false);
  });

  it('should format MerchantTradeDate in Taiwan time', () => {
    expect(ecpay.formatTaipeiDate(new Date('2026-10-15T16:30:05Z'))).toBe('2026/10/16 00:30:05');
  });
});

describe('ECPay Payment API', () => {
  let token;
  let order;

  beforeAll(async () => {
    ({ token } = await registerUser());
    order = await createOrder(token);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should build signed AIO checkout params', async () => {
    const res = await startPayment(token, order.id);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('error', null);
    const { action_url, params } = res.body.data;
    expect(action_url).toContain('/Cashier/AioCheckOut/V5');
    expect(action_url).toContain('payment-stage');
    expect(params.TotalAmount).toBe(String(order.total_amount));
    expect(params.MerchantTradeNo).toMatch(/^[A-Za-z0-9]{1,20}$/);
    expect(params.ChoosePayment).toBe('Credit');
    expect(params.PaymentType).toBe('aio');
    expect(params.EncryptType).toBe('1');
    expect(params.CustomField1).toBe(order.id);
    expect(params.ReturnURL).toMatch(/\/api\/ecpay\/notify$/);
    expect(params.OrderResultURL).toMatch(/\/ecpay\/result$/);
    expect(params.MerchantTradeDate).toMatch(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(ecpay.verifyWithConfig(params)).toBe(true);
  });

  it('should generate a new MerchantTradeNo on every attempt', async () => {
    const a = await startPayment(token, order.id);
    const b = await startPayment(token, order.id);
    expect(a.body.data.params.MerchantTradeNo).not.toBe(b.body.data.params.MerchantTradeNo);
  });

  it("should not create payment for another user's order", async () => {
    const { token: otherToken } = await registerUser();
    const res = await startPayment(otherToken, order.id);
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('data', null);
  });

  it('should require login', async () => {
    const res = await request(app).post(`/api/orders/${order.id}/ecpay`);
    expect(res.status).toBe(401);
  });

  it('should reject notify with invalid CheckMacValue', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    const start = await startPayment(token, order.id);
    const body = signedCallback({
      MerchantTradeNo: start.body.data.merchant_trade_no,
      TradeAmt: String(order.total_amount)
    });
    body.CheckMacValue = '0'.repeat(64);

    const res = await request(app).post('/api/ecpay/notify').type('form').send(body);
    expect(res.status).toBe(200);
    expect(res.text).not.toBe('1|OK');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await getOrder(token, order.id)).status).toBe('pending');
  });

  it('should not mark paid when QueryTradeInfo says unpaid, even with a signed success callback', async () => {
    const start = await startPayment(token, order.id);
    const merchantTradeNo = start.body.data.merchant_trade_no;
    const fetchSpy = mockQueryTradeInfo({ MerchantTradeNo: merchantTradeNo, TradeAmt: String(order.total_amount), TradeStatus: '0' });
    const body = signedCallback({ MerchantTradeNo: merchantTradeNo, TradeAmt: String(order.total_amount) });

    const notify = await request(app).post('/api/ecpay/notify').type('form').send(body);
    expect(notify.status).toBe(200);
    expect(notify.text).not.toBe('1|OK'); // ECPay will resend later

    const result = await request(app).post('/ecpay/result').type('form').send(body);
    expect(result.status).toBe(302);
    expect(result.headers.location).toBe(`/orders/${order.id}?payment=pending`);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect((await getOrder(token, order.id)).status).toBe('pending');
  });

  it('should not acknowledge notify when QueryTradeInfo is unreachable', async () => {
    const start = await startPayment(token, order.id);
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network down'));
    const body = signedCallback({ MerchantTradeNo: start.body.data.merchant_trade_no, TradeAmt: String(order.total_amount) });

    const res = await request(app).post('/api/ecpay/notify').type('form').send(body);
    expect(res.status).toBe(200);
    expect(res.text).not.toBe('1|OK');
    expect((await getOrder(token, order.id)).status).toBe('pending');
  });

  it('should keep order pending when QueryTradeInfo amount does not match', async () => {
    const start = await startPayment(token, order.id);
    const merchantTradeNo = start.body.data.merchant_trade_no;
    mockQueryTradeInfo({ MerchantTradeNo: merchantTradeNo, TradeAmt: String(order.total_amount + 1), TradeStatus: '1' });
    const body = signedCallback({ MerchantTradeNo: merchantTradeNo, TradeAmt: String(order.total_amount) });

    const res = await request(app).post('/ecpay/result').type('form').send(body);
    expect(res.headers.location).toBe(`/orders/${order.id}?payment=failed`);
    expect((await getOrder(token, order.id)).status).toBe('pending');
  });

  it('should keep order pending when payment fails, without querying', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    const start = await startPayment(token, order.id);
    const body = signedCallback({
      MerchantTradeNo: start.body.data.merchant_trade_no,
      TradeAmt: String(order.total_amount),
      RtnCode: '10100058',
      RtnMsg: '付款失敗'
    });

    const res = await request(app).post('/ecpay/result').type('form').send(body);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/orders/${order.id}?payment=failed`);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await getOrder(token, order.id)).status).toBe('pending');
  });

  it('should mark order paid after QueryTradeInfo confirms notify, and reply 1|OK idempotently', async () => {
    const start = await startPayment(token, order.id);
    const merchantTradeNo = start.body.data.merchant_trade_no;
    const fetchSpy = mockQueryTradeInfo({ MerchantTradeNo: merchantTradeNo, TradeAmt: String(order.total_amount), TradeStatus: '1' });
    const body = signedCallback({ MerchantTradeNo: merchantTradeNo, TradeAmt: String(order.total_amount) });

    const res = await request(app).post('/api/ecpay/notify').type('form').send(body);
    expect(res.status).toBe(200);
    expect(res.text).toBe('1|OK');
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0][0]).toContain('/Cashier/QueryTradeInfo/V5');
    const sent = Object.fromEntries(new URLSearchParams(fetchSpy.mock.calls[0][1].body));
    expect(sent.MerchantTradeNo).toBe(merchantTradeNo);
    expect(ecpay.verifyWithConfig(sent)).toBe(true);
    expect((await getOrder(token, order.id)).status).toBe('paid');

    // Resent notice: already paid, no second query
    const again = await request(app).post('/api/ecpay/notify').type('form').send(body);
    expect(again.text).toBe('1|OK');
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect((await getOrder(token, order.id)).status).toBe('paid');
  });

  it('should not start payment for a paid order', async () => {
    const res = await startPayment(token, order.id);
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error', 'INVALID_STATUS');
  });

  it('should redirect with success after QueryTradeInfo confirms OrderResultURL', async () => {
    const newOrder = await createOrder(token);
    const start = await startPayment(token, newOrder.id);
    const merchantTradeNo = start.body.data.merchant_trade_no;
    mockQueryTradeInfo({ MerchantTradeNo: merchantTradeNo, TradeAmt: String(newOrder.total_amount), TradeStatus: '1' });
    const body = signedCallback({ MerchantTradeNo: merchantTradeNo, TradeAmt: String(newOrder.total_amount) });

    const res = await request(app).post('/ecpay/result').type('form').send(body);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/orders/${newOrder.id}?payment=success`);
    expect((await getOrder(token, newOrder.id)).status).toBe('paid');
  });

  it('should redirect to order list when OrderResultURL CheckMacValue is invalid', async () => {
    const res = await request(app)
      .post('/ecpay/result')
      .type('form')
      .send({ MerchantTradeNo: 'FLNOTEXIST', RtnCode: '1', CheckMacValue: 'bad' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/orders?payment=failed');
  });

  it('should sync paid status from QueryTradeInfo', async () => {
    const newOrder = await createOrder(token);
    const start = await startPayment(token, newOrder.id);
    const fetchSpy = mockQueryTradeInfo({
      MerchantTradeNo: start.body.data.merchant_trade_no,
      TradeAmt: String(newOrder.total_amount),
      TradeStatus: '1'
    });

    const res = await request(app)
      .post(`/api/orders/${newOrder.id}/ecpay/query`)
      .set('Authorization', `Bearer ${token}`);

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('error', null);
    expect(res.body.data).toHaveProperty('status', 'paid');
    expect(Array.isArray(res.body.data.items)).toBe(true);
  });

  it('should reject a QueryTradeInfo reply for a different trade', async () => {
    const newOrder = await createOrder(token);
    await startPayment(token, newOrder.id);
    mockQueryTradeInfo({ MerchantTradeNo: 'FLSOMEOTHERTRADE0001', TradeAmt: String(newOrder.total_amount), TradeStatus: '1' });

    const res = await request(app)
      .post(`/api/orders/${newOrder.id}/ecpay/query`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(502);
    expect((await getOrder(token, newOrder.id)).status).toBe('pending');
  });

  it('should return 502 when ECPay query fails', async () => {
    const newOrder = await createOrder(token);
    await startPayment(token, newOrder.id);
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network down'));

    const res = await request(app)
      .post(`/api/orders/${newOrder.id}/ecpay/query`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(502);
    expect(res.body).toHaveProperty('error', 'PAYMENT_GATEWAY_ERROR');
    expect((await getOrder(token, newOrder.id)).status).toBe('pending');
  });
});
