import { LightningElement, track } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import submitTemplate from '@salesforce/apex/WATemplateController.submitTemplate';
import refreshStatuses from '@salesforce/apex/WATemplateController.refreshStatuses';
import listMetaTemplates from '@salesforce/apex/WATemplateController.listMetaTemplates';

const CATEGORY_OPTIONS = [
    { label: 'Marketing', value: 'MARKETING' },
    { label: 'Utility', value: 'UTILITY' },
    { label: 'Authentication', value: 'AUTHENTICATION' }
];
const HEADER_OPTIONS = [
    { label: 'None', value: 'None' },
    { label: 'Text', value: 'Text' },
    { label: 'Image', value: 'Image' }
];

export default class WaTemplateBuilder extends LightningElement {
    categoryOptions = CATEGORY_OPTIONS;
    headerOptions = HEADER_OPTIONS;

    @track form = {
        name: '', category: 'MARKETING', language: 'en', headerType: 'None',
        headerText: '', bodyText: '', bodyExample: '', footer: '', button1: '', button2: ''
    };
    imageBase64 = null;
    imageMime = null;
    imageName = '';
    submitting = false;
    loadingList = false;
    @track rows = [];

    connectedCallback() {
        this.loadTemplates();
    }

    get isText() {
        return this.form.headerType === 'Text';
    }
    get isImage() {
        return this.form.headerType === 'Image';
    }

    handleChange(event) {
        this.form = { ...this.form, [event.target.dataset.field]: event.target.value };
    }

    handleImage(event) {
        const file = event.target.files && event.target.files[0];
        if (!file) return;
        this.imageMime = file.type;
        this.imageName = file.name;
        const reader = new FileReader();
        reader.onload = () => {
            this.imageBase64 = reader.result.split(',')[1];
        };
        reader.readAsDataURL(file);
    }

    buildButtons() {
        const buttons = [];
        if (this.form.button1) buttons.push({ type: 'QUICK_REPLY', text: this.form.button1 });
        if (this.form.button2) buttons.push({ type: 'QUICK_REPLY', text: this.form.button2 });
        return buttons;
    }

    async handleSubmit() {
        if (!this.form.name || !this.form.bodyText) {
            this.toast('Error', 'Template name and body are required.', 'error');
            return;
        }
        if (this.isImage && !this.imageBase64) {
            this.toast('Error', 'Please choose an image for the header.', 'error');
            return;
        }
        this.submitting = true;
        const payload = {
            name: this.form.name.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_'),
            category: this.form.category,
            language: this.form.language || 'en',
            headerType: this.form.headerType,
            headerText: this.form.headerText,
            bodyText: this.form.bodyText,
            bodyExample: this.form.bodyExample,
            footer: this.form.footer,
            buttons: this.buildButtons()
        };
        try {
            const resp = await submitTemplate({
                payloadJson: JSON.stringify(payload),
                imageBase64: this.isImage ? this.imageBase64 : null,
                imageMime: this.isImage ? this.imageMime : null
            });
            const parsed = JSON.parse(resp);
            if (parsed.status) {
                this.toast('Submitted', `Template "${payload.name}" is ${parsed.status} for approval.`, 'success');
                this.resetForm();
            } else {
                const err = parsed.error ? JSON.stringify(parsed.error) : 'Submission failed';
                this.toast('Rejected', err, 'error');
            }
            await this.loadTemplates();
        } catch (e) {
            this.toast('Error', e.body ? e.body.message : e.message, 'error');
        } finally {
            this.submitting = false;
        }
    }

    async handleRefresh() {
        try {
            await refreshStatuses();
            await this.loadTemplates();
            this.toast('Refreshed', 'Statuses updated from Meta.', 'success');
        } catch (e) {
            this.toast('Error', e.body ? e.body.message : e.message, 'error');
        }
    }

    // Fetch ALL templates in the account (incl. previously approved) + build previews.
    async loadTemplates() {
        this.loadingList = true;
        try {
            const resp = await listMetaTemplates();
            const parsed = JSON.parse(resp);
            const tpls = (parsed && parsed.templates) || [];
            this.rows = tpls.map((t) => this.toRow(t));
        } catch (e) {
            this.toast('Error', e.body ? e.body.message : e.message, 'error');
        } finally {
            this.loadingList = false;
        }
    }

    toRow(t) {
        let headerText = '';
        let headerMedia = '';
        let body = '';
        let footer = '';
        let buttons = [];
        const comps = t.components || [];
        for (const c of comps) {
            if (c.type === 'HEADER') {
                if (c.format === 'TEXT') headerText = c.text || '';
                else if (c.format) headerMedia = c.format; // IMAGE / VIDEO / DOCUMENT
            } else if (c.type === 'BODY') {
                body = this.fillExample(c.text || '', c.example);
            } else if (c.type === 'FOOTER') {
                footer = c.text || '';
            } else if (c.type === 'BUTTONS') {
                buttons = (c.buttons || []).map((b, i) => ({ key: `${t.id}_${i}`, text: b.text }));
            }
        }
        return {
            id: t.id,
            name: t.name,
            status: t.status,
            category: t.category,
            headerText,
            headerMedia,
            isImageHeader: headerMedia === 'IMAGE',
            mediaLabel: headerMedia ? `📷 ${headerMedia}` : '',
            body,
            footer,
            buttons,
            hasButtons: buttons.length > 0,
            statusClass: 'wa-status status-' + (t.status || '')
        };
    }

    fillExample(text, example) {
        let vals = [];
        if (example && example.body_text && example.body_text[0]) vals = example.body_text[0];
        return text.replace(/\{\{(\d+)\}\}/g, (m, n) => vals[n - 1] || m);
    }

    resetForm() {
        this.form = {
            name: '', category: 'MARKETING', language: 'en', headerType: 'None',
            headerText: '', bodyText: '', bodyExample: '', footer: '', button1: '', button2: ''
        };
        this.imageBase64 = null;
        this.imageMime = null;
        this.imageName = '';
    }

    toast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
    }
}
