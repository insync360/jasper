public with sharing class WALifecycleMessenger {
    // (orderId, event) pairs to message. event = 'booking' | 'delivery'.
    public class Item {
        public Id orderId;
        public String evt;
        public Item(Id o, String e) {
            this.orderId = o;
            this.evt = e;
        }
    }

    /** Enqueue lifecycle WhatsApp messages (callout happens async in a Queueable). */
    public static void send(List<Item> items) {
        if (items == null || items.isEmpty()) return;
        if (System.isFuture() || System.isBatch()) return; // avoid nested async limits
        System.enqueueJob(new Sender(items));
    }

    public class Sender implements Queueable, Database.AllowsCallouts {
        List<Item> items;
        public Sender(List<Item> i) {
            this.items = i;
        }
        public void execute(QueueableContext qc) {
            WA_Bot_Setting__c cfg = WA_Bot_Setting__c.getOrgDefaults();
            String base = cfg.Base_URL__c == null ? '' : cfg.Base_URL__c.removeEnd('/');
            Set<Id> ids = new Set<Id>();
            for (Item it : items) ids.add(it.orderId);
            Map<Id, Order> orders = new Map<Id, Order>([
                SELECT Id, Phone__c, OrderNumber, Status, Color__c, Grand_Total__c, Account.Name,
                       (SELECT Product2.Name FROM OrderItems LIMIT 1)
                FROM Order WHERE Id IN :ids
            ]);
            for (Item it : items) {
                Order o = orders.get(it.orderId);
                if (o == null || String.isBlank(o.Phone__c)) continue;
                String tpl = (it.evt == 'delivery')
                    ? cfg.Delivery_Greeting_Template__c
                    : cfg.Booking_Welcome_Template__c;
                if (String.isBlank(tpl)) continue;

                String name = (o.Account != null && o.Account.Name != null) ? o.Account.Name : 'Customer';
                String vehicle = '';
                if (o.OrderItems != null && !o.OrderItems.isEmpty() && o.OrderItems[0].Product2 != null) {
                    vehicle = o.OrderItems[0].Product2.Name;
                }
                String amount = (o.Grand_Total__c != null) ? '₹' + o.Grand_Total__c.format() : '';
                Map<String, String> data = new Map<String, String>{
                    'name' => name, 'vehicle' => vehicle, 'orderNumber' => o.OrderNumber,
                    'amount' => amount, 'color' => o.Color__c
                };

                Map<String, Object> body = new Map<String, Object>{
                    'to' => normalize(o.Phone__c),
                    'template' => tpl,
                    'language' => 'en',
                    'components' => new List<Object>{
                        new Map<String, Object>{ 'type' => 'body', 'parameters' => WAVars.bodyParams(tpl, data, true) }
                    }
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
                    System.debug('WA lifecycle send failed: ' + e.getMessage());
                }
            }
        }
    }

    private static String normalize(String p) {
        if (p == null) return '';
        String digits = p.replaceAll('[^0-9]', '');
        if (digits.length() == 10) digits = '91' + digits;
        return digits;
    }
}
