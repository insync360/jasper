/**
 * Gathers lost-lead data from Salesforce and asks the bot backend (Claude) to produce
 * an AI lost-case analysis: top reasons, root causes, recommendations to arrest losses,
 * and win-back ideas. Used by the waLostCaseAnalysis LWC.
 */
public with sharing class WALostCaseController {

    private static String baseUrl() {
        String u = WA_Bot_Setting__c.getOrgDefaults().Base_URL__c;
        return String.isBlank(u) ? '' : u.removeEnd('/');
    }
    private static String apiKey() {
        return WA_Bot_Setting__c.getOrgDefaults().API_Key__c;
    }

    /**
     * Returns the backend response body as JSON: { ok, analysis:{ summary, topReasons,
     * rootCauses, recommendations, winBack }, total }. The LWC parses it.
     */
    @AuraEnabled(cacheable=false)
    public static String analyzeLostCases() {
        Map<String, Object> payload = buildPayload();
        Integer total = (Integer) payload.get('total');
        if (total == 0) {
            return JSON.serialize(new Map<String, Object>{ 'ok' => false, 'error' => 'No lost leads found to analyze.', 'total' => 0 });
        }

        HttpRequest req = new HttpRequest();
        req.setEndpoint(baseUrl() + '/analyze/lost-cases');
        req.setMethod('POST');
        req.setHeader('x-api-key', apiKey());
        req.setHeader('Content-Type', 'application/json');
        req.setTimeout(120000);
        req.setBody(JSON.serialize(payload));
        try {
            HttpResponse resp = new Http().send(req);
            if (resp.getStatusCode() != 200) {
                throw new AuraHandledException('Backend error ' + resp.getStatusCode() + ': ' + resp.getBody());
            }
            // Re-wrap with total so the UI can show "analyzed N lost leads".
            Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(resp.getBody());
            body.put('total', total);
            return JSON.serialize(body);
        } catch (CalloutException e) {
            throw new AuraHandledException('Could not reach the analysis service: ' + e.getMessage());
        }
    }

    /**
     * List lost leads (Status='Close lost') with any previously-saved per-case analysis,
     * so the UI can show each case and its kept analysis. Returns JSON array.
     */
    @AuraEnabled(cacheable=false)
    public static String getLostCases() {
        List<Map<String, Object>> out = new List<Map<String, Object>>();
        for (Lead l : [
            SELECT Id, Name, Lost_Reason__c, Lost_reason_if_any__c, Source__c, Buying_Span__c,
                   City, CreatedDate, AI_Lost_Analysis__c, AI_Lost_Analysis_Date__c
            FROM Lead WHERE Status = 'Close lost' ORDER BY CreatedDate DESC LIMIT 200
        ]) {
            Object analysis = null;
            if (String.isNotBlank(l.AI_Lost_Analysis__c)) {
                try { analysis = JSON.deserializeUntyped(l.AI_Lost_Analysis__c); } catch (Exception e) { analysis = null; }
            }
            out.add(new Map<String, Object>{
                'id' => l.Id,
                'name' => l.Name,
                'reason' => blankTo(l.Lost_Reason__c, 'Not specified'),
                'note' => blankTo(l.Lost_reason_if_any__c, ''),
                'source' => blankTo(l.Source__c, 'Unknown'),
                'city' => blankTo(l.City, ''),
                'ageDays' => l.CreatedDate.date().daysBetween(Date.today()),
                'analysis' => analysis,
                'analyzedDate' => l.AI_Lost_Analysis_Date__c == null ? '' : l.AI_Lost_Analysis_Date__c.format('dd MMM yyyy, h:mm a')
            });
        }
        return JSON.serialize(out);
    }

    /**
     * Analyze ONE lost case with AI and KEEP the result on the lead. Returns JSON:
     * { ok, analysis:{ verdict, recoverability, factors, winBackAction, suggestedMessage }, analyzedDate }.
     */
    @AuraEnabled
    public static String analyzeCase(Id leadId) {
        Lead l = [
            SELECT Id, Name, Lost_Reason__c, Lost_reason_if_any__c, Source__c, Buying_Span__c, City, CreatedDate
            FROM Lead WHERE Id = :leadId LIMIT 1
        ];
        Map<String, Object> c = new Map<String, Object>{
            'name' => l.Name,
            'reason' => blankTo(l.Lost_Reason__c, 'Not specified'),
            'note' => blankTo(l.Lost_reason_if_any__c, ''),
            'source' => blankTo(l.Source__c, 'Unknown'),
            'buyingSpan' => blankTo(l.Buying_Span__c, 'Unknown'),
            'city' => blankTo(l.City, ''),
            'ageDays' => l.CreatedDate.date().daysBetween(Date.today())
        };

        HttpRequest req = new HttpRequest();
        req.setEndpoint(baseUrl() + '/analyze/lost-case');
        req.setMethod('POST');
        req.setHeader('x-api-key', apiKey());
        req.setHeader('Content-Type', 'application/json');
        req.setTimeout(120000);
        req.setBody(JSON.serialize(new Map<String, Object>{ 'case' => c }));

        HttpResponse resp;
        try {
            resp = new Http().send(req);
        } catch (CalloutException e) {
            throw new AuraHandledException('Could not reach the analysis service: ' + e.getMessage());
        }
        if (resp.getStatusCode() != 200) {
            throw new AuraHandledException('Backend error ' + resp.getStatusCode() + ': ' + resp.getBody());
        }

        Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(resp.getBody());
        Object analysis = body.get('analysis');

        // KEEP it: save the analysis + timestamp on the lead (callout-then-DML is allowed).
        Datetime now = Datetime.now();
        update new Lead(Id = leadId, AI_Lost_Analysis__c = JSON.serialize(analysis), AI_Lost_Analysis_Date__c = now);

        return JSON.serialize(new Map<String, Object>{
            'ok' => true,
            'analysis' => analysis,
            'analyzedDate' => now.format('dd MMM yyyy, h:mm a')
        });
    }

    /** Build aggregates + a sample of lost leads for the model. */
    private static Map<String, Object> buildPayload() {
        Integer total = [SELECT COUNT() FROM Lead WHERE Status = 'Close lost'];

        List<Map<String, Object>> byReason = new List<Map<String, Object>>();
        for (AggregateResult ar : [
            SELECT Lost_Reason__c r, COUNT(Id) c FROM Lead
            WHERE Status = 'Close lost' GROUP BY Lost_Reason__c ORDER BY COUNT(Id) DESC
        ]) {
            byReason.add(new Map<String, Object>{
                'reason' => blankTo((String) ar.get('r'), 'Not specified'),
                'count' => (Integer) ar.get('c')
            });
        }

        List<Map<String, Object>> bySource = new List<Map<String, Object>>();
        for (AggregateResult ar : [
            SELECT Source__c s, COUNT(Id) c FROM Lead
            WHERE Status = 'Close lost' GROUP BY Source__c ORDER BY COUNT(Id) DESC
        ]) {
            bySource.add(new Map<String, Object>{
                'source' => blankTo((String) ar.get('s'), 'Unknown'),
                'count' => (Integer) ar.get('c')
            });
        }

        List<Map<String, Object>> bySpan = new List<Map<String, Object>>();
        for (AggregateResult ar : [
            SELECT Buying_Span__c b, COUNT(Id) c FROM Lead
            WHERE Status = 'Close lost' GROUP BY Buying_Span__c ORDER BY COUNT(Id) DESC
        ]) {
            bySpan.add(new Map<String, Object>{
                'span' => blankTo((String) ar.get('b'), 'Unknown'),
                'count' => (Integer) ar.get('c')
            });
        }

        List<Map<String, Object>> samples = new List<Map<String, Object>>();
        for (Lead l : [
            SELECT Lost_Reason__c, Lost_reason_if_any__c, Source__c, Buying_Span__c, City, CreatedDate
            FROM Lead WHERE Status = 'Close lost' ORDER BY CreatedDate DESC LIMIT 60
        ]) {
            samples.add(new Map<String, Object>{
                'reason' => blankTo(l.Lost_Reason__c, 'Not specified'),
                'note' => blankTo(l.Lost_reason_if_any__c, ''),
                'source' => blankTo(l.Source__c, 'Unknown'),
                'buyingSpan' => blankTo(l.Buying_Span__c, 'Unknown'),
                'city' => blankTo(l.City, ''),
                'ageDays' => l.CreatedDate.date().daysBetween(Date.today())
            });
        }

        return new Map<String, Object>{
            'total' => total,
            'byReason' => byReason,
            'bySource' => bySource,
            'byBuyingSpan' => bySpan,
            'samples' => samples
        };
    }

    private static String blankTo(String v, String dflt) {
        return String.isBlank(v) ? dflt : v;
    }
}
