const { app, request, registerUser, getAdminToken } = require('./setup');
const ecpay = require('../src/services/ecpay');
const db = require('../src/database');

// Sign a form body the same way ECPay does
function sign(body) {
  const { hashKey, hashIv } = ecpay.getConfig();
  return { ...body, CheckMacValue: ecpay.generateCheckMacValue(body, hashKey, hashIv) };
}

// ATM number-taken notice (PaymentInfoURL / ClientRedirectURL), RtnCode=2
function atmInfoBody(merchantTradeNo, amount, fields = {}) {
  return sign({
    MerchantID: ecpay.getConfig().merchantId,
    MerchantTradeNo: merchantTradeNo,
    RtnCode: '2',
    RtnMsg: 'Get VirtualAccount Succeeded',
    TradeNo: '2610151300000001',
    TradeAmt: String(amount),
    PaymentType: 'ATM_TAISHIN',
    TradeDate: '2026/10/15 13:00:00',
    BankCode: '812',
    vAccount: '9103522175887271',
    ExpireDate: '2099/12/31',
    ...fields
  });
}

// Payment notice to ReturnURL
function paidNoticeBody(merchantTradeNo, amount, fields = {}) {
  return sign({
    MerchantID: ecpay.getConfig().merchantId,
    MerchantTradeNo: merchantTradeNo,
    RtnCode: '1',
    RtnMsg: '付款成功',
    TradeNo: '2610151300000001',
    TradeAmt: String(amount),
    PaymentDate: '2026/10/15 13:05:00',
    PaymentType: 'ATM_TAISHIN',
    PaymentTypeChargeFee: '0',
    TradeDate: '2026/10/15 13:00:00',
    SimulatePaid: '0',
    ...fields
  });
}

// Mock both ECPay query endpoints by URL; a fresh signed Response per call
function mockEcpay({ tradeInfo, paymentInfo }) {
  const { merchantId } = ecpay.getConfig();
  return vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
    const fields = String(url).includes('QueryPaymentInfo') ? paymentInfo : tradeInfo;
    if (!fields) throw new Error(`unexpected fetch ${url}`);
    const reply = sign({ MerchantID: merchantId, ...fields });
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
    .send({ recipientName: 'ATM 測試', recipientEmail: 'atm@example.com', recipientAddress: '台北市轉帳路 2 號' });
  return res.body.data;
}

function startPayment(token, orderId, body) {
  const req = request(app)
    .post(`/api/orders/${orderId}/ecpay`)
    .set('Authorization', `Bearer ${token}`);
  return body === undefined ? req : req.send(body);
}

async function getOrder(token, orderId) {
  const res = await request(app)
    .get(`/api/orders/${orderId}`)
    .set('Authorization', `Bearer ${token}`);
  return res.body.data;
}

function postForm(path, body) {
  return request(app).post(path).type('form').send(body);
}

describe('ECPay ATM payment', () => {
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

  it('should build ATM checkout params without OrderResultURL', async () => {
    const order = await createOrder(token);
    const res = await startPayment(token, order.id, { paymentMethod: 'ATM' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('error', null);
    const { params } = res.body.data;
    expect(params.ChoosePayment).toBe('ATM');
    expect(params.ExpireDate).toBe(String(ecpay.getConfig().atmExpireDays));
    expect(params.PaymentInfoURL).toMatch(/\/api\/ecpay\/payment-info$/);
    expect(params.ClientRedirectURL).toMatch(/\/ecpay\/payment-info-result$/);
    expect(params).not.toHaveProperty('OrderResultURL');
    expect(ecpay.verifyWithConfig(params)).toBe(true);

    const detail = await getOrder(token, order.id);
    expect(detail.payment).toMatchObject({ payment_method: 'ATM', status: 'pending', v_account: null });
  });

  it('should default to Credit when paymentMethod is omitted', async () => {
    const order = await createOrder(token);
    const res = await startPayment(token, order.id);

    expect(res.status).toBe(200);
    expect(res.body.data.params.ChoosePayment).toBe('Credit');
    expect(res.body.data.params).toHaveProperty('OrderResultURL');
    expect((await getOrder(token, order.id)).payment.payment_method).toBe('Credit');
  });

  it('should reject an unknown paymentMethod', async () => {
    const order = await createOrder(token);
    const res = await startPayment(token, order.id, { paymentMethod: 'Cash' });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('data', null);
    expect(res.body).toHaveProperty('error', 'VALIDATION_ERROR');
  });

  describe('number taken via PaymentInfoURL', () => {
    let order;
    let merchantTradeNo;

    beforeAll(async () => {
      order = await createOrder(token);
      const res = await startPayment(token, order.id, { paymentMethod: 'ATM' });
      merchantTradeNo = res.body.data.merchant_trade_no;
    });

    it('should reject a PaymentInfoURL notice with a bad CheckMacValue', async () => {
      const body = { ...atmInfoBody(merchantTradeNo, order.total_amount), CheckMacValue: '0'.repeat(64) };
      const res = await postForm('/api/ecpay/payment-info', body);

      expect(res.status).toBe(200);
      expect(res.text).not.toBe('1|OK');
      expect((await getOrder(token, order.id)).payment.v_account).toBeNull();
    });

    it('should store the ATM account on RtnCode=2 and keep the order pending', async () => {
      const res = await postForm('/api/ecpay/payment-info', atmInfoBody(merchantTradeNo, order.total_amount));

      expect(res.status).toBe(200);
      expect(res.text).toBe('1|OK');
      const detail = await getOrder(token, order.id);
      expect(detail.status).toBe('pending');
      expect(detail.payment).toEqual({
        payment_method: 'ATM',
        status: 'pending',
        bank_code: '812',
        v_account: '9103522175887271',
        expire_date: '2099/12/31',
        is_expired: false
      });
    });

    it('should handle a repeated PaymentInfoURL notice idempotently', async () => {
      const res = await postForm('/api/ecpay/payment-info', atmInfoBody(merchantTradeNo, order.total_amount));

      expect(res.text).toBe('1|OK');
      const detail = await getOrder(token, order.id);
      expect(detail.payment.v_account).toBe('9103522175887271');
      expect(detail.payment.status).toBe('pending');
    });

    it('should block any new payment while the ATM account is still valid', async () => {
      const atm = await startPayment(token, order.id, { paymentMethod: 'ATM' });
      const credit = await startPayment(token, order.id, { paymentMethod: 'Credit' });

      for (const res of [atm, credit]) {
        expect(res.status).toBe(409);
        expect(res.body).toHaveProperty('data', null);
        expect(res.body).toHaveProperty('error', 'CONFLICT');
      }
    });

    it('should allow paying again after the ATM account has expired', async () => {
      db.prepare('UPDATE payments SET expire_date = ? WHERE merchant_trade_no = ?').run('2000/01/01', merchantTradeNo);
      expect((await getOrder(token, order.id)).payment.is_expired).toBe(true);

      const res = await startPayment(token, order.id, { paymentMethod: 'Credit' });
      expect(res.status).toBe(200);
      expect(res.body.data.params.ChoosePayment).toBe('Credit');
    });
  });

  it('should store the account and redirect with ?payment=atm on ClientRedirectURL', async () => {
    const order = await createOrder(token);
    const start = await startPayment(token, order.id, { paymentMethod: 'ATM' });
    const body = atmInfoBody(start.body.data.merchant_trade_no, order.total_amount);

    const res = await postForm('/ecpay/payment-info-result', body);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/orders/${order.id}?payment=atm`);
    expect((await getOrder(token, order.id)).payment.v_account).toBe('9103522175887271');
  });

  it('should treat RtnCode=2 at ReturnURL as a number-taken notice, not a failure', async () => {
    const order = await createOrder(token);
    const start = await startPayment(token, order.id, { paymentMethod: 'ATM' });
    const body = atmInfoBody(start.body.data.merchant_trade_no, order.total_amount);

    const res = await postForm('/api/ecpay/notify', body);

    expect(res.text).toBe('1|OK');
    const detail = await getOrder(token, order.id);
    expect(detail.payment.status).toBe('pending');
    expect(detail.payment.v_account).toBe('9103522175887271');
  });

  describe('payment confirmation', () => {
    it('should fetch missing account info via QueryPaymentInfo and stay pending until transferred', async () => {
      const order = await createOrder(token);
      const start = await startPayment(token, order.id, { paymentMethod: 'ATM' });
      const merchantTradeNo = start.body.data.merchant_trade_no;
      const fetchSpy = mockEcpay({
        paymentInfo: {
          MerchantTradeNo: merchantTradeNo, RtnCode: '2', RtnMsg: 'Get VirtualAccount Succeeded',
          TradeNo: '2610151300000002', TradeAmt: String(order.total_amount), PaymentType: 'ATM_TAISHIN',
          BankCode: '812', vAccount: '9103522175880000', ExpireDate: '2099/12/31'
        },
        tradeInfo: {
          MerchantTradeNo: merchantTradeNo, TradeNo: '2610151300000002', TradeAmt: String(order.total_amount),
          PaymentType: 'ATM_TAISHIN', TradeStatus: '0'
        }
      });

      const res = await request(app)
        .post(`/api/orders/${order.id}/ecpay/query`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('尚未完成付款');
      expect(res.body.data.status).toBe('pending');
      expect(res.body.data.payment.v_account).toBe('9103522175880000');
      const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes('/Cashier/QueryPaymentInfo'))).toBe(true);
      expect(urls.some((u) => u.includes('/Cashier/QueryTradeInfo/V5'))).toBe(true);
    });

    it('should accept a simulated payment (SimulatePaid=1) outside production without querying', async () => {
      const order = await createOrder(token);
      const start = await startPayment(token, order.id, { paymentMethod: 'ATM' });
      const merchantTradeNo = start.body.data.merchant_trade_no;
      await postForm('/api/ecpay/payment-info', atmInfoBody(merchantTradeNo, order.total_amount));
      const fetchSpy = vi.spyOn(global, 'fetch');

      const res = await postForm('/api/ecpay/notify',
        paidNoticeBody(merchantTradeNo, order.total_amount, { SimulatePaid: '1' }));

      expect(res.text).toBe('1|OK');
      expect(fetchSpy).not.toHaveBeenCalled();
      expect((await getOrder(token, order.id)).status).toBe('paid');
      const row = db.prepare('SELECT status, simulate_paid FROM payments WHERE merchant_trade_no = ?').get(merchantTradeNo);
      expect(row).toEqual({ status: 'paid', simulate_paid: 1 });
    });

    it('should ignore a simulated payment in production', async () => {
      const order = await createOrder(token);
      const start = await startPayment(token, order.id, { paymentMethod: 'ATM' });
      const merchantTradeNo = start.body.data.merchant_trade_no;

      const previous = process.env.ECPAY_ENV;
      process.env.ECPAY_ENV = 'production';
      try {
        const res = await postForm('/api/ecpay/notify',
          paidNoticeBody(merchantTradeNo, order.total_amount, { SimulatePaid: '1' }));
        expect(res.text).toBe('1|OK');
      } finally {
        if (previous === undefined) delete process.env.ECPAY_ENV;
        else process.env.ECPAY_ENV = previous;
      }
      expect((await getOrder(token, order.id)).status).toBe('pending');

      // Same order: a simulated notice with the wrong amount is recorded as failed, order stays pending
      const mismatch = await postForm('/api/ecpay/notify',
        paidNoticeBody(merchantTradeNo, order.total_amount + 1, { SimulatePaid: '1' }));
      expect(mismatch.text).toBe('1|OK');
      expect((await getOrder(token, order.id)).status).toBe('pending');
    });

    it('should mark paid on a real ATM payment notice once QueryTradeInfo confirms it', async () => {
      const order = await createOrder(token);
      const start = await startPayment(token, order.id, { paymentMethod: 'ATM' });
      const merchantTradeNo = start.body.data.merchant_trade_no;
      await postForm('/api/ecpay/payment-info', atmInfoBody(merchantTradeNo, order.total_amount));
      const fetchSpy = mockEcpay({
        tradeInfo: {
          MerchantTradeNo: merchantTradeNo, TradeNo: '2610151300000001', TradeAmt: String(order.total_amount),
          PaymentDate: '2026/10/16 09:00:00', PaymentType: 'ATM_TAISHIN', TradeStatus: '1'
        }
      });

      const res = await postForm('/api/ecpay/notify', paidNoticeBody(merchantTradeNo, order.total_amount));

      expect(res.text).toBe('1|OK');
      expect(fetchSpy).toHaveBeenCalledOnce();
      const detail = await getOrder(token, order.id);
      expect(detail.status).toBe('paid');
      expect(detail.payment).toMatchObject({ payment_method: 'ATM', status: 'paid' });

      // Admin order detail exposes the same payment summary
      const adminToken = await getAdminToken();
      const admin = await request(app)
        .get(`/api/admin/orders/${order.id}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(admin.status).toBe(200);
      expect(admin.body.data.payment).toMatchObject({ payment_method: 'ATM', status: 'paid', v_account: '9103522175887271' });
    });
  });

  it("should not create an ATM payment for another user's order, or without login", async () => {
    const order = await createOrder(token);
    const { token: otherToken } = await registerUser();

    const other = await startPayment(otherToken, order.id, { paymentMethod: 'ATM' });
    expect(other.status).toBe(404);
    expect(other.body).toHaveProperty('data', null);

    const anonymous = await request(app).post(`/api/orders/${order.id}/ecpay`).send({ paymentMethod: 'ATM' });
    expect(anonymous.status).toBe(401);
  });
});
