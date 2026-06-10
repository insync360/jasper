public with sharing class WATemplateController {
    // Backend URL + API key are read from the WA_Bot_Setting__c custom setting
    // (configured at runtime), so no secret lives in source.
    private static String baseUrl() {
        String u = WA_Bot_Setting__c.getOrgDefaults().Base_URL__c;
        return String.isBlank(u) ? '' : u.removeEnd('/');
    }
    private static String apiKey() {
        return WA_Bot_Setting__c.getOrgDefaults().API_Key__c;
    }

    /**
     * Submit a new WhatsApp template (optionally with an image header) to Meta via
     * the bot backend, and store a tracking record. Returns the raw backend response.
     */
    @AuraEnabled
    public static String submitTemplate(String payloadJson, String imageBase64, String imageMime) {
        Map<String, Object> in0 = (Map<String, Object>) JSON.deserializeUntyped(payloadJson);
        String name = (String) in0.get('name');
        String category = (String) in0.get('category');
        String language = (String) in0.get('language');
        String headerType = (String) in0.get('headerType');
        String headerText = (String) in0.get('headerText');
        String bodyText = (String) in0.get('bodyText');
        String bodyExample = (String) in0.get('bodyExample');
        String footer = (String) in0.get('footer');
        List<Object> buttons = (List<Object>) in0.get('buttons');

        Map<String, Object> req = new Map<String, Object>();
        req.put('name', name);
        req.put('category', category);
        req.put('language', String.isBlank(language) ? 'en' : language);
        if (headerType == 'Text' && String.isNotBlank(headerText)) {
            req.put('headerText', headerText);
        }
        req.put('bodyText', bodyText);
        if (String.isNotBlank(bodyExample)) {
            req.put('bodyExample', new List<String>{ bodyExample });
        }
        if (String.isNotBlank(footer)) {
            req.put('footer', footer);
        }
        if (buttons != null && !buttons.isEmpty()) {
            req.put('buttons', buttons);
        }
        if (headerType == 'Image' && String.isNotBlank(imageBase64)) {
            req.put('image', new Map<String, Object>{
                'data' => imageBase64,
                'mime' => String.isBlank(imageMime) ? 'image/jpeg' : imageMime
            });
        }

        HttpRequest httpReq = new HttpRequest();
        httpReq.setEndpoint(baseUrl() + '/templates');
        httpReq.setMethod('POST');
        httpReq.setHeader('Content-Type', 'application/json');
        httpReq.setHeader('x-api-key', apiKey());
        httpReq.setTimeout(120000);
        httpReq.setBody(JSON.serialize(req));

        HttpResponse res = new Http().send(httpReq);
        String respBody = res.getBody();
        Map<String, Object> out = (Map<String, Object>) JSON.deserializeUntyped(respBody);

        WA_Template__c rec = new WA_Template__c();
        rec.Name = name;
        rec.Category__c = category;
        rec.Language__c = String.isBlank(language) ? 'en' : language;
        rec.Header_Type__c = headerType;
        rec.Header_Text__c = headerText;
        rec.Body__c = bodyText;
        rec.Body_Example__c = bodyExample;
        rec.Footer__c = footer;
        if (buttons != null) {
            rec.Buttons_JSON__c = JSON.serialize(buttons);
        }
        if (out.get('status') != null) {
            rec.Status__c = 'Submitted';
            rec.Meta_Template_Id__c = (String) out.get('id');
        } else {
            rec.Status__c = 'Failed';
            rec.Error__c = respBody;
        }
        insert rec;
        return respBody;
    }

    /**
     * Fetch ALL templates in the WhatsApp account (incl. previously approved ones)
     * with their components, so the UI can render a WhatsApp-style preview.
     * Returns the raw backend JSON ({ ok, templates:[...] }).
     */
    @AuraEnabled(cacheable=false)
    public static String listMetaTemplates() {
        HttpRequest req = new HttpRequest();
        req.setEndpoint(baseUrl() + '/templates');
        req.setMethod('GET');
        req.setHeader('x-api-key', apiKey());
        req.setTimeout(60000);
        HttpResponse res = new Http().send(req);
        return res.getBody();
    }

    /** Templates created from Salesforce, newest first. */
    @AuraEnabled(cacheable=true)
    public static List<WA_Template__c> getTemplates() {
        return [
            SELECT Id, Name, Category__c, Status__c, Meta_Template_Id__c, Error__c, CreatedDate
            FROM WA_Template__c
            ORDER BY CreatedDate DESC
            LIMIT 50
        ];
    }

    /** Pull current approval status from Meta (via the backend) and update records. */
    @AuraEnabled
    public static void refreshStatuses() {
        HttpRequest req = new HttpRequest();
        req.setEndpoint(baseUrl() + '/templates');
        req.setMethod('GET');
        req.setHeader('x-api-key', apiKey());
        req.setTimeout(60000);
        HttpResponse res = new Http().send(req);
        Map<String, Object> out = (Map<String, Object>) JSON.deserializeUntyped(res.getBody());
        List<Object> tpls = (List<Object>) out.get('templates');
        if (tpls == null) {
            return;
        }
        Map<String, String> statusByName = new Map<String, String>();
        for (Object o : tpls) {
            Map<String, Object> t = (Map<String, Object>) o;
            statusByName.put((String) t.get('name'), (String) t.get('status'));
        }
        List<WA_Template__c> toUpdate = new List<WA_Template__c>();
        for (WA_Template__c rec : [
            SELECT Id, Name, Status__c FROM WA_Template__c WHERE Name IN :statusByName.keySet()
        ]) {
            String metaStatus = statusByName.get(rec.Name);
            String mapped = rec.Status__c;
            if (metaStatus == 'APPROVED') {
                mapped = 'Approved';
            } else if (metaStatus == 'REJECTED') {
                mapped = 'Rejected';
            } else if (metaStatus == 'PENDING') {
                mapped = 'Submitted';
            }
            if (mapped != rec.Status__c) {
                rec.Status__c = mapped;
                toUpdate.add(rec);
            }
        }
        if (!toUpdate.isEmpty()) {
            update toUpdate;
        }
    }
}
