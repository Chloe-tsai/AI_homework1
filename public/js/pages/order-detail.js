const { createApp, ref, onMounted } = Vue;

createApp({
  setup() {
    if (!Auth.requireAuth()) return {};

    const el = document.getElementById('app');
    const orderId = el.dataset.orderId;
    const paymentResult = ref(el.dataset.paymentResult || null);

    const order = ref(null);
    const payment = ref(null);
    const loading = ref(true);
    const paying = ref(false);
    const verifying = ref(false);

    const statusMap = {
      pending: { label: '待付款', cls: 'bg-apricot/20 text-apricot' },
      paid: { label: '已付款', cls: 'bg-sage/20 text-sage' },
      failed: { label: '付款失敗', cls: 'bg-red-100 text-red-600' },
    };

    const paymentMessages = {
      success: { text: '付款成功！感謝您的購買。', cls: 'bg-sage/10 text-sage border border-sage/20' },
      failed: { text: '綠界已確認交易失敗；此訂單無法再次付款，請重新下單。', cls: 'bg-red-50 text-red-600 border border-red-100' },
      cancel: { text: '付款已取消。', cls: 'bg-apricot/10 text-apricot border border-apricot/20' },
      return: { text: '您已返回商店。請按「查詢付款結果」，由本機伺服器向綠界驗證交易。', cls: 'bg-apricot/10 text-apricot border border-apricot/20' },
      pending: { text: '綠界尚未確認付款；請稍後再查詢，避免過於頻繁。', cls: 'bg-apricot/10 text-apricot border border-apricot/20' },
    };

    async function startEcpayPayment() {
      if (!order.value || paying.value) return;
      paying.value = true;
      try {
        const res = await apiFetch('/api/orders/' + order.value.id + '/payments/ecpay', {
          method: 'POST'
        });
        payment.value = res.data.payment;

        const checkout = res.data.checkout;
        const form = document.createElement('form');
        form.method = checkout.method;
        form.action = checkout.action;
        for (const [name, value] of Object.entries(checkout.fields)) {
          const input = document.createElement('input');
          input.type = 'hidden';
          input.name = name;
          input.value = value;
          form.appendChild(input);
        }
        document.body.appendChild(form);
        form.submit();
      } catch (err) {
        Notification.show(err?.data?.message || '無法建立綠界付款', 'error');
      } finally {
        paying.value = false;
      }
    }

    async function verifyEcpayPayment() {
      if (!order.value || verifying.value) return;
      verifying.value = true;
      try {
        const res = await apiFetch('/api/orders/' + order.value.id + '/payments/ecpay/verify', {
          method: 'POST'
        });
        order.value = { ...order.value, ...res.data.order };
        payment.value = res.data.payment;
        paymentResult.value = payment.value.status === 'paid'
          ? 'success'
          : (payment.value.status === 'failed' ? 'failed' : 'pending');
        Notification.show(res.message, payment.value.status === 'paid' ? 'success' : 'info');
      } catch (err) {
        Notification.show(err?.data?.message || '查詢付款結果失敗', 'error');
      } finally {
        verifying.value = false;
      }
    }

    onMounted(async function () {
      try {
        const res = await apiFetch('/api/orders/' + orderId);
        order.value = res.data;
        payment.value = res.data.payment;
      } catch (e) {
        Notification.show('載入訂單失敗', 'error');
      } finally {
        loading.value = false;
      }
    });

    return {
      order, payment, loading, paying, verifying, paymentResult,
      statusMap, paymentMessages, startEcpayPayment, verifyEcpayPayment
    };
  }
}).mount('#app');
