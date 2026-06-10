import { LightningElement } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import getLostCases from '@salesforce/apex/WALostCaseController.getLostCases';
import analyzeCase from '@salesforce/apex/WALostCaseController.analyzeCase';

export default class WaLostCaseAnalysis extends LightningElement {
    cases = [];
    loading = true;
    error = '';

    connectedCallback() {
        this.loadCases();
    }

    async loadCases() {
        this.loading = true;
        this.error = '';
        try {
            const data = await getLostCases();
            const arr = JSON.parse(data) || [];
            this.cases = arr.map((c) => this.buildCase(c));
        } catch (e) {
            this.error = this.msg(e);
        } finally {
            this.loading = false;
        }
    }

    buildCase(c) {
        const age = c.ageDays != null && c.ageDays !== '' ? c.ageDays + ' days ago' : '';
        return {
            id: c.id,
            name: c.name,
            reason: c.reason,
            note: c.note,
            hasNote: !!c.note,
            meta: [c.source, c.city, age].filter(Boolean).join('  •  '),
            analyzing: false,
            ...this.analysisFields(c.analysis, c.analyzedDate)
        };
    }

    analysisFields(a, date) {
        const has = !!a;
        const recov = has ? a.recoverability || '' : '';
        const factors = has ? a.factors || [] : [];
        return {
            hasAnalysis: has,
            analyzedDate: date || '',
            verdict: has ? a.verdict : '',
            recoverability: recov,
            recovClass: 'recov ' + recov.toLowerCase(),
            factors: factors.map((f, i) => ({ key: 'f' + i, text: f })),
            hasFactors: factors.length > 0,
            winBackAction: has ? a.winBackAction : '',
            suggestedMessage: has ? a.suggestedMessage : '',
            hasMessage: has && !!a.suggestedMessage,
            btnLabel: has ? 'Re-analyse' : 'Analyse Now'
        };
    }

    async handleAnalyze(event) {
        const id = event.target.dataset.id;
        this.setCase(id, { analyzing: true });
        try {
            const res = await analyzeCase({ leadId: id });
            const r = JSON.parse(res);
            this.setCase(id, { analyzing: false, ...this.analysisFields(r.analysis, r.analyzedDate) });
            this.toast('Analysis ready', 'Case analysed and saved.', 'success');
        } catch (e) {
            this.setCase(id, { analyzing: false });
            this.toast('Error', this.msg(e), 'error');
        }
    }

    setCase(id, patch) {
        this.cases = this.cases.map((c) => (c.id === id ? { ...c, ...patch } : c));
    }

    get hasCases() {
        return !this.loading && this.cases.length > 0;
    }
    get isEmpty() {
        return !this.loading && this.cases.length === 0;
    }
    get count() {
        return this.cases.length;
    }

    msg(e) {
        return e && e.body ? e.body.message : e ? e.message : 'Unknown error';
    }
    toast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
    }
}
