import { LightningElement } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import getApprovedTemplates from '@salesforce/apex/WACampaignController.getApprovedTemplates';
import getCatalogVehicles from '@salesforce/apex/WACampaignController.getCatalogVehicles';
import getRecipients from '@salesforce/apex/WACampaignController.getRecipients';
import sendVehiclePromo from '@salesforce/apex/WACampaignController.sendVehiclePromo';

const DEFAULT_TEMPLATE = 'jasper_price_alert';

export default class WaVehiclePromo extends LightningElement {
    templateOptions = [];
    templatesByName = {};
    selectedTemplate = '';
    platinumOnly = false;
    vehicles = [];
    vehicleId = '';
    recipients = [];
    selected = new Set();
    search = '';
    hotOnly = false;
    loadingVehicles = false;
    loadingRecipients = false;
    sending = false;
    result;

    connectedCallback() {
        this.loadTemplates();
        this.loadVehicles();
        this.loadRecipients();
    }

    async loadTemplates() {
        try {
            const resp = await getApprovedTemplates();
            const parsed = JSON.parse(resp);
            const tpls = ((parsed && parsed.templates) || []).filter((t) => t.status === 'APPROVED');
            this.templateOptions = tpls.map((t) => ({ label: `${t.name} (${t.category})`, value: t.name }));
            this.templatesByName = {};
            tpls.forEach((t) => (this.templatesByName[t.name] = t));
            if (this.templatesByName[DEFAULT_TEMPLATE]) this.selectedTemplate = DEFAULT_TEMPLATE;
            else if (tpls.length) this.selectedTemplate = tpls[0].name;
        } catch (e) {
            this.toast('Error', this.msg(e), 'error');
        }
    }

    async loadVehicles() {
        this.loadingVehicles = true;
        try {
            const vs = await getCatalogVehicles({ platinumOnly: this.platinumOnly });
            this.vehicles = vs || [];
            if (!this.vehicles.find((v) => v.id === this.vehicleId)) {
                this.vehicleId = this.vehicles.length ? this.vehicles[0].id : '';
            }
        } catch (e) {
            this.toast('Error', this.msg(e), 'error');
        } finally {
            this.loadingVehicles = false;
        }
    }

    get vehicleOptions() {
        return this.vehicles.map((v) => ({
            label: v.name + (v.price ? ' — ' + v.price : '') + (v.platinum ? '  ★' : ''),
            value: v.id
        }));
    }
    get noVehicles() {
        return !this.loadingVehicles && this.vehicles.length === 0;
    }

    async loadRecipients() {
        this.loadingRecipients = true;
        try {
            const rs = await getRecipients({ stage: 'Enquiries' });
            this.recipients = (rs || []).map((r) => ({ ...r, key: r.id }));
        } catch (e) {
            this.toast('Error', this.msg(e), 'error');
        } finally {
            this.loadingRecipients = false;
        }
    }

    handleTemplate(e) {
        this.selectedTemplate = e.detail.value;
        this.result = undefined;
    }
    handlePlatinumToggle(e) {
        this.platinumOnly = e.target.checked;
        this.loadVehicles();
    }
    handleVehicle(e) {
        this.vehicleId = e.detail.value;
    }
    handleSearch(e) {
        this.search = (e.target.value || '').toLowerCase();
    }
    handleHotToggle(e) {
        this.hotOnly = e.target.checked;
    }

    get filteredRecipients() {
        const s = this.search;
        let list = this.hotOnly ? this.recipients.filter((r) => r.hot) : this.recipients;
        if (s) {
            list = list.filter(
                (r) =>
                    (r.name || '').toLowerCase().includes(s) ||
                    (r.phone || '').includes(s) ||
                    (r.info || '').toLowerCase().includes(s)
            );
        }
        return list.map((r) => ({ ...r, checked: this.selected.has(r.id) }));
    }

    get hotCount() {
        return this.recipients.filter((r) => r.hot).length;
    }
    get selectedCount() {
        return this.selected.size;
    }
    get allFilteredSelected() {
        const f = this.filteredRecipients;
        return f.length > 0 && f.every((r) => this.selected.has(r.id));
    }

    handleToggle(e) {
        const id = e.target.dataset.id;
        if (e.target.checked) this.selected.add(id);
        else this.selected.delete(id);
        this.selected = new Set(this.selected);
    }
    handleSelectAll(e) {
        const on = e.target.checked;
        for (const r of this.filteredRecipients) {
            if (on) this.selected.add(r.id);
            else this.selected.delete(r.id);
        }
        this.selected = new Set(this.selected);
    }

    get canSend() {
        return !!this.selectedTemplate && !!this.vehicleId && this.selected.size > 0 && !this.sending;
    }
    get sendDisabled() {
        return !this.canSend;
    }

    async handleSend() {
        const chosen = this.recipients
            .filter((r) => this.selected.has(r.id))
            .map((r) => ({ id: r.id, name: r.name, phone: r.phone }));
        if (!chosen.length || !this.vehicleId || !this.selectedTemplate) return;
        const tpl = this.templatesByName[this.selectedTemplate];
        this.sending = true;
        this.result = undefined;
        try {
            const res = await sendVehiclePromo({
                templateName: this.selectedTemplate,
                language: (tpl && tpl.language) || 'en',
                vehicleId: this.vehicleId,
                recipientsJson: JSON.stringify(chosen)
            });
            this.result = `✅ Sent: ${res.sent}   ❌ Failed: ${res.failed}`;
            this.toast('Done', this.result, res.failed ? 'warning' : 'success');
        } catch (e) {
            this.toast('Error', this.msg(e), 'error');
        } finally {
            this.sending = false;
        }
    }

    msg(e) {
        return e && e.body ? e.body.message : e ? e.message : 'Error';
    }
    toast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
    }
}
