/**
 * On-demand payment reminders: lists orders with a pending payment and sends the
 * jasper_payment_alert template to the customer when the user clicks "Send Reminder".
 * Used by the waPaymentReminders LWC.
 */
public with sharing class WAPaymentController {

    private static String baseUrl() {
        String u = WA_Bot_Setting__c.getOrgDefaults().Base_URL__c;
        return String.isBlank(u) ? '' : u.removeEnd('/');
    }

    /** Orders awaiting payment (Payment_Status__c = Pending or a remaining balance). */
    @AuraEnabled(cacheable=false)
    public static List<Map<String, Object>> getPendingPaymentOrders() {
        List<Map<String, Object>> out = new List<Map<String, Object>>();
        for (Order o : [
            SELECT Id, OrderNumber, Phone__c, Status, Payment_Status__c, Remaining_Amount__c, Account.Name,
                   (SELECT Product2.Name FROM OrderItems LIMIT 1)
            FROM Order
            WHERE Phone__c != null AND (Payment_Status__c = 'Pending' OR Remaining_Amount__c > 0)
            ORDER BY CreatedDate DESC LIMIT 200
        ]) {
            out.add(new Map<String, Object>{
                'id' => o.Id,
                'name' => (o.Account != null && o.Account.Name != null) ? o.Account.Name : o.OrderNumber,
                'orderNumber' => o.OrderNumber,
                'vehicle' => vehicleOf(o),
                'remaining' => formatAmt(o.Remaining_Amount__c),
                'status' => o.Status
            });
        }
        return out;
    }

    /** Send the payment reminder for one order. Returns 'ok' or throws. */
    @AuraEnabled
    public static String sendPaymentReminder(Id orderId) {
        Order o = [
            SELECT Id, OrderNumber, Phone__c, Remaining_Amount__c, Account.Name,
                   (SELECT Product2.Name FROM OrderItems LIMIT 1)
            FROM Order WHERE Id = :orderId LIMIT 1
        ];
        String phone = normalize(o.Phone__c);
        if (String.isBlank(phone)) {
            throw new AuraHandledException('This order has no customer phone (Account.Phone).');
        }
        Map<String, String> data = new Map<String, String>{
            'name' => (o.Account != null && o.Account.Name != null) ? o.Account.Name : 'Customer',
            'remaining' => formatAmt(o.Remaining_Amount__c),
            'vehicle' => vehicleOf(o),
            'orderNumber' => o.OrderNumber
        };
        Map<String, Object> body = new Map<String, Object>{
            'to' => phone, 'template' => 'jasper_payment_alert', 'language' => 'en',
            'components' => new List<Object>{
                new Map<String, Object>{ 'type' => 'body', 'parameters' => WAVars.bodyParams('jasper_payment_alert', data, true) }
            }
        };
        HttpRequest req = new HttpRequest();
        req.setEndpoint(baseUrl() + '/send/template');
        req.setMethod('POST');
        req.setHeader('Content-Type', 'application/json');
        req.setTimeout(60000);
        req.setBody(JSON.serialize(body));
        HttpResponse res;
        try {
            res = new Http().send(req);
        } catch (CalloutException e) {
            throw new AuraHandledException('Could not reach the messaging service: ' + e.getMessage());
        }
        Map<String, Object> resp = (Map<String, Object>) JSON.deserializeUntyped(res.getBody());
        if (resp.get('ok') == true) return 'ok';
        throw new AuraHandledException('Send failed: ' + res.getBody());
    }

    private static String vehicleOf(Order o) {
        if (o.OrderItems != null && !o.OrderItems.isEmpty() && o.OrderItems[0].Product2 != null) {
            return o.OrderItems[0].Product2.Name;
        }
        return '';
    }
    private static String formatAmt(Decimal d) {
        return (d != null) ? '₹' + d.format() : '₹0';
    }
    private static String normalize(String p) {
        if (p == null) return '';
        String digits = p.replaceAll('[^0-9]', '');
        if (digits.length() == 10) digits = '91' + digits;
        return digits;
    }
}
