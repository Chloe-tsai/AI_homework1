const { app, request, registerUser } = require('./setup');
const ecpay = require('../src/services/ecpay');

// Sign a form body the same way ECPay does
function sign(body) {
  const { hashKey, hashIv } = ecpay.getConfig();
  return { ...body, CheckMacValue: ecpay.generateCheckMacValue(body, hashKey, hashIv) };
}

// WebATM payment notice (ReturnURL / OrderResultURL); WebATM is real-time like Credit
function webAtmNotice(merchantTradeNo, amount, fields = {}) {
  return sign({
    MerchantID: ecpay.getConfig().merchantId,
    MerchantTradeNo: merchantTradeNo,
    RtnCode: '1',
    RtnMsg: '交易成功',
    TradeNo: '2610151400000001',
    TradeAmt: String(amount),
    PaymentDate: '2026/10/15 14:00:00',
    PaymentType: 'WebATM_TAISHIN',
    PaymentTypeChargeFee: '0',
    TradeDate: '2026/10/15 13:59:00',
    SimulatePaid: '0',
    ...fields
  });
}

// Mock ECPay QueryTradeInfo with a signed reply; a fresh Response per call
function mockQueryTradeInfo(fields) {
  const { merchantId } = ecpay.getConfig();
  return vi.spyOn(global, 'fetch').mockImplementation(async () => {
    const reply = sign({ MerchantID: merchantId, TradeNo: '2610151400000001', PaymentType: 'WebATM_TAISHIN', ...fields });
    return new Response(new URLSearchParams(reply).toString(), { status: 200 });
  });
}

let productId;

async function createOrder(token) {
  await request(app)
    .post('/api/cart')
    .set('Authorization', `Bearer ${token}`)
    .send({ productId, quantity: 1 });

  const res = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${token}`)
    .send({ recipientName: 'WebATM 測試', recipientEmail: 'webatm@example.com', recipientAddress: '台北市網銀路 3 號' });
  return res.body.data;
}

function startPayment(token, orderId, paymentMethod) {
  return request(app)
    .post(`/api/orders/${orderId}/ecpay`)
    .set('Authorization', `Bearer ${token}`)
    .send({ paymentMethod });
}

async function getOrder(token, orderId) {
  const res = await request(app)
    .get(`/api/orders/${orderId}`)
    .set('Authorization', `Bearer ${token}`);
  return res.body.data;
}

describe('ECPay WebATM payment', () => {
  let token;

  beforeAll(async () => {
    ({ token } = await registerUser());
    // Use the product with the most stock so repeated runs don't drain the one other tests use
    const prodRes = await request(app).get('/api/products?limit=100');
    productId = prodRes.body.data.products.reduce((a, b) => (b.stock > a.stock ? b : a)).id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should build WebATM checkout params like a real-time method', async () => {
    const order = await createOrder(token);
    const res = await startPayment(token, order.id, 'WebATM');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('error', null);
    const { params } = res.body.data;
    expect(params.ChoosePayment).toBe('WebATM');
    expect(params.OrderResultURL).toMatch(/\/ecpay\/result$/);
    expect(params).not.toHaveProperty('ExpireDate');
    expect(params).not.toHaveProperty('PaymentInfoURL');
    expect(params).not.toHaveProperty('ClientRedirectURL');
    expect(ecpay.verifyWithConfig(params)).toBe(true);

    const detail = await getOrder(token, order.id);
    expect(detail.payment).toMatchObject({ payment_method: 'WebATM', status: 'pending', v_account: null, is_expired: false });
  });

  it('should list WebATM in the validation message for an unknown method', async () => {
    const order = await createOrder(token);
    const res = await startPayment(token, order.id, 'Cash');

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('data', null);
    expect(res.body).toHaveProperty('error', 'VALIDATION_ERROR');
    expect(res.body.message).toContain('WebATM');
  });

  it('should block WebATM while an ATM account is still valid', async () => {
    const order = await createOrder(token);
    const atm = await startPayment(token, order.id, 'ATM');
    await request(app).post('/api/ecpay/payment-info').type('form').send(sign({
      MerchantID: ecpay.getConfig().merchantId,
      MerchantTradeNo: atm.body.data.merchant_trade_no,
      RtnCode: '2',
      RtnMsg: 'Get VirtualAccount Succeeded',
      TradeNo: '2610151400000009',
      TradeAmt: String(order.total_amount),
      PaymentType: 'ATM_TAISHIN',
      TradeDate: '2026/10/15 14:00:00',
      BankCode: '812',
      vAccount: '9103522175887272',
      ExpireDate: '2099/12/31'
    }));

    const res = await startPayment(token, order.id, 'WebATM');
    expect(res.status).toBe(409);
    expect(res.body).toHaveProperty('error', 'CONFLICT');
  });

  it('should mark paid on a ReturnURL notice once QueryTradeInfo confirms it', async () => {
    const order = await createOrder(token);
    const start = await startPayment(token, order.id, 'WebATM');
    const merchantTradeNo = start.body.data.merchant_trade_no;
    const fetchSpy = mockQueryTradeInfo({
      MerchantTradeNo: merchantTradeNo, TradeAmt: String(order.total_amount),
      PaymentDate: '2026/10/15 14:00:00', TradeStatus: '1'
    });

    const res = await request(app).post('/api/ecpay/notify').type('form').send(webAtmNotice(merchantTradeNo, order.total_amount));

    expect(res.text).toBe('1|OK');
    expect(fetchSpy).toHaveBeenCalledOnce();
    const detail = await getOrder(token, order.id);
    expect(detail.status).toBe('paid');
    expect(detail.payment).toMatchObject({ payment_method: 'WebATM', status: 'paid' });
  });

  it('should redirect with ?payment=pending when OrderResultURL is not yet confirmed', async () => {
    const order = await createOrder(token);
    const start = await startPayment(token, order.id, 'WebATM');
    const merchantTradeNo = start.body.data.merchant_trade_no;
    mockQueryTradeInfo({ MerchantTradeNo: merchantTradeNo, TradeAmt: String(order.total_amount), TradeStatus: '0' });

    const res = await request(app).post('/ecpay/result').type('form').send(webAtmNotice(merchantTradeNo, order.total_amount));

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/orders/${order.id}?payment=pending`);
    expect((await getOrder(token, order.id)).status).toBe('pending');
  });

  it('should redirect with ?payment=success when OrderResultURL is confirmed', async () => {
    const order = await createOrder(token);
    const start = await startPayment(token, order.id, 'WebATM');
    const merchantTradeNo = start.body.data.merchant_trade_no;
    mockQueryTradeInfo({ MerchantTradeNo: merchantTradeNo, TradeAmt: String(order.total_amount), TradeStatus: '1' });

    const res = await request(app).post('/ecpay/result').type('form').send(webAtmNotice(merchantTradeNo, order.total_amount));

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/orders/${order.id}?payment=success`);
    expect((await getOrder(token, order.id)).status).toBe('paid');
  });
});
