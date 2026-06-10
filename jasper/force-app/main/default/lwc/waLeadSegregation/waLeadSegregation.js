import { LightningElement } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import getCandidates from '@salesforce/apex/WALeadSegmentController.getCandidates';
import segregateSelected from '@salesforce/apex/WALeadSegmentController.segregateSelected';

export default class WaLeadSegregation extends LightningElement {
    candidates = [];
    selected = new Set();
    search = '';
    loadingList = false;
    loading = false;
    error = '';
    done = false;
    total = 0;
    counts = { Hot: 0, Warm: 0, Cold: 0 };
    rows = [];

    connectedCallback() {
        this.loadCandidates();
    }

    async loadCandidates() {
        this.loadingList = true;
        try {
            const cs = await getCandidates();
            this.candidates = (cs || []).map((c) => ({ ...c, key: c.id }));
        } catch (e) {
            this.toast('Error', this.msg(e), 'error');
        } finally {
            this.loadingList = false;
        }
    }

    handleSearch(e) {
        this.search = (e.target.value || '').toLowerCase();
    }

    get filteredCandidates() {
        const s = this.search;
        const list = s
            ? this.candidates.filter(
                  (c) =>
                      (c.name || '').toLowerCase().includes(s) ||
                      (c.phone || '').includes(s) ||
                      (c.info || '').toLowerCase().includes(s)
              )
            : this.candidates;
        return list.map((c) => ({ ...c, checked: this.selected.has(c.id) }));
    }

    get selectedCount() {
        return this.selected.size;
    }
    get allFilteredSelected() {
        const f = this.filteredCandidates;
        return f.length > 0 && f.every((c) => this.selected.has(c.id));
    }

    handleToggle(e) {
        const id = e.target.dataset.id;
        if (e.target.checked) this.selected.add(id);
        else this.selected.delete(id);
        this.selected = new Set(this.selected);
    }
    handleSelectAll(e) {
        const on = e.target.checked;
        for (const c of this.filteredCandidates) {
            if (on) this.selected.add(c.id);
            else this.selected.delete(c.id);
        }
        this.selected = new Set(this.selected);
    }

    get sendDisabled() {
        return this.selected.size === 0 || this.loading;
    }

    async handleSegregate() {
        if (this.selected.size === 0) return;
        this.loading = true;
        this.error = '';
        this.done = false;
        try {
            const resp = await segregateSelected({ leadIdsJson: JSON.stringify([...this.selected]) });
            const r = JSON.parse(resp);
            if (!r.ok) {
                this.error = r.error || 'Segregation failed.';
                this.toast('Nothing to do', this.error, 'warning');
                return;
            }
            this.total = r.total;
            this.counts = r.counts || { Hot: 0, Warm: 0, Cold: 0 };
            this.rows = (r.results || []).map((x) => ({
                ...x,
                badgeClass: 'seg ' + (x.segment || '').toLowerCase()
            }));
            this.done = true;
            this.toast('Done', `Segregated ${r.total} customers.`, 'success');
            this.loadCandidates(); // refresh segment badges in the list
        } catch (e) {
            this.error = this.msg(e);
            this.toast('Error', this.error, 'error');
        } finally {
            this.loading = false;
        }
    }

    get hotCount() {
        return this.counts.Hot || 0;
    }
    get warmCount() {
        return this.counts.Warm || 0;
    }
    get coldCount() {
        return this.counts.Cold || 0;
    }

    msg(e) {
        return e && e.body ? e.body.message : e ? e.message : 'Error';
    }
    toast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
    }
}
