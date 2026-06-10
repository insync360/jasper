import { LightningElement } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import getPendingPaymentOrders from '@salesforce/apex/WAPaymentController.getPendingPaymentOrders';
import sendPaymentReminder from '@salesforce/apex/WAPaymentController.sendPaymentReminder';

export default class WaPaymentReminders extends LightningElement {
    orders = [];
    loading = false;
    search = '';

    connectedCallback() {
        this.load();
    }

    async load() {
        this.loading = true;
        try {
            const os = await getPendingPaymentOrders();
            this.orders = (os || []).map((o) => ({ ...o, sending: false, sent: false }));
        } catch (e) {
            this.toast('Error', this.msg(e), 'error');
        } finally {
            this.loading = false;
        }
    }

    handleSearch(e) {
        this.search = (e.target.value || '').toLowerCase();
    }

    get filtered() {
        const s = this.search;
        const list = s
            ? this.orders.filter(
                  (o) =>
                      (o.name || '').toLowerCase().includes(s) ||
                      (o.orderNumber || '').toLowerCase().includes(s) ||
                      (o.vehicle || '').toLowerCase().includes(s)
              )
            : this.orders;
        return list.map((o) => ({
            ...o,
            btnLabel: o.sent ? 'Sent ✓' : 'Send Reminder',
            btnDisabled: o.sending || o.sent
        }));
    }
    get isEmpty() {
        return !this.loading && this.orders.length === 0;
    }
    get count() {
        return this.orders.length;
    }

    async handleSend(e) {
        const id = e.target.dataset.id;
        this.setRow(id, { sending: true });
        try {
            await sendPaymentReminder({ orderId: id });
            this.setRow(id, { sending: false, sent: true });
            this.toast('Sent', 'Payment reminder sent.', 'success');
        } catch (err) {
            this.setRow(id, { sending: false });
            this.toast('Error', this.msg(err), 'error');
        }
    }

    setRow(id, patch) {
        this.orders = this.orders.map((o) => (o.id === id ? { ...o, ...patch } : o));
    }

    msg(e) {
        return e && e.body ? e.body.message : e ? e.message : 'Error';
    }
    toast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
    }
}
