process.env.ECPAY_MERCHANT_ID = '3002607';
process.env.ECPAY_HASH_KEY = 'pwFHCqoQZGmho4w6';
process.env.ECPAY_HASH_IV = 'EkRm7iFT261dpevs';
process.env.ECPAY_ENV = 'staging';

const { app, request, registerUser } = require('./setup');
const ecpayService = require('../src/services/ecpayService');

describe('ECPay service', () => {
  it('should generate the official SHA256 CheckMacValue test vector', () => {
    const params = {
      MerchantID: '3002607',
      MerchantTradeNo: 'Test1234567890',
      MerchantTradeDate: '2025/01/01 12:00:00',
      PaymentType: 'aio',
      TotalAmount: '100',
      TradeDesc: '測試',
      ItemName: '測試商品',
      ReturnURL: 'https://example.com/notify',
      ChoosePayment: 'ALL',
      EncryptType: '1'
    };

    expect(ecpayService.generateCheckMacValue(
      params,
      'pwFHCqoQZGmho4w6',
      'EkRm7iFT261dpevs'
    )).toBe('291CBA324D31FB5A4BBBFDF2CFE5D32598524753AFD4959C3BF590C5B2F57FB2');
  });

  it('should verify a signed QueryTradeInfo response', async () => {
    const config = ecpayService.getConfig();
    const merchantTradeNo = 'FL123456789012345678';
    const responseParams = {
      MerchantID: config.merchantId,
      MerchantTradeNo: merchantTradeNo,
      TradeNo: '2401011234567890',
      TradeAmt: '100',
      PaymentDate: '2026/10/15 12:00:00',
      PaymentType: 'Credit_CreditCard',
      TradeDate: '2026/10/15 11:59:00',
      TradeStatus: '1',
      ItemName: '測試商品'
    };
    responseParams.CheckMacValue = ecpayService.generateCheckMacValue(
      responseParams,
      config.hashKey,
      config.hashIv
    );

    const fetchImpl = vi.fn(async (_url, options) => {
      const sent = Object.fromEntries(new URLSearchParams(options.body).entries());
      expect(sent.MerchantID).toBe(config.merchantId);
      expect(sent.MerchantTradeNo).toBe(merchantTradeNo);
      expect(ecpayService.verifyCheckMacValue(sent, config.hashKey, config.hashIv)).toBe(true);
      return {
        status: 200,
        ok: true,
        text: async () => new URLSearchParams(responseParams).toString()
      };
    });

    const result = await ecpayService.queryTradeInfo(merchantTradeNo, { fetchImpl });
    expect(result.TradeStatus).toBe('1');
    expect(result.TradeAmt).toBe('100');
  });
});

describe('ECPay order payment API', () => {
  let token;
  let orderId;
  let totalAmount;
  let merchantTradeNo;

  beforeAll(async () => {
    const registered = await registerUser();
    token = registered.token;

    const products = await request(app).get('/api/products');
    const product = products.body.data.products.find(item => item.stock > 0);
    await request(app)
      .post('/api/cart')
      .set('Authorization', `Bearer ${token}`)
      .send({ productId: product.id, quantity: 1 });

    const order = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({
        recipientName: 'ECPay 測試收件人',
        recipientEmail: 'ecpay@example.com',
        recipientAddress: '台北市測試路 789 號'
      });
    orderId = order.body.data.id;
    totalAmount = order.body.data.total_amount;

    const payment = await request(app)
      .post(`/api/orders/${orderId}/payments/ecpay`)
      .set('Authorization', `Bearer ${token}`);
    merchantTradeNo = payment.body.data.payment.merchant_trade_no;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should create a signed ECPay checkout form for an owned pending order', async () => {
    const res = await request(app)
      .post(`/api/orders/${orderId}/payments/ecpay`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();
    expect(res.body.data.payment.provider).toBe('ecpay');
    expect(res.body.data.payment.merchant_trade_no).toBe(merchantTradeNo);
    expect(res.body.data.payment.amount).toBe(totalAmount);
    expect(res.body.data.checkout.action).toContain('/Cashier/AioCheckOut/V5');
    expect(res.body.data.checkout.fields.ChoosePayment).toBe('Credit');
    expect(res.body.data.checkout.fields.TotalAmount).toBe(String(totalAmount));
    expect(res.body.data.checkout.fields.CheckMacValue).toMatch(/^[A-F0-9]{64}$/);
  });

  it('should mark the order paid only after a verified server-side query', async () => {
    vi.spyOn(ecpayService, 'queryTradeInfo').mockResolvedValue({
      MerchantID: process.env.ECPAY_MERCHANT_ID,
      MerchantTradeNo: merchantTradeNo,
      TradeNo: '2610151234567890',
      TradeAmt: String(totalAmount),
      PaymentDate: '2026/10/15 12:34:56',
      PaymentType: 'Credit_CreditCard',
      TradeStatus: '1'
    });

    const res = await request(app)
      .post(`/api/orders/${orderId}/payments/ecpay/verify`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();
    expect(res.body.data.order.status).toBe('paid');
    expect(res.body.data.payment.status).toBe('paid');

    const detail = await request(app)
      .get(`/api/orders/${orderId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(detail.body.data.status).toBe('paid');
    expect(detail.body.data.payment.status).toBe('paid');
  });

  it('should no longer accept the client-controlled simulated payment endpoint', async () => {
    const res = await request(app)
      .patch(`/api/orders/${orderId}/pay`)
      .set('Authorization', `Bearer ${token}`)
      .send({ action: 'success' });

    expect(res.status).toBe(404);
  });
});
