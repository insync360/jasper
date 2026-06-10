public with sharing class WAStageMessenger {
    // (recordId, objectType, statusValue) reached a stage that may have a configured message.
    // objectType: 'Opportunity' | 'Order' | 'Lead'. statusValue: a status/stage, or 'Created' for inserts.
    public class Item {
        public Id recordId;
        public String objectType;
        public String statusValue;
        public Item(Id r, String o, String s) {
            this.recordId = r;
            this.objectType = o;
            this.statusValue = s;
        }
    }

    public static void send(List<Item> items) {
        if (items == null || items.isEmpty()) return;
        if (System.isFuture() || System.isBatch()) return;
        // Only enqueue if there's at least one matching active config.
        Set<String> keys = new Set<String>();
        for (Item it : items) keys.add(it.objectType + '|' + it.statusValue);
        Integer matches = [
            SELECT COUNT() FROM WA_Stage_Message__c WHERE Active__c = true
        ];
        if (matches == 0) return;
        System.enqueueJob(new Sender(items));
    }

    public class Sender implements Queueable, Database.AllowsCallouts {
        List<Item> items;
        public Sender(List<Item> i) {
            this.items = i;
        }
        public void execute(QueueableContext qc) {
            WA_Bot_Setting__c s = WA_Bot_Setting__c.getOrgDefaults();
            String base = s.Base_URL__c == null ? '' : s.Base_URL__c.removeEnd('/');

            // template config keyed by Object|Status
            Map<String, String> tplByKey = new Map<String, String>();
            for (WA_Stage_Message__c c : [
                SELECT Object__c, Status_Value__c, Template_Name__c FROM WA_Stage_Message__c WHERE Active__c = true
            ]) {
                tplByKey.put(c.Object__c + '|' + c.Status_Value__c, c.Template_Name__c);
            }

            // Gather ids per object that actually have a configured template.
            Set<Id> oppIds = new Set<Id>();
            Set<Id> orderIds = new Set<Id>();
            for (Item it : items) {
                if (!tplByKey.containsKey(it.objectType + '|' + it.statusValue)) continue;
                if (it.objectType == 'Opportunity') oppIds.add(it.recordId);
                else if (it.objectType == 'Order') orderIds.add(it.recordId);
            }

            Map<Id, Map<String, String>> oppData = loadOpportunities(oppIds);
            Map<Id, Map<String, String>> orderData = loadOrders(orderIds);

            for (Item it : items) {
                String tpl = tplByKey.get(it.objectType + '|' + it.statusValue);
                if (String.isBlank(tpl)) continue;
                Map<String, String> data = (it.objectType == 'Opportunity')
                    ? oppData.get(it.recordId)
                    : orderData.get(it.recordId);
                if (data == null) continue;
                String phone = data.get('phone');
                if (String.isBlank(phone)) continue;
                sendOne(base, phone, tpl, data);
            }
        }

        Map<Id, Map<String, String>> loadOpportunities(Set<Id> ids) {
            Map<Id, Map<String, String>> out = new Map<Id, Map<String, String>>();
            if (ids.isEmpty()) return out;
            Map<Id, String> phoneByOpp = new Map<Id, String>();
            for (OpportunityContactRole r : [
                SELECT OpportunityId, Contact.Phone, Contact.MobilePhone
                FROM OpportunityContactRole WHERE OpportunityId IN :ids AND IsPrimary = true
            ]) {
                String ph = String.isNotBlank(r.Contact.MobilePhone) ? r.Contact.MobilePhone : r.Contact.Phone;
                if (String.isNotBlank(ph)) phoneByOpp.put(r.OpportunityId, ph);
            }
            for (Opportunity o : [SELECT Id, Name, Account.Name FROM Opportunity WHERE Id IN :ids]) {
                out.put(o.Id, new Map<String, String>{
                    'name' => (o.Account != null && o.Account.Name != null) ? o.Account.Name : o.Name,
                    'lostReason' => 'no specific reason',
                    'phone' => normalize(phoneByOpp.get(o.Id))
                });
            }
            return out;
        }

        Map<Id, Map<String, String>> loadOrders(Set<Id> ids) {
            Map<Id, Map<String, String>> out = new Map<Id, Map<String, String>>();
            if (ids.isEmpty()) return out;
            Map<Id, String> phoneByOrder = new Map<Id, String>();
            for (Order o : [
                SELECT Id, OrderNumber, Phone__c, Grand_Total__c, Remaining_Amount__c, Account.Name,
                       Color__c, Vehicle_Colour__c, Vehicle_Gen_Version__c, Delivery_Date__c,
                       (SELECT Product2.Name FROM OrderItems LIMIT 1)
                FROM Order WHERE Id IN :ids
            ]) {
                String vehicle = '';
                if (o.OrderItems != null && !o.OrderItems.isEmpty() && o.OrderItems[0].Product2 != null) {
                    vehicle = o.OrderItems[0].Product2.Name;
                }
                String colour = String.isNotBlank(o.Color__c) ? o.Color__c : o.Vehicle_Colour__c;
                String edd = (o.Delivery_Date__c != null) ? o.Delivery_Date__c.format() : '';
                out.put(o.Id, new Map<String, String>{
                    'name' => (o.Account != null && o.Account.Name != null) ? o.Account.Name : 'Customer',
                    'vehicle' => vehicle,
                    'variant' => blankTo(o.Vehicle_Gen_Version__c, 'To be confirmed'),
                    'color' => blankTo(colour, 'To be confirmed'),
                    'orderNumber' => o.OrderNumber,
                    'amount' => (o.Grand_Total__c != null) ? '₹' + o.Grand_Total__c.format() : '',
                    'remaining' => (o.Remaining_Amount__c != null) ? '₹' + o.Remaining_Amount__c.format() : '₹0',
                    'edd' => blankTo(edd, 'To be confirmed'),
                    'phone' => normalize(o.Phone__c)
                });
                phoneByOrder.put(o.Id, last10(o.Phone__c));
            }

            // Resolve each order's customer Lead (by phone) -> survey link id for the feedback button.
            Set<String> phones = new Set<String>(phoneByOrder.values());
            phones.remove(null);
            phones.remove('');
            Map<String, Id> leadByPhone = new Map<String, Id>();
            if (!phones.isEmpty()) {
                for (Lead l : [SELECT Id, Phone FROM Lead WHERE Phone IN :phones ORDER BY CreatedDate DESC]) {
                    String d = last10(l.Phone);
                    if (String.isNotBlank(d) && !leadByPhone.containsKey(d)) leadByPhone.put(d, l.Id);
                }
            }
            for (Id oid : out.keySet()) {
                Id lid = leadByPhone.get(phoneByOrder.get(oid));
                // Always set a non-blank survey id (the URL-button param is required at send time);
                // fall back to the order id so the delivered message never fails to send.
                out.get(oid).put('surveyId', lid != null ? String.valueOf(lid) : String.valueOf(oid));
            }
            return out;
        }

        void sendOne(String base, String phone, String tpl, Map<String, String> data) {
            List<Object> comps = new List<Object>{
                new Map<String, Object>{ 'type' => 'body', 'parameters' => WAVars.bodyParams(tpl, data, true) }
            };
            // Append a dynamic URL button (e.g. the post-delivery feedback survey link) if configured.
            Map<String, Object> btn = WAVars.urlButtonComponent(tpl, data);
            if (btn != null) comps.add(btn);

            Map<String, Object> body = new Map<String, Object>{
                'to' => phone,
                'template' => tpl,
                'language' => 'en',
                'components' => comps
            };
            try {
                HttpRequest req = new HttpRequest();
                req.setEndpoint(base + '/send/template');
                req.setMethod('POST');
                req.setHeader('Content-Type', 'application/json');
                req.setTimeout(60000);
                req.setBody(JSON.serialize(body));
                new Http().send(req);
            } catch (Exception e) {
                System.debug('WA stage send failed: ' + e.getMessage());
            }
        }
    }

    private static String normalize(String p) {
        if (p == null) return '';
        String digits = p.replaceAll('[^0-9]', '');
        if (digits.length() == 10) digits = '91' + digits;
        return digits;
    }

    private static String blankTo(String v, String dflt) {
        return String.isBlank(v) ? dflt : v;
    }

    /** Last 10 digits of a phone (matches how Lead.Phone is stored). */
    private static String last10(String p) {
        if (p == null) return '';
        String digits = p.replaceAll('[^0-9]', '');
        return digits.length() > 10 ? digits.substring(digits.length() - 10) : digits;
    }
}
