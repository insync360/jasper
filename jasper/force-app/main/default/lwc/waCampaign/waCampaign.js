import { LightningElement, api, track } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import getApprovedTemplates from '@salesforce/apex/WACampaignController.getApprovedTemplates';
import getRecipients from '@salesforce/apex/WACampaignController.getRecipients';
import sendCampaign from '@salesforce/apex/WACampaignController.sendCampaign';

const COLUMNS_ENQUIRY = [
    { label: 'Name', fieldName: 'name' },
    { label: 'Phone', fieldName: 'phone' },
    { label: 'Status', fieldName: 'info' }
];
const COLUMNS_ORDER = [
    { label: 'Name', fieldName: 'name' },
    { label: 'Phone', fieldName: 'phone' },
    { label: 'Vehicle', fieldName: 'vehicle' },
    { label: 'Order #', fieldName: 'orderNumber' },
    { label: 'Amount', fieldName: 'amount' },
    { label: 'Status', fieldName: 'info' }
];

export default class WaCampaign extends LightningElement {
    @api stage = 'Enquiries';

    columns = COLUMNS_ENQUIRY;
    templateOptions = [];
    templatesByName = {};
    selectedTemplate = '';
    @track preview = null;
    @track recipients = [];
    allRecipients = [];
    infoOptions = [{ label: 'All', value: 'All' }];
    selectedInfo = 'All';
    searchTerm = '';
    selectedRows = [];
    selectedRowIds = [];
    sending = false;
    loading = false;
    needsImage = false;
    headerImageUrl = 'https://www.jasperindustries.com/uploads/model/full/cfee116def375e4e78e3148d241e92e7.jpg';

    connectedCallback() {
        this.columns = this.stage === 'Enquiries' ? COLUMNS_ENQUIRY : COLUMNS_ORDER;
        this.loadTemplates();
        this.loadRecipients();
    }

    get title() {
        return `${this.stage} — WhatsApp Campaign`;
    }
    get sendLabel() {
        return `Send to ${this.selectedRows.length} selected`;
    }
    get sendDisabled() {
        return this.sending || !this.selectedTemplate || this.selectedRows.length === 0;
    }
    get hasPreview() {
        return this.preview !== null;
    }
    get recipientCount() {
        return this.recipients.length;
    }
    get selectedCount() {
        return this.selectedRows.length;
    }

    async loadTemplates() {
        try {
            const resp = await getApprovedTemplates();
            const parsed = JSON.parse(resp);
            const tpls = ((parsed && parsed.templates) || []).filter((t) => t.status === 'APPROVED');
            this.templateOptions = tpls.map((t) => ({ label: `${t.name} (${t.category})`, value: t.name }));
            this.templatesByName = {};
            tpls.forEach((t) => {
                this.templatesByName[t.name] = t;
            });
        } catch (e) {
            this.toast('Error', this.msg(e), 'error');
        }
    }

    async loadRecipients() {
        this.loading = true;
        try {
            const data = await getRecipients({ stage: this.stage });
            this.allRecipients = (data || []).map((r) => ({ ...r, id: r.id }));
            // Build the Info filter options from distinct values.
            const distinct = [...new Set(this.allRecipients.map((r) => r.info).filter((v) => v))].sort();
            this.infoOptions = [{ label: 'All', value: 'All' }, ...distinct.map((v) => ({ label: v, value: v }))];
            this.selectedInfo = 'All';
            this.applyFilter();
        } catch (e) {
            this.toast('Error', this.msg(e), 'error');
        } finally {
            this.loading = false;
        }
    }

    applyFilter() {
        let rows =
            this.selectedInfo === 'All'
                ? this.allRecipients
                : this.allRecipients.filter((r) => r.info === this.selectedInfo);
        const term = (this.searchTerm || '').toLowerCase().trim();
        if (term) {
            rows = rows.filter(
                (r) =>
                    (r.name || '').toLowerCase().includes(term) ||
                    (r.phone || '').toLowerCase().includes(term) ||
                    (r.info || '').toLowerCase().includes(term)
            );
        }
        this.recipients = rows;
        // Reset selection when the filter/search changes.
        this.selectedRowIds = [];
        this.selectedRows = [];
    }

    handleInfoFilter(event) {
        this.selectedInfo = event.detail.value;
        this.applyFilter();
    }

    handleSearch(event) {
        this.searchTerm = event.target.value;
        this.applyFilter();
    }

    handleSelectAll() {
        this.selectedRowIds = this.recipients.map((r) => r.id);
        this.selectedRows = [...this.recipients];
    }

    handleClearSelection() {
        this.selectedRowIds = [];
        this.selectedRows = [];
    }

    handleTemplateChange(event) {
        this.selectedTemplate = event.detail.value;
        const t = this.templatesByName[this.selectedTemplate];
        this.preview = this.buildPreview(t);
        const header = t && (t.components || []).find((c) => c.type === 'HEADER');
        this.needsImage = !!(header && header.format === 'IMAGE');
    }

    handleRowSelection(event) {
        this.selectedRows = event.detail.selectedRows;
        this.selectedRowIds = this.selectedRows.map((r) => r.id);
    }

    buildPreview(t) {
        if (!t) return null;
        let headerText = '', headerMedia = '', body = '', footer = '', buttons = [];
        (t.components || []).forEach((c) => {
            if (c.type === 'HEADER') {
                if (c.format === 'TEXT') headerText = c.text || '';
                else if (c.format) headerMedia = c.format;
            } else if (c.type === 'BODY') {
                let vals = [];
                if (c.example && c.example.body_text && c.example.body_text[0]) vals = c.example.body_text[0];
                body = (c.text || '').replace(/\{\{(\d+)\}\}/g, (m, n) => vals[n - 1] || m);
            } else if (c.type === 'FOOTER') {
                footer = c.text || '';
            } else if (c.type === 'BUTTONS') {
                buttons = (c.buttons || []).map((b, i) => ({ key: i, text: b.text }));
            }
        });
        return {
            headerText,
            headerMedia,
            mediaLabel: headerMedia ? `📷 ${headerMedia}` : '',
            imageUrl: headerMedia === 'IMAGE' ? this.headerImageUrl : null,
            showMediaPlaceholder: !!headerMedia && headerMedia !== 'IMAGE',
            body, footer, buttons, hasButtons: buttons.length > 0
        };
    }

    hasBodyVar() {
        const t = this.templatesByName[this.selectedTemplate];
        if (!t) return false;
        const bodyComp = (t.components || []).find((c) => c.type === 'BODY');
        return !!(bodyComp && /\{\{\d+\}\}/.test(bodyComp.text || ''));
    }

    async handleSend() {
        if (this.selectedRows.length > 90) {
            this.toast('Too many', 'Please select 90 or fewer recipients per send.', 'warning');
            return;
        }
        this.sending = true;
        try {
            const t = this.templatesByName[this.selectedTemplate];
            const res = await sendCampaign({
                templateName: this.selectedTemplate,
                language: (t && t.language) || 'en',
                hasBodyVar: this.hasBodyVar(),
                headerImageUrl: this.needsImage ? this.headerImageUrl : null,
                recipientsJson: JSON.stringify(
                    this.selectedRows.map((r) => ({
                        name: r.name,
                        phone: r.phone,
                        vehicle: r.vehicle,
                        orderNumber: r.orderNumber,
                        amount: r.amount,
                        color: r.color,
                        info: r.info
                    }))
                )
            });
            this.toast('Campaign sent', `✅ Sent: ${res.sent} · ❌ Failed: ${res.failed}`, res.failed ? 'warning' : 'success');
        } catch (e) {
            this.toast('Error', this.msg(e), 'error');
        } finally {
            this.sending = false;
        }
    }

    msg(e) {
        return e && e.body && e.body.message ? e.body.message : (e.message || 'Unknown error');
    }
    toast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
    }
}
