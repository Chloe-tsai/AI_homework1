const { createApp, ref, computed, onMounted } = Vue;

createApp({
  setup() {
    if (!Auth.requireAuth()) return {};

    const el = document.getElementById('app');
    const orderId = el.dataset.orderId;
    const paymentResult = ref(el.dataset.paymentResult || null);

    const order = ref(null);
    const loading = ref(true);
    const paying = ref(false); // false | 'Credit' | 'ATM' | 'WebATM'
    // ECPay WebATM needs a desktop browser with a card reader; mobile is not supported
    const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    const checking = ref(false);
    const isProduction = el.dataset.ecpayEnv === 'production';

    const statusMap = {
      pending: { label: '待付款', cls: 'bg-apricot/20 text-apricot' },
      paid: { label: '已付款', cls: 'bg-sage/20 text-sage' },
      failed: { label: '付款失敗', cls: 'bg-red-100 text-red-600' },
    };

    const paymentMessages = {
      success: { text: '付款成功！感謝您的購買。', cls: 'bg-sage/10 text-sage border border-sage/20' },
      failed: { text: '付款失敗，請重試。', cls: 'bg-red-50 text-red-600 border border-red-100' },
      cancel: { text: '付款已取消。', cls: 'bg-apricot/10 text-apricot border border-apricot/20' },
      pending: { text: '正在向綠界確認付款結果，請稍候…', cls: 'bg-apricot/10 text-apricot border border-apricot/20' },
      atm: { text: '已取得 ATM 繳費帳號，請於期限內完成轉帳。', cls: 'bg-sage/10 text-sage border border-sage/20' },
    };

    // A valid ATM account replaces the payment buttons (the API also refuses new payments with 409)
    const atmActive = computed(function () {
      const p = order.value && order.value.payment;
      return Boolean(p && p.payment_method === 'ATM' && p.status === 'pending' && p.v_account && !p.is_expired);
    });

    // Server confirms with ECPay QueryTradeInfo; retry a few times while the bank settles
    const CONFIRM_RETRIES = 5;
    const CONFIRM_INTERVAL_MS = 3000;

    // Submit the signed AIO form as a full-page POST (ECPay forbids iframes)
    function submitEcpayForm(actionUrl, params) {
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = actionUrl;
      form.style.display = 'none';
      Object.keys(params).forEach(function (key) {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = key;
        input.value = params[key];
        form.appendChild(input);
      });
      document.body.appendChild(form);
      form.submit();
    }

    async function payWithEcpay(method) {
      if (!order.value || paying.value) return;
      paying.value = method;
      try {
        const res = await apiFetch('/api/orders/' + order.value.id + '/ecpay', {
          method: 'POST',
          body: JSON.stringify({ paymentMethod: method })
        });
        if (!res) return;
        submitEcpayForm(res.data.action_url, res.data.params);
      } catch (e) {
        Notification.show(e?.data?.message || '無法建立付款，請稍後再試', 'error');
        paying.value = false;
        // 409: an ATM account is still valid; reload so the transfer info is shown
        if (e?.status === 409) refreshPaymentStatus(true);
      }
    }

    async function copyAccount() {
      try {
        await navigator.clipboard.writeText(order.value.payment.v_account);
        Notification.show('已複製虛擬帳號', 'success');
      } catch (e) {
        Notification.show('複製失敗，請手動選取帳號', 'warning');
      }
    }

    async function refreshPaymentStatus(silent) {
      if (!order.value || checking.value) return;
      checking.value = true;
      try {
        const res = await apiFetch('/api/orders/' + order.value.id + '/ecpay/query', { method: 'POST' });
        if (!res) return;
        order.value = res.data;
        if (res.data.status === 'paid') {
          paymentResult.value = 'success';
        } else if (!silent) {
          Notification.show(atmActive.value ? '尚未收到轉帳款項' : '綠界尚未確認付款', 'info');
        }
      } catch (e) {
        if (!silent) Notification.show(e?.data?.message || '查詢付款狀態失敗', 'error');
      } finally {
        checking.value = false;
      }
    }

    async function confirmUntilSettled() {
      for (let i = 0; i < CONFIRM_RETRIES; i++) {
        await refreshPaymentStatus(true);
        if (!order.value || order.value.status !== 'pending') return;
        await new Promise(function (resolve) { setTimeout(resolve, CONFIRM_INTERVAL_MS); });
      }
      if (paymentResult.value === 'pending') paymentResult.value = null;
      Notification.show('尚未確認付款，請稍後按「重新查詢付款狀態」', 'warning');
    }

    onMounted(async function () {
      try {
        const res = await apiFetch('/api/orders/' + orderId);
        order.value = res.data;
        // Back from ECPay but not confirmed yet: keep asking the server to query ECPay
        if (order.value.status === 'pending' && paymentResult.value === 'pending') {
          confirmUntilSettled();
        } else if (order.value.status === 'pending' && paymentResult.value === 'atm') {
          // Transfer happens later; only fetch the account info if it has not arrived yet
          if (!atmActive.value) refreshPaymentStatus(true);
        } else if (order.value.status === 'pending' && paymentResult.value) {
          refreshPaymentStatus(true);
        }
      } catch (e) {
        Notification.show('載入訂單失敗', 'error');
      } finally {
        loading.value = false;
      }
    });

    return { order, loading, paying, checking, isProduction, isMobile, paymentResult, statusMap, paymentMessages, atmActive, payWithEcpay, copyAccount, refreshPaymentStatus };
  }
}).mount('#app');
