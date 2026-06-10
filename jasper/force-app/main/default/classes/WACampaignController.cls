public with sharing class WACampaignController {
    private static String baseUrl() {
        String u = WA_Bot_Setting__c.getOrgDefaults().Base_URL__c;
        return String.isBlank(u) ? '' : u.removeEnd('/');
    }
    private static String apiKey() {
        return WA_Bot_Setting__c.getOrgDefaults().API_Key__c;
    }

    /** Tell the bot to drop its cache and reload vehicles from Salesforce now. */
    @AuraEnabled
    public static String syncCatalog() {
        HttpRequest req = new HttpRequest();
        req.setEndpoint(baseUrl() + '/catalog/refresh');
        req.setMethod('POST');
        req.setHeader('x-api-key', apiKey());
        req.setHeader('Content-Type', 'application/json');
        req.setTimeout(60000);
        return new Http().send(req).getBody();
    }

    /** Approved templates (raw backend JSON with components) for the picker + preview. */
    @AuraEnabled(cacheable=false)
    public static String getApprovedTemplates() {
        HttpRequest req = new HttpRequest();
        req.setEndpoint(baseUrl() + '/templates');
        req.setMethod('GET');
        req.setHeader('x-api-key', apiKey());
        req.setTimeout(60000);
        return new Http().send(req).getBody();
    }

    /** Recipients for a lifecycle stage: Enquiries (Lead) / Bookings (Order) / Delivery (Order). */
    @AuraEnabled(cacheable=false)
    public static List<Map<String, Object>> getRecipients(String stage) {
        List<Map<String, Object>> out = new List<Map<String, Object>>();
        if (stage == 'Enquiries') {
            for (Lead l : [
                SELECT Id, Name, Phone, Status, Buying_Span__c,
                       (SELECT Id FROM Test_Drives__r LIMIT 1)
                FROM Lead WHERE Phone != null AND IsConverted = false
                ORDER BY CreatedDate DESC LIMIT 200
            ]) {
                Boolean hasTd = l.Test_Drives__r != null && !l.Test_Drives__r.isEmpty();
                Boolean active = !(l.Status == 'Close lost' || l.Status == 'Converted' || l.Status == 'Junk');
                Boolean hot = active && (isHotStatus(l.Status) || isHotSpan(l.Buying_Span__c) || hasTd);
                out.add(new Map<String, Object>{
                    'id' => l.Id, 'name' => l.Name, 'phone' => l.Phone, 'info' => l.Status, 'hot' => hot
                });
            }
        } else if (stage == 'Bookings') {
            for (Order o : [
                SELECT Id, OrderNumber, Phone__c, Status, Color__c, Grand_Total__c, Account.Name,
                       (SELECT Product2.Name FROM OrderItems LIMIT 1)
                FROM Order WHERE Phone__c != null ORDER BY CreatedDate DESC LIMIT 200
            ]) {
                out.add(orderRow(o, o.Status));
            }
        } else if (stage == 'Delivery') {
            for (Order o : [
                SELECT Id, OrderNumber, Phone__c, Status, Color__c, Grand_Total__c, Account.Name, Delivery_Date__c,
                       (SELECT Product2.Name FROM OrderItems LIMIT 1)
                FROM Order WHERE Phone__c != null AND (Delivery_Date__c != null OR Status LIKE '%Deliver%')
                ORDER BY CreatedDate DESC LIMIT 200
            ]) {
                String info = (o.Delivery_Date__c != null ? String.valueOf(o.Delivery_Date__c) : o.Status);
                out.add(orderRow(o, info));
            }
        }
        return out;
    }

    /** Build a recipient row from an Order (with vehicle/order#/amount for personalization). */
    private static Map<String, Object> orderRow(Order o, String info) {
        String vehicle = '';
        if (o.OrderItems != null && !o.OrderItems.isEmpty() && o.OrderItems[0].Product2 != null) {
            vehicle = o.OrderItems[0].Product2.Name;
        }
        String amount = (o.Grand_Total__c != null) ? '₹' + o.Grand_Total__c.format() : '';
        return new Map<String, Object>{
            'id' => o.Id,
            'name' => (o.Account != null ? o.Account.Name : o.OrderNumber),
            'phone' => o.Phone__c,
            'info' => info,
            'vehicle' => vehicle,
            'orderNumber' => o.OrderNumber,
            'amount' => amount,
            'color' => o.Color__c
        };
    }

    /** Send an approved template to the selected recipients via the bot backend. */
    @AuraEnabled
    public static Map<String, Object> sendCampaign(
        String templateName, String language, Boolean hasBodyVar, String headerImageUrl, String recipientsJson
    ) {
        List<Object> recips = (List<Object>) JSON.deserializeUntyped(recipientsJson);
        Integer sent = 0, failed = 0;
        List<String> errors = new List<String>();
        String lang = String.isBlank(language) ? 'en' : language;
        Set<String> seenPhones = new Set<String>(); // de-dupe: one message per number per run

        for (Object ro : recips) {
            Map<String, Object> r = (Map<String, Object>) ro;
            String name = (String) r.get('name');
            String phone = normalize((String) r.get('phone'));
            if (String.isBlank(phone)) {
                failed++;
                continue;
            }
            if (seenPhones.contains(phone)) {
                continue; // same number already messaged in this run
            }
            seenPhones.add(phone);
            Map<String, Object> body = new Map<String, Object>{
                'to' => phone, 'template' => templateName, 'language' => lang
            };
            List<Object> components = new List<Object>();
            // IMAGE-header templates need the image supplied at send time.
            if (String.isNotBlank(headerImageUrl)) {
                components.add(new Map<String, Object>{
                    'type' => 'header',
                    'parameters' => new List<Object>{
                        new Map<String, Object>{ 'type' => 'image', 'image' => new Map<String, Object>{ 'link' => headerImageUrl } }
                    }
                });
            }
            // Body variables: map {{1}},{{2}}... to the recipient's fields per template.
            Map<String, String> data = new Map<String, String>{
                'name' => name,
                'vehicle' => str(r.get('vehicle')),
                'orderNumber' => str(r.get('orderNumber')),
                'amount' => str(r.get('amount')),
                'color' => str(r.get('color')),
                'info' => str(r.get('info'))
            };
            List<Object> bodyParams = WAVars.bodyParams(templateName, data, hasBodyVar);
            if (bodyParams != null) {
                components.add(new Map<String, Object>{ 'type' => 'body', 'parameters' => bodyParams });
            }
            if (!components.isEmpty()) {
                body.put('components', components);
            }
            HttpRequest req = new HttpRequest();
            req.setEndpoint(baseUrl() + '/send/template');
            req.setMethod('POST');
            req.setHeader('Content-Type', 'application/json');
            req.setTimeout(60000);
            req.setBody(JSON.serialize(body));
            try {
                HttpResponse res = new Http().send(req);
                Map<String, Object> resp = (Map<String, Object>) JSON.deserializeUntyped(res.getBody());
                if (resp.get('ok') == true) {
                    sent++;
                } else {
                    failed++;
                    if (errors.size() < 5) errors.add(name + ': ' + res.getBody());
                }
            } catch (Exception e) {
                failed++;
                if (errors.size() < 5) errors.add(name + ': ' + e.getMessage());
            }
        }
        return new Map<String, Object>{ 'sent' => sent, 'failed' => failed, 'errors' => errors };
    }

    /** Vehicles from the live catalog for the Price-Alert / Platinum-Spotlight picker. */
    @AuraEnabled(cacheable=false)
    public static List<Map<String, Object>> getCatalogVehicles(Boolean platinumOnly) {
        List<Vehicle> vs = (platinumOnly == true)
            ? [SELECT Id, Name, MarketPrice, Image_URL__c, Platinum__c FROM Vehicle WHERE Platinum__c = true ORDER BY Name]
            : [SELECT Id, Name, MarketPrice, Image_URL__c, Platinum__c FROM Vehicle ORDER BY Name];
        List<Map<String, Object>> out = new List<Map<String, Object>>();
        for (Vehicle v : vs) {
            out.add(new Map<String, Object>{
                'id' => v.Id,
                'name' => v.Name,
                'price' => formatPrice(v.MarketPrice),
                'image' => v.Image_URL__c,
                'platinum' => v.Platinum__c == true
            });
        }
        return out;
    }

    /**
     * Send a price-alert / platinum-spotlight template for ONE chosen vehicle to the selected
     * recipients. Vehicle name + price come from the vehicle; name from each recipient.
     */
    @AuraEnabled
    public static Map<String, Object> sendVehiclePromo(
        String templateName, String language, String vehicleId, String recipientsJson
    ) {
        Vehicle v = [SELECT Id, Name, MarketPrice FROM Vehicle WHERE Id = :vehicleId LIMIT 1];
        String vehicleName = v.Name;
        String price = formatPrice(v.MarketPrice);
        List<Object> recips = (List<Object>) JSON.deserializeUntyped(recipientsJson);
        Integer sent = 0, failed = 0;
        List<String> errors = new List<String>();
        String lang = String.isBlank(language) ? 'en' : language;
        Set<String> seenPhones = new Set<String>(); // de-dupe: one message per number per run

        for (Object ro : recips) {
            Map<String, Object> r = (Map<String, Object>) ro;
            String name = (String) r.get('name');
            String phone = normalize((String) r.get('phone'));
            if (String.isBlank(phone)) { failed++; continue; }
            if (seenPhones.contains(phone)) { continue; }
            seenPhones.add(phone);

            Map<String, String> data = new Map<String, String>{
                'name' => name, 'vehicle' => vehicleName, 'price' => price
            };
            Map<String, Object> body = new Map<String, Object>{
                'to' => phone, 'template' => templateName, 'language' => lang,
                'components' => new List<Object>{
                    new Map<String, Object>{ 'type' => 'body', 'parameters' => WAVars.bodyParams(templateName, data, true) }
                }
            };
            HttpRequest req = new HttpRequest();
            req.setEndpoint(baseUrl() + '/send/template');
            req.setMethod('POST');
            req.setHeader('Content-Type', 'application/json');
            req.setTimeout(60000);
            req.setBody(JSON.serialize(body));
            try {
                HttpResponse res = new Http().send(req);
                Map<String, Object> resp = (Map<String, Object>) JSON.deserializeUntyped(res.getBody());
                if (resp.get('ok') == true) { sent++; }
                else { failed++; if (errors.size() < 5) errors.add(name + ': ' + res.getBody()); }
            } catch (Exception e) {
                failed++;
                if (errors.size() < 5) errors.add(name + ': ' + e.getMessage());
            }
        }
        return new Map<String, Object>{ 'sent' => sent, 'failed' => failed, 'errors' => errors };
    }

    /** Hot-prospect signals (for the Vehicle Promos "Hot prospects only" filter). */
    private static Boolean isHotStatus(String s) {
        return s == 'Ready For booking' || s == 'Test Ride' || s == 'Follow Up';
    }
    private static Boolean isHotSpan(String s) {
        return s == 'Within 7 Days' || s == 'Within 15 Days';
    }

    private static String formatPrice(Object marketPrice) {
        if (marketPrice == null) return '';
        Decimal d = Decimal.valueOf(String.valueOf(marketPrice));
        return '₹' + d.setScale(0).format();
    }

    /** Normalize an Indian number to E.164 digits (prepend 91 for 10-digit numbers). */
    private static String normalize(String p) {
        if (p == null) return '';
        String digits = p.replaceAll('[^0-9]', '');
        if (digits.length() == 10) digits = '91' + digits;
        return digits;
    }

    private static String str(Object o) {
        return o == null ? '' : String.valueOf(o);
    }
}
