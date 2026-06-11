/**
 * Bookings #8 (auto) — payment alerts to all booking customers before delivery.
 *
 * Daily job: for orders that are allocated, still owe money, and not yet delivered/cancelled,
 * send the jasper_payment_alert template (with the remaining balance) on day 2, 4 and 6 after
 * allocation. Anchored on Allocation_Date__c (stamped when a vehicle is assigned to the order),
 * so reminders run in the pre-delivery window. Exact-day matching means each order is reminded
 * once per milestone; it drops out automatically once the balance is cleared
 * (Remaining_Amount__c <= 0) or the order is delivered/cancelled.
 *
 * Complements the manual "Payment Reminders" tab (WAPaymentController), which stays for ad-hoc nudges.
 *
 * Schedule daily (e.g. noon) with:
 *   System.schedule('WA Payment Reminder', '0 0 12 * * ?', new WAPaymentReminderScheduler());
 */
public with sharing class WAPaymentReminderScheduler implements Schedulable {

    static final Set<String> DONE = new Set<String>{
        'Vehicle Delivered', 'Delivered', 'Order Cancelled', 'Cancellation Requested'
    };

    public void execute(SchedulableContext sc) {
        List<Date> days = new List<Date>{
            Date.today().addDays(-2), Date.today().addDays(-4), Date.today().addDays(-6)
        };
        List<Order> orders = [
            SELECT Id, OrderNumber, Phone__c, Status, Remaining_Amount__c, Account.Name,
                   (SELECT Product2.Name FROM OrderItems LIMIT 1)
            FROM Order
            WHERE Allocation_Date__c != null
              AND Phone__c != null
              AND Allocation_Date__c IN :days
              AND Status NOT IN :DONE
              AND (Payment_Status__c = 'Pending' OR Remaining_Amount__c > 0)
        ];
        if (!orders.isEmpty()) System.enqueueJob(new Sender(orders));
    }

    /** Async callout job: sends the payment alert (remaining balance) to each customer. */
    public class Sender implements Queueable, Database.AllowsCallouts {
        List<Order> orders;
        public Sender(List<Order> o) { this.orders = o; }

        public void execute(QueueableContext qc) {
            WA_Bot_Setting__c s = WA_Bot_Setting__c.getOrgDefaults();
            String base = (s == null || s.Base_URL__c == null) ? '' : s.Base_URL__c.removeEnd('/');
            for (Order o : orders) {
                Map<String, String> data = new Map<String, String>{
                    'name' => (o.Account != null && o.Account.Name != null) ? o.Account.Name : 'Customer',
                    'remaining' => (o.Remaining_Amount__c != null) ? '₹' + o.Remaining_Amount__c.format() : '₹0',
                    'vehicle' => vehicleOf(o),
                    'orderNumber' => o.OrderNumber
                };
                send(base, normalize(o.Phone__c), data);
            }
        }

        String vehicleOf(Order o) {
            if (o.OrderItems != null && !o.OrderItems.isEmpty() && o.OrderItems[0].Product2 != null) {
                return o.OrderItems[0].Product2.Name;
            }
            return '';
        }

        void send(String base, String phone, Map<String, String> data) {
            if (String.isBlank(phone)) return;
            Map<String, Object> body = new Map<String, Object>{
                'to' => phone, 'template' => 'jasper_payment_alert', 'language' => 'en',
                'components' => new List<Object>{
                    new Map<String, Object>{ 'type' => 'body', 'parameters' => WAVars.bodyParams('jasper_payment_alert', data, true) }
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
                System.debug('payment reminder send failed: ' + e.getMessage());
            }
        }

        String normalize(String p) {
            if (p == null) return '';
            String d = p.replaceAll('[^0-9]', '');
            if (d.length() == 10) d = '91' + d;
            return d;
        }
    }
}
