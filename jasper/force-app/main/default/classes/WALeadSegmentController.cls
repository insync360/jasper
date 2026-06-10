/**
 * On-demand lead segregation: the user SELECTS which active enquiry leads to process; their
 * responses (conversation transcript) + signals are sent to the bot backend (Claude), which
 * buckets each into Hot / Warm / Cold — saved on the lead. Used by the waLeadSegregation LWC.
 */
public with sharing class WALeadSegmentController {

    private static String baseUrl() {
        String u = WA_Bot_Setting__c.getOrgDefaults().Base_URL__c;
        return String.isBlank(u) ? '' : u.removeEnd('/');
    }
    private static String apiKey() {
        return WA_Bot_Setting__c.getOrgDefaults().API_Key__c;
    }

    private static final Set<String> VALID = new Set<String>{ 'Hot', 'Warm', 'Cold' };

    /** Selectable candidates: active enquiry leads (excludes Converted / Junk / Close lost). */
    @AuraEnabled(cacheable=false)
    public static List<Map<String, Object>> getCandidates() {
        List<Map<String, Object>> out = new List<Map<String, Object>>();
        for (Lead l : [
            SELECT Id, Name, Phone, Status, Lead_Segment__c FROM Lead
            WHERE Phone != null AND Status NOT IN ('Converted', 'Junk', 'Close lost')
            ORDER BY CreatedDate DESC LIMIT 300
        ]) {
            out.add(new Map<String, Object>{
                'id' => l.Id, 'name' => l.Name, 'phone' => l.Phone,
                'info' => l.Status, 'segment' => l.Lead_Segment__c
            });
        }
        return out;
    }

    /**
     * Segregate the SELECTED leads (max 50/run). Returns JSON:
     * { ok, total, counts:{Hot,Warm,Cold}, results:[{id,name,segment,detail}] }
     */
    @AuraEnabled
    public static String segregateSelected(String leadIdsJson) {
        Set<Id> ids = new Set<Id>();
        for (Object o : (List<Object>) JSON.deserializeUntyped(leadIdsJson)) {
            try { ids.add((Id) String.valueOf(o)); } catch (Exception e) { /* skip */ }
        }
        if (ids.isEmpty()) {
            return JSON.serialize(new Map<String, Object>{ 'ok' => false, 'error' => 'No customers selected.', 'total' => 0 });
        }
        if (ids.size() > 50) {
            return JSON.serialize(new Map<String, Object>{ 'ok' => false, 'error' => 'Please select 50 or fewer customers per run.', 'total' => 0 });
        }

        List<Lead> leads = [
            SELECT Id, Name, Status, Buying_Span__c, Source__c, City
            FROM Lead WHERE Id IN :ids
        ];
        if (leads.isEmpty()) {
            return JSON.serialize(new Map<String, Object>{ 'ok' => false, 'error' => 'Selected leads not found.', 'total' => 0 });
        }

        // Conversation transcripts (the customer's responses), keyed by lead.
        Map<Id, String> transcriptByLead = new Map<Id, String>();
        for (WhatsApp_Conversation__c c : [
            SELECT Lead__c, Transcript__c FROM WhatsApp_Conversation__c WHERE Lead__c IN :ids
        ]) {
            if (String.isNotBlank(c.Transcript__c) && !transcriptByLead.containsKey(c.Lead__c)) {
                String t = c.Transcript__c;
                if (t.length() > 600) t = t.substring(0, 600);
                transcriptByLead.put(c.Lead__c, t);
            }
        }

        List<Map<String, Object>> payload = new List<Map<String, Object>>();
        for (Lead l : leads) {
            payload.add(new Map<String, Object>{
                'id' => l.Id,
                'name' => l.Name,
                'status' => blankTo(l.Status, ''),
                'buyingSpan' => blankTo(l.Buying_Span__c, ''),
                'source' => blankTo(l.Source__c, ''),
                'city' => blankTo(l.City, ''),
                'transcript' => blankTo(transcriptByLead.get(l.Id), '')
            });
        }

        HttpRequest req = new HttpRequest();
        req.setEndpoint(baseUrl() + '/analyze/segregate');
        req.setMethod('POST');
        req.setHeader('x-api-key', apiKey());
        req.setHeader('Content-Type', 'application/json');
        req.setTimeout(120000);
        req.setBody(JSON.serialize(new Map<String, Object>{ 'leads' => payload }));
        HttpResponse resp;
        try {
            resp = new Http().send(req);
        } catch (CalloutException e) {
            throw new AuraHandledException('Could not reach the segregation service: ' + e.getMessage());
        }
        if (resp.getStatusCode() != 200) {
            throw new AuraHandledException('Backend error ' + resp.getStatusCode() + ': ' + resp.getBody());
        }

        Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(resp.getBody());
        List<Object> results = (List<Object>) body.get('results');
        Map<Id, Map<String, Object>> byId = new Map<Id, Map<String, Object>>();
        if (results != null) {
            for (Object ro : results) {
                Map<String, Object> r = (Map<String, Object>) ro;
                try { byId.put((Id) String.valueOf(r.get('id')), r); } catch (Exception e) { /* skip */ }
            }
        }

        List<Lead> toUpdate = new List<Lead>();
        List<Map<String, Object>> outRows = new List<Map<String, Object>>();
        Integer hot = 0, warm = 0, cold = 0;
        for (Lead l : leads) {
            Map<String, Object> r = byId.get(l.Id);
            String seg = (r != null) ? String.valueOf(r.get('segment')) : null;
            if (!VALID.contains(seg)) seg = 'Warm';
            String interest = (r != null) ? blankTo(String.valueOf(r.get('interest')), '') : '';
            String reason = (r != null) ? blankTo(String.valueOf(r.get('reason')), '') : '';
            String detail = (interest + (String.isNotBlank(reason) ? ' — ' + reason : '')).trim();
            if (detail.length() > 255) detail = detail.substring(0, 255);

            if (seg == 'Hot') hot++; else if (seg == 'Cold') cold++; else warm++;
            toUpdate.add(new Lead(Id = l.Id, Lead_Segment__c = seg, Lead_Segment_Detail__c = detail));
            outRows.add(new Map<String, Object>{ 'id' => l.Id, 'name' => l.Name, 'segment' => seg, 'detail' => detail });
        }
        update toUpdate;

        return JSON.serialize(new Map<String, Object>{
            'ok' => true,
            'total' => leads.size(),
            'counts' => new Map<String, Object>{ 'Hot' => hot, 'Warm' => warm, 'Cold' => cold },
            'results' => outRows
        });
    }

    private static String blankTo(String v, String dflt) {
        return String.isBlank(v) ? dflt : v;
    }
}
